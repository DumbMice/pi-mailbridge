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
import { StateVersionError, checkStateVersion, stamp } from "./schema.ts"

interface CursorFile {
	v?: number
	lastUid: number
	/** The mailbox's UIDVALIDITY when this cursor was written. */
	uidValidity?: number
	/**
	 * `prime` has run. Existence of this file proves nothing: the daemon writes it on its first
	 * connect, before it has read any mail, so "has a file" cannot distinguish a fresh install
	 * (prime is wanted) from a mailbox already being watched (prime would skip mail).
	 */
	primed?: boolean
}

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, "uid-cursor.json")
}

/**
 * Is the bridge already watching this mailbox, so that priming would skip mail?
 *
 * True when `prime` ran before (the flag survives a renumbering reset), or when the cursor has
 * actually been advanced past something. A file with `lastUid: 0` and no flag is a fresh install:
 * the daemon writes it on connect before reading anything, and priming there is the whole point.
 */
export function isPrimed(env: NodeJS.ProcessEnv = process.env): boolean {
	const file = readFile(env)
	return file.primed === true || file.lastUid > 0
}

/** Record that `prime` ran, so a later run refuses. Preserves the cursor itself. */
export function markPrimed(env: NodeJS.ProcessEnv = process.env): void {
	const file = readFile(env)
	write(env, file.lastUid, file.uidValidity, true)
}

export function readCursor(env: NodeJS.ProcessEnv = process.env): number {
	return readFile(env).lastUid
}

function readFile(env: NodeJS.ProcessEnv): CursorFile {
	const p = path(env)
	try {
		if (!existsSync(p)) return { lastUid: 0 }
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CursorFile>
		checkStateVersion("uid-cursor.json", parsed)
		const uid = parsed?.lastUid
		const validity = parsed?.uidValidity
		return {
			lastUid: typeof uid === "number" && Number.isFinite(uid) && uid >= 0 ? uid : 0,
			...(typeof validity === "number" && Number.isFinite(validity) ? { uidValidity: validity } : {}),
			...(parsed?.primed === true ? { primed: true } : {}),
		}
	} catch (error) {
		if (error instanceof StateVersionError) throw error
		return { lastUid: 0 }
	}
}

function write(env: NodeJS.ProcessEnv, uid: number, uidValidity?: number, primed?: boolean): void {
	const p = path(env)
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tmp = `${p}.${process.pid}.tmp`
	const keepPrimed = primed ?? readFile(env).primed === true
	const body: CursorFile = {
		...stamp(),
		lastUid: uid,
		...(uidValidity === undefined ? {} : { uidValidity }),
		...(keepPrimed ? { primed: true } : {}),
	}
	writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
	renameSync(tmp, p)
}

/**
 * Compare the mailbox's UIDVALIDITY with the one this cursor was written under.
 *
 * UIDs are only meaningful within one UIDVALIDITY. A recreated or migrated folder renumbers
 * them from 1, and a persisted high-water cursor then skips everything for ever - visible
 * only as "examined 0". When it changes, the cursor is reset so the new UID space is read from
 * the start. The cost is the one ARCHITECTURE.md states: the journal is space-scoped, so a
 * renumbering can re-deliver a reply that was acked inside the route TTL.
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
