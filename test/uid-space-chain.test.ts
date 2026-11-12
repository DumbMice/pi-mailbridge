import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDaemonService } from "../src/daemon/service.ts"
import { createDaemonClient } from "../src/daemon/spawn.ts"
import { createDeliveryRunner } from "../src/core/deliveries.ts"
import { addPending, listPending } from "../src/store/pending-store.ts"
import { isJournaled } from "../src/store/journal.ts"
import type { ResolvedConfig } from "../src/core/config.ts"

// The whole real chain: delivery runner -> daemon client -> HTTP service -> store.
// Four times a guard existed in the store but was dropped by an adapter on the way in, and
// each time the unit tests stayed green because they only exercised one hop. This drives
// every hop with the production implementations.

const TOKEN = "test-token"

function config(): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "you@qq.com", password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: "you@qq.com", password: "x", authType: "LOGIN" },
			to: "you@qq.com",
		},
		security: { allowFrom: ["you@qq.com"], requireDmarcPass: false, allowSelfReplies: true, tokenTtlHours: 24 },
		daemon: { host: "127.0.0.1", port: 4177, exitWhenIdle: true, idleTimeoutSecs: 120 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
	} as ResolvedConfig
}

async function chain(opts: { validity: number; recordValidity: number }) {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-chain-")) }
	addPending(env, {
		uid: 7,
		sessionId: "sess-1",
		from: "you@qq.com",
		subject: "re",
		body: "yes",
		receivedAt: 1,
		uidValidity: opts.recordValidity,
	})
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => opts.validity, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	const client = createDaemonClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN })
	const injected: string[] = []
	const runner = createDeliveryRunner({
		client: {
			claim: (uid, id, v) => client.claim(uid, id, v),
			ack: (uid, id, s, v) => client.ack(uid, id, s, v),
			pending: () => client.pending(),
		},
		instanceId: "inst",
		sessionId: () => "sess-1",
		inject: async (body) => {
			injected.push(body)
		},
	})
	const outcomes = await runner.drain()
	await service.close()
	return { outcomes, injected, pending: listPending(env), env }
}

test("the real chain refuses a claim or ack from another UID space", async () => {
	// The store now holds the NEW record (space 2222). A runner still holding the old one
	// (1111) must not claim it: claim + inject + ack would delete the new reply, journal its
	// UID and mark it \Seen while the cursor is already past it.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-chain-")) }
	addPending(env, {
		uid: 7,
		sessionId: "sess-1",
		from: "you@qq.com",
		subject: "re",
		body: "NEW reply",
		receivedAt: 1,
		uidValidity: 2222,
	})
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => 2222, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	const client = createDaemonClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN })
	try {
		const stale = await client.claim(7, "inst", 1111)
		assert.equal(stale.ok, false)
		assert.equal(!stale.ok && stale.code, "stale-space", "claim refused across the space boundary")

		const fresh = await client.claim(7, "inst", 2222)
		assert.equal(fresh.ok, true, "the right space claims normally")

		const staleAck = await client.ack(7, "inst", "sess-1", 1111)
		assert.equal(staleAck.ok, false, "ack refused across the space boundary")
		assert.equal(listPending(env).length, 1, "the new reply survives")

		const freshAck = await client.ack(7, "inst", "sess-1", 2222)
		assert.equal(freshAck.ok, true)
		assert.equal(listPending(env).length, 0)
		assert.equal(isJournaled(env, 7, 2222), true, "journaled in the record's space")
		assert.equal(isJournaled(env, 7, 1111), false, "and not in the stale one")
	} finally {
		await service.close()
	}
})
