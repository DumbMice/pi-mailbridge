// Scan → fetch → authorize → parse → persist. Port of opencode-afk `core/process.js`.
//
// THE ORDERING HERE IS THE CORRECTNESS PROPERTY (docs/ARCHITECTURE.md §2):
//
//   1. search `UID <cursor>+1:*`            UID cursor, never \Seen, never SUBJECT
//   2. fetch envelope + body
//   3. authorize (loop → robot → allowlist → pinned DMARC)
//   4. verify the routing token             routes, does not authorize
//   5. strip quoted text
//   6. persist to the durable pending store  <- nothing is lost after this
//   7. advance the cursor                     <- only after persist
//
// Marking \Seen and journaling happen later, in the daemon's /ack handler, once a
// session has injected the reply. Doing it here would lose replies on a crash.

import type { ResolvedConfig } from "../core/config.ts"
import { authorize } from "../core/authz.ts"
import { stripQuoted, type HeaderLike } from "../core/reply-parse.ts"
import { sessionIdFromSubject } from "../core/token.ts"
import { addPending, type PendingRecord } from "../store/pending-store.ts"
import { isJournaled } from "../store/journal.ts"
import { advanceCursor, readCursor } from "../store/uid-cursor.ts"

export interface RawMessage {
	uid: number
	from: string | undefined
	subject: string | undefined
	/** Plain-text body. */
	text: string
	headers: HeaderLike
	receivedAt: number
}

/**
 * Minimal mail source. `watcher.ts` implements this over imapflow; tests
 * implement it over an in-memory fixture, so the pipeline never needs a socket.
 */
export interface MailSource {
	/** UIDs strictly greater than `afterUid`, ascending. */
	searchAfter(afterUid: number): Promise<number[]>
	/** The message, or undefined when it vanished between search and fetch. */
	fetch(uid: number): Promise<RawMessage | undefined>
}

export interface ScanDeps {
	source: MailSource
	/** HMAC key for routing-token verification. */
	secret: Buffer
	env?: NodeJS.ProcessEnv
	now?: () => number
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
		if (isJournaled(env, uid)) {
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

		const authz = authorize({ from: message.from, headers: message.headers }, config)
		if (!authz.ok) {
			result.rejected++
			bump(result.reasons, authz.reason)
			result.cursor = advanceCursor(env, uid)
			continue
		}

		// Routing token: present and MAC-valid, or the message is not ours.
		const sessionId = sessionIdFromSubject(message.subject, deps.secret, now())
		if (!sessionId) {
			result.rejected++
			bump(result.reasons, "no-token")
			result.cursor = advanceCursor(env, uid)
			continue
		}

		const body = stripQuoted(message.text)
		if (!body) {
			result.rejected++
			bump(result.reasons, "empty-body")
			result.cursor = advanceCursor(env, uid)
			continue
		}

		const record: PendingRecord = {
			uid,
			sessionId,
			from: authz.from,
			subject: message.subject ?? "",
			body,
			receivedAt: message.receivedAt,
		}

		// Persist BEFORE the cursor moves. A crash here leaves the mail unseen.
		addPending(env, record)
		result.persisted++

		result.cursor = advanceCursor(env, uid)
	}

	return result
}
