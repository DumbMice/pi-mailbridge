// IMAP IDLE watcher — the read side. Port of opencode-afk `core/watcher.js`.
//
// One connection per machine, owned by the daemon, exposed to the scan pipeline
// as a `MailSource`. Two things make this testable without a socket:
//   - the client comes from an injectable factory (`ImapClientFactory`)
//   - body decoding comes from an injectable parser (`BodyParser`)
//
// Design notes carried over from the reference implementation:
//   - IDLE renews well under the server's ~29 minute timeout
//   - reconnect is exponential and bounded
//   - credentials are never logged
//   - errors are summarised from responseStatus/responseText only

import { simpleParser } from "mailparser"

import type { ResolvedConfig } from "../core/config.ts"
import type { RawMessage, MailSource } from "./process.ts"
import type { HeaderLike } from "../core/reply-parse.ts"
import type { RawAttachment } from "../core/attachments.ts"

export const DEFAULT_IDLE_RENEW_MS = 25 * 60 * 1000
export const DEFAULT_BACKOFF_INITIAL_MS = 1_000
export const DEFAULT_BACKOFF_MAX_MS = 60_000

/** Headers the authorization and routing layers need. */
export const WANTED_HEADERS = [
	"authentication-results",
	"auto-submitted",
	"precedence",
	"x-auto-response-suppress",
	"list-id",
	"from",
	"subject",
	// Reply-chain fallback: threading headers, so a reply reaches the session even
	// when the subject token was rewritten by a client or a human.
	"in-reply-to",
	"references",
] as const

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * IMAP UID range for "everything after `cursor`". UIDs are 32-bit and a server
 * may assign 0, so `1:*` is the safe floor.
 */
export function searchRangeFor(cursor: number): string {
	return `${Math.max(1, cursor + 1)}:*`
}

/** Bounded exponential backoff. */
export function nextBackoff(attempt: number, initial = DEFAULT_BACKOFF_INITIAL_MS, max = DEFAULT_BACKOFF_MAX_MS): number {
	const safeAttempt = Math.max(0, Math.min(attempt, 30))
	return Math.min(max, initial * 2 ** safeAttempt)
}

/**
 * Every value of every header, in wire order, plus a raw `From`/`Subject`.
 *
 * Written by hand rather than delegated because `Authentication-Results` MUST
 * keep its original order and multiplicity: authorization trusts only the
 * topmost header whose authserv-id is ours (docs/SECURITY.md §2.1). Most MIME
 * parsers collapse duplicates, which would silently discard that distinction.
 */
export interface ExtractedHeaders {
	headerValues: Map<string, string[]>
	from?: string
	subject?: string
}

export function extractHeaders(raw: Buffer | string): ExtractedHeaders {
	const text = typeof raw === "string" ? raw : raw.toString("utf8")
	// Headers end at the first blank line.
	const end = text.search(/\r?\n\r?\n/)
	const head = end === -1 ? text : text.slice(0, end)

	const unfolded = head.replace(/\r?\n[ \t]+/g, " ")
	const headerValues = new Map<string, string[]>()

	for (const line of unfolded.split(/\r?\n/)) {
		const colon = line.indexOf(":")
		if (colon <= 0) continue
		const name = line.slice(0, colon).trim().toLowerCase()
		const value = line.slice(colon + 1).trim()
		if (!name) continue
		const existing = headerValues.get(name)
		if (existing) existing.push(value)
		else headerValues.set(name, [value])
	}

	const pick = (name: string): string | undefined => {
		const values = headerValues.get(name)
		if (!values) return undefined
		// From/Subject are logically single-valued; servers may fold them, so join
		// rather than silently using only the first instance.
		return values.join(" ")
	}

	return { headerValues, from: pick("from"), subject: pick("subject") }
}

/** Map extracted headers onto the shape the authorization layer consumes. */
export function toHeaderLike(extracted: ExtractedHeaders): HeaderLike {
	const one = (name: string): string | undefined => extracted.headerValues.get(name)?.[0]
	return {
		from: extracted.from,
		subject: extracted.subject,
		authResults: extracted.headerValues.get("authentication-results"),
		...(one("in-reply-to") ? { inReplyTo: one("in-reply-to") } : {}),
		...(extracted.headerValues.get("references") ? { references: extracted.headerValues.get("references") } : {}),
		autoSubmitted: one("auto-submitted"),
		precedence: one("precedence"),
		autoResponseSuppress: one("x-auto-response-suppress"),
		listId: one("list-id"),
	}
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface BodyParser {
	/** Decode the plain-text body (and any attachments) from a raw message. */
	(raw: Buffer): Promise<{ text: string; attachments?: RawAttachment[] }>
}

export const defaultBodyParser: BodyParser = async (raw) => {
	const parsed = await simpleParser(raw)
	const attachments: RawAttachment[] = (parsed.attachments ?? []).map((a) => ({
		...(a.filename ? { filename: a.filename } : {}),
		contentType: a.contentType ?? "application/octet-stream",
		content: a.content,
	}))
	return { text: parsed.text ?? "", attachments }
}

/** The subset of ImapFlow this module uses. */
export interface ImapClientLike {
	connect(): Promise<void>
	logout(): Promise<void>
	mailboxOpen(path: string): Promise<unknown>
	search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[]>
	fetchOne(uid: number, query: Record<string, unknown>, options?: { uid?: boolean }): Promise<unknown>
	/** Adds flags (e.g. \\Seen). Only called from the ack path. */
	messageFlagsAdd?(uid: number, flags: string[], options?: { uid?: boolean }): Promise<unknown>
	on(event: string, listener: (...args: unknown[]) => void): void
	/** imapflow sets this false when the connection is gone. */
	usable?: boolean
}

export interface ImapClientFactory {
	/** May be async: XOAUTH2 has to fetch an access token before connecting. */
	(config: ResolvedConfig, tuning: { idleRenewMs: number }): ImapClientLike | Promise<ImapClientLike>
}

export interface WatcherTimers {
	setTimeout(handler: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

const defaultTimers: WatcherTimers = {
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface WatcherCallbacks {
	/** New mail may be waiting. Must not throw. */
	onMail: () => void
	/** Connection is usable; run the catch-up scan. */
	onReady: () => void
	/** Reconnect planned, for logging. */
	onError?: (error: Error, nextDelayMs: number) => void
}

export interface WatcherOptions {
	factory: ImapClientFactory
	callbacks: WatcherCallbacks
	parser?: BodyParser
	timers?: WatcherTimers
}

/** A fetched message as imapflow returns it. */
interface FetchResultLike {
	source?: Buffer
	envelope?: { from?: { address?: string }[]; subject?: string }
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export interface ImapWatcher extends MailSource {
	start(): Promise<void>
	stop(): Promise<void>
	isHealthy(): boolean
}

export function createImapWatcher(config: ResolvedConfig, options: WatcherOptions): ImapWatcher {
	const { factory, callbacks } = options
	const parser = options.parser ?? defaultBodyParser
	const timers = options.timers ?? defaultTimers
	const idleRenewMs = config.tuning.idleRenewMs ?? DEFAULT_IDLE_RENEW_MS

	let client: ImapClientLike | undefined
	let reconnectHandle: unknown
	let attempt = 0
	let stopped = false

	async function teardown(): Promise<void> {
		const c = client
		client = undefined
		if (!c) return
		try {
			await c.logout()
		} catch {
			// A dead connection cannot log out; that is expected during reconnect.
		}
	}

	function scheduleReconnect(error: Error): void {
		if (stopped) return
		const delay = nextBackoff(attempt, config.tuning.backoffInitialMs, config.tuning.backoffMaxMs)
		attempt++
		callbacks.onError?.(error, delay)
		reconnectHandle = timers.setTimeout(() => {
			reconnectHandle = undefined
			void connectOnce()
		}, delay)
	}

	async function connectOnce(): Promise<void> {
		if (stopped) return
		try {
			const c = await factory(config, { idleRenewMs })
			client = c
			await c.connect()
			await c.mailboxOpen(config.mail.imap.folder || "INBOX")
			attempt = 0
			c.on("exists", () => callbacks.onMail())
			c.on("close", () => {
				if (stopped) return
				scheduleReconnect(new Error("imap connection closed"))
			})
			c.on("error", (error) => scheduleReconnect(error instanceof Error ? error : new Error(String(error))))
			callbacks.onReady()
		} catch (error) {
			await teardown()
			scheduleReconnect(error instanceof Error ? error : new Error(String(error)))
		}
	}

	return {
		async start() {
			stopped = false
			await connectOnce()
		},

		async stop() {
			stopped = true
			if (reconnectHandle !== undefined) {
				timers.clearTimeout(reconnectHandle)
				reconnectHandle = undefined
			}
			await teardown()
		},

		isHealthy() {
			return !stopped && client !== undefined && client.usable !== false
		},

		async searchAfter(afterUid: number): Promise<number[]> {
			const c = client
			if (!c) throw new Error("imap watcher not connected")
			const uids = await c.search({ uid: searchRangeFor(afterUid) }, { uid: true })
			return uids.filter((n) => Number.isFinite(n) && n > afterUid).sort((a, b) => a - b)
		},

		async fetch(uid: number): Promise<RawMessage | undefined> {
			const c = client
			if (!c) throw new Error("imap watcher not connected")
			const fetched = (await c.fetchOne(
				uid,
				{ source: true, envelope: true, headers: [...WANTED_HEADERS] },
				{ uid: true },
			)) as FetchResultLike | false | undefined
			if (!fetched || !fetched.source) return undefined

			const extracted = extractHeaders(fetched.source)
			const parsed = await parser(fetched.source)
			const from = extracted.from ?? fetched.envelope?.from?.[0]?.address
			const subject = extracted.subject ?? fetched.envelope?.subject

			return {
				uid,
				from,
				subject,
				text: parsed.text,
				...(parsed.attachments?.length ? { attachments: parsed.attachments } : {}),
				headers: toHeaderLike(extracted),
				receivedAt: Date.now(),
			}
		},

		/** Mailbox hygiene, invoked by the daemon's /ack handler only. */
		async markSeen(uid: number): Promise<void> {
			const c = client
			if (!c?.messageFlagsAdd) return
			await c.messageFlagsAdd(uid, ["\\Seen"], { uid: true })
		},
	}
}
