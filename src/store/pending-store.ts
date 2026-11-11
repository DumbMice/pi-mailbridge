// Durable pending deliveries.
//
// Written by the daemon immediately after a message is parsed and authorized —
// *before* any session is told about it. That ordering is the whole point: a
// crash after this write still leaves the reply available for redelivery, while
// the mail stays unseen on the server.
//
// Single-writer model: only the daemon mutates this file, so no inter-process
// lock is required. Atomic rename protects against torn reads.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
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
	receivedAt: number
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

function load(env: NodeJS.ProcessEnv): PendingRecord[] {
	const p = path(env)
	try {
		if (!existsSync(p)) return []
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<PendingFile>
		if (!Array.isArray(parsed?.items)) return []
		return parsed.items.filter(
			(r): r is PendingRecord =>
				typeof r?.uid === "number" && typeof r?.sessionId === "string" && typeof r?.body === "string",
		)
	} catch {
		return []
	}
}

function save(env: NodeJS.ProcessEnv, items: PendingRecord[]): void {
	const p = path(env)
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tmp = `${p}.${process.pid}.tmp`
	const trimmed = items.length > PENDING_CAP ? items.slice(items.length - PENDING_CAP) : items
	writeFileSync(tmp, JSON.stringify({ items: trimmed } satisfies PendingFile), { mode: 0o600 })
	renameSync(tmp, p)
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

/** Add or replace the record for `uid`. Idempotent on replay. */
export function addPending(env: NodeJS.ProcessEnv, record: PendingRecord): PendingRecord {
	const items = load(env).filter((r) => r.uid !== record.uid)
	items.push(record)
	save(env, items)
	return record
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

/** Remove a delivery. Only the claimant may ack. */
export function ackPending(env: NodeJS.ProcessEnv, uid: number, instanceId: string): boolean {
	const items = load(env)
	const record = items.find((r) => r.uid === uid)
	if (!record) return false
	if (record.claimedBy && record.claimedBy !== instanceId) return false
	save(env, items.filter((r) => r.uid !== uid))
	return true
}

export function pendingSize(env: NodeJS.ProcessEnv): number {
	return load(env).length
}
