// "Watch from now on": skip the mail that is already in the mailbox.
//
// This is a first-run decision, not an operation. The scanner polls `UID <cursor>+1:*`, so
// moving the cursor past unscanned mail makes it permanently invisible to the bridge: no
// ack, no `\Seen`, no error - just a reply nobody ever answers. That is only possible when a
// cursor already exists, which is why priming refuses to run a second time (a `/mailbridge
// on` that processes what arrived meanwhile depends on that cursor staying put).
//
// Both the CLI (`--prime`) and the in-pi command go through here, so the two cannot disagree
// about when it is allowed.

import type { ResolvedConfig } from "./config.ts"

export type PrimePlan =
	| { ok: false; currentUid: number }
	| { ok: true; highest: number; count: number; currentUid: number }

/**
 * Decide whether to prime, given the stored cursor and the mailbox's UIDs.
 *
 * Pure: the callers do the IMAP work, so the rule is testable without a server.
 */
export function planPrime(currentUid: number, uids: readonly number[], alreadyWatching: boolean): PrimePlan {
	// Neither "the file exists" nor "uid > 0" answers this on its own. The daemon writes the file
	// on its first connect, before reading anything (a fresh install wants prime); a renumbering
	// resets the uid to 0 while the mailbox is already being watched (prime would skip exactly
	// the mail the reset was meant to re-read). The caller passes a flag set by prime itself.
	if (alreadyWatching) return { ok: false, currentUid }
	const highest = uids.length > 0 ? Math.max(...uids) : 0
	return { ok: true, highest, count: uids.length, currentUid }
}

/** The message shown when priming is refused, in both surfaces. */
export function alreadyPrimedMessage(currentUid: number): string {
	return (
		`already watching from uid ${currentUid} - prime is a first-run step, and moving the cursor ` +
		`now would skip any reply that arrived while the bridge was not scanning. ` +
		`To re-prime deliberately, remove uid-cursor.json from the state directory.`
	)
}

export interface PrimeDeps {
	/** Injected so the two surfaces can share this without importing each other's plumbing. */
	openMailbox: (config: ResolvedConfig) => Promise<{
		search: () => Promise<number[]>
		close: () => Promise<void>
	}>
	readCursor: () => number
	/** Whether this mailbox is already being watched; see isPrimed. */
	isPrimed: () => boolean
	/** Record that prime ran, so the next attempt refuses. */
	markPrimed: () => void
	advanceCursor: (uid: number) => void
}

/**
 * Run the check, and only touch the cursor when the plan allows it.
 *
 * The mailbox is still searched when priming is refused: the count is what makes the refusal
 * concrete ("3 messages are in that range"), and a search is cheap.
 */
export async function runPrime(config: ResolvedConfig, deps: PrimeDeps): Promise<PrimePlan> {
	const mailbox = await deps.openMailbox(config)
	try {
		const plan = planPrime(deps.readCursor(), await mailbox.search(), deps.isPrimed())
		if (plan.ok) {
			deps.advanceCursor(plan.highest)
			deps.markPrimed()
		}
		return plan
	} finally {
		await mailbox.close().catch(() => undefined)
	}
}
