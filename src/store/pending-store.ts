// Durable pending deliveries.
//
// Written by the daemon immediately after a message is parsed and authorized —
// *before* any session is told about it. That ordering is the whole point: a
// crash after this write still leaves the reply available for redelivery, while
// the mail stays unseen on the server.
//
// Single-writer model: only the daemon mutates this file, so no inter-process
// lock is required. Atomic rename protects against torn reads.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { statePath } from "./paths.ts"

/** Bound the store so a stuck mailbox cannot grow it without limit. */
export const PENDING_CAP = 1_000
/** A claim older than this is considered abandoned and may be re-taken. */
export const CLAIM_TTL_MS = 120_000

export interface PendingRecord {
	uid: number
	sessionId: string
	from: string
	subject: string
	body: string
	/** Already allowlisted and capped by core/attachments before persisting. */
	attachments?: { name: string; mimeType: string; size: number; data: string }[]
	receivedAt: number
	/** The UIDVALIDITY this UID belongs to, when known. */
	uidValidity?: number
	claimedBy?: string
	claimedAt?: number
}

interface PendingFile {
	items: PendingRecord[]
}

export type ClaimResult =
	| { ok: true }
	| { ok: false; reason: "not-found" | "claimed-by-other" }

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, "pending.json")
}

/**
 * Parsed-file cache, keyed by the file's mtime+size.
 *
 * /health is unauthenticated and reads the queue length on every request; every poll tick
 * and every claim/ack re-reads it too. Without a cache, one large queued reply is re-parsed
 * (and re-serialised to JSON) many times a minute.
 */
let cached: { path: string; stamp: string; items: PendingRecord[] } | undefined

function load(env: NodeJS.ProcessEnv): PendingRecord[] {
	const p = path(env)
	try {
		if (!existsSync(p)) return []
		const stat = statSync(p)
		const stamp = `${stat.mtimeMs}:${stat.size}`
		if (cached && cached.path === p && cached.stamp === stamp) return cached.items
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<PendingFile>
		if (!Array.isArray(parsed?.items)) return []
		const items = parsed.items.filter(
			(r): r is PendingRecord =>
				typeof r?.uid === "number" && typeof r?.sessionId === "string" && typeof r?.body === "string",
		)
		cached = { path: p, stamp, items }
		return items
	} catch {
		return []
	}
}

function save(env: NodeJS.ProcessEnv, items: PendingRecord[]): void {
	const p = path(env)
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tmp = `${p}.${process.pid}.tmp`
	// Never trim here. These records were accepted and the cursor has already moved past
	// them, so dropping one is silent, unrecoverable mail loss. The cap is enforced at
	// insertion instead, where the caller can refuse and leave the cursor alone.
	writeFileSync(tmp, JSON.stringify({ items } satisfies PendingFile), { mode: 0o600 })
	renameSync(tmp, p)
	// The process that wrote knows the truth; an mtime+size stamp can collide when two writes
	// land in the same millisecond with the same length (measured on ext4).
	try {
		const stat = statSync(p)
		cached = { path: p, stamp: `${stat.mtimeMs}:${stat.size}`, items }
	} catch {
		cached = undefined
	}
}

export function listPending(env: NodeJS.ProcessEnv = process.env): PendingRecord[] {
	return load(env)
}

export function listPendingForSession(env: NodeJS.ProcessEnv, sessionId: string): PendingRecord[] {
	return load(env).filter((r) => r.sessionId === sessionId)
}

export function getPending(env: NodeJS.ProcessEnv, uid: number): PendingRecord | undefined {
	return load(env).find((r) => r.uid === uid)
}

export type AddResult = { ok: true; record: PendingRecord } | { ok: false; reason: "full" }

/**
 * Add or replace the record for `uid`. Idempotent on replay.
 *
 * Refuses a NEW record once the store is full rather than making room by discarding an
 * older one: every record here was already accepted, and the caller's cursor is about to
 * move past it. Replacing an existing uid (replay) is always allowed.
 */
export function addPending(env: NodeJS.ProcessEnv, record: PendingRecord): AddResult {
	const existing = load(env)
	const without = existing.filter((r) => r.uid !== record.uid)
	if (without.length >= PENDING_CAP) return { ok: false, reason: "full" }
	without.push(record)
	save(env, without)
	return { ok: true, record }
}

/**
 * Claim a delivery for `instanceId`.
 *
 * Succeeds when the record is unclaimed, already claimed by this same instance,
 * or its claim has expired (abandoned instance).
 */
export function claimPending(
	env: NodeJS.ProcessEnv,
	uid: number,
	instanceId: string,
	now: number = Date.now(),
): ClaimResult {
	const items = load(env)
	const record = items.find((r) => r.uid === uid)
	if (!record) return { ok: false, reason: "not-found" }
	if (record.claimedBy && record.claimedBy !== instanceId) {
		const age = now - (record.claimedAt ?? 0)
		if (age < CLAIM_TTL_MS) return { ok: false, reason: "claimed-by-other" }
	}
	record.claimedBy = instanceId
	record.claimedAt = now
	save(env, items)
	return { ok: true }
}

/**
 * Remove a delivery. Only the claimant may ack.
 *
 * An unclaimed record must NOT be ackable: with two sessions on one machine, any
 * authenticated client could otherwise delete, journal and mark `\Seen` another
 * session's reply - and nothing would re-read it, because the cursor has already moved.
 * Returns the record's session so the caller releases the right decision slot instead of
 * trusting whatever session id the request body carried.
 */
export type AckResult = { ok: true; sessionId: string } | { ok: false; reason: "not-found" | "not-claimed" }

export function ackPending(env: NodeJS.ProcessEnv, uid: number, instanceId: string): AckResult {
	const items = load(env)
	const record = items.find((r) => r.uid === uid)
	if (!record) return { ok: false, reason: "not-found" }
	if (record.claimedBy !== instanceId) return { ok: false, reason: "not-claimed" }
	save(env, items.filter((r) => r.uid !== uid))
	return { ok: true, sessionId: record.sessionId }
}

/**
 * Drop queued records that belong to a different UID numbering.
 *
 * A re-indexed mailbox renumbers from 1, so an old UID can collide with a new one and
 * `addPending` would silently replace a queued reply. The dropped mail is *not* lost: it was
 * never acked, so it is still unread in the mailbox, and the cursor reset that accompanies
 * this re-reads it.
 *
 * @returns how many records were dropped.
 */
export function dropPendingFromOtherSpaces(env: NodeJS.ProcessEnv, uidValidity: number): number {
	const items = load(env)
	const kept = items.filter((r) => r.uidValidity === undefined || r.uidValidity === uidValidity)
	const dropped = items.length - kept.length
	if (dropped > 0) save(env, kept)
	return dropped
}

export function pendingSize(env: NodeJS.ProcessEnv): number {
	return load(env).length
}
