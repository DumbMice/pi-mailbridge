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
	claim(uid: number, instanceId: string, uidValidity?: number): Promise<ClientResult<{ ok: boolean }>>
	ack(uid: number, instanceId: string, sessionId?: string, uidValidity?: number): Promise<ClientResult<{ ok: boolean }>>
	pending(): Promise<ClientResult<{ pending: PendingRecord[] }>>
}

export type DeliveryOutcome =
	| "injected"
	| "already-injected"
	| "foreign-session"
	| "claimed-by-other"
	| "inject-failed"
	| "claim-unconfirmed"
	| "stale-space"
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

/**
 * UIDs already injected, per instance.
 *
 * Per instance, not per runner object: a rebuilt runtime (a respawn, or a new session in
 * the same pi process after session_shutdown) constructs a new runner while the claim key -
 * the pid - stays the same. A per-runner set let the rebuilt runner re-inject a reply whose
 * ack had failed, which is the one failure this design cannot undo.
 */
const injectedByInstance = new Map<string, Set<string>>()
/** A process has one instanceId; this only guards against a pathological caller. */
const MAX_INSTANCE_SETS = 8
/** Cap per instance, like the journal: one key per injected message, oldest dropped. */
const MAX_INJECTED_PER_INSTANCE = 5_000

/** UIDs are only unique within a UIDVALIDITY, so the key must carry it. */
function injectionKey(record: { uid: number; uidValidity?: number }): string {
	return `${record.uidValidity ?? ""}:${record.uid}`
}

function injectedFor(instanceId: string): Set<string> {
	let set = injectedByInstance.get(instanceId)
	if (!set) {
		set = new Set<string>()
		injectedByInstance.set(instanceId, set)
		if (injectedByInstance.size > MAX_INSTANCE_SETS) {
			const oldest = injectedByInstance.keys().next().value
			// Never evict the caller's own set: losing it would let this instance re-inject.
			if (oldest !== undefined && oldest !== instanceId) injectedByInstance.delete(oldest)
		}
	}
	return set
}

export function createDeliveryRunner(deps: DeliveryRunnerDeps): DeliveryRunner {
	/** Stale-space refusals already reported, so a stuck record does not log every poll. */
	const reported = new Set<string>()
	const injected = (): Set<string> => injectedFor(deps.instanceId)

	async function handle(record: PendingRecord): Promise<DeliveryOutcome> {
		if (injected().has(injectionKey(record))) {
			// Injected earlier but possibly not acked: a single failed /ack used to pin the
			// record for the process lifetime, leaking a queue slot, leaving \Seen unset and
			// the journal unwritten - and after a restart (new pid, new instance) the same
			// instruction would be injected again. The ack is idempotent, so retry it.
			try {
				const retried = await deps.client.ack(record.uid, deps.instanceId, record.sessionId, record.uidValidity)
				// A retry that keeps failing is the same silent leak as a first ack that
				// failed: surface it rather than looping quietly.
				if (!retried.ok && retried.status !== 404) {
					deps.onError?.(new Error(`ack retry failed (${retried.code ?? retried.status})`), record)
				}
			} catch (error) {
				deps.onError?.(error instanceof Error ? error : new Error(String(error)), record)
			}
			return "already-injected"
		}

		const mine = deps.sessionId()
		if (!mine || record.sessionId !== mine) return "foreign-session"

		const claim = await deps.client.claim(record.uid, deps.instanceId, record.uidValidity)
		if (!claim.ok) {
			// Expected when another instance won the race; the daemon answers 409.
			if (claim.code === "claimed-by-other") return "claimed-by-other"
			// The record belongs to a UID numbering the mailbox has left. It cannot be delivered
			// and is dropped at the next connect; say so once rather than retrying in silence
			// every poll tick.
			if (claim.code === "stale-space") {
				const key = injectionKey(record)
				if (!reported.has(key)) {
					reported.add(key)
					deps.onError?.(new Error("reply belongs to an earlier UID space; it will be dropped"), record)
				}
				return "stale-space"
			}
			// Only a definite 404 means the record is gone. Anything else - a timeout, a
			// network error, a rotated secret (401) - leaves the outcome unknown, and calling
			// that "not-found" is the same lie in a different costume. It self-heals (the
			// claim TTL expires, the next drain re-claims), but the diagnostic must not mislead.
			if (claim.status === 404) return "not-found"
			return "claim-unconfirmed"
		}

		try {
			await deps.inject(record.body, record)
		} catch (error) {
			// Do NOT ack: the delivery must stay pending so it is retried.
			deps.onError?.(error instanceof Error ? error : new Error(String(error)), record)
			return "inject-failed"
		}

		// Record before acking: if the ack fails we still refuse to inject twice.
		const set = injected()
		set.add(injectionKey(record))
		// Bounded like the journal. Evicting an entry whose ack never landed would let it be
		// injected again, so this is a last resort, not a free trade.
		while (set.size > MAX_INJECTED_PER_INSTANCE) {
			const oldest = set.values().next().value
			if (oldest === undefined) break
			set.delete(oldest)
		}

		try {
			const ackResult = await deps.client.ack(record.uid, deps.instanceId, record.sessionId, record.uidValidity)
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
		injectedUids: () => [...injected()].map((key) => Number(key.split(":")[1])),

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
