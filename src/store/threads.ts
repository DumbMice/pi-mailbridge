// Outbound Message-ID registry — the reply-chain fallback.
//
// The signed subject token is the primary way a reply is identified, but a human
// can edit a subject and some clients rewrite it. Mail clients, however, keep
// `In-Reply-To` / `References` intact: that is how threading works, and it is what
// "reply to this mail" actually does.
//
// So every outbound notification's Message-ID is recorded here, mapped to the
// session (and device) it came from. When a reply arrives with no usable token,
// the scan walks its References chain and accepts the first id we minted.
//
// Threat note: a Message-ID is unguessable in practice — it is only visible to the
// recipient of the mail — and this path still sits behind the sender allowlist and
// pinned DMARC. It is a convenience fallback, not an authentication mechanism.
//
// Capped and atomic, like every other store here.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { statePath } from "./paths.ts"

/** Keep this many recent outbound ids. Replies to older mail fall back to the token. */
export const THREAD_CAP = 2_000

export interface ThreadRecord {
	/** Normalized Message-ID without angle brackets. */
	messageId: string
	sessionId: string
	device?: string
	subject: string
	createdAt: number
}

interface ThreadFile {
	items: ThreadRecord[]
}

/** Strip angle brackets and surrounding whitespace: `<a@b>` -> `a@b`. */
export function normalizeMessageId(raw: string | undefined | null): string {
	if (!raw) return ""
	return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim()
}

/** Every Message-ID inside a References/In-Reply-To header value. */
export function parseMessageIds(raw: string | undefined | null): string[] {
	if (!raw) return []
	const matches = raw.match(/<[^<>]+>/g)
	if (matches) return matches.map((m) => normalizeMessageId(m)).filter(Boolean)
	// Tolerate clients that drop the angle brackets.
	return raw
		.split(/\s+/)
		.map((part) => normalizeMessageId(part))
		.filter((part) => part.includes("@"))
}

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, "threads.json")
}

function load(env: NodeJS.ProcessEnv): ThreadRecord[] {
	const p = path(env)
	try {
		if (!existsSync(p)) return []
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<ThreadFile>
		if (!Array.isArray(parsed?.items)) return []
		return parsed.items.filter(
			(r): r is ThreadRecord =>
				typeof r?.messageId === "string" && typeof r?.sessionId === "string" && Boolean(r.messageId),
		)
	} catch {
		return []
	}
}

function save(env: NodeJS.ProcessEnv, items: ThreadRecord[]): void {
	const p = path(env)
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tmp = `${p}.${process.pid}.tmp`
	const trimmed = items.length > THREAD_CAP ? items.slice(items.length - THREAD_CAP) : items
	writeFileSync(tmp, JSON.stringify({ items: trimmed } satisfies ThreadFile), { mode: 0o600 })
	renameSync(tmp, p)
}

/** Remember an outbound notification so its replies can be traced back. */
export function recordOutbound(
	env: NodeJS.ProcessEnv,
	record: { messageId: string; sessionId: string; device?: string; subject: string; createdAt?: number },
): ThreadRecord | undefined {
	const messageId = normalizeMessageId(record.messageId)
	if (!messageId || !record.sessionId) return undefined

	const entry: ThreadRecord = {
		messageId,
		sessionId: record.sessionId,
		...(record.device ? { device: record.device } : {}),
		subject: record.subject,
		createdAt: record.createdAt ?? Date.now(),
	}

	const items = load(env).filter((r) => r.messageId !== messageId)
	items.push(entry)
	save(env, items)
	return entry
}

/**
 * First recorded outbound message among `ids`, searched in order.
 *
 * References lists ancestors oldest-first, so we search from the newest backward:
 * the closest ancestor is the notification the human actually replied to.
 */
export function lookupChain(env: NodeJS.ProcessEnv, ids: readonly string[]): ThreadRecord | undefined {
	if (ids.length === 0) return undefined
	const byId = new Map(load(env).map((r) => [r.messageId, r]))
	for (let i = ids.length - 1; i >= 0; i--) {
		const hit = byId.get(normalizeMessageId(ids[i]!))
		if (hit) return hit
	}
	return undefined
}

export function threadCount(env: NodeJS.ProcessEnv): number {
	return load(env).length
}
