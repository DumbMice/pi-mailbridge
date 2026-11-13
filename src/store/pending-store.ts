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
import { StateVersionError, checkStateVersion, stamp } from "./schema.ts"

/** Bound the store so a stuck mailbox cannot grow it without limit. */
export const PENDING_CAP = 1_000
/**
 * Byte ceiling for the whole store, because the record cap alone was not a bound.
 *
 * `save()` rewrites the entire array on every claim and every ack, so 1000 records at the 100k-char
 * body cap is a ~100 MB file rewritten several times a minute - and the queue is already
 * misbehaving when it is that full. Measured in stored characters (body plus base64 attachment
 * data), which is what actually lands on disk.
 */
export const PENDING_MAX_BYTES = 8 * 1024 * 1024
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
	/**
	 * The device that scanned it. Two machines sharing one state directory (or one device.name)
	 * must not deliver each other's replies, so /pending filters and /claim refuses on this.
	 */
	device?: string
	claimedBy?: string
	claimedAt?: number
}

interface PendingFile {
	v?: number
	items: PendingRecord[]
}

export type ClaimResult =
	| { ok: true }
	| { ok: false; reason: "not-found" | "claimed-by-other" | "stale-space" | "foreign-device" }

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
		// Refuses a file from a newer schema rather than filtering records it cannot read.
		checkStateVersion("pending.json", parsed)
		if (!Array.isArray(parsed?.items)) return []
		const items = parsed.items.filter(
			(r): r is PendingRecord =>
				typeof r?.uid === "number" && typeof r?.sessionId === "string" && typeof r?.body === "string",
		)
		cached = { path: p, stamp, items }
		return items
	} catch (error) {
		if (error instanceof StateVersionError) throw error
		// Unparsable is not empty. Returning [] lets the next addPending rewrite the file with a
		// single record, discarding a queue whose replies the cursor has already passed. Keep the
		// bytes where a human can recover them and start clean.
		try {
			renameSync(p, `${p}.corrupt-${Date.now()}`)
		} catch {
			/* if it cannot be moved, the caller still gets an empty queue rather than a crash */
		}
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
	writeFileSync(tmp, JSON.stringify({ ...stamp(), items } satisfies PendingFile), { mode: 0o600 })
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

/** Only the records this device scanned; absent device means "from before the field". */
export function listPendingForDevice(env: NodeJS.ProcessEnv, device: string): PendingRecord[] {
	return load(env).filter((r) => r.device === undefined || r.device === device)
}

export function listPendingForSession(env: NodeJS.ProcessEnv, sessionId: string): PendingRecord[] {
	return load(env).filter((r) => r.sessionId === sessionId)
}

export function getPending(env: NodeJS.ProcessEnv, uid: number): PendingRecord | undefined {
	return load(env).find((r) => r.uid === uid)
}

export type AddResult = { ok: true; record: PendingRecord } | { ok: false; reason: "full" }

/** What a record costs on disk: the body, plus the already-base64 attachment payloads. */
export function recordBytes(record: PendingRecord): number {
	return record.body.length + (record.attachments ?? []).reduce((total, a) => total + a.data.length, 0)
}

/**
 * Add or replace the record for `uid`. Idempotent on replay.
 *
 * Refuses a NEW record once the store is full rather than making room by discarding an
 * older one: every record here was already accepted, and the caller's cursor is about to
 * move past it. Replacing an existing uid (replay) is always allowed.
 */
export function addPending(
	env: NodeJS.ProcessEnv,
	record: PendingRecord,
	options: { maxBytes?: number } = {},
): AddResult {
	const existing = load(env)
	const without = existing.filter((r) => r.uid !== record.uid)
	if (without.length >= PENDING_CAP) return { ok: false, reason: "full" }
	// The same rule as the count cap, for the same reason: refuse at insertion, so the caller's
	// cursor stays put and the reply is retried instead of dropped.
	const candidateBytes = without.reduce((total, r) => total + recordBytes(r), 0) + recordBytes(record)
	if (candidateBytes > (options.maxBytes ?? PENDING_MAX_BYTES)) return { ok: false, reason: "full" }
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
	uidValidity?: number,
	liveValidity?: number,
	device?: string,
): ClaimResult {
	const items = load(env)
	const record = items.find((r) => r.uid === uid)
	if (!record) return { ok: false, reason: "not-found" }
	// Defence in depth for a shared state directory: /pending already filters by device, but a
	// caller that names a uid it should not have (an older client, or a direct POST) is refused.
	if (record.device !== undefined && device !== undefined && record.device !== device) {
		return { ok: false, reason: "foreign-device" }
	}
	// A caller holding a record from a previous UID numbering must not act on whatever now
	// occupies that UID: after a renumbering it is a different message.
	if (record.uidValidity !== undefined && uidValidity !== undefined && record.uidValidity !== uidValidity) {
		return { ok: false, reason: "stale-space" }
	}
	// Also compare against the mailbox itself: a caller and a record can agree with each other
	// while both belong to a numbering the mailbox has already left.
	if (record.uidValidity !== undefined && liveValidity !== undefined && record.uidValidity !== liveValidity) {
		return { ok: false, reason: "stale-space" }
	}
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
export type AckResult =
	| { ok: true; sessionId: string; uidValidity?: number }
	| { ok: false; reason: "not-found" | "not-claimed" | "stale-space" }

export function ackPending(
	env: NodeJS.ProcessEnv,
	uid: number,
	instanceId: string,
	uidValidity?: number,
	liveValidity?: number,
): AckResult {
	const items = load(env)
	const record = items.find((r) => r.uid === uid)
	if (!record) return { ok: false, reason: "not-found" }
	// Same rule as claim: an ack from another UID space would journal a UID that now means
	// something else.
	if (record.uidValidity !== undefined && uidValidity !== undefined && record.uidValidity !== uidValidity) {
		return { ok: false, reason: "stale-space" }
	}
	if (record.uidValidity !== undefined && liveValidity !== undefined && record.uidValidity !== liveValidity) {
		return { ok: false, reason: "stale-space" }
	}
	if (record.claimedBy !== instanceId) return { ok: false, reason: "not-claimed" }
	save(env, items.filter((r) => r.uid !== uid))
	return { ok: true, sessionId: record.sessionId, ...(record.uidValidity === undefined ? {} : { uidValidity: record.uidValidity }) }
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
export function dropPendingFromOtherSpaces(
	env: NodeJS.ProcessEnv,
	uidValidity: number,
	options: { includeUnknown?: boolean } = {},
): PendingRecord[] {
	const items = load(env)
	// On a detected renumbering, a record that carries no space cannot be shown to belong to the
	// new numbering - and a live review caught one being claimed there and injecting a different
	// message's body. Its mail is unread and the reset cursor re-reads it.
	const keep = (r: PendingRecord): boolean =>
		r.uidValidity === uidValidity || (r.uidValidity === undefined && !options.includeUnknown)
	const kept = items.filter(keep)
	const dropped = items.filter((r) => !keep(r))
	if (dropped.length > 0) save(env, kept)
	// Returned, not just counted: the caller releases exactly these sessions' decision slots,
	// and a second pass over the file could disagree with what was actually removed.
	return dropped
}

/** Records older than this, for sessions that are gone, are expired under queue pressure only
 * (see `process.ts`): never on connect, where a `/mailbridge off` plus a holiday would delete replies. */
export const PENDING_MAX_AGE_MS = 7 * 24 * 3600_000

/**
 * Drop records nothing can deliver any more.
 *
 * A record whose session never comes back is refused by every runner (`foreign-session`) and
 * removed by nothing else, so a handful of them can fill `PENDING_CAP` - and at the cap the
 * scanner stops advancing the cursor, which stalls *all* inbound mail. Expiring them is a
 * deliberate, bounded loss: their mail stays unread in the mailbox, but the cursor has moved
 * past it, so it will not be re-read.
 *
 * @returns the dropped records, so the caller can release their decision slots.
 */
export function expirePending(env: NodeJS.ProcessEnv, maxAgeMs = PENDING_MAX_AGE_MS, now = Date.now()): PendingRecord[] {
	const items = load(env)
	const expired = items.filter((r) => now - r.receivedAt > maxAgeMs)
	if (expired.length === 0) return []
	save(env, items.filter((r) => now - r.receivedAt <= maxAgeMs))
	return expired
}

export function pendingSize(env: NodeJS.ProcessEnv): number {
	return load(env).length
}
