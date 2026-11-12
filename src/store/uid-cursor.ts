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
	/** The mailbox's UIDVALIDITY when this cursor was written. */
	uidValidity?: number
}

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, "uid-cursor.json")
}

/**
 * Has the bridge ever established a cursor?
 *
 * `lastUid` alone cannot answer this: the first connect on an empty mailbox and a UIDVALIDITY
 * reset both write `{lastUid: 0}`, and treating those as "never primed" would let `prime` skip
 * a mailbox that is already being watched.
 */
export function hasCursor(env: NodeJS.ProcessEnv = process.env): boolean {
	return existsSync(path(env))
}

export function readCursor(env: NodeJS.ProcessEnv = process.env): number {
	return readFile(env).lastUid
}

function readFile(env: NodeJS.ProcessEnv): CursorFile {
	const p = path(env)
	try {
		if (!existsSync(p)) return { lastUid: 0 }
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CursorFile>
		const uid = parsed?.lastUid
		const validity = parsed?.uidValidity
		return {
			lastUid: typeof uid === "number" && Number.isFinite(uid) && uid >= 0 ? uid : 0,
			...(typeof validity === "number" && Number.isFinite(validity) ? { uidValidity: validity } : {}),
		}
	} catch {
		return { lastUid: 0 }
	}
}

function write(env: NodeJS.ProcessEnv, uid: number, uidValidity?: number): void {
	const p = path(env)
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tmp = `${p}.${process.pid}.tmp`
	const body: CursorFile = { lastUid: uid, ...(uidValidity === undefined ? {} : { uidValidity }) }
	writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
	renameSync(tmp, p)
}

/**
 * Compare the mailbox's UIDVALIDITY with the one this cursor was written under.
 *
 * UIDs are only meaningful within one UIDVALIDITY. A recreated or migrated folder renumbers
 * them from 1, and a persisted high-water cursor then skips everything for ever - visible
 * only as "examined 0". When it changes, the cursor is reset so the new UID space is read
 * from the start (the journal still prevents re-injecting anything already acked).
 *
 * @returns true when the cursor was reset.
 */
export function syncUidValidity(
	env: NodeJS.ProcessEnv,
	uidValidity: number | undefined,
	uidNext?: number,
): boolean {
	if (uidValidity === undefined || !Number.isFinite(uidValidity)) return false
	const current = readFile(env)
	if (current.uidValidity === uidValidity) return false

	// First observation on a cursor from a version that stored no validity: usually an
	// upgrade over an unchanged mailbox, so keep the cursor. But if the cursor is at or past
	// the mailbox's next UID, it cannot belong to this numbering - the folder was renumbered
	// while we were not looking - and keeping it would skip everything for ever.
	const observedFirst = current.uidValidity === undefined
	const outside = observedFirst && uidNext !== undefined && current.lastUid >= uidNext
	const reset = !observedFirst || outside
	write(env, reset ? 0 : current.lastUid, uidValidity)
	return reset
}

/**
 * Advance the cursor to `uid`, never backwards.
 * @returns the cursor value after the call.
 */
export function advanceCursor(env: NodeJS.ProcessEnv, uid: number): number {
	const current = readFile(env)
	if (uid <= current.lastUid) return current.lastUid
	write(env, uid, current.uidValidity)
	return uid
}

/** Test helper: force the cursor to a value (ignores monotonicity). */
export function resetCursor(env: NodeJS.ProcessEnv, uid = 0): void {
	write(env, uid, readFile(env).uidValidity)
}
