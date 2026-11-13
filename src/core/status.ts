// Turning a scan summary into the lines `/mailbridge status` shows.
//
// Pure on purpose: this is the answer to "why did my reply not arrive", and it lived inline
// in the extension where no test could reach it - which is how an unconditional "queue full"
// line shipped in its first version.

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

	const refused = list((r) => !HANDLED.has(r) && !DEFERRED.has(r) && !r.startsWith("attachment-"))
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
		// Conditional, and it says what the reader should do about it. Both bounds are named: a
		// byte-full queue can hold six replies, so "1 000" alone read as a contradiction with the
		// "pending replies: 6" line right above it.
		...(deferred
			? ["queue full: 1 000 replies or 8 MB queued — deferred, not dropped; start a session so they drain"]
			: []),
	]
}
