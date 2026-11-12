// One scan at a time, with at most one queued behind it.
//
// Three things ask for a scan concurrently: an IMAP `exists`, a reconnect's catch-up, and
// mode turning on. Overlapping scans are not harmless - two that pass the journal check
// before either persists would deliver the same reply twice, which is the one outcome this
// design cannot undo. A burst of IDLE events also should not become a burst of full scans,
// so a request that arrives while one is running coalesces into a single follow-up.

export interface ScanQueue {
	(why: string): Promise<void>
	/** True while a scan is running or one is queued. */
	busy(): boolean
}

export function createScanQueue(run: (why: string) => Promise<void>): ScanQueue {
	let current: Promise<void> | undefined
	let queued: string | undefined

	const start = (why: string): Promise<void> => {
		current = (async () => {
			try {
				await run(why)
			} catch {
				// A scan failure is logged by the caller; the queue must survive it.
			} finally {
				current = undefined
				if (queued !== undefined) {
					const next = queued
					queued = undefined
					void start(next)
				}
			}
		})()
		return current
	}

	const scan = (why: string): Promise<void> => {
		if (!current) return start(why)
		// Coalesce: one follow-up covers any number of requests that arrive mid-scan.
		queued ??= why
		return current
	}

	return Object.assign(scan, { busy: () => current !== undefined })
}
