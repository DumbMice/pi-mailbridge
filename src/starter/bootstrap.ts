// The bootstrap: the only code that is allowed to turn a mail body into a session's first message.
//
// It exists because pi's initial prompt cannot carry untrusted text safely. A positional prompt is parsed
// as CLI options (`--continue`), `@path` arguments after `--` are read as *files*, and any prompt starting
// with `/` is dispatched as an extension command - so a mail saying `/mailbridge setup …` would have run a
// command in the session it started. `pi.sendUserMessage()` without `expandPromptTemplates` is the
// documented way to reach the model as plain text; this module is the smallest possible caller of it.
//
// The prompt travels in a file, named by an environment variable, one file per request (two starts sharing
// one file was a real failure: the first unlinked it and the second had nothing). The file is removed as
// soon as it is read, and a readiness marker is written so the starter learns the outcome from code it
// ships rather than by scraping a terminal.
//
// It never throws: `session_start` is inside pi's own event loop, and an exception there left a session
// idle with no message and nothing reported. A missing or oversized prompt produces a diagnostic message
// and a `ok: false` marker instead.

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"

/** The small part of pi's extension API this module uses. Typed locally: no import means no coupling. */
export interface BootstrapPi {
	on(event: "session_start" | "turn_start", handler: () => unknown): void
	/** Deliberately called without `expandPromptTemplates`: that option is what dispatches commands. */
	sendUserMessage(text: string): void
}

export interface BootstrapEnv {
	PI_MAILBRIDGE_START_PROMPT?: string
	PI_MAILBRIDGE_START_READY?: string
	PI_MAILBRIDGE_START_REQUEST?: string
	PI_MAILBRIDGE_START_MAX_BYTES?: string
	[key: string]: string | undefined
}

/** A prompt file larger than this is not ours; the grammar caps prompts far below it. */
const DEFAULT_MAX_BYTES = 1_000_000

/** How long pi has to start a turn before the prompt counts as not accepted. */
const ACCEPT_TIMEOUT_MS = 20_000

export interface BootstrapOutcome {
	ok: boolean
	requestId?: string
	bytes?: number
	/** Diagnostic text sent to the model instead of the prompt, when it could not be read. */
	error?: string
}

function writeMarker(env: BootstrapEnv, outcome: BootstrapOutcome): void {
	const target = env.PI_MAILBRIDGE_START_READY
	if (!target) return
	try {
		writeFileSync(target, JSON.stringify({ ...outcome, at: Date.now() }), { mode: 0o600 })
	} catch {
		/* the starter treats a missing marker as refused; nothing else to do from here */
	}
}

/** Remove the prompt file whether or not it was usable: it is a secret-bearing temp file. */
function consume(file: string | undefined): void {
	if (!file) return
	try {
		unlinkSync(file)
	} catch {
		/* already gone */
	}
}

/**
 * Read the prompt exactly once, or explain why not. Exported so the behaviour can be tested without pi.
 */
export function readPromptFile(env: BootstrapEnv): { ok: true; text: string; bytes: number } | { ok: false; error: string } {
	const file = env.PI_MAILBRIDGE_START_PROMPT
	if (!file) return { ok: false, error: "no prompt file was provided" }
	const max = Number(env.PI_MAILBRIDGE_START_MAX_BYTES ?? DEFAULT_MAX_BYTES)
	try {
		const size = statSync(file).size
		if (!Number.isFinite(max) || max <= 0 ? size > DEFAULT_MAX_BYTES : size > max) {
			return { ok: false, error: `the prompt file is too large (${size} bytes)` }
		}
		const text = readFileSync(file, "utf8")
		return { ok: true, text, bytes: Buffer.byteLength(text) }
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		return { ok: false, error: code === "ENOENT" ? "the prompt file is missing" : `the prompt file could not be read (${code ?? "error"})` }
	}
}

/** Wire the bootstrap into an extension. Exported for tests; the default export is what pi loads. */
export function installBootstrap(pi: BootstrapPi, env: BootstrapEnv = process.env): void {
	pi.on("session_start", () => {
		// `/reload` emits another session_start. The marker means this request was already delivered, so a
		// second run must neither re-inject a diagnostic nor claim readiness again - the prompt file is gone.
		const ready = env.PI_MAILBRIDGE_START_READY
		if (ready && existsSync(ready)) return
		const requestId = env.PI_MAILBRIDGE_START_REQUEST
		const prompt = readPromptFile(env)
		consume(env.PI_MAILBRIDGE_START_PROMPT)

		if (!prompt.ok) {
			const diagnostic = `[pi-mailbridge: this session was started by mail, but ${prompt.error}; ask the starter to send it again]`
			try {
				pi.sendUserMessage(diagnostic)
			} catch {
				/* if even that fails, the marker below is all we have */
			}
			writeMarker(env, { ok: false, ...(requestId ? { requestId } : {}), error: prompt.error })
			return
		}

		try {
			// `sendUserMessage` returns before pi has accepted the turn, and pi swallows a rejected prompt
			// (missing credentials) internally. Readiness therefore waits for the observable `turn_start`:
			// a live but idle session reported as "started" is the failure this prevents.
			let accepted = false
			pi.on("turn_start", () => {
				accepted = true
				writeMarker(env, { ok: true, ...(requestId ? { requestId } : {}), bytes: prompt.bytes })
			})
			pi.sendUserMessage(prompt.text)
			setTimeout(() => {
				if (accepted) return
				writeMarker(env, {
					ok: false,
					...(requestId ? { requestId } : {}),
					error: "pi did not start a turn for the prompt (missing credentials?)",
				})
			}, ACCEPT_TIMEOUT_MS)
		} catch (error) {
			writeMarker(env, { ok: false, ...(requestId ? { requestId } : {}), error: (error as Error).message })
		}
	})
}

export default function (pi: BootstrapPi): void {
	installBootstrap(pi)
}
