import { test } from "node:test"
import assert from "node:assert/strict"

import { alreadyPrimedMessage, planPrime, runPrime } from "../src/core/prime.ts"
import type { ResolvedConfig } from "../src/core/config.ts"

const config = { mail: { imap: { folder: "INBOX" }, to: "" } } as unknown as ResolvedConfig

test("prime is allowed only with no cursor", () => {
	assert.deepEqual(planPrime(0, [3, 9, 12]), { ok: true, highest: 12, count: 3, currentUid: 0 })
	// An empty mailbox cannot prime past anything, and must not move the cursor.
	assert.deepEqual(planPrime(0, []), { ok: true, highest: 0, count: 0, currentUid: 0 })

	// A cursor means the bridge has been watching: moving it now would skip mail that arrived
	// unscanned (mode off, daemon down) - no ack, no \Seen, no error, just silence.
	assert.deepEqual(planPrime(4747, [4748, 4749]), { ok: false, currentUid: 4747 })
})

test("a refused prime does not touch the cursor", async () => {
	const advanced: number[] = []
	let closed = false
	const plan = await runPrime(config, {
		openMailbox: async () => ({
			search: async () => [500, 501],
			close: async () => {
				closed = true
			},
		}),
		readCursor: () => 4747,
		advanceCursor: (uid) => advanced.push(uid),
	})
	assert.equal(plan.ok, false)
	assert.deepEqual(advanced, [], "the cursor must stay where it was")
	assert.equal(closed, true, "and the connection is still closed")
})

test("the refusal says what to do about a deliberate re-prime", () => {
	const message = alreadyPrimedMessage(4747)
	assert.match(message, /4747/)
	assert.match(message, /remove uid-cursor\.json/i)
})
