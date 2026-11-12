import { test } from "node:test"
import assert from "node:assert/strict"

import { createDeliveryRunner, type DeliveryClient, type DeliveryOutcome } from "../src/core/deliveries.ts"
import type { PendingRecord } from "../src/store/pending-store.ts"

const SESSION = "sess-1"

function record(over: Partial<PendingRecord> = {}): PendingRecord {
	return { uid: 1, sessionId: SESSION, from: "you@example.com", subject: "re", body: "yes, ship it", receivedAt: 1, ...over }
}

interface FakeClient extends DeliveryClient {
	calls: string[]
	acked: number[]
	claimed: { uid: number; instanceId: string }[]
}

function fakeClient(opts: { claimOk?: boolean; claimCode?: string; ackOk?: boolean; pending?: PendingRecord[] } = {}): FakeClient {
	const calls: string[] = []
	const acked: number[] = []
	const claimed: { uid: number; instanceId: string }[] = []
	return {
		calls,
		acked,
		claimed,
		async claim(uid, instanceId) {
			calls.push(`claim:${uid}`)
			claimed.push({ uid, instanceId })
			if (opts.claimOk === false) {
				// The daemon answers 404 for a record that is gone and 409 for a lost race.
				const code = opts.claimCode ?? "claimed-by-other"
				return { ok: false, status: code === "not-found" ? 404 : 409, code }
			}
			return { ok: true, data: { ok: true } }
		},
		async ack(uid) {
			calls.push(`ack:${uid}`)
			acked.push(uid)
			if (opts.ackOk === false) return { ok: false, status: 500, code: "boom" }
			return { ok: true, data: { ok: true } }
		},
		async pending() {
			calls.push("pending")
			if (!opts.pending) return { ok: false, status: 0, code: "network" }
			return { ok: true, data: { pending: opts.pending } }
		},
	}
}

// Each runner gets its own instance id, as each pi process does: the injected-UID set is
// shared per instance (deliberately - see createDeliveryRunner), so a fixed id across tests
// would make one test's injections visible to the next.
let instanceSeq = 0
function runner(
	client: DeliveryClient,
	injectImpl: (body: string) => Promise<void>,
	sessionId: () => string | undefined = () => SESSION,
	instanceId = `instance-${++instanceSeq}`,
) {
	const injected: string[] = []
	const errors: Error[] = []
	return {
		injected,
		errors,
		r: createDeliveryRunner({
			client,
			instanceId,
			sessionId,
			inject: async (body) => {
				injected.push(body)
				await injectImpl(body)
			},
			onError: (e) => errors.push(e),
		}),
	}
}

test("injects and acks a delivery for this session", async () => {
	const client = fakeClient()
	const { r, injected } = runner(client, async () => {})
	assert.equal(await r.handle(record()), "injected")
	assert.deepEqual(injected, ["yes, ship it"])
	assert.deepEqual(client.acked, [1])
	assert.deepEqual(client.calls, ["claim:1", "ack:1"], "claim precedes ack")
	assert.match(client.claimed[0]!.instanceId, /^instance-\d+$/, "claimed as this runner's instance")
})

test("a delivery for another session is never claimed or injected", async () => {
	const client = fakeClient()
	const { r, injected } = runner(client, async () => {})
	assert.equal(await r.handle(record({ sessionId: "someone-else" })), "foreign-session")
	assert.deepEqual(injected, [])
	assert.deepEqual(client.calls, [], "no daemon round-trip at all")
})

test("no session means nothing is claimed", async () => {
	const client = fakeClient()
	const { r } = runner(client, async () => {}, () => undefined)
	assert.equal(await r.handle(record()), "foreign-session")
	assert.deepEqual(client.calls, [])
})

test("a failed injection is NOT acked, so the reply can be retried", async () => {
	const client = fakeClient()
	const { r, errors } = runner(client, async () => {
		throw new Error("session busy")
	})
	assert.equal(await r.handle(record()), "inject-failed")
	assert.deepEqual(client.acked, [], "must not ack")
	assert.equal(errors.length, 1)
	assert.match(errors[0]!.message, /session busy/)
})

test("a claimed-by-other delivery is left alone", async () => {
	const client = fakeClient({ claimOk: false, claimCode: "claimed-by-other" })
	const { r, injected } = runner(client, async () => {})
	assert.equal(await r.handle(record()), "claimed-by-other")
	assert.deepEqual(injected, [])
	assert.deepEqual(client.acked, [])
})

test("an unknown uid is reported, not treated as a crash", async () => {
	const client = fakeClient({ claimOk: false, claimCode: "not-found" })
	const { r } = runner(client, async () => {})
	assert.equal(await r.handle(record()), "not-found")
})

test("a replayed delivery is not injected twice in the same process", async () => {
	const client = fakeClient()
	const { r, injected } = runner(client, async () => {})
	assert.equal(await r.handle(record()), "injected")
	assert.equal(await r.handle(record()), "already-injected")
	assert.deepEqual(injected, ["yes, ship it"], "injected exactly once")
	// A replay re-acks (idempotent) rather than skipping: that is what lets a failed ack
	// recover on the next drain.
	assert.deepEqual(client.acked, [1, 1], "re-acked on replay, injected once")
})

test("drain replays pending and skips uids already injected", async () => {
	const client = fakeClient({
		pending: [record({ uid: 1 }), record({ uid: 2, body: "second" }), record({ uid: 3, sessionId: "other" })],
	})
	const { r, injected } = runner(client, async () => {})
	const outcomes: DeliveryOutcome[] = await r.drain()
	assert.deepEqual(outcomes, ["injected", "injected", "foreign-session"])
	assert.deepEqual(injected, ["yes, ship it", "second"])

	// A reconnect replays everything again; nothing is re-injected.
	const again = await r.drain()
	assert.deepEqual(again, ["already-injected", "already-injected", "foreign-session"])
	assert.equal(injected.length, 2)
})

test("a failed ack does not cause a double injection later in the process", async () => {
	const client = fakeClient({ ackOk: false })
	const { r, injected, errors } = runner(client, async () => {})
	assert.equal(await r.handle(record()), "injected")
	assert.equal(errors.length, 1, "ack failure surfaced")
	// The record is still in /pending because the ack failed.
	const again = await r.handle(record())
	assert.equal(again, "already-injected")
	assert.deepEqual(injected, ["yes, ship it"], "in-process guard held")
})

test("drain tolerates an unreachable daemon", async () => {
	const client = fakeClient()
	const { r } = runner(client, async () => {})
	assert.deepEqual(await r.drain(), [])
})

test("injectedUids reports what this runner has accepted", async () => {
	const client = fakeClient()
	const { r } = runner(client, async () => {})
	await r.handle(record({ uid: 11 }))
	await r.handle(record({ uid: 12 }))
	assert.deepEqual(r.injectedUids().sort(), [11, 12])
})

test("two overlapping drains inject once", async () => {
	// The claim registry is keyed per pid, so a second concurrent drain in this process is
	// granted the same uid - and a duplicate injection cannot be undone.
	let injected = 0
	let claims = 0
	const runner = createDeliveryRunner({
		client: {
			pending: async () => ({ ok: true, data: { pending: [record()] } }),
			claim: async () => {
				claims++
				await new Promise((r) => setTimeout(r, 5))
				return { ok: true, data: { ok: true } }
			},
			ack: async () => ({ ok: true, data: { ok: true } }),
		} as never,
		instanceId: "inst",
		sessionId: () => SESSION,
		inject: async () => {
			injected++
			await new Promise((r) => setTimeout(r, 5))
		},
	})
	await Promise.all([runner.drain(), runner.drain()])
	assert.equal(injected, 1, "serialized: the second drain rides the first")
	assert.equal(claims, 1)
})

test("a claim that could not be confirmed is not reported as 'not-found'", async () => {
	// Only a definite 404 means the record vanished. A timeout, a rotated secret (401) or a
	// bad request leave the outcome unknown, and the diagnostic must not claim otherwise.
	for (const [code, status] of [
		["timeout", 0],
		["network", 0],
		["unauthorized", 401],
	] as const) {
		const client = fakeClient({ claimOk: false, claimCode: code })
		const { r } = runner(client, async () => {})
		const outcome = await r.handle(record())
		assert.equal(outcome, "claim-unconfirmed", `${code} must not read as not-found`)
	}
	const gone = fakeClient({ claimOk: false, claimCode: "not-found" })
	const { r } = runner(gone, async () => {})
	assert.equal(await r.handle(record()), "not-found", "a 404 really is gone")
})

test("a rebuilt runner with the same instance does not re-inject after a failed ack", async () => {
	// A respawn (or a new session in the same pi process) builds a new runner while the
	// claim key - the pid - stays the same, so claimPending re-grants the record. The
	// injected-UID set must therefore be per instance, not per runner object.
	const instance = "instance-shared"
	const client = fakeClient({ ackOk: false })
	const first = runner(client, async () => {}, () => SESSION, instance)
	assert.equal(await first.r.handle(record()), "injected")
	assert.equal(client.acked.length, 1, "the ack was attempted and failed")

	const second = runner(client, async () => {}, () => SESSION, instance)
	assert.equal(await second.r.handle(record()), "already-injected")
	assert.deepEqual(second.injected, [], "the rebuilt runner must not inject it again")
	assert.equal(client.acked.length, 2, "and it retried the failed ack")
})

test("a failed ack is retried on the next drain instead of pinning the record", async () => {
	// Without the retry the record stays pending forever: it holds a queue slot, \Seen is
	// never set, the journal is never written, and after a restart it is injected again.
	const client = fakeClient({ pending: [record()] })
	let acks = 0
	client.ack = async () => {
		acks++
		return acks === 1
			? { ok: false as const, status: 502, code: "boom" }
			: { ok: true as const, data: { ok: true } }
	}
	const { r, injected } = runner(client, async () => {})

	assert.deepEqual(await r.drain(), ["injected"])
	assert.equal(acks, 1, "the first ack failed")
	assert.equal(injected.length, 1)

	// The record is still pending; the next drain must retry the ack, not skip silently.
	assert.deepEqual(await r.drain(), ["already-injected"])
	assert.equal(acks, 2, "the ack was retried")
	assert.equal(injected.length, 1, "and it was not injected twice")
})
