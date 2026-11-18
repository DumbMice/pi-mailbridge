// The deterministic grammar for a starter request.
//
// A mail body is a `key: value` block (cwd, model, thinking, name, prompt, parse) or, for the two
// commands, `stop:`/`list:`. Three states, never a bag of merged values:
//
//   complete    every required field is present and plausible   -> spawn
//   incomplete  a field is missing that the agent parse may fill -> stage B, or refuse
//   invalid     an explicit value is wrong, or a key is unknown  -> refuse, say which
//
// Why three and not two: an *explicit but wrong* value must never be repaired by an agent, and a
// *missing* one must never be silently defaulted when the operator clearly meant to set it. Merging
// defaults first is exactly how those two become indistinguishable.
//
// The parse is deliberately strict and boring: no inline comments, no quoting, one block, block-scalar
// prompt. Quoted history and the signature are stripped by the caller (the existing reply parser), so
// this sees only what the human typed.

export type RequestKind = "start" | "stop" | "list"

export interface StartFields {
	cwd?: string
	model?: string
	thinking?: string
	name?: string
	prompt?: string
	/** `parse: agent` asks for stage B even when stage A is complete. */
	parse: "agent" | "auto"
}

export interface ParsedRequest {
	kind: RequestKind
	fields: StartFields
	/** The target of `stop:`; `all` is allowed and resolved against the journal by the caller. */
	stopTarget?: string
}

export interface GrammarError {
	/** Stable code for the refusal mail and the tests. */
	code: string
	detail: string
}

export type GrammarResult =
	| { state: "complete"; request: ParsedRequest }
	| { state: "incomplete"; request: ParsedRequest; missing: ("cwd" | "prompt")[] }
	| { state: "invalid"; errors: GrammarError[] }

const KEYS = ["cwd", "model", "thinking", "name", "prompt", "parse", "stop", "list"] as const
type Key = (typeof KEYS)[number]

export const KNOWN_THINKING: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

/**
 * Split the body into its key block and the remainder.
 *
 * The block runs from the first line to the first blank line (or the end). A line that is not
 * `key: value` ends the block only when the key is known - otherwise an ordinary sentence containing a
 * colon ("note: the build is broken") would silently become a key. Unknown keys inside the block are an
 * error, because a typo (`promt:`) must not fall back to `hi`.
 */
function splitBlock(body: string): { block: [string, string][]; rest: string; unknown: string[] } {
	const lines = body.replace(/\r\n/g, "\n").split("\n")

	// Collect the contiguous key-shaped prefix first; whether it *is* a block depends on what it holds.
	const shaped: { key: string; value: string }[] = []
	let end = 0
	for (; end < lines.length; end++) {
		const line = lines[end] ?? ""
		if (line.trim() === "") break
		const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s?(.*)$/.exec(line)
		if (!match) break
		shaped.push({ key: match[1]!.toLowerCase(), value: match[2] ?? "" })
	}

	// A lone `note: the build is broken` is prose; `promt: x` next to `cwd: /tmp` is a typo in a block.
	// The rule: it is a block when at least one line carries a key we know. Otherwise the whole body is
	// the prompt, colon and all.
	const known = shaped.filter((entry) => (KEYS as readonly string[]).includes(entry.key))
	if (known.length === 0) return { block: [], rest: lines.join("\n"), unknown: [] }

	const block: [string, string][] = []
	const unknown: string[] = []
	for (const entry of shaped) {
		if ((KEYS as readonly string[]).includes(entry.key)) block.push([entry.key as Key, entry.value])
		else unknown.push(entry.key)
	}
	return { block, rest: lines.slice(end).join("\n"), unknown }
}

/**
 * `prompt: |` takes the remaining lines verbatim, with the block's own indentation removed.
 *
 * Bounded before it allocates: `Math.min(...indents)` throws RangeError past V8's argument limit, and a
 * body of hundreds of thousands of short lines is well under the mail ceiling. Parsing happens before
 * authentication, so an unauthenticated sender could otherwise stall every later request (including a
 * stop) by making the scan throw forever.
 */
function blockScalar(rest: string): string {
	const lines = rest.replace(/^\n+/, "").split("\n")
	let indent = 0
	let seen = false
	for (const line of lines) {
		if (line.trim() === "") continue
		const width = /^\s*/.exec(line)?.[0].length ?? 0
		indent = seen ? Math.min(indent, width) : width
		seen = true
	}
	return lines
		.map((l) => (l.trim() === "" ? "" : l.slice(indent)))
		.join("\n")
		.replace(/\s+$/, "")
}

/** `Re:`, `Re[2]:`, `Fwd:`, `AW:` — the markers a mail client puts on a reply or forward. */
export function isReplySubject(subject: string | undefined): boolean {
	return /^(?:re|aw|sv|antw|fwd|fw|tr)\s*(?:\[\d+\])?\s*:/i.test(subject ?? "")
}

/**
 * Drop quoted history: everything from the first `>`-quote, `On … wrote:` line or `-----Original` marker.
 * A reply's body is the new text, and a `stop:` typed above the quote is the command; below it is history.
 */
export function stripQuotedText(body: string): string {
	const lines = body.split("\n")
	const kept: string[] = []
	for (const line of lines) {
		if (/^\s*>/.test(line)) break
		if (/^\s*On\b.*\bwrote:\s*$/i.test(line)) break
		if (/^\s*-{2,}\s*(original message|forwarded message)/i.test(line)) break
		if (/^\s*_{5,}\s*$/.test(line)) break
		kept.push(line)
	}
	return kept.join("\n").trimEnd()
}

export function parseRequest(body: string, options: { promptMaxChars: number }): GrammarResult {
	const errors: GrammarError[] = []
	const { block, rest, unknown } = splitBlock(body)
	for (const key of unknown) errors.push({ code: "unknown-field", detail: key })

	const seen = new Set<Key>()
	const values = new Map<Key, string>()
	for (const [key, value] of block) {
		if (seen.has(key as Key)) errors.push({ code: "duplicate-field", detail: key })
		seen.add(key as Key)
		values.set(key as Key, value)
	}

	const isStop = seen.has("stop")
	const isList = seen.has("list")
	if (isStop && isList) errors.push({ code: "both-commands", detail: "stop and list in one message" })
	if ((isStop || isList) && [...seen].some((k) => k !== "stop" && k !== "list")) {
		errors.push({ code: "command-with-fields", detail: "a command must not carry start fields" })
	}
	if (errors.length > 0) return { state: "invalid", errors }

	if (isStop) {
		const target = (values.get("stop") ?? "").trim()
		if (!target) return { state: "invalid", errors: [{ code: "empty-stop", detail: "stop needs a name or all" }] }
		return { state: "complete", request: { kind: "stop", fields: { parse: "auto" }, stopTarget: target } }
	}
	if (isList) return { state: "complete", request: { kind: "list", fields: { parse: "auto" } } }

	const fields: StartFields = { parse: "auto" }

	const cwd = values.get("cwd")?.trim()
	if (cwd !== undefined) {
		if (cwd === "") errors.push({ code: "empty-value", detail: "cwd" })
		else fields.cwd = cwd
	}
	const model = values.get("model")?.trim()
	if (model !== undefined) {
		if (model === "") errors.push({ code: "empty-value", detail: "model" })
		else fields.model = model
	}
	const thinking = values.get("thinking")?.trim().toLowerCase()
	if (thinking !== undefined) {
		if (!KNOWN_THINKING.includes(thinking)) {
			errors.push({ code: "bad-thinking", detail: `${thinking} (one of ${KNOWN_THINKING.join(", ")})` })
		} else fields.thinking = thinking
	}
	const name = values.get("name")?.trim()
	if (name !== undefined) {
		if (name === "") errors.push({ code: "empty-value", detail: "name" })
		else fields.name = name
	}
	const parseMode = values.get("parse")?.trim().toLowerCase()
	if (parseMode !== undefined) {
		if (parseMode !== "agent" && parseMode !== "auto") {
			errors.push({ code: "bad-parse-mode", detail: `${parseMode} (auto or agent)` })
		} else fields.parse = parseMode
	}

	if (errors.length > 0) return { state: "invalid", errors }

	// The prompt: an explicit block scalar wins; otherwise the remainder of the body.
	const explicitPrompt = values.get("prompt")
	const promptSource = explicitPrompt === undefined ? rest : explicitPrompt.trim() === "|" ? rest : explicitPrompt
	const prompt = (explicitPrompt !== undefined ? blockScalar(promptSource) : promptSource).trim()

	if (prompt.length > options.promptMaxChars) {
		return {
			state: "invalid",
			errors: [{ code: "prompt-too-long", detail: `${prompt.length} > ${options.promptMaxChars}` }],
		}
	}
	if (prompt) fields.prompt = prompt

	const missing: ("cwd" | "prompt")[] = []
	if (!fields.cwd) missing.push("cwd")
	if (!fields.prompt) missing.push("prompt")
	// `prompt` missing is not incomplete: `hi` is a legitimate default. Only `cwd` can be missing in a
	// way that matters, and only `parse: agent` may fill it.
	if (!fields.cwd) return { state: "incomplete", request: { kind: "start", fields }, missing: ["cwd"] }
	return { state: "complete", request: { kind: "start", fields } }
}
