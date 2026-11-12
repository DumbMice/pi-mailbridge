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
	if (!reset) return { reset: false, validity, dropped: 0 }
	// Queued records from the old numbering could collide with new UIDs and be replaced
	// silently. Dropping them is safe: they were never acked, so the mail is still unread and
	// the reset cursor re-reads it. Their decision slots are freed, though, or that session
	// would be told it still has an outstanding decision for up to a day.
	const doomed = listPending(env).filter((r) => r.uidValidity !== undefined && r.uidValidity !== validity)
	const dropped = dropPendingFromOtherSpaces(env, validity)
	for (const record of doomed) onDropped?.(record.sessionId)
	return { reset: true, validity, dropped }
}
