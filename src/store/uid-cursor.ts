// Monotonic IMAP UID cursor.
//
// Polling is `UID <cursor>+1:*` — never `UNSEEN`, never by SUBJECT. `\Seen` is
// shared mutable state: any other mail client can flip it and silently eat a
// reply. The cursor is ours alone and only ever moves forward.
//
// Writes are atomic (tmp + rename) so a crash cannot leave a torn file. The daemon writes it,
// and so does `prime` (from the extension or the CLI); the value only moves forward, so two
// concurrent primes cannot corrupt it and no lock is needed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { statePath } from "./paths.ts"

interface CursorFile {
	lastUid: number
}

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, "uid-cursor.json")
}

export function readCursor(env: NodeJS.ProcessEnv = process.env): number {
	const p = path(env)
	try {
		if (!existsSync(p)) return 0
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CursorFile>
		const uid = parsed?.lastUid
		return typeof uid === "number" && Number.isFinite(uid) && uid >= 0 ? uid : 0
	} catch {
		// A corrupt cursor is treated as "start from the beginning" rather than
		// throwing: worst case we re-examine mail, and the journal still dedupes.
		return 0
	}
}

function write(env: NodeJS.ProcessEnv, uid: number): void {
	const p = path(env)
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tmp = `${p}.${process.pid}.tmp`
	writeFileSync(tmp, JSON.stringify({ lastUid: uid } satisfies CursorFile), { mode: 0o600 })
	renameSync(tmp, p)
}

/**
 * Advance the cursor to `uid`, never backwards.
 * @returns the cursor value after the call.
 */
export function advanceCursor(env: NodeJS.ProcessEnv, uid: number): number {
	const current = readCursor(env)
	if (uid <= current) return current
	write(env, uid)
	return uid
}

/** Test helper: force the cursor to a value (ignores monotonicity). */
export function resetCursor(env: NodeJS.ProcessEnv, uid = 0): void {
	write(env, uid)
}
