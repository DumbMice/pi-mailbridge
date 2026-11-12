// Delivery runner — the extension side of claim → inject → ack.
//
// Invariants, in order of importance:
//
//   1. Never inject a delivery for another session. The token already routed it;
//      this is the second check, and it is cheap.
//   2. Never ack a delivery that was not injected. Acking early would mark the
//      mail seen and drop the record, losing the human's reply.
//   3. Never inject the same UID twice *in this process*, even if the ack failed
//      — a reconnect replays /pending, and a duplicate injection is worse than a
//      stale seen-flag.
//   4. A failed claim (another instance owns it) is not an error: leave it alone.
//
// The runner is deliberately synchronous-per-delivery: mail replies are serial and
// ordering them keeps the transcript readable.

import type { PendingRecord } from "../store/pending-store.ts"

/** The daemon calls this runner needs. `createDaemonClient` satisfies it. */
export type ClientResult<T> = { ok: true; data: T } | { ok: false; status: number; code?: string }

export interface DeliveryClient {
	claim(uid: number, instanceId: string): Promise<ClientResult<{ ok: boolean }>>
	ack(uid: number, instanceId: string, sessionId?: string): Promise<ClientResult<{ ok: boolean }>>
	pending(): Promise<ClientResult<{ pending: PendingRecord[] }>>
}

export type DeliveryOutcome =
	| "injected"
	| "already-injected"
	| "foreign-session"
	| "claimed-by-other"
	| "inject-failed"
	| "claim-unconfirmed"
	| "not-found"

export interface DeliveryRunnerDeps {
	client: DeliveryClient
	/** Stable id for this pi process; the daemon uses it for claim exclusivity. */
	instanceId: string
	/** Current session id, or undefined when there is no session. */
	sessionId: () => string | undefined
	/** Inject into the live session. Throw to signal failure (do not ack). */
	inject: (body: string, record: PendingRecord) => Promise<void>
	onError?: (error: Error, record: PendingRecord) => void
}

export interface DeliveryRunner {
	handle(record: PendingRecord): Promise<DeliveryOutcome>
	/** Replay everything the daemon still holds. Used on connect and reconnect. */
	drain(): Promise<DeliveryOutcome[]>
	/** Test/diagnostic: uids injected by this runner. */
	injectedUids(): number[]
}

/** In-flight drains, shared across runner instances in this process. */
const inFlightByInstance = new Map<string, Promise<DeliveryOutcome[]>>()

export function createDeliveryRunner(deps: DeliveryRunnerDeps): DeliveryRunner {
	/** UIDs already injected in this process lifetime. */
	const injected = new Set<number>()

	async function handle(record: PendingRecord): Promise<DeliveryOutcome> {
		if (injected.has(record.uid)) return "already-injected"

		const mine = deps.sessionId()
		if (!mine || record.sessionId !== mine) return "foreign-session"

		const claim = await deps.client.claim(record.uid, deps.instanceId)
		if (!claim.ok) {
			// Expected when another instance won the race; the daemon answers 409.
			if (claim.code === "claimed-by-other") return "claimed-by-other"
			// A timeout means the outcome is unknown: the daemon may have granted the claim,
			// so this is not "the record vanished". It self-heals (the claim TTL expires and
			// the next drain re-claims), but the diagnostic must not lie.
			if (claim.code === "timeout" || claim.code === "network") return "claim-unconfirmed"
			return "not-found"
		}

		try {
			await deps.inject(record.body, record)
		} catch (error) {
			// Do NOT ack: the delivery must stay pending so it is retried.
			deps.onError?.(error instanceof Error ? error : new Error(String(error)), record)
			return "inject-failed"
		}

		// Record before acking: if the ack fails we still refuse to inject twice.
		injected.add(record.uid)

		try {
			const ackResult = await deps.client.ack(record.uid, deps.instanceId, record.sessionId)
			if (!ackResult.ok) {
				// Injected but not acked: the record will be re-offered on reconnect and
				// the `injected` set will absorb it. Surface it — a silent ack failure
				// hides a growing pending queue.
				deps.onError?.(new Error(`ack failed (${ackResult.code ?? ackResult.status})`), record)
			}
		} catch (error) {
			// Injected but not acked: same handling as above.
			deps.onError?.(error instanceof Error ? error : new Error(String(error)), record)
		}

		return "injected"
	}

	return {
		handle,
		injectedUids: () => [...injected],

		async drain() {
			// One drain at a time. The claim registry is keyed per pid, so two overlapping
			// drains in this process would both be granted the same uid and inject twice -
			// and a duplicate injection cannot be undone.
			// Keyed by instanceId, not by this runner object: a respawn builds a new runner
			// while the claim key (the pid) stays the same, so a per-object flag would let an
			// old runner's drain overlap a new one's.
			const running = inFlightByInstance.get(deps.instanceId)
			if (running) return running
			const attempt = (async () => {
				try {
					const result = await deps.client.pending()
					if (!result.ok) return []
					const outcomes: DeliveryOutcome[] = []
					for (const record of result.data.pending) outcomes.push(await handle(record))
					return outcomes
				} finally {
					inFlightByInstance.delete(deps.instanceId)
				}
			})()
			inFlightByInstance.set(deps.instanceId, attempt)
			return attempt
		},
	}
}
