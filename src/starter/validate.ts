// Validation for a starter request: the boundary that makes mail-chosen input safe to execute.
//
// The rule that matters most is the one the first draft of the plan got backwards: a request's `cwd` must
// be a **descendant** of a configured root, never an ancestor. (`~/Work/project` is allowed under root
// `~/Work`; `~` and `/` are not allowed under it.) Everything here is fail-closed and returns a reason
// code rather than throwing, because the reason is what the refusal mail says.

import { homedir } from "node:os"
import { isAbsolute } from "node:path"

import { existingDirectory, realpathOrUndefined, segmentsBelow } from "../core/containment.ts"
import { KNOWN_THINKING } from "./grammar.ts"

export interface Invalid {
	ok: false
	code: string
	detail: string
}

export type Valid<T> = { ok: true; value: T } | Invalid

export interface CwdOptions {
	/** Already expanded by the config layer (`~` → home); validated again because the mail's cwd is not. */
	roots: string[]
	/** Directories that are never a session root: the bridge's own config and state. */
	reserved: string[]
}

function invalid(code: string, detail: string): Invalid {
	return { ok: false, code, detail }
}

/** `~` and `~/x` only; anything else is left to `isAbsolute`. */
export function expandHome(value: string): string {
	const trimmed = value.trim()
	if (trimmed === "~") return homedir()
	if (trimmed.startsWith("~/")) return `${homedir()}${trimmed.slice(1)}`
	return trimmed
}

/**
 * Resolve a requested cwd and prove it is inside a root.
 *
 * Order matters for the reason the human reads: resolve first (so a symlink is judged by where it
 * *lands*), then the filesystem root, then reserved directories, then containment, then hidden segments.
 */
export function validateCwd(requested: string, options: CwdOptions): Valid<string> {
	const expanded = expandHome(requested)
	if (!expanded) return invalid("empty-path", "cwd is empty")
	if (!isAbsolute(expanded)) return invalid("not-absolute", `${requested} is not an absolute path`)

	const real = existingDirectory(expanded)
	if (!real) {
		const resolved = realpathOrUndefined(expanded)
		return resolved ? invalid("not-a-directory", expanded) : invalid("not-found", expanded)
	}
	// With root `/`, every path on the machine is "inside" it, which is the same as having no root.
	if (real === "/") return invalid("filesystem-root", "/")

	for (const dir of options.reserved) {
		const reservedReal = realpathOrUndefined(dir)
		if (!reservedReal) continue
		if (real === reservedReal || real.startsWith(`${reservedReal}/`)) {
			return invalid("reserved-directory", `${real} is the bridge's own ${reservedReal ? "state or config" : "directory"}`)
		}
	}

	const roots = options.roots.map((root) => realpathOrUndefined(expandHome(root)) ?? expandHome(root))
	for (const root of roots) {
		if (root === "/") continue
		// Containment is asked explicitly: `hasHiddenSegmentBelow` answers `false` for a path outside the
		// root, which is not the same as "inside and clean" - treating the two alike accepted every path.
		const segments = segmentsBelow(root, real)
		if (segments === undefined) continue // not under this root; try the next
		if (real === root) return invalid("root-itself", "a session must not be rooted at the root itself")
		if (segments.some((part) => part === ".." || part.startsWith("."))) {
			return invalid("hidden-path", "a hidden path segment below the root is refused")
		}
		return { ok: true, value: real }
	}
	return invalid("outside-root", `${real} is not under any configured root`)
}

/** Exact `provider/model` from the allowlist. No fuzzy matching, no fallback to pi's default. */
export function validateModel(requested: string, allowed: string[]): Valid<string> {
	const value = requested.trim()
	if (!value) return invalid("empty-model", "model is empty")
	if (!value.includes("/")) return invalid("model-not-qualified", `${value} must be provider/model`)
	if (!allowed.includes(value)) {
		return invalid("model-not-allowed", `${value} (allowed: ${allowed.join(", ") || "none — a model field is refused while starter.models is empty"})`)
	}
	return { ok: true, value }
}

export function validateThinking(requested: string): Valid<string> {
	const value = requested.trim().toLowerCase()
	return KNOWN_THINKING.includes(value) ? { ok: true, value } : invalid("bad-thinking", value)
}

/** pi session ids accept letters, numbers, dot, underscore and dash, and must start and end alnum. */
export function sanitiseName(raw: string, max = 40): string {
	const collapsed = raw
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
	return collapsed.slice(0, max).replace(/[^A-Za-z0-9]+$/g, "")
}

/**
 * The name a session will carry: the requested one, else the mail's title, else a timestamp.
 * Collisions are suffixed rather than refused - two requests from the same subject are normal.
 */
export function planName(options: { requested?: string; title: string; taken: string[]; now: Date }): Valid<string> {
	const base =
		sanitiseName(options.requested ?? "") ||
		sanitiseName(options.title) ||
		`pi-${options.now.toISOString().slice(2, 16).replace(/[-:T]/g, "")}`
	if (!base) return invalid("empty-name", "the name has no usable characters")
	if (base.length === 0) return invalid("empty-name", "the name has no usable characters")
	const taken = new Set(options.taken)
	if (!taken.has(base)) return { ok: true, value: base }
	for (let n = 2; n <= 99; n++) {
		const candidate = `${base}-${n}`.slice(0, 40).replace(/[^A-Za-z0-9]+$/g, "")
		if (!taken.has(candidate)) return { ok: true, value: candidate }
	}
	return invalid("name-exhausted", base)
}

/** The prompt, with the documented default. Length is capped by the grammar, before this runs. */
export function resolvePrompt(prompt: string | undefined): string {
	const text = (prompt ?? "").trim()
	return text === "" ? "hi" : text
}
