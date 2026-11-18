// Spawning a detached pi session in tmux, and stopping it again.
//
// Three rules make this safe, and each of them was learned the hard way:
//
//   1. **No prompt in argv.** pi parses positional prompts as options, reads `@path` as a file after `--`,
//      and dispatches `/cmd`; the prompt travels in a file and is sent by the bootstrap extension (see
//      bootstrap.ts). The argv builder below is pure so a test can assert the prompt never appears in it.
//   2. **A dedicated tmux socket.** `-L pimail` cannot touch the operator's interactive sessions, and
//      `stop`/`list` address only ours.
//   3. **Verify, don't assume.** tmux returning 0 does not mean pi started: a bad model or missing
//      credential exits immediately. Success is the readiness marker the bootstrap writes, plus a live
//      session; a failure is killed and reported with the captured pane text.

import { existsSync, readFileSync } from "node:fs"
import { execFile as nodeExecFile } from "node:child_process"

export const DEFAULT_SOCKET = "pimail"
/** How long to wait for the bootstrap's readiness marker before calling the start a failure. */
// Longer than the bootstrap's own acceptance window: the marker is written on `turn_start` or on that
// timeout, and the spawn must outlast it to report the reason instead of "no marker".
export const READY_TIMEOUT_MS = 30_000
export const READY_POLL_MS = 100
/** Captured pane text is a diagnostic, not a transcript: cap it and strip control characters. */
const MAX_DIAGNOSTIC_CHARS = 2_000

export interface SpawnPlan {
	/** tmux session name; also the pi session id is separate, so a historical name cannot be resumed. */
	tmuxId: string
	/** A fresh pi session id. `--session-id` would resume an existing session with the same id. */
	piSessionId: string
	/** The human-readable name (`-n`), which may be reused. */
	displayName: string
	cwd: string
	model?: string
	thinking?: string
	/** The per-request prompt file (0600) the bootstrap reads and removes. */
	promptFile: string
	/** Where the bootstrap writes its readiness marker. */
	readyFile: string
	requestId: string
	/** `on`/`off` for the started session's email mode; omitted when the starter does not set it. */
	emailMode?: "on" | "off"
	/** Absolute path to the compiled bootstrap extension. */
	bootstrapPath: string
	socket?: string
}

export interface ExecResult {
	code: number
	stdout: string
	stderr: string
}

export interface SpawnDeps {
	exec?: (argv: string[]) => Promise<ExecResult>
	readFile?: (path: string) => string | undefined
	sleep?: (ms: number) => Promise<void>
	now?: () => number
	readyTimeoutMs?: number
	readyPollMs?: number
}

export type SpawnResult =
	| { ok: true; tmuxSessionId: string }
	| { ok: false; reason: string; detail: string }

function defaultExec(argv: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		nodeExecFile(argv[0]!, argv.slice(1), { timeout: 30_000, encoding: "utf8" }, (error, stdout, stderr) => {
			resolve({
				code: error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? (error as unknown as { code: number }).code : 1) : 0,
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? "") || (error ? String((error as Error).message) : ""),
			})
		})
	})
}

/** `KEY=value` argv elements for the `env` wrapper; values never become a shell string. */
function envAssignments(plan: SpawnPlan): string[] {
	const env: string[] = [
		`PI_MAILBRIDGE_START_PROMPT=${plan.promptFile}`,
		`PI_MAILBRIDGE_START_READY=${plan.readyFile}`,
		`PI_MAILBRIDGE_START_REQUEST=${plan.requestId}`,
	]
	if (plan.emailMode) env.push(`PI_MAILBRIDGE_SESSION_MODE=${plan.emailMode}`)
	return env
}

/**
 * The exact argv. Pure, and asserted element by element by the tests: the prompt is absent, the socket is
 * ours, and the session identity is the fresh id rather than the human name.
 */
export function buildSpawnArgv(plan: SpawnPlan): string[] {
	const socket = plan.socket ?? DEFAULT_SOCKET
	return [
		"tmux",
		"-L",
		socket,
		"new-session",
		"-d",
		"-s",
		plan.tmuxId,
		"-c",
		plan.cwd,
		"--",
		"env",
		...envAssignments(plan),
		"pi",
		"-e",
		plan.bootstrapPath,
		"-n",
		plan.displayName,
		"--session-id",
		plan.piSessionId,
		...(plan.model ? ["--model", plan.model] : []),
		...(plan.thinking ? ["--thinking", plan.thinking] : []),
	]
}

/** argv for asking tmux for a session's immutable id (`$3`), or something provably not ours. */
export function buildSessionIdArgv(tmuxId: string, socket = DEFAULT_SOCKET): string[] {
	return ["tmux", "-L", socket, "display-message", "-p", "-t", tmuxId, "#{session_id}"]
}

export function buildKillArgv(tmuxSessionId: string, socket = DEFAULT_SOCKET): string[] {
	// Kill by the immutable id, never by the reusable name: a stale name could belong to a session the
	// operator started by hand.
	return ["tmux", "-L", socket, "kill-session", "-t", tmuxSessionId]
}

/** `#{session_name}` for one id: the ownership check, without relying on the numeric id. */
export function buildNameArgv(tmuxSessionId: string, socket = DEFAULT_SOCKET): string[] {
	return ["tmux", "-L", socket, "display-message", "-p", "-t", tmuxSessionId, "#{session_name}"]
}

export function buildListArgv(socket = DEFAULT_SOCKET): string[] {
	return ["tmux", "-L", socket, "list-sessions", "-F", "#{session_id}\t#{session_name}"]
}

/** A pane's text, capped and stripped of control characters, for a refusal mail. */
export function diagnosticsFrom(pane: string): string {
	const clean = pane
		// eslint-disable-next-line no-control-regex
		.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
		.trim()
	return clean.length > MAX_DIAGNOSTIC_CHARS ? `${clean.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : clean
}

interface ReadyMarker {
	ok?: boolean
	requestId?: string
	error?: string
	bytes?: number
}

function readMarker(path: string, readFile: (p: string) => string | undefined): ReadyMarker | undefined {
	const text = readFile(path)
	if (text === undefined) return undefined
	try {
		const parsed = JSON.parse(text) as ReadyMarker
		return typeof parsed === "object" && parsed !== null ? parsed : undefined
	} catch {
		return undefined
	}
}

/**
 * Spawn, then wait for the bootstrap to say it delivered the prompt.
 *
 * A timeout, a marker with `ok: false`, or a missing tmux session all end the same way: kill what we
 * created and report why. The caller records the outcome; this function does not write state.
 */
export async function spawnSession(plan: SpawnPlan, deps: SpawnDeps = {}): Promise<SpawnResult> {
	const exec = deps.exec ?? defaultExec
	const readFile = deps.readFile ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined))
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const now = deps.now ?? Date.now
	const deadline = now() + (deps.readyTimeoutMs ?? READY_TIMEOUT_MS)
	const pollMs = deps.readyPollMs ?? READY_POLL_MS
	const socket = plan.socket ?? DEFAULT_SOCKET

	const created = await exec(buildSpawnArgv(plan))
	if (created.code !== 0) {
		const detail = diagnosticsFrom(created.stderr || created.stdout)
		return { ok: false, reason: "spawn-failed", detail: detail || "tmux could not start the session" }
	}

	const kill = async (): Promise<void> => {
		const id = await exec(buildSessionIdArgv(plan.tmuxId, socket))
		if (id.code === 0) await exec(buildKillArgv(id.stdout.trim(), socket))
	}

	for (;;) {
		const marker = readMarker(plan.readyFile, readFile)
		if (marker) {
			if (marker.ok !== true) {
				await kill()
				return { ok: false, reason: "unready", detail: marker.error ?? "the bootstrap could not deliver the prompt" }
			}
			// The marker is a claim by our own code; the session must still exist.
			const id = await exec(buildSessionIdArgv(plan.tmuxId, socket))
			const tmuxSessionId = id.stdout.trim()
			if (id.code !== 0 || !tmuxSessionId.startsWith("$")) {
				return { ok: false, reason: "no-session", detail: "the bootstrap reported ready but no tmux session is running" }
			}
			return { ok: true, tmuxSessionId }
		}
		if (now() >= deadline) {
			const pane = await exec(["tmux", "-L", socket, "capture-pane", "-p", "-t", plan.tmuxId])
			await kill()
			const detail = diagnosticsFrom(pane.stdout)
			return { ok: false, reason: "unready", detail: detail || "the session did not report ready in time" }
		}
		await sleep(pollMs)
	}
}

/** Stop a session, but only if the id still matches what we recorded. */
export async function stopSession(
	tmuxSessionId: string,
	deps: (Pick<SpawnDeps, "exec"> & { socket?: string; expectedName?: string }) | undefined = {},
): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> {
	const exec = deps.exec ?? defaultExec
	const socket = deps.socket ?? DEFAULT_SOCKET
	if (!tmuxSessionId.startsWith("$")) {
		return { ok: false, reason: "bad-session-id", detail: `${tmuxSessionId} is not a tmux session id` }
	}
	// `$N` is only unique while the server lives: after a restart it can name a different session. The name
	// we chose is the ownership marker, so it is verified before anything is killed.
	if (deps.expectedName !== undefined) {
		const name = await exec(buildNameArgv(tmuxSessionId, socket))
		if (name.code !== 0) {
			return { ok: false, reason: "gone", detail: "the session is no longer running" }
		}
		if (name.stdout.trim() !== deps.expectedName) {
			return {
				ok: false,
				reason: "not-ours",
				detail: `${tmuxSessionId} is now ${name.stdout.trim()}, not ${deps.expectedName}`,
			}
		}
	}
	const killed = await exec(buildKillArgv(tmuxSessionId, socket))
	if (killed.code !== 0) {
		const detail = diagnosticsFrom(killed.stderr || killed.stdout)
		return { ok: false, reason: "kill-failed", detail: detail || "tmux refused to kill it" }
	}
	return { ok: true }
}

/**
 * Live sessions on our socket, as `{ id, name }`.
 *
 * `[]` means the server is simply not running (tmux exits 1 for that). A failure we cannot interpret returns
 * `undefined`, because a timed-out or broken `tmux` must not be read as "every session ended".
 */
export async function listSessions(
	deps: Pick<SpawnDeps, "exec"> & { socket?: string } = {},
): Promise<{ id: string; name: string }[] | undefined> {
	const exec = deps.exec ?? defaultExec
	const listed = await exec(buildListArgv(deps.socket ?? DEFAULT_SOCKET))
	if (listed.code !== 0) return /no server( running)?|no sessions|error connecting/i.test(`${listed.stderr}${listed.stdout}`) ? [] : undefined
	return listed.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [id = "", name = ""] = line.split("\t")
			return { id, name }
		})
		.filter((entry) => entry.id.startsWith("$"))
}
