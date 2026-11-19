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
import { cleanDiagnostic } from "../core/diagnostics.ts"
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
	/** `uncertain`: the launch may have produced a session we cannot identify; recovery must look, not forget. */
	| { ok: false; reason: string; detail: string; uncertain?: boolean }

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
		// The request id lives in the session's own environment: after a tmux server restart a `$N` *and*
		// the display name can both be reused, and this is the only proof the session is ours.
		"-e",
		`PI_MAILBRIDGE_REQUEST=${plan.requestId}`,
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

/** The request id stored in the session's environment: the ownership proof that survives an id reuse. */
export async function readOwnershipMarker(
	tmuxSessionId: string,
	deps: Pick<SpawnDeps, "exec"> & { socket?: string } = {},
): Promise<string | undefined> {
	const exec = deps.exec ?? defaultExec
	const read = await exec(["tmux", "-L", deps.socket ?? DEFAULT_SOCKET, "show-environment", "-t", tmuxSessionId, "PI_MAILBRIDGE_REQUEST"])
	if (read.code !== 0) return undefined
	const line = read.stdout.trim()
	const value = line.startsWith("PI_MAILBRIDGE_REQUEST=") ? line.slice("PI_MAILBRIDGE_REQUEST=".length) : ""
	return value || undefined
}

/**
 * Kill only if the session's environment still names this request — evaluated *inside* the tmux server by a
 * single `if-shell`, so a restart cannot swap the target between the check and the kill: the command and its
 * condition run in the same server process, and a server that dies takes the command with it.
 */
export function buildKillIfOwnedArgv(tmuxSessionId: string, requestId: string, socket = DEFAULT_SOCKET): string[] {
	const marker = `$(tmux -L ${socket} show-environment -t '${tmuxSessionId}' PI_MAILBRIDGE_REQUEST 2>/dev/null)`
	const test = `test "${marker}" = "PI_MAILBRIDGE_REQUEST=${requestId}"`
	return ["tmux", "-L", socket, "if-shell", "-t", tmuxSessionId, test, `kill-session -t '${tmuxSessionId}'`]
}

/**
 * Did the server *establish* that a session is gone, or could it not answer?
 *
 * `has-session` exits nonzero for both. Treating the second as absence marks a live session stopped, or
 * deletes the evidence for a child that cleanup never proved it killed.
 */
export function sessionAbsent(result: { code: number; stdout: string; stderr: string }): boolean {
	if (result.code === 0) return false
	// A socket that does not exist is absence; one we may not read is not. tmux says the first as
	// "error connecting … (No such file or directory)" and the second as "Permission denied".
	return /no such session|no server( running)?|can't find session|no sessions|no such file or directory/i.test(
		`${result.stderr}${result.stdout}`,
	)
}

/** `#{session_name}` for one id: the ownership check, without relying on the numeric id. */
export function buildNameArgv(tmuxSessionId: string, socket = DEFAULT_SOCKET): string[] {
	return ["tmux", "-L", socket, "display-message", "-p", "-t", tmuxSessionId, "#{session_name}"]
}

export function buildListArgv(socket = DEFAULT_SOCKET): string[] {
	// A literal space, not `\t`: tmux does not expand escapes in `-F`, so a `\t` came back as the two
	// characters `\` `t` and the parser produced ids like `$0\tname` with an empty name - which made every
	// sweep believe no recorded session was running.
	return ["tmux", "-L", socket, "list-sessions", "-F", "#{session_id} #{session_name}"]
}

/** A pane's text, capped and stripped of control characters, for a refusal mail. */
export function diagnosticsFrom(pane: string): string {
	// Pane text keeps its CRLF, as it always did; only the cap applies.
	return cleanDiagnostic(pane, MAX_DIAGNOSTIC_CHARS, false)
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

	/**
	 * Kill the session *we* created, if it is still ours.
	 *
	 * A name is reusable: if the process that created it exited and a new starter (or a person) reused the
	 * name, killing by name alone would stop a stranger. The request id in the environment is the proof.
	 */
	const kill = async (): Promise<"killed" | "not-ours" | "unknown"> => {
		const id = await exec(buildSessionIdArgv(plan.tmuxId, socket))
		if (id.code !== 0) return "unknown"
		const target = id.stdout.trim()
		if (!target.startsWith("$")) return "unknown"
		const removed = await exec(buildKillIfOwnedArgv(target, plan.requestId, socket))
		if (removed.code !== 0) return "unknown"
		// `if-shell` succeeds whether or not its condition matched, so ask the server afterwards. Still there
		// means the marker did not match (or could not be read): our cleanup killed nothing, and whether that
		// session is ours is unresolved.
		const still = await exec(["tmux", "-L", socket, "has-session", "-t", target])
		if (still.code === 0) return "not-ours"
		return sessionAbsent(still) ? "killed" : "unknown"
	}

	for (;;) {
		const marker = readMarker(plan.readyFile, readFile)
		if (marker) {
			if (marker.ok !== true) {
				const cleaned = await kill()
				return {
					ok: false,
					reason: "unready",
					detail: marker.error ?? "the bootstrap could not deliver the prompt",
					// A cleanup that could not establish termination may have left our child running.
					...(cleaned === "unknown" || cleaned === "not-ours" ? { uncertain: true } : {}),
				}
			}
			// The marker is a claim by our own code; the session must still exist.
			const id = await exec(buildSessionIdArgv(plan.tmuxId, socket))
			const tmuxSessionId = id.stdout.trim()
			if (id.code !== 0 || !tmuxSessionId.startsWith("$")) {
				return { ok: false, reason: "no-session", detail: "the bootstrap reported ready but no tmux session is running" }
			}
			// Ready is a claim about *a* session; the marker says it is ours.
			const owner = await readOwnershipMarker(tmuxSessionId, { exec, socket })
			if (owner !== plan.requestId) {
				return {
					ok: false,
					reason: "not-ours",
					detail: "the ready session carries another request's marker",
					uncertain: true,
				}
			}
			return { ok: true, tmuxSessionId }
		}
		if (now() >= deadline) {
			const pane = await exec(["tmux", "-L", socket, "capture-pane", "-p", "-t", plan.tmuxId])
			const cleaned = await kill()
			const detail = diagnosticsFrom(pane.stdout)
			return {
				ok: false,
				reason: "unready",
				detail: detail || "the session did not report ready in time",
				...(cleaned === "unknown" || cleaned === "not-ours" ? { uncertain: true } : {}),
			}
		}
		await sleep(pollMs)
	}
}

/** Stop a session, but only if the id still matches what we recorded. */
export async function stopSession(
	tmuxSessionId: string,
	deps: (Pick<SpawnDeps, "exec"> & { socket?: string; expectedName?: string; expectedRequestId?: string }) | undefined = {},
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
	// The name can be reused too. The request id in the session's environment is the marker that a restart
	// cannot counterfeit, so the final step is a *conditional* kill: the check and the kill run inside one
	// tmux server, and a restart takes the command with it instead of retargeting it at a stranger.
	if (deps.expectedRequestId !== undefined) {
		const marked = await readOwnershipMarker(tmuxSessionId, { exec, socket })
		if (marked === undefined || marked !== deps.expectedRequestId) {
			return {
				ok: false,
				reason: "not-ours",
				detail:
					marked === undefined
						? `${tmuxSessionId} carries no ownership marker`
						: `${tmuxSessionId} belongs to request ${marked}, not ${deps.expectedRequestId}`,
			}
		}
		const conditional = await exec(buildKillIfOwnedArgv(tmuxSessionId, deps.expectedRequestId, socket))
		if (conditional.code !== 0) {
			return { ok: false, reason: "kill-failed", detail: diagnosticsFrom(conditional.stderr || conditional.stdout) || "tmux refused the conditional kill" }
		}
		const still = await exec(["tmux", "-L", socket, "has-session", "-t", tmuxSessionId])
		if (still.code === 0) {
			return { ok: false, reason: "not-ours", detail: `${tmuxSessionId} did not match its ownership marker; nothing was killed` }
		}
		if (!sessionAbsent(still)) {
			// The server could not tell us: do not record a session as stopped on that basis.
			return { ok: false, reason: "unknown", detail: "tmux did not answer whether the session is gone" }
		}
		return { ok: true }
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
	// Only the known absence diagnostics mean "none". A permission failure is "could not look", and treating
	// it as empty would sweep every owned session to ended.
	if (listed.code !== 0) {
		const text = `${listed.stderr}${listed.stdout}`
		// A socket that does not exist is absence; one we may not read is not. tmux spells the first as
		// "error connecting … (No such file or directory)" and the second as "Permission denied".
		return /no server( running)?|no sessions|no such file or directory/i.test(text) ? [] : undefined
	}
	return listed.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			// Split at the first space: a session name may itself contain spaces ("probe one").
			const cut = line.indexOf(" ")
			return cut === -1 ? { id: line, name: "" } : { id: line.slice(0, cut), name: line.slice(cut + 1) }
		})
		.filter((entry) => entry.id.startsWith("$"))
}
