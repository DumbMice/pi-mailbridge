// The MailSource the daemon actually hands to the scanner and the HTTP service.
//
// This is a seam, not a convenience: it exists so a test can exercise exactly what production
// wires up. Three rounds of "the guard is inert in production" came from code that was only
// ever tested through a hand-built fixture, so the proxy and the UIDVALIDITY bookkeeping live
// here, in one small file, where they can be driven directly.

import { dropPendingFromOtherSpaces, listPending } from "../store/pending-store.ts"
import { syncUidValidity } from "../store/uid-cursor.ts"
import type { MailSource } from "./process.ts"

/** What the proxy needs from the watcher. */
export interface ProxyTarget extends MailSource {
	uidValidity(): number | undefined
	uidNext(): number | undefined
}

export interface SourceProxyDeps {
	/** The current watcher, or undefined while it is stopped or being replaced. */
	watcher: () => ProxyTarget | undefined
	env?: NodeJS.ProcessEnv
}

export function createSourceProxy(deps: SourceProxyDeps): MailSource {
	const target = (): ProxyTarget => {
		const watcher = deps.watcher()
		if (!watcher) throw new Error("pi-mailbridge: imap watcher not started")
		return watcher
	}
	return {
		searchAfter: (uid) => target().searchAfter(uid),
		fetch: (uid) => target().fetch(uid),
		markSeen: async (uid) => {
			await deps.watcher()?.markSeen?.(uid)
		},
		// Every call reads the live watcher: the daemon swaps watchers on reload, and a
		// captured reference would answer from the old connection.
		uidValidity: () => deps.watcher()?.uidValidity(),
	}
}

export interface UidValidityOutcome {
	reset: boolean
	validity: number | undefined
	dropped: number
}

/**
 * Compare the mailbox's UIDVALIDITY with the recorded one, and reset what a renumbering
 * invalidates.
 *
 * Called on every successful connect. A renumbering cannot be detected by the cursor alone,
 * so this is the only place it is noticed - and the only place its consequences are undone.
 */
export function applyUidValidity(
	env: NodeJS.ProcessEnv,
	watcher: ProxyTarget | undefined,
	onDropped?: (sessionId: string) => void,
): UidValidityOutcome {
	const validity = watcher?.uidValidity()
	if (validity === undefined) return { reset: false, validity, dropped: 0 }
	const reset = syncUidValidity(env, validity, watcher?.uidNext())
	// Drop on EVERY connect, not only on a reset: a crash between the cursor write and the
	// drop leaves records from another space that nothing can claim (the guard refuses them)
	// and nothing would ever remove, because the cursor already carries the new validity.
	// Queued records from the wrong numbering could collide with new UIDs and be replaced
	// silently. Dropping them is safe: they were never acked, so the mail is still unread.
	// On a reset the cursor re-reads it; on the orphan path (no reset) the message is behind
	// an already-advanced cursor, which is why the drop runs every connect. Their decision
	// slots are freed, or that session would be told it has an outstanding decision for a day.
	const dropped = dropPendingFromOtherSpaces(env, validity)
	if (dropped.length > 0) {
		// Only free a slot the dropped record was holding: a session that still has a live
		// record in the current space must keep its reservation, or it could be granted a
		// second decision while the first is unanswered.
		const stillQueued = new Set(listPending(env).map((r) => r.sessionId))
		for (const record of dropped) {
			if (!stillQueued.has(record.sessionId)) onDropped?.(record.sessionId)
		}
	}
	return { reset, validity, dropped: dropped.length }
}
