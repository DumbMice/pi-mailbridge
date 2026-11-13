// On-disk schema versions.
//
// Separate from API_VERSION (daemon/api.ts) on purpose: that one asks "can these two processes
// talk", and is recovered by replacing a process. This one asks "can this build read the bytes",
// and the data outlives every process - a downgrade, a shared or synced state directory, or two
// builds pointed at one XDG_STATE_HOME.
//
// The policy every store follows (AGENTS.md "Compatibility"):
//
//   absent  -> schema 1: written before the field existed; read it, upgrade on the next save.
//   older   -> migrate on read, write the current version on the next save.
//   current -> parse normally.
//   newer   -> refuse to read AND refuse to write, naming both versions. Filtering unknown
//              records and saving the rest is how state is silently lost.

import { readFileSync } from "node:fs"

import { statePath } from "./paths.ts"

export const STATE_VERSION = 1

/** Every versioned file, so one probe can refuse the whole directory up front. */
export const VERSIONED_FILES = [
	"pending.json",
	"journal.json",
	"routes.json",
	"threads.json",
	"uid-cursor.json",
] as const

export class StateVersionError extends Error {
	readonly file: string
	readonly found: unknown
	readonly current: number

	constructor(file: string, found: unknown) {
		super(
			`${file} was written by a newer version of pi-mailbridge (schema ${String(found)}; ` +
				`this build understands ${STATE_VERSION}). Refusing to read or rewrite it - update ` +
				`pi-mailbridge, or move that file aside to start fresh.`,
		)
		this.name = "StateVersionError"
		this.file = file
		this.found = found
		this.current = STATE_VERSION
	}
}

/**
 * Validate the version of an already-parsed file.
 *
 * Returns the version to interpret the payload as. Throws `StateVersionError` for anything from
 * the future, which is the only case where reading would corrupt: an older shape is migrated.
 */
export function checkStateVersion(file: string, parsed: unknown): number {
	const version = (parsed as { v?: unknown } | null | undefined)?.v
	if (version === undefined) return STATE_VERSION
	if (typeof version !== "number" || !Number.isFinite(version) || version < 0) {
		throw new StateVersionError(file, version)
	}
	if (version > STATE_VERSION) throw new StateVersionError(file, version)
	return version
}

/** The version to write, stamped by every save. */
export function stamp(): { v: number } {
	return { v: STATE_VERSION }
}

/**
 * Read every versioned file's `v` and refuse the directory if any is newer.
 *
 * Called once at boot, before the daemon listens: a load-time throw inside a request would
 * surface as a 500 and inside a scan as a repeating log line, while this is one clear message.
 * Missing or unparsable files are left to their stores (they have their own recovery), so this
 * only fails on a *version* the build does not understand.
 */
export function assertStateReadable(env: NodeJS.ProcessEnv): void {
	for (const name of VERSIONED_FILES) {
		let parsed: unknown
		try {
			parsed = JSON.parse(readFileSync(statePath(env, name), "utf8"))
		} catch {
			continue
		}
		checkStateVersion(name, parsed)
	}
}
