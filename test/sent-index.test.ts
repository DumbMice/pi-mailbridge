import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { captureDeliveredMessageId, messageIdFromHeaders, stampedIdFromHeaders } from "../src/core/sent-index.ts"
import { lookupChain } from "../src/store/threads.ts"
import type { ResolvedConfig } from "../src/core/config.ts"

const MINTED = "4c77b6b5-d077-40a6-8ee6-20ed6689b3e9@qq.com"

function config(sentFolder?: string): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.qq.com", port: 993, secure: true, user: "you@qq.com", password: "x", folder: "INBOX", ...(sentFolder ? { sentFolder } : {}) },
			smtp: { host: "smtp.qq.com", port: 465, secure: true, user: "you@qq.com", password: "x", authType: "LOGIN" },
			to: "you@hotmail.com",
		},
		security: { allowFrom: ["you@hotmail.com"], requireDmarcPass: true, tokenTtlHours: 24 },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "box" },
		warnings: [],
	} as ResolvedConfig
}

function sentCopy(minted: string, delivered: string): Buffer {
	return Buffer.from(
		[
			"X-Pi-Mailbridge: notification",
			`X-Pi-Mailbridge-Id: <${minted}>`,
			`Message-ID: <${delivered}>`,
			"Subject: =?UTF-8?Q?=5Bpi=3Aabc123=5D_pi=3A_live_test?=",
			"",
			"body",
		].join("\r\n"),
	)
}

test("the delivered Message-ID is recorded, identified by the id we stamped", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-sent-")) }
	const id = await captureDeliveredMessageId({
		config: config("Sent Messages"),
		mintedId: `<${MINTED}>`,
		subject: "[pi:abc123] pi: live test",
		sessionId: "sess-1",
		env,
		retryDelaysMs: [0],
		connect: async () => ({
			connect: async () => {},
			mailboxOpen: async () => {},
			search: async () => [563, 564],
			fetchOne: async (uid: number) =>
				uid === 564
					? { source: sentCopy(MINTED, "tencent_OURS@qq.com") }
					: { source: sentCopy("someone-else@qq.com", "tencent_THEIRS@qq.com") },
			logout: async () => {},
		}),
	})
	assert.equal(id, "tencent_OURS@qq.com", "ours, not the neighbouring notification's")
	assert.equal(lookupChain(env, ["<tencent_OURS@qq.com>"])?.sessionId, "sess-1")
})

test("another session's notification is never recorded", async () => {
	// The live bug: matching on the marker alone took the previous notification's id.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-sent-")) }
	const id = await captureDeliveredMessageId({
		config: config("Sent Messages"),
		mintedId: `<${MINTED}>`,
		subject: "x",
		sessionId: "sess-1",
		env,
		retryDelaysMs: [0],
		connect: async () => ({
			connect: async () => {},
			mailboxOpen: async () => {},
			search: async () => [900],
			fetchOne: async () => ({ source: sentCopy("different@qq.com", "tencent_OTHER@qq.com") }),
			logout: async () => {},
		}),
	})
	assert.equal(id, undefined, "nothing recorded")
	assert.equal(lookupChain(env, ["<tencent_OTHER@qq.com>"]), undefined)
})

test("it retries while the provider is still appending the copy", async () => {
	// QQ took 20-30 s to show the copy in one measurement; a single attempt is not enough.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-sent-")) }
	let attempts = 0
	const id = await captureDeliveredMessageId({
		config: config("Sent Messages"),
		mintedId: MINTED,
		subject: "x",
		sessionId: "sess-1",
		env,
		retryDelaysMs: [0, 0, 0],
		sleep: async () => {},
		connect: async () => ({
			connect: async () => {},
			mailboxOpen: async () => {},
			search: async () => {
				attempts++
				return attempts >= 3 ? [700] : []
			},
			fetchOne: async () => ({ source: sentCopy(MINTED, "tencent_LATE@qq.com") }),
			logout: async () => {},
		}),
	})
	assert.equal(id, "tencent_LATE@qq.com")
	assert.equal(attempts, 3)
})

test("nothing happens without a sent folder", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-sent-")) }
	let connected = 0
	const id = await captureDeliveredMessageId({
		config: config(),
		mintedId: MINTED,
		subject: "x",
		sessionId: "s",
		env,
		connect: async () => {
			connected++
			return { connect: async () => {}, mailboxOpen: async () => {}, search: async () => [], fetchOne: async () => undefined, logout: async () => {} }
		},
	})
	assert.equal(id, undefined)
	assert.equal(connected, 0, "no IMAP round trip when the option is off")
})

test("header parsing handles folding and missing values", () => {
	assert.equal(messageIdFromHeaders("Subject: x\r\nMessage-ID:\r\n <abc@qq.com>\r\n"), "abc@qq.com")
	assert.equal(messageIdFromHeaders("Subject: x\r\n"), undefined)
	assert.equal(stampedIdFromHeaders("X-Pi-Mailbridge-Id: <abc@qq.com>\r\n"), "abc@qq.com")
	assert.equal(stampedIdFromHeaders("X-Pi-Mailbridge: notification\r\n"), undefined)
})
