// Daemon supervision from the extension side.
//
// The extension must never assume a daemon is running: a session can start on a
// freshly booted machine. `ensureDaemon` probes /health and, if nothing answers,
// spawns the daemon detached so it outlives this pi session.
//
// Detached, with output appended to daemon.log (not stdio:ignore: a silent daemon made the
// catch-up failures invisible). The daemon owns the mailbox and must outlive the
// process that started it so another session (or the phone) can still be served. It is not
// immortal: it exits once every session has stopped pinging.

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process"
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, statSync } from "node:fs"
import { dirname } from "node:path"

import type { PendingRecord } from "../store/pending-store.ts"
import { API_VERSION, apiCompatible } from "./api.ts"
import { statePath } from "../store/paths.ts"

export interface ProbeOptions {
	baseUrl: string
	timeoutMs?: number
	/** Injected for tests. Defaults to global fetch. */
	fetchImpl?: typeof fetch
}

/** True when a daemon answers /health. Never throws. */
export async function probeHealth(options: ProbeOptions): Promise<boolean> {
	const health = await probeHealthDetail(options)
	return health.ok
}

/**
 * `/health`, with the protocol it speaks.
 *
 * `ok` means "something answered"; `apiVersion` says whether *this* build can use it. A daemon
 * from another protocol is alive but unusable, and reusing it would make a replacement look
 * successful while the mismatch stayed.
 */
export async function probeHealthDetail(options: ProbeOptions): Promise<{ ok: boolean; apiVersion?: number }> {
	const doFetch = options.fetchImpl ?? fetch
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 750)
	try {
		const response = await doFetch(`${options.baseUrl}/health`, { signal: controller.signal })
		if (!response.ok) return { ok: false }
		const body = (await response.json().catch(() => undefined)) as { apiVersion?: unknown } | undefined
		return {
			ok: true,
			...(typeof body?.apiVersion === "number" ? { apiVersion: body.apiVersion } : {}),
		}
	} catch {
		return { ok: false }
	} finally {
		clearTimeout(timer)
	}
}

export interface EnsureDaemonOptions {
	baseUrl: string
	/** Absolute path to the daemon entry (`.ts` or `.js`). */
	scriptPath: string
	/** Extra argv passed after the script path (e.g. none). */
	args?: string[]
	env?: NodeJS.ProcessEnv
	/** How long to wait for the spawned daemon to answer /health. */
	waitMs?: number
	/** Injected for tests. */
	fetchImpl?: typeof fetch
	spawnImpl?: (
		command: string,
		args: string[],
		options: SpawnOptions,
	) => {
		unref?: () => void
		pid?: number
		/** Needed to catch a fork failure; without a listener Node throws in *this* process. */
		on?: (event: "error", listener: (error: Error) => void) => unknown
	}
	execPath?: string
	sleep?: (ms: number) => Promise<void>
}

export interface EnsureDaemonResult {
	/** True when this call spawned the process. */
	started: boolean
	/** True when the daemon answers /health afterwards, on this build's protocol. */
	healthy: boolean
	/** Something answered but spoke another protocol; it must be replaced, not reused. */
	incompatible?: boolean
	/** Why the spawn failed, when it did (EAGAIN, ENOENT, a sandbox refusal). */
	error?: string
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Make sure a daemon is running.
 *
 * Reuses an existing daemon rather than racing it: `daemon.lock` in the state directory is the
 * lock (the port is a second guard), and a
 * second daemon exits 0 on EADDRINUSE, so the worst case is a wasted spawn rather
 * than two watchers on one mailbox.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
	const doFetch = options.fetchImpl ?? fetch
	const found = await probeHealthDetail({ baseUrl: options.baseUrl, fetchImpl: doFetch })
	if (found.ok) {
		// Reuse only a daemon this build can talk to. An incompatible one is reported so the
		// caller can replace it, instead of being adopted and failing on the first request.
		if (apiCompatible(API_VERSION, found.apiVersion)) return { started: false, healthy: true }
		return { started: false, healthy: false, incompatible: true }
	}

	const spawn = options.spawnImpl ?? nodeSpawn
	const execPath = options.execPath ?? process.execPath
	// The port this process probed, so the child cannot pick a different one from its own env -
	// otherwise two daemons can end up on one state directory, which has no cross-process locks.
	const probedPort = (() => {
		try {
			return new URL(options.baseUrl).port
		} catch {
			return ""
		}
	})()
	// `--experimental-strip-types` only for the TypeScript entry: the published build runs
	// `dist/daemon/main.js`, and Node refuses type stripping under `node_modules` anyway.
	const args = [
		...(options.scriptPath.endsWith(".ts") ? ["--experimental-strip-types"] : []),
		options.scriptPath,
		...(probedPort ? ["--port", probedPort] : []),
		...(options.args ?? []),
	]

	// Detached with output ignored would make failures invisible: a catch-up scan could
	// fail on every boot with nothing to show for it. Append to a log file instead.
	const env = options.env ?? process.env
	const logPath = statePath(env, "daemon.log")
	let logHandle: number | undefined
	try {
		mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
		// One rotation at 5 MB: the log grows only when mail is seen, but it grows forever.
		try {
			if (statSync(logPath).size > 5 * 1024 * 1024) renameSync(logPath, `${logPath}.1`)
		} catch {
			/* no log yet, or cannot rotate - appending is still better than nothing */
		}
		logHandle = openSync(logPath, "a", 0o600)
		// An older build created it 0644; the log carries addresses and session names.
		try {
			chmodSync(logPath, 0o600)
		} catch {
			/* best effort */
		}
	} catch {
		// A read-only state dir must not stop the daemon from starting.
	}

	const child = spawn(execPath, args, {
		detached: true,
		stdio: logHandle === undefined ? "ignore" : ["ignore", logHandle, logHandle],
		env,
	} as SpawnOptions)
	// A fork failure (EAGAIN under fd pressure, a sandbox denying exec) arrives as an `error`
	// event. Without a listener Node treats it as an uncaught exception in *pi's* process: the
	// session dies while the daemon it was trying to start never existed.
	let spawnError: Error | undefined
	child.on?.("error", (error) => {
		spawnError = error
	})
	child.unref?.()
	if (logHandle !== undefined) {
		// The child holds its own copy of the descriptor.
		try {
			closeSync(logHandle)
		} catch {
			/* already closed */
		}
	}

	const sleep = options.sleep ?? defaultSleep
	const deadline = Date.now() + (options.waitMs ?? 5_000)
	while (Date.now() < deadline) {
		if (spawnError) return { started: true, healthy: false, error: spawnError.message }
		await sleep(100)
		if (await probeHealth({ baseUrl: options.baseUrl, fetchImpl: doFetch })) {
			return { started: true, healthy: true }
		}
	}
	return { started: true, healthy: false }
}

/** Default loopback base URL for the configured port. */
export function daemonBaseUrl(port: number, host = "127.0.0.1"): string {
	return `http://${host}:${port}`
}

/** SMTP transactions with inlined images are slow; be generous rather than lose the mail. */
const SEND_TIMEOUT_MS = 120_000
/** Reload tears down and re-dials IMAP, which can involve a token fetch. */
const RELOAD_TIMEOUT_MS = 120_000

export interface DaemonClientOptions {
	baseUrl: string
	token: string
	/** This machine's device name; /pending returns only this device's records. */
	device?: string
	fetchImpl?: typeof fetch
	/**
	 * Per-request ceiling. Without one, a daemon that accepts a connection and never
	 * answers leaves the caller's promise unsettled forever - and the drain it is inside
	 * then wedges every later drain in the process.
	 */
	timeoutMs?: number
}

/** Tiny typed client used by the extension and by `/mailbridge`. */
export type DaemonResult<T> = { ok: true; data: T } | { ok: false; status: number; code?: string }

export function createDaemonClient(options: DaemonClientOptions) {
	const doFetch = options.fetchImpl ?? fetch
	const deviceName = options.device ?? ""
	const headers = { authorization: `Bearer ${options.token}`, "content-type": "application/json" }

	async function call<T>(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs: number = options.timeoutMs ?? 15_000,
	): Promise<DaemonResult<T>> {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await doFetch(`${options.baseUrl}${path}`, {
				method,
				headers,
				signal: controller.signal,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
			const text = await response.text()
			if (!response.ok) {
				let code: string | undefined
				try {
					code = (JSON.parse(text) as { error?: { code?: string } }).error?.code
				} catch {
					/* non-JSON error body */
				}
				return { ok: false, status: response.status, ...(code ? { code } : {}) }
			}
			return { ok: true, data: (text ? JSON.parse(text) : {}) as T }
		} catch (error) {
			// A timeout is reported distinctly: the outcome is unknown, so callers must
			// treat it like a network failure (retry later) rather than a definite "no".
			if (error instanceof Error && error.name === "AbortError") return { ok: false, status: 0, code: "timeout" }
			return { ok: false, status: 0, code: "network" }
		} finally {
			clearTimeout(timer)
		}
	}

	return {
		health: () =>
			call<{
				ok: boolean
				mode: string
				pending: number
				lastScan?: {
					at: number
					examined: number
					persisted: number
					rejected: number
					reasons: Record<string, number>
				} | null
				configLoadedAt?: number | null
				/** The daemon's package version. Diagnostic only. */
				version?: string
				/** The wire contract it implements; absent on a build from before this field. */
				apiVersion?: number
				/** Additive features inside that contract. */
				capabilities?: string[]
				/** "connected" | "disconnected" | "unknown" */
				imap?: string
			}>("GET", "/health"),
		pending: () =>
			call<{ pending: PendingRecord[]; withheld?: number }>(
				"GET",
				`/pending?device=${encodeURIComponent(deviceName)}`,
			),
		mode: () => call<{ mode: string }>("GET", "/mode"),
		setMode: (mode: "on" | "off") => call<{ mode: string }>("POST", "/mode", { mode }),
		claim: (uid: number, instanceId: string, uidValidity?: number) =>
			call<{ ok: boolean }>("POST", "/claim", {
				uid,
				instanceId,
				...(uidValidity === undefined ? {} : { uidValidity }),
			}),
		ack: (uid: number, instanceId: string, sessionId?: string, uidValidity?: number) =>
			call<{ ok: boolean }>("POST", "/ack", {
				uid,
				instanceId,
				sessionId,
				...(uidValidity === undefined ? {} : { uidValidity }),
			}),
		register: (sessionId: string) => call<{ alreadyPending: boolean; full: boolean }>("POST", "/register", { sessionId }),
		release: (sessionId: string) => call<{ ok: boolean }>("DELETE", "/register", { sessionId }),
		// A notification can carry a few hundred KB of inlined images and the daemon awaits
		// the whole SMTP transaction, so a slow-but-healthy relay must not be cut off: the
		// generic 15 s ceiling would drop the one mail this product exists to deliver.
		send: (message: {
			/** "settle" and "decision" are exempt from the daemon's notification budget. */
			kind?: "settle" | "decision" | "notification"
			to?: string
			subject: string
			text: string
			cwd?: string
			sessionId?: string
		}) => call<{ ok: boolean }>("POST", "/send", message, SEND_TIMEOUT_MS),
		/** Re-read config and restart the watcher (after setup or auth). */
		// Includes an IMAP logout, an XOAUTH2 token fetch and a fresh dial.
		reload: () => call<{ ok: boolean; warning?: string }>("POST", "/reload", undefined, RELOAD_TIMEOUT_MS),
		/** Ask the daemon to exit, so a fresh process can load updated code. */
		shutdown: () => call<{ ok: boolean }>("POST", "/shutdown"),
		/** Liveness heartbeat; the daemon exits when every client stops pinging. */
		ping: (instanceId: string) => call<{ ok: boolean; clients: number }>("POST", "/ping", { instanceId }),
		/** Tell the daemon this session is gone. */
		bye: (instanceId: string) => call<{ ok: boolean; clients: number }>("POST", "/bye", { instanceId }),
	}
}

export type DaemonClient = ReturnType<typeof createDaemonClient>
