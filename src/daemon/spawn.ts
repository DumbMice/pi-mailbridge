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
import { loopbackFetch } from "./loopback-http.ts"
import { isUnrunnableScript } from "./script.ts"
import { API_VERSION, apiCompatible } from "./api.ts"
import { statePath } from "../store/paths.ts"

/**
 * Is this body our `/health`?
 *
 * `ok: true` alone is not enough: `{"ok":true}` is the most common health payload there is, so a
 * dev server on `daemon.port` would still be read as "our daemon, protocol 0" — replaced, and
 * POSTed `/shutdown` at — which is the misdiagnosis the discriminated probe exists to prevent.
 * Every daemon we have ever shipped also sends `mode`, and every one since `apiVersion` existed
 * sends a numeric `apiVersion`; requiring one of the three keeps an old daemon recognisable while
 * a stranger's `{"ok":true}` is not.
 */
function classifyHealth(body: unknown): { ok: boolean; apiVersion?: number; foreign?: true } {
	if (typeof body !== "object" || body === null || (body as { ok?: unknown }).ok !== true) return { ok: false, foreign: true }
	const health = body as { apiVersion?: unknown; mode?: unknown; capabilities?: unknown }
	const ours =
		typeof health.apiVersion === "number" || typeof health.mode === "string" || Array.isArray(health.capabilities)
	if (!ours) return { ok: false, foreign: true }
	return { ok: true, ...(typeof health.apiVersion === "number" ? { apiVersion: health.apiVersion } : {}) }
}

export interface ProbeOptions {
	baseUrl: string
	timeoutMs?: number
	/** Injected for tests. Defaults to `loopbackFetch`, never the ambient `fetch`. */
	fetchImpl?: typeof fetch
}

/** True when a daemon answers /health. Never throws. */
export async function probeHealth(options: ProbeOptions): Promise<boolean> {
	const health = await probeHealthDetail(options)
	return health.ok
}

/**
 * `/health`, with what actually answered.
 *
 * Three outcomes, and they are different problems: nothing answered (`ok: false`); our daemon
 * answered and speaks some protocol (`ok: true`, maybe an `apiVersion`); or *something else*
 * answered on that port (`foreign: true`). Collapsing the third into the second made a dev server
 * squatting `daemon.port` look like "the daemon is on protocol 0", so the session announced a
 * protocol mismatch and POSTed `/shutdown` at it once a minute.
 */
export async function probeHealthDetail(options: ProbeOptions): Promise<{ ok: boolean; apiVersion?: number; foreign?: true }> {
	const doFetch = options.fetchImpl ?? loopbackFetch
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 750)
	try {
		const response = await doFetch(`${options.baseUrl}/health`, { signal: controller.signal })
		if (!response.ok) {
			// `500` is the one status our own /health can emit (a handler failure), so it stays
			// "nothing usable". Everything else from an unauthenticated endpoint - 3xx, 401, 404,
			// 502/503 from a gateway - is somebody else's service: folding those into "nothing
			// answered" spawns a daemon every backoff, and the child exits 0 on EADDRINUSE against a
			// port nobody names.
			return response.status === 500 ? { ok: false } : { ok: false, foreign: true }
		}
		let body: unknown
		try {
			body = await response.json()
		} catch {
			return { ok: false, foreign: true }
		}
		return classifyHealth(body)
	} catch (error) {
		// A reply too large to be ours is the same story as a wrong-shaped one.
		if (error instanceof Error && error.name === "BadResponseError") return { ok: false, foreign: true }
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
	/** The protocol the answering daemon spoke, when one answered and was not reused. */
	apiVersion?: number
	/** Something answers on the port but is not this daemon: a wrong `daemon.port`. */
	foreign?: boolean
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
	const doFetch = options.fetchImpl ?? loopbackFetch
	const found = await probeHealthDetail({ baseUrl: options.baseUrl, fetchImpl: doFetch })
	if (found.ok) {
		// Reuse only a daemon this build can talk to. An incompatible one is reported so the
		// caller can replace it, instead of being adopted and failing on the first request.
		if (apiCompatible(API_VERSION, found.apiVersion)) return { started: false, healthy: true }
		return { started: false, healthy: false, incompatible: true, apiVersion: found.apiVersion }
	}
	if (found.foreign) {
		// Answering, but not us: a different service owns daemon.port. Spawning would collide with
		// it and the "protocol mismatch" story would send the user to `/mailbridge restart` forever.
		return { started: false, healthy: false, foreign: true }
	}

	if (isUnrunnableScript(options.scriptPath) && (options.spawnImpl ?? nodeSpawn) === nodeSpawn) {
		// Nothing to spawn, and spawning it anyway would only produce a Node error in a log file.
		return { started: false, healthy: false, error: "this install has no compiled build (dist/); reinstall the package" }
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

/**
 * `http://host:port`, bracket-ready. An IPv6 literal must be bracketed to parse at all
 * (`new URL("http://::1:4177")` throws), and `daemon.host` accepts the bare form, so the bracket
 * belongs here rather than in every caller.
 */
export function daemonBaseUrl(port: number, host = "127.0.0.1"): string {
	// `host` reaches here from config, but also from a caller that read it elsewhere; an empty value
	// used to build `http://:4177`, which does not parse.
	const bare = (host || "127.0.0.1").trim().replace(/^\[|]$/g, "")
	return bare.includes(":") ? `http://[${bare}]:${port}` : `http://${bare}:${port}`
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
	const doFetch = options.fetchImpl ?? loopbackFetch
	const deviceName = options.device ?? ""
	const headers = { authorization: `Bearer ${options.token}`, "content-type": "application/json" }

	async function call<T>(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs: number = options.timeoutMs ?? 15_000,
		/**
		 * Most endpoints answer `{ok: true, …}`; `/mode`, `/pending` and `/register` do not, and are
		 * checked by shape instead. Verified against `daemon/service.ts`, not guessed: a wrong guess
		 * here turns a working endpoint into `bad_response`.
		 */
		validate: (body: Record<string, unknown>) => boolean = (body) => body.ok === true,
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
			let parsed: unknown
			try {
				parsed = JSON.parse(text)
			} catch {
				// Not JSON - and every daemon reply is JSON, including `{}`. An empty body lands
				// here too: it means something else is answering on the port (a dev server), which
				// is a wrong-port problem. Reporting success with `{}` would let `claim`/`ack`/`send`
				// "succeed" without the daemon having done anything; reporting "network" would point
				// the user at `pi update` while the daemon is up.
				return { ok: false, status: response.status, code: "bad_response" }
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				// A JSON scalar or array is not a reply of ours either.
				return { ok: false, status: response.status, code: "bad_response" }
			}
			if (!validate(parsed as Record<string, unknown>)) {
				// Valid JSON, wrong envelope: a squatter that answers `{}` to everything would make
				// `claim`/`ack` look confirmed without the daemon having journaled anything.
				return { ok: false, status: response.status, code: "bad_response" }
			}
			return { ok: true, data: parsed as T }
		} catch (error) {
			// A timeout is reported distinctly: the outcome is unknown, so callers must
			// treat it like a network failure (retry later) rather than a definite "no".
			if (error instanceof Error && error.name === "AbortError") return { ok: false, status: 0, code: "timeout" }
			// A reply that is too large to be ours is a wrong-port problem, not a dead daemon.
			if (error instanceof Error && error.name === "BadResponseError") return { ok: false, status: 0, code: "bad_response" }
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
				undefined,
				undefined,
				(body) => Array.isArray(body.pending),
			),
		// The endpoints whose contract has no `ok`: `/mode` answers `{ mode }`, `/pending` answers
		// `{ pending, withheld }`. They are checked by shape, so a squatter's `{}` is not mistaken
		// for either - `pending.data.pending.length` would otherwise throw.
		mode: (instanceId?: string) =>
			call<{ mode: string; global?: string; session?: string; globalUpdatedAt?: number }>(
				"GET",
				`/mode${instanceId ? `?instanceId=${encodeURIComponent(instanceId)}` : ""}`,
				undefined,
				undefined,
				(body) => typeof body.mode === "string",
			),
		/**
		 * `scope: "session"` turns this session's channel off (or back on) without touching the global
		 * switch. A global write clears every override, so it really is "every session".
		 */
		setMode: (
			mode: "on" | "off",
			options: { scope?: "session" | "global"; instanceId?: string } = {},
		) =>
			call<{ mode: string; global?: string; session?: string; globalUpdatedAt?: number }>(
				"POST",
				"/mode",
				{
					mode,
					...(options.scope ? { scope: options.scope } : {}),
					...(options.instanceId ? { instanceId: options.instanceId } : {}),
				},
				undefined,
				(body) => typeof body.mode === "string",
			),
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
		// `/register` answers `{alreadyPending, full}` - no `ok` - so it is shape-checked. Getting this
		// wrong is not cosmetic: the caller reads `!reserved.ok` as "another decision is outstanding",
		// so every request_decision would refuse to mail *and* leak the slot the daemon reserved.
		register: (sessionId: string) =>
			call<{ alreadyPending: boolean; full: boolean }>(
				"POST",
				"/register",
				{ sessionId },
				undefined,
				(body) => typeof body.alreadyPending === "boolean" && typeof body.full === "boolean",
			),
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
