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
import { decodeRfc2047 } from "../core/header-encoding.ts"
import type { RawAttachment } from "../core/attachments.ts"

export const DEFAULT_IDLE_RENEW_MS = 25 * 60 * 1000

/**
 * Hard ceiling on a message we will parse. The attachment caps (4 x 1 MB) live well inside
 * it; anything larger is refused before the body is downloaded.
 */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

const DEFAULT_BACKOFF_INITIAL_MS = 1_000
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
	// Our own Message-ID and marker, so a notification that comes back is recognised as an
	// echo even if the id was never recorded (a send that raced the scan).
	"message-id",
	"x-pi-mailbridge",
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
		// rather than silently using only the first instance. Then decode RFC 2047:
		// a client that encodes a subject makes the routing token unreadable otherwise.
		return decodeRfc2047(values.join(" "))
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
		// message-id is what lets the scanner recognise our own notification coming back.
		...(one("message-id") ? { messageId: one("message-id") } : {}),
		...(one("x-pi-mailbridge") ? { piMailbridge: one("x-pi-mailbridge") } : {}),
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
	// mailparser leaves `text` undefined for a multipart message whose only body part is
	// text/html, and the scanner rejected such a reply as empty-body - permanently, because the
	// cursor had advanced. Fall back to the HTML part, tag-stripped.
	// `text` is often the empty string (not undefined) for that shape, so test for content.
	const text = parsed.text?.trim() ? parsed.text : parsed.html ? htmlToText(parsed.html) : ""
	return { text, attachments }
}

/** Coarse HTML → text: enough to keep the human's words, not a renderer. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
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
	/** Populated once the mailbox is open; UID space identity. */
	mailbox?: { uidValidity?: bigint | number; uidNext?: bigint | number }
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
	/** RFC822 size, when the fetch asked for it. */
	size?: number
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/** imapflow reports these as bigint; normalise both to a safe number. */
function normaliseUid(raw: bigint | number | undefined): number | undefined {
	if (raw === undefined) return undefined
	const value = typeof raw === "bigint" ? Number(raw) : raw
	return Number.isFinite(value) ? value : undefined
}

export interface ImapWatcher extends MailSource {
	start(): Promise<void>
	stop(): Promise<void>
	isHealthy(): boolean
	/** The open mailbox's UIDVALIDITY, when the server exposes it. */
	uidValidity(): number | undefined
	/** The open mailbox's next UID, when the server exposes it. */
	uidNext(): number | undefined
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
	let connecting = false

	async function teardown(target?: ImapClientLike): Promise<void> {
		// Take the connection explicitly when the caller still holds it: stop() may already
		// have nulled `client` (and logged out nothing, because the dial had not finished),
		// and tearing down `client` again would silently do nothing.
		const c = target ?? client
		// Clear it either way: after a stop during the dial, `client` was assigned the very
		// connection we are about to close, and leaving it set lets search/fetch reach a
		// logged-out socket instead of failing fast.
		if (client === c) client = undefined
		if (!c) return
		try {
			await c.logout()
		} catch {
			// A dead connection cannot log out; that is expected during reconnect.
		}
	}

	function scheduleReconnect(error: Error): void {
		// A dying connection emits both "close" and "error", and connectOnce's catch adds a
		// third path. Without this guard each one arms its own timer, so the watcher opens
		// several connections and leaks all but the last.
		if (stopped || reconnectHandle !== undefined || connecting) return
		const delay = nextBackoff(attempt, config.tuning.backoffInitialMs, config.tuning.backoffMaxMs)
		attempt++
		callbacks.onError?.(error, delay)
		reconnectHandle = timers.setTimeout(() => {
			reconnectHandle = undefined
			void connectOnce()
		}, delay)
	}

	async function connectOnce(): Promise<void> {
		if (stopped || connecting) return
		connecting = true
		try {
			const c = await factory(config, { idleRenewMs })
			client = c
			await c.connect()
			await c.mailboxOpen(config.mail.imap.folder || "INBOX")
			// stop() may have run while those were awaited; the entry check cannot see that.
			// Without this, the connection stays open with handlers attached and nothing
			// will ever tear it down (isHealthy() would meanwhile report false).
			if (stopped) {
				await teardown(c)
				return
			}
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
			// Clear the in-flight flag first: scheduleReconnect refuses while a connect is
			// pending, and this catch is one of the legs that must be able to arm it.
			connecting = false
			scheduleReconnect(error instanceof Error ? error : new Error(String(error)))
		} finally {
			connecting = false
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

		/** The open mailbox's UIDVALIDITY, when the client exposes one. */
		uidValidity(): number | undefined {
			return normaliseUid(client?.mailbox?.uidValidity)
		},

		/** The open mailbox's next UID, when the client exposes one. */
		uidNext(): number | undefined {
			return normaliseUid(client?.mailbox?.uidNext)
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

			// Ask for the size first: the full source is downloaded before authorization, so
			// an oversized message from any sender - spam, a 200 MB newsletter - would cost the
			// one shared daemon a full download and parse. `size` is cheap and needs no body.
			const meta = (await c.fetchOne(uid, { size: true, envelope: true }, { uid: true })) as
				| FetchResultLike
				| false
				| undefined
			if (meta && typeof meta.size === "number" && meta.size > MAX_MESSAGE_BYTES) {
				return {
					uid,
					from: meta.envelope?.from?.[0]?.address,
					subject: meta.envelope?.subject,
					text: "",
					headers: { subject: meta.envelope?.subject },
					receivedAt: Date.now(),
					tooLarge: meta.size,
				}
			}

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
