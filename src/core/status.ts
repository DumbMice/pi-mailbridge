// Turning a scan summary into the lines `/mailbridge status` shows.
//
// Pure on purpose: this is the answer to "why did my reply not arrive", and it lived inline
// in the extension where no test could reach it - which is how an unconditional "queue full"
// line shipped in its first version.

import { PENDING_CAP, PENDING_MAX_BYTES } from "../store/pending-store.ts"

export interface ScanSummary {
	/** When the last scan that saw mail ran; absent until one has. */
	at?: number
	/** When the daemon last *checked*, which is later than `at` on a quiet mailbox. */
	checkedAt?: number
	examined?: number
	persisted?: number
	rejected?: number
	reasons?: Record<string, number>
}

/**
 * Counter keys that are not refusals.
 *
 * `routed` / `threaded` / `journaled` / `vanished` are successful paths. `route-miss` is a
 * miss on the subject id that still routed by token or chain. `attachment-*` drops one file
 * but keeps the reply.
 */
const HANDLED = new Set([
	"routed",
	"threaded",
	"journaled",
	"vanished",
	"route-miss",
	// In single-mailbox mode our own notifications come back on every send. Rejecting them is
	// the system working, so counting them as rejections made a healthy install look broken.
	"self-echo",
])

/** Deferred, not dropped: the queue was full and the same UID is retried. */
const DEFERRED = new Set(["pending-full"])

/**
 * Aged out under queue pressure. Not a rejection of anything in *this* scan - the record was
 * already queued and undeliverable - so listing it under "rejections" beside `rejected 0` read
 * as the same contradiction the counter fix was meant to remove.
 */
const EXPIRED = new Set(["expired"])

/**
 * The queue's two bounds, named from the constants.
 *
 * Hardcoding the numbers here is how the panel would start lying the day one of them changed -
 * with a green suite, because the only assertion matched the words "queue full".
 */
export function queueLimits(): string {
	return `${PENDING_CAP} replies or ${Math.round(PENDING_MAX_BYTES / 1024 / 1024)} MB queued`
}

export function formatScan(summary: ScanSummary | null | undefined): string[] {
	if (!summary) return ["last scan: (never — is the daemon running?)"]
	if (summary.at === undefined) {
		// No scan has seen mail yet. Say when we last looked: otherwise a healthy quiet
		// mailbox is indistinguishable from a dead poll loop.
		const checked = summary.checkedAt ? new Date(summary.checkedAt).toLocaleTimeString() : "unknown"
		return [`no mail yet — last checked ${checked}`]
	}

	const entries = Object.entries(summary.reasons ?? {}).filter(([, n]) => Number(n) > 0)
	const list = (pick: (reason: string) => boolean): string =>
		entries
			.filter(([reason]) => pick(reason))
			.map(([reason, n]) => `${reason} ${n}`)
			.join(", ")

	const refused = list((r) => !HANDLED.has(r) && !DEFERRED.has(r) && !EXPIRED.has(r) && !r.startsWith("attachment-"))
	const expired = list((r) => EXPIRED.has(r))
	const handled = list((r) => HANDLED.has(r))
	const dropped = list((r) => r.startsWith("attachment-"))
	const deferred = entries.some(([reason]) => DEFERRED.has(reason))

	// Freshness stays visible after the first message: "last scan with mail: 10:00" alone cannot
	// tell a live poll loop from one that died at 10:05.
	const checked =
		summary.checkedAt && summary.checkedAt - summary.at > 60_000
			? ` (last checked ${new Date(summary.checkedAt).toLocaleTimeString()})`
			: ""

	return [
		`last scan with mail: ${new Date(summary.at).toLocaleTimeString()}${checked} — examined ${summary.examined}, kept ${summary.persisted}, rejected ${summary.rejected}`,
		`rejections: ${refused || "none"}`,
		...(handled ? [`handled: ${handled}`] : []),
		...(dropped ? [`attachments dropped: ${dropped}`] : []),
		...(expired ? [`aged out under queue pressure: ${expired}`] : []),
		// Conditional, and it says what the reader should do about it. Both bounds are named: a
		// byte-full queue can hold six replies, so the count alone read as a contradiction with
		// the "pending replies: 6" line right above it.
		...(deferred
			? [`queue full: ${queueLimits()} — deferred, not dropped; start a session so they drain`]
			: []),
	]
}
