// Acked UIDs — durable replay protection.
//
// The cursor says what we have *seen*; the journal says what a session has *acked*. A crash
// between the two is why this file exists.
//
// UIDs are only meaningful within one UIDVALIDITY, so the journal stores the one it belongs
// to. A re-indexed mailbox renumbers from 1, and an old journal then suppresses brand-new
// mail as "already acked" - so a validity mismatch means the journal is not consulted.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { statePath } from "./paths.ts"
import { StateVersionError, checkStateVersion, stamp } from "./schema.ts"

/** Keep the last N acked UIDs. */
export const JOURNAL_CAP = 5_000

interface JournalFile {
	v?: number
	uids: number[]
	/** The UIDVALIDITY these UIDs were acked under. */
	uidValidity?: number
}

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, "journal.json")
}

function loadFile(env: NodeJS.ProcessEnv): JournalFile {
	const p = path(env)
	try {
		if (!existsSync(p)) return { uids: [] }
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<JournalFile>
		checkStateVersion("journal.json", parsed)
		return {
			uids: Array.isArray(parsed?.uids) ? parsed.uids.filter((n) => typeof n === "number") : [],
			...(typeof parsed?.uidValidity === "number" ? { uidValidity: parsed.uidValidity } : {}),
		}
	} catch (error) {
		if (error instanceof StateVersionError) throw error
		return { uids: [] }
	}
}

function save(env: NodeJS.ProcessEnv, file: JournalFile): void {
	const p = path(env)
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tmp = `${p}.${process.pid}.tmp`
	const trimmed = file.uids.length > JOURNAL_CAP ? file.uids.slice(file.uids.length - JOURNAL_CAP) : file.uids
	writeFileSync(tmp, JSON.stringify({ ...stamp(), ...file, uids: trimmed } satisfies JournalFile), { mode: 0o600 })
	renameSync(tmp, p)
}

/**
 * Has this UID been acked?
 *
 * When the caller knows the mailbox's UIDVALIDITY and it differs from the journal's, the
 * answer is "no": those UIDs belonged to a different numbering and say nothing about this one.
 */
export function isJournaled(env: NodeJS.ProcessEnv, uid: number, uidValidity?: number): boolean {
	const file = loadFile(env)
	if (uidValidity !== undefined) {
		// The caller knows the live numbering. A journal tagged with a different space cannot
		// answer for it - and neither can an untagged one, written before the field existed:
		// after a renumbering its old UIDs are reused, and "already seen" would let the cursor
		// advance past genuinely new mail.
		if (file.uidValidity === undefined) return false
		if (file.uidValidity !== uidValidity) return false
	}
	return file.uids.includes(uid)
}

/** Append `uid` (idempotent). Returns false when it was already journaled. */
export function journal(env: NodeJS.ProcessEnv, uid: number, uidValidity?: number): boolean {
	const file = loadFile(env)
	// A new numbering starts a new journal: keeping old entries would suppress new mail.
	const sameSpace = uidValidity === undefined || file.uidValidity === undefined || file.uidValidity === uidValidity
	const uids = sameSpace ? file.uids : []
	// Never erase a validity we already know: an ack from a caller that could not report one
	// must not blind the next comparison.
	// The caller's space wins, because claim/ack refuse a record from another space: an ack
	// that reaches here is for the live numbering, and the file must adopt it. (Preferring the
	// file's space made it write-once - after the first renumbering every later ack was
	// journaled under the dead numbering and dedupe was permanently inert.)
	const known = uidValidity ?? file.uidValidity
	const next = { uids, ...(known === undefined ? {} : { uidValidity: known }) }
	if (uids.includes(uid)) {
		save(env, next)
		return false
	}
	uids.push(uid)
	save(env, next)
	return true
}

export function journalSize(env: NodeJS.ProcessEnv): number {
	return loadFile(env).uids.length
}

/** Test helper: forget every ack. */
export function resetJournal(env: NodeJS.ProcessEnv): void {
	save(env, { uids: [] })
}
