// Scan → fetch → authorize → parse → persist. Port of opencode-afk `core/process.js`.
//
// THE ORDERING HERE IS THE CORRECTNESS PROPERTY (docs/ARCHITECTURE.md §2):
//
//   0. skip everything if mode is off       `/mailbridge off` must close the channel, not just mute it
//   1. search `UID <cursor>+1:*`            UID cursor, never \Seen, never SUBJECT
//   2. fetch envelope + body
//   3. self-echo, part 1: the marker header (before authorization, because in single-mailbox
//      mode the sender IS the human and would otherwise pass every later gate)
//   4. authorize (loop → robot → allowlist → DMARC)
//   5. self-echo, part 2: our own recorded Message-ID
//   5. route: short id, then legacy signed token, then the reply chain  (routes, does not authorize)
//   6. strip quoted text, then filter attachments
//   7. persist to the durable pending store  <- nothing is lost after this
//   8. advance the cursor                     <- only after persist
//
// Marking \Seen and journaling happen later, in the daemon's /ack handler, once a
// session has injected the reply. Doing it here would lose replies on a crash.

import type { ResolvedConfig } from "../core/config.ts"
import { authorize } from "../core/authz.ts"
import { stripQuoted, type HeaderLike } from "../core/reply-parse.ts"
import { tokenFromSubject } from "../core/token.ts"
import { selectAttachments, type RawAttachment } from "../core/attachments.ts"
import { findOutbound, parseMessageIds, lookupChain } from "../store/threads.ts"
import { routeIdFromSubject, resolveRoute } from "../store/routes.ts"
import { addPending, expirePending, listPending, type PendingRecord } from "../store/pending-store.ts"
import { isJournaled } from "../store/journal.ts"
import { advanceCursor, readCursor } from "../store/uid-cursor.ts"

/** Longest body we keep. Well above any real instruction; far below "a whole newsletter". */
export const MAX_BODY_CHARS = 100_000
/**
 * Longest subject we persist. Routing already happened on the raw header, so this is a display
 * field - and it is the one field the scanner does not otherwise bound (`MAX_MESSAGE_BYTES` is the
 * only upstream limit, and it is the same size as the whole queue's ceiling). Without this cap a
 * single message carrying a multi-megabyte `Subject:` header produced a record larger than
 * `PENDING_MAX_BYTES`, which `addPending` then refused on every scan with nothing to expire: a
 * permanent stall of all inbound mail. `test/pending-store.test.ts` pins the relationship.
 */
export const MAX_SUBJECT_CHARS = 300

export function persistedSubject(subject: string | undefined): string {
	const value = subject ?? ""
	return value.length > MAX_SUBJECT_CHARS ? `${value.slice(0, MAX_SUBJECT_CHARS)} [truncated]` : value
}

export interface RawMessage {
	uid: number
	from: string | undefined
	subject: string | undefined
	/** Plain-text body. */
	text: string
	/** Decoded attachments; the pipeline applies the allowlist and caps. */
	attachments?: RawAttachment[]
	headers: HeaderLike
	receivedAt: number
	/** Set when the server reported a message larger than we will parse. */
	tooLarge?: number
}

/**
 * Minimal mail source. `watcher.ts` implements this over imapflow; tests
 * implement it over an in-memory fixture, so the pipeline never needs a socket.
 */
export interface MailSource {
	/** The mailbox's UIDVALIDITY, or undefined when the source cannot report one. */
	uidValidity(): number | undefined
	/** UIDs strictly greater than `afterUid`, ascending. */
	searchAfter(afterUid: number): Promise<number[]>
	/** The message, or undefined when it vanished between search and fetch. */
	fetch(uid: number): Promise<RawMessage | undefined>
	/**
	 * Mark the message seen on the server. Called only from `/ack`, i.e. after a
	 * session has injected the reply — never at parse time.
	 */
	markSeen?(uid: number): Promise<void>
}

export interface ScanDeps {
	source: MailSource
	/** HMAC key for routing-token verification. */
	secret: Buffer
	env?: NodeJS.ProcessEnv
	now?: () => number
	/** Release a decision slot whose record was dropped, when nothing else holds it. */
	onDropped?: (sessionId: string) => void
}

export interface ScanResult {
	/** UIDs the source returned this scan. */
	examined: number
	/** Deliveries persisted to the pending store. */
	persisted: number
	/** Rejected: not for us, unauthorized, or machine-generated. */
	rejected: number
	/** Already journaled (acked earlier) — dedupe, not a rejection. */
	skipped: number
	/** Per-reason rejection counts, for logs and `/mailbridge status`. */
	reasons: Record<string, number>
	/** Cursor value after the scan. */
	cursor: number
}

function bump(reasons: Record<string, number>, key: string): void {
	reasons[key] = (reasons[key] ?? 0) + 1
}

/**
 * One incremental scan.
 *
 * A message is "handled" (and the cursor moves past it) when it is persisted,
 * rejected, skipped, or has vanished. Only a thrown error from the source or the
 * pending store stops the scan with the cursor left before the offending UID, so
 * the next scan retries it.
 */
export async function scanAndProcess(config: ResolvedConfig, deps: ScanDeps): Promise<ScanResult> {
	const env = deps.env ?? process.env
	const now = deps.now ?? (() => Date.now())

	const startCursor = readCursor(env)
	const uidValidity = deps.source.uidValidity?.()
	const uids = (await deps.source.searchAfter(startCursor)).slice().sort((a, b) => a - b)

	const result: ScanResult = {
		examined: uids.length,
		persisted: 0,
		rejected: 0,
		skipped: 0,
		reasons: {},
		cursor: startCursor,
	}

	for (const uid of uids) {
		// Dedupe: an acked UID must never be re-offered, whatever the server says.
		if (isJournaled(env, uid, uidValidity)) {
			result.skipped++
			bump(result.reasons, "journaled")
			result.cursor = advanceCursor(env, uid)
			continue
		}

		const message = await deps.source.fetch(uid)
		if (!message) {
			// Deleted between search and fetch. Nothing to do; do not block the cursor.
			result.skipped++
			bump(result.reasons, "vanished")
			result.cursor = advanceCursor(env, uid)
			continue
		}

		// The marker is stamped on every notification we send. Seeing it inbound means the
		// mail is ours coming back - check before authorization, because in single-mailbox
		// mode it is From: the human and would otherwise pass every gate.
		if (message.headers.piMailbridge) {
			result.rejected++
			bump(result.reasons, "self-echo")
			result.cursor = advanceCursor(env, uid)
			continue
		}

		// The watcher refuses to download anything over the size ceiling and marks it here.
		// Reject before authorization: this is our resource guard, not the sender's fault.
		if (message.tooLarge) {
			result.rejected++
			bump(result.reasons, "too-large")
			result.cursor = advanceCursor(env, uid)
			continue
		}

		const authz = authorize({ from: message.from, headers: message.headers }, config)
		if (!authz.ok) {
			result.rejected++
			bump(result.reasons, authz.reason)
			result.cursor = advanceCursor(env, uid)
			continue
		}

		// Self-echo, before routing: never treat our own notification as a reply. It arrives
		// From: the mailbox itself, and because notifications now carry In-Reply-To (threading)
		// the single-mailbox guard in authorize() can no longer tell them from a genuine
		// reply. The outbound registry can: if this message's own Message-ID is one we sent,
		// it is ours, whatever its headers say.
		const ownIds = parseMessageIds(message.headers.messageId)
		if (ownIds.length > 0 && ownIds.some((id) => findOutbound(env, id))) {
			result.rejected++
			bump(result.reasons, "self-echo")
			result.cursor = advanceCursor(env, uid)
			continue
		}

		// Routing, in order of preference:
		//   1. a short local route id  [pi:a1b2c3]  — what new notifications carry
		//   2. a signed token          [pi:<base64>.<mac>] — messages already in flight
		//   3. the reply chain         In-Reply-To / References → recorded Message-ID
		// All three are routing only; authorization happened above.
		let sessionId: string | undefined
		const routeId = routeIdFromSubject(message.subject)

		if (routeId) {
			// Short ids are local, so an id minted on another machine - or one whose 30-day
			// TTL has passed - does not resolve here. Fall through to the older rules rather
			// than dropping the reply: a human answering an old notification should still
			// reach the session through the token or the reply chain.
			const route = resolveRoute(routeId, { device: config.device.name, now: now(), env })
			if (route) {
				sessionId = route.sessionId
				bump(result.reasons, "routed")
			} else {
				bump(result.reasons, "route-miss")
			}
		}

		if (!sessionId) {
			const token = tokenFromSubject(message.subject, deps.secret, now(), config.device.name)
			if (token) {
				// deviceMatches === false means the token was minted for another machine.
				// undefined means the format carries no device, which is not a mismatch.
				if (token.deviceMatches === false || (token.device && token.device !== config.device.name)) {
					result.rejected++
					bump(result.reasons, "other-device")
					result.cursor = advanceCursor(env, uid)
					continue
				}
				sessionId = token.sessionId
			} else if (config.security.allowHeaderThreading !== false) {
				// The reply chain: a client or human that rewrote the subject still leaves
				// In-Reply-To/References intact, which is how "reply to this mail" works.
				const ids = [
					...parseMessageIds(message.headers.inReplyTo),
					...parseMessageIds((message.headers.references ?? []).join(" ")),
				]
				const thread = lookupChain(env, ids, { now: now(), ttlHours: config.security.tokenTtlHours })
				if (thread?.device && thread.device !== config.device.name) {
					result.rejected++
					bump(result.reasons, "other-device")
					result.cursor = advanceCursor(env, uid)
					continue
				}
				if (thread) {
					sessionId = thread.sessionId
					bump(result.reasons, "threaded")
				}
			}
		}

		if (!sessionId) {
			result.rejected++
			bump(result.reasons, "no-token")
			result.cursor = advanceCursor(env, uid)
			continue
		}

		// A body cap as well as a message cap: the pending store is re-read on every poll and
		// on every /health, so one enormous reply would be paid for repeatedly.
		const stripped = stripQuoted(message.text)
		// Marked, not silently cut: the agent must be able to tell that its instruction is
		// incomplete (the outbound truncation note does the same).
		const body =
			stripped.length > MAX_BODY_CHARS
				? `${stripped.slice(0, MAX_BODY_CHARS)}\n\n[truncated: ${stripped.length - MAX_BODY_CHARS} more characters]`
				: stripped

		// Attachments are filtered BEFORE persisting; a dropped one is recorded with
		// a reason so `/mailbridge` can explain why the agent did not see it.
		const { accepted, dropped } = selectAttachments(message.attachments ?? [])
		for (const item of dropped) bump(result.reasons, `attachment-${item.reason}`)

		// A reply is empty only if it has neither prose nor a surviving attachment. Judging
		// the body first discarded the image-from-a-phone case: nothing persisted, the
		// attachment left unread, and the cursor moved past it.
		//
		// The same applies when the *only* content was an attachment that got dropped (a phone
		// image over the 1 MB total, say). Rejecting it loses the human's whole reply with
		// no trace, so it is persisted with a note naming the drop and delivered: the agent can
		// ask for the text, and the mail is no longer sitting past the cursor unread.
		if (!body && accepted.length === 0) {
			const reasons = [...new Set(dropped.map((d) => d.reason))].join(", ")
			if (reasons.length > 0) {
				const note = `[pi-mailbridge: ${dropped.length} attachment(s) dropped (${reasons}); this reply had no text]`
				// Not counted as rejected: the reply *is* delivered, as a note. The reason is
				// named so the panel can say the content was lost, without claiming the mail was.
				bump(result.reasons, "attachment-only-dropped")
				const stub: PendingRecord = {
					uid,
					sessionId,
					from: authz.from,
					subject: persistedSubject(message.subject),
					body: note,
					receivedAt: message.receivedAt ?? now(),
					...(uidValidity === undefined ? {} : { uidValidity }),
					device: config.device.name,
				}
				const persisted = addPending(env, stub)
				if (!persisted.ok) {
					// Same rule as a real record: do not advance past it, retry when there is room.
					bump(result.reasons, "pending-full")
					break
				}
				result.persisted++
				result.cursor = advanceCursor(env, uid)
				continue
			}
			result.rejected++
			bump(result.reasons, "empty-body")
			result.cursor = advanceCursor(env, uid)
			continue
		}

		const record: PendingRecord = {
			uid,
			sessionId,
			from: authz.from,
			subject: persistedSubject(message.subject),
			body,
			...(accepted.length ? { attachments: accepted } : {}),
			receivedAt: message.receivedAt,
			// Re-read per record: a renumber can land mid-scan, and stamping the scan's opening
			// space would leave the tail of the batch unclaimable until the next connect.
			...((deps.source.uidValidity?.() ?? uidValidity) === undefined
				? {}
				: { uidValidity: deps.source.uidValidity?.() ?? uidValidity }),
		}

		// Persist BEFORE the cursor moves. A crash here leaves the mail unseen.
		const added = addPending(env, { ...record, device: config.device.name })
		if (!added.ok) {
			// The queue is full. Before stalling every future reply, drop records nothing can
			// deliver any more - a session that has not come back in a week. This is the only
			// place age-based expiry runs, because it is the only place the loss buys progress.
			const expired = expirePending(env)
			if (expired.length > 0) {
				// Not a rejection of *this* message: the reason says what was dropped, and the
				// counts stay usable ("examined 1, rejected 1"), which they did not when the
				// expiry was counted here and the refusal below counted it again.
				bump(result.reasons, "expired")
				// The same rule as the UID-space drop: free a slot only when nothing else is
				// queued for that session, or a live record would lose its reservation.
				const stillQueued = new Set(listPending(env).map((r) => r.sessionId))
				for (const gone of expired) {
					if (!stillQueued.has(gone.sessionId)) deps.onDropped?.(gone.sessionId)
				}
				const retry = addPending(env, { ...record, device: config.device.name })
				if (retry.ok) {
					result.persisted++
					result.cursor = advanceCursor(env, uid)
					continue
				}
			}
			// The queue is full. STOP the batch: advancing past this UID would lose it, and
			// so would processing a later UID (the cursor is monotonic, so it would jump
			// over this one). The mail stays unread and the whole batch is retried once
			// space appears.
			result.rejected++
			bump(result.reasons, "pending-full")
			break
		}
		result.persisted++

		result.cursor = advanceCursor(env, uid)
	}

	return result
}
