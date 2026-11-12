// Daemon supervision from the extension side.
//
// The extension must never assume a daemon is running: a session can start on a
// freshly booted machine. `ensureDaemon` probes /health and, if nothing answers,
// spawns the daemon detached so it outlives this pi session.
//
// Detached, with output appended to daemon.log (not stdio:ignore: a silent daemon made the
// catch-up failures invisible). The daemon owns the mailbox and must outlive the
// process that started it so another session (or the phone) can still be served. It is not
// immortal: it exits once every session has stopped pinging - see `daemon.exitWhenIdle`.

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"

import type { PendingRecord } from "../store/pending-store.ts"
import { statePath } from "../store/paths.ts"

export interface ProbeOptions {
	baseUrl: string
	timeoutMs?: number
	/** Injected for tests. Defaults to global fetch. */
	fetchImpl?: typeof fetch
}

/** True when a daemon answers /health. Never throws. */
export async function probeHealth(options: ProbeOptions): Promise<boolean> {
	const doFetch = options.fetchImpl ?? fetch
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 750)
	try {
		const response = await doFetch(`${options.baseUrl}/health`, { signal: controller.signal })
		return response.ok
	} catch {
		return false
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
	spawnImpl?: (command: string, args: string[], options: SpawnOptions) => { unref?: () => void; pid?: number }
	execPath?: string
	sleep?: (ms: number) => Promise<void>
}

export interface EnsureDaemonResult {
	/** True when this call spawned the process. */
	started: boolean
	/** True when the daemon answers /health afterwards. */
	healthy: boolean
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Make sure a daemon is running.
 *
 * Reuses an existing daemon rather than racing it: the port is the lock, and a
 * second daemon exits 0 on EADDRINUSE, so the worst case is a wasted spawn rather
 * than two watchers on one mailbox.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
	const doFetch = options.fetchImpl ?? fetch
	if (await probeHealth({ baseUrl: options.baseUrl, fetchImpl: doFetch })) {
		return { started: false, healthy: true }
	}

	const spawn = options.spawnImpl ?? nodeSpawn
	const execPath = options.execPath ?? process.execPath
	const args = ["--experimental-strip-types", options.scriptPath, ...(options.args ?? [])]

	// Detached with output ignored would make failures invisible: a catch-up scan could
	// fail on every boot with nothing to show for it. Append to a log file instead.
	const env = options.env ?? process.env
	const logPath = statePath(env, "daemon.log")
	let logHandle: number | undefined
	try {
		mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
		logHandle = openSync(logPath, "a", 0o600)
	} catch {
		// A read-only state dir must not stop the daemon from starting.
	}

	const child = spawn(execPath, args, {
		detached: true,
		stdio: logHandle === undefined ? "ignore" : ["ignore", logHandle, logHandle],
		env,
	} as SpawnOptions)
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
		health: () => call<{ ok: boolean; mode: string; pending: number }>("GET", "/health"),
		pending: () => call<{ pending: PendingRecord[] }>("GET", "/pending"),
		mode: () => call<{ mode: string }>("GET", "/mode"),
		setMode: (mode: "on" | "off") => call<{ mode: string }>("POST", "/mode", { mode }),
		claim: (uid: number, instanceId: string) => call<{ ok: boolean }>("POST", "/claim", { uid, instanceId }),
		ack: (uid: number, instanceId: string, sessionId?: string) =>
			call<{ ok: boolean }>("POST", "/ack", { uid, instanceId, sessionId }),
		register: (sessionId: string) => call<{ alreadyPending: boolean; full: boolean }>("POST", "/register", { sessionId }),
		release: (sessionId: string) => call<{ ok: boolean }>("DELETE", "/register", { sessionId }),
		// A notification can carry a few hundred KB of inlined images and the daemon awaits
		// the whole SMTP transaction, so a slow-but-healthy relay must not be cut off: the
		// generic 15 s ceiling would drop the one mail this product exists to deliver.
		send: (message: { to?: string; subject: string; text: string; cwd?: string; sessionId?: string }) =>
			call<{ ok: boolean }>("POST", "/send", message, SEND_TIMEOUT_MS),
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
