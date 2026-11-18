// Containment, in one place.
//
// Two features ask the same question — "is this path inside that directory?" — and both must answer it
// the same way or one of them becomes the weak one: the attachment guard (a markdown link must land inside
// the project) and the session starter (a mail-chosen cwd must land inside an allowed root).
//
// The rules here are deliberately dumb and separator-agnostic: no `/`-joined prefix tests (a prefix test
// says `/a/bc` is inside `/a/b`, and on Windows the separator is `\`), no case folding, no globbing.

import { realpathSync, statSync } from "node:fs"
import { isAbsolute, relative } from "node:path"

/** `realpath`, or undefined when the path does not resolve (missing, dangling link, permission). */
export function realpathOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path)
	} catch {
		return undefined
	}
}

/** Is `child` inside `parent` (or equal to it)? `relative()` sees separators and `..` correctly. */
export function contains(parent: string, child: string): boolean {
	const rel = relative(parent, child)
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * The segments of `target` below `root`, or undefined when it is not below `root` at all.
 * Empty segments and `.` are dropped; `..` is preserved so callers can decide (a path that climbs out
 * and back in is still inside, but the caller may want to know it has `..` in it).
 */
export function segmentsBelow(root: string, target: string): string[] | undefined {
	if (!contains(root, target)) return undefined
	return relative(root, target).split(/[\\/]/).filter((part) => part && part !== ".")
}

/** Does any segment strictly below `root` start with a dot? (`.ssh`, `.env`, `.github`.) */
export function hasHiddenSegmentBelow(root: string, target: string): boolean {
	const segments = segmentsBelow(root, target)
	return segments !== undefined && segments.some((part) => part === ".." || part.startsWith("."))
}

/** An existing directory, resolved. `undefined` when it is missing or is not a directory. */
export function existingDirectory(path: string): string | undefined {
	const real = realpathOrUndefined(path)
	if (!real) return undefined
	try {
		return statSync(real).isDirectory() ? real : undefined
	} catch {
		return undefined
	}
}
