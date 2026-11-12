// End-to-end: a real mailbox event becomes a real session message, exactly once.
//
// Everything here is the production code path except the two edges:
//   - the IMAP server is a fake MailSource
//   - pi.sendUserMessage is a recording function
//
// The daemon is a real HTTP server, the client is the real fetch client, the
// runner is the real claim→inject→ack loop, and the stores are real files.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ResolvedConfig } from "../src/core/config.ts"
import { signToken } from "../src/core/token.ts"
import { scanAndProcess, type MailSource, type RawMessage } from "../src/daemon/process.ts"
import { createDaemonService } from "../src/daemon/service.ts"
import { createDaemonClient } from "../src/daemon/spawn.ts"
import { createDeliveryRunner } from "../src/core/deliveries.ts"
import { listPending } from "../src/store/pending-store.ts"
import { isJournaled } from "../src/store/journal.ts"
import { readCursor } from "../src/store/uid-cursor.ts"

const SECRET = Buffer.alloc(32, 11)
const TOKEN = SECRET.toString("base64url")
const SESSION = "01a1c453-f2fc-7169-8c89-69c93fa1a152"
const HUMAN = "you@example.com"
const MAILBOX = "pi@example.com"

function config(): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: MAILBOX, password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: MAILBOX, password: "x", authType: "LOGIN" },
			to: HUMAN,
		},
		security: { allowFrom: [HUMAN], requireDmarcPass: true, trustedAuthservId: "mx.example.com", tokenTtlHours: 24 },
		daemon: { host: "127.0.0.1", port: 0 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
	}
}

function reply(uid: number, body = "yes, ship it"): RawMessage {
	return {
		uid,
		from: HUMAN,
		subject: `Re: [pi:${signToken(SESSION, SECRET)}] pi: fix-login is waiting for you`,
		text: [body, "", "On Tue, pi <pi@example.com> wrote:", "> original question"].join("\n"),
		headers: { authResults: ["mx.example.com; spf=pass; dmarc=pass header.from=example.com"] },
		receivedAt: 1_700_000_000_000,
	}
}

interface Rig {
	env: NodeJS.ProcessEnv
	markedSeen: number[]
	source: (messages: RawMessage[]) => MailSource
	service: ReturnType<typeof createDaemonService>
	baseUrl: string
	close(): Promise<void>
}

async function boot(): Promise<Rig> {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-e2e-")) }
	const markedSeen: number[] = []
	let current: RawMessage[] = []

	const source = (messages: RawMessage[]): MailSource => {
		current = messages
		return {
			uidValidity: () => undefined,
			async searchAfter(afterUid) {
				return current.filter((m) => m.uid > afterUid).map((m) => m.uid)
			},
			async fetch(uid) {
				return current.find((m) => m.uid === uid)
			},
			async markSeen(uid) {
				markedSeen.push(uid)
			},
		}
	}

	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: source([]),
		send: async () => {},
	})

	const { port } = await service.listen(0, "127.0.0.1")
	return {
		env,
		markedSeen,
		source,
		service,
		baseUrl: `http://127.0.0.1:${port}`,
		close: () => service.close(),
	}
}

test("a reply travels mailbox → scan → daemon → inject → ack exactly once", { timeout: 30_000 }, async () => {
	const rig = await boot()
	try {
		const source = rig.source([reply(1)])

		// 1. The daemon's scan persists the reply and advances the cursor.
		const scan = await scanAndProcess(config(), { source, secret: SECRET, env: rig.env })
		assert.equal(scan.persisted, 1)
		assert.equal(readCursor(rig.env), 1)
		assert.equal(listPending(rig.env).length, 1)

		// 2. The extension sees it and claims/injects/acks through the real client.
		const injected: string[] = []
		const runner = createDeliveryRunner({
			client: createDaemonClient({ baseUrl: rig.baseUrl, token: TOKEN }),
			instanceId: "instance-1",
			sessionId: () => SESSION,
			inject: async (body) => {
				injected.push(body)
			},
		})

		const outcomes = await runner.drain()
		assert.deepEqual(outcomes, ["injected"])
		assert.deepEqual(injected, ["yes, ship it"], "quoted text stripped before injection")

		// 3. Ack removed the record and journalled the uid; the mail is now seen.
		assert.equal(listPending(rig.env).length, 0)
		assert.equal(isJournaled(rig.env, 1), true)
		assert.deepEqual(rig.markedSeen, [1])

		// 4. A second scan finds nothing new and cannot redeliver.
		const rescan = await scanAndProcess(config(), { source, secret: SECRET, env: rig.env })
		assert.equal(rescan.examined, 0)
		assert.deepEqual(await runner.drain(), [])
		assert.equal(injected.length, 1, "still exactly one injection")
	} finally {
		await rig.close()
	}
})

test("an injection failure keeps the reply pending and it is delivered once on retry", { timeout: 30_000 }, async () => {
	const rig = await boot()
	try {
		const source = rig.source([reply(2, "retry me")])
		await scanAndProcess(config(), { source, secret: SECRET, env: rig.env })

		let attempt = 0
		const injected: string[] = []
		const runner = createDeliveryRunner({
			client: createDaemonClient({ baseUrl: rig.baseUrl, token: TOKEN }),
			instanceId: "instance-1",
			sessionId: () => SESSION,
			inject: async (body) => {
				attempt++
				if (attempt === 1) throw new Error("session busy")
				injected.push(body)
			},
		})

		// First pass: claimed, injection failed, NOT acked.
		assert.deepEqual(await runner.drain(), ["inject-failed"])
		assert.equal(listPending(rig.env).length, 1, "record survives a failed injection")
		assert.equal(isJournaled(rig.env, 2), false, "not journalled")
		assert.deepEqual(rig.markedSeen, [], "mail not marked seen")

		// Second pass: the daemon still holds it, so the same runner retries.
		assert.deepEqual(await runner.drain(), ["injected"])
		assert.deepEqual(injected, ["retry me"], "delivered exactly once")
		assert.equal(listPending(rig.env).length, 0)
		assert.equal(isJournaled(rig.env, 2), true)
		assert.deepEqual(rig.markedSeen, [2])
	} finally {
		await rig.close()
	}
})

test("a reply for another session is never injected by this one", { timeout: 30_000 }, async () => {
	const rig = await boot()
	try {
		const other = reply(3, "for someone else")
		const source = rig.source([{ ...other, subject: `Re: [pi:${signToken("another-session", SECRET)}] pi: x` }])
		await scanAndProcess(config(), { source, secret: SECRET, env: rig.env })

		const injected: string[] = []
		const runner = createDeliveryRunner({
			client: createDaemonClient({ baseUrl: rig.baseUrl, token: TOKEN }),
			instanceId: "instance-1",
			sessionId: () => SESSION,
			inject: async (body) => {
				injected.push(body)
			},
		})

		assert.deepEqual(await runner.drain(), ["foreign-session"])
		assert.deepEqual(injected, [])
		assert.equal(listPending(rig.env).length, 1, "left for its own session")
		assert.deepEqual(rig.markedSeen, [], "not marked seen by a stranger")
	} finally {
		await rig.close()
	}
})

test("an unauthorized sender never reaches the pending store", { timeout: 30_000 }, async () => {
	const rig = await boot()
	try {
		const forged = { ...reply(4), from: "attacker@evil.example" }
		const source = rig.source([forged])
		const scan = await scanAndProcess(config(), { source, secret: SECRET, env: rig.env })

		assert.equal(scan.persisted, 0)
		assert.equal(scan.reasons["not-allowlisted"], 1)
		assert.equal(listPending(rig.env).length, 0)
		assert.equal(readCursor(rig.env), 4, "cursor advances past junk so it is not refetched")
	} finally {
		await rig.close()
	}
})
