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

/** A cursor store for one file. The daemon and the starter each own one; nothing is shared. */
export interface CursorStore {
	readonly fileName: string
	read(env: NodeJS.ProcessEnv): number
	isPrimed(env: NodeJS.ProcessEnv): boolean
	markPrimed(env: NodeJS.ProcessEnv): void
	sync(env: NodeJS.ProcessEnv, uidValidity: number | undefined, uidNext?: number): boolean
	advance(env: NodeJS.ProcessEnv, uid: number): number
	reset(env: NodeJS.ProcessEnv, uid?: number): void
}

/**
 * The cursor's file name is a parameter for a reason: the session starter must not write the daemon's
 * cursor, and `applyUidValidity` must not delete the daemon's queued records on its behalf. Two
 * instances of this store are two independent cursors over the same mailbox.
 */
export function createCursorStore(fileName: string): CursorStore {
	const path = (env: NodeJS.ProcessEnv): string => statePath(env, fileName)

	function readFile(env: NodeJS.ProcessEnv): CursorFile {
		const p = path(env)
		try {
			if (!existsSync(p)) return { lastUid: 0 }
			const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CursorFile>
			checkStateVersion(fileName, parsed)
			const uid = parsed?.lastUid
			const validity = parsed?.uidValidity
			return {
				lastUid: typeof uid === "number" && Number.isFinite(uid) && uid >= 0 ? uid : 0,
				...(typeof validity === "number" && Number.isFinite(validity) ? { uidValidity: validity } : {}),
				...(parsed?.primed === true ? { primed: true } : {}),
			}
		} catch (error) {
			if (error instanceof StateVersionError) throw error
			// A parse failure is recoverable state; a read failure is not the caller's to overwrite.
			if (!(error instanceof SyntaxError)) throw error
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

	return {
		fileName,
		read: (env) => readFile(env).lastUid,
		isPrimed: (env) => {
			const file = readFile(env)
			return file.primed === true || file.lastUid > 0
		},
		markPrimed: (env) => {
			const file = readFile(env)
			write(env, file.lastUid, file.uidValidity, true)
		},
		sync(env, uidValidity, uidNext) {
			if (uidValidity === undefined || !Number.isFinite(uidValidity)) return false
			const current = readFile(env)
			if (current.uidValidity === uidValidity) return false
			// First observation on a cursor from a version that stored no validity: usually an upgrade
			// over an unchanged mailbox, so keep the cursor. But if the cursor is at or past the
			// mailbox's next UID it cannot belong to this numbering, and keeping it would skip
			// everything for ever.
			const observedFirst = current.uidValidity === undefined
			const outside = observedFirst && uidNext !== undefined && current.lastUid >= uidNext
			const reset = !observedFirst || outside
			write(env, reset ? 0 : current.lastUid, uidValidity)
			return reset
		},
		advance(env, uid) {
			const current = readFile(env)
			if (uid <= current.lastUid) return current.lastUid
			write(env, uid, current.uidValidity)
			return uid
		},
		reset(env, uid = 0) {
			write(env, uid, readFile(env).uidValidity)
		},
	}
}

/** The daemon's cursor: the file every existing caller means. */
export const daemonCursor = createCursorStore("uid-cursor.json")

/**
 * Is the bridge already watching this mailbox, so that priming would skip mail?
 *
 * True when `prime` ran before (the flag survives a renumbering reset), or when the cursor has
 * actually been advanced past something. A file with `lastUid: 0` and no flag is a fresh install:
 * the daemon writes it on connect before reading anything, and priming there is the whole point.
 */
export const isPrimed = (env: NodeJS.ProcessEnv = process.env): boolean => daemonCursor.isPrimed(env)

/** Record that `prime` ran, so a later run refuses. Preserves the cursor itself. */
export const markPrimed = (env: NodeJS.ProcessEnv = process.env): void => daemonCursor.markPrimed(env)

export const readCursor = (env: NodeJS.ProcessEnv = process.env): number => daemonCursor.read(env)

/**
 * Compare the mailbox's UIDVALIDITY with the one this cursor was written under. Returns true when the
 * cursor was reset. Kept as a function because `source-proxy` calls it for the daemon's cursor.
 */
export const syncUidValidity = (
	env: NodeJS.ProcessEnv,
	uidValidity: number | undefined,
	uidNext?: number,
): boolean => daemonCursor.sync(env, uidValidity, uidNext)

/** Advance the cursor to `uid`, never backwards. Returns the value after the call. */
export const advanceCursor = (env: NodeJS.ProcessEnv, uid: number): number => daemonCursor.advance(env, uid)

/** Test helper: force the cursor to a value (ignores monotonicity). */
export const resetCursor = (env: NodeJS.ProcessEnv, uid = 0): void => daemonCursor.reset(env, uid)
