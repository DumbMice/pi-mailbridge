// Ack journal — durable replay protection.
//
// A UID lands here only after a session has injected the reply and acked. That
// is what makes delivery at-least-once but effect-at-most-once: if a pending
// record is re-offered (daemon restart, client reconnect) the journal refuses it.
//
// Capped so the file cannot grow without bound; the oldest entries are dropped,
// which is safe because the UID cursor has long since passed them in practice.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { statePath } from "./paths.ts"

/** Keep the last N acked UIDs. */
export const JOURNAL_CAP = 5_000

interface JournalFile {
	uids: number[]
}

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, "journal.json")
}

function load(env: NodeJS.ProcessEnv): number[] {
	const p = path(env)
	try {
		if (!existsSync(p)) return []
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<JournalFile>
		return Array.isArray(parsed?.uids) ? parsed.uids.filter((n) => typeof n === "number") : []
	} catch {
		return []
	}
}

function save(env: NodeJS.ProcessEnv, uids: number[]): void {
	const p = path(env)
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tmp = `${p}.${process.pid}.tmp`
	const trimmed = uids.length > JOURNAL_CAP ? uids.slice(uids.length - JOURNAL_CAP) : uids
	writeFileSync(tmp, JSON.stringify({ uids: trimmed } satisfies JournalFile), { mode: 0o600 })
	renameSync(tmp, p)
}

export function isJournaled(env: NodeJS.ProcessEnv, uid: number): boolean {
	return load(env).includes(uid)
}

/** Append `uid` (idempotent). Returns false when it was already journaled. */
export function journal(env: NodeJS.ProcessEnv, uid: number): boolean {
	const uids = load(env)
	if (uids.includes(uid)) return false
	uids.push(uid)
	save(env, uids)
	return true
}

export function journalSize(env: NodeJS.ProcessEnv): number {
	return load(env).length
}
