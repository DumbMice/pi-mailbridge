// How much mail this daemon will send per minute.
//
// The delivery path is model-driven: `notify_user` and settle notifications can be produced by an
// agent, and an injected agent can ask for a great many. Providers answer a burst by throttling
// the account or refusing for the day, which silences the notifications that actually matter.
// A small sliding window keeps a loop from spending the quota.
//
// Deliberately not a queue: a refused send is reported to the caller (`429 send_budget`), so the
// agent sees it and the human is not mailed a backlog of stale notifications later.

export interface SendBudget {
	/** True when a send is allowed now; consumes one slot. */
	take(now: number): boolean
	/** Slots used inside the current window, for tests and diagnostics. */
	used(now: number): number
}

export function createSendBudget(options: { limit: number; windowMs: number }): SendBudget {
	const sent: number[] = []
	const prune = (now: number): void => {
		const floor = now - options.windowMs
		while (sent.length > 0 && sent[0]! <= floor) sent.shift()
	}
	return {
		take(now: number) {
			prune(now)
			if (sent.length >= options.limit) return false
			sent.push(now)
			return true
		},
		used(now: number) {
			prune(now)
			return sent.length
		},
	}
}
