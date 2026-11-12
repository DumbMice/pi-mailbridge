import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { captureDeliveredMessageId, messageIdFromHeaders } from "../src/core/sent-index.ts"
import { lookupChain } from "../src/store/threads.ts"
import type { ResolvedConfig } from "../src/core/config.ts"

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

test("the delivered Message-ID is recorded from the Sent folder", async () => {
	// QQ replaces our stamp with <tencent_...@qq.com>; the human's reply references that one, so
	// only the provider's id makes the reply chain work.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-sent-")) }
	const headers = [
		"Message-ID: <tencent_ABC123@qq.com>",
		"X-Pi-Mailbridge: notification",
		"Subject: [pi:914625] pi: live test",
		"",
		"body",
	]
	const id = await captureDeliveredMessageId({
		config: config("Sent Messages"),
		subject: "[pi:914625] pi: live test",
		sessionId: "sess-1",
		env,
		connect: async () => ({
			connect: async () => {},
			mailboxOpen: async () => {},
			// QQ's Sent folder answers a subject search with nothing; a date search works.
			search: async (query: Record<string, unknown>) => ("subject" in query ? [] : [563]),
			fetchOne: async () => ({ source: Buffer.from(headers.join("\r\n")) }),
			logout: async () => {},
		}),
	})
	assert.equal(id, "tencent_ABC123@qq.com")
	assert.equal(lookupChain(env, ["<tencent_ABC123@qq.com>"])?.sessionId, "sess-1", "and the chain now resolves")
})

test("nothing happens without a sent folder", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-sent-")) }
	let connected = 0
	const id = await captureDeliveredMessageId({
		config: config(),
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

test("messageIdFromHeaders handles folded headers", () => {
	assert.equal(
		messageIdFromHeaders("Subject: x\r\nMessage-ID:\r\n <abc@qq.com>\r\n"),
		"abc@qq.com",
	)
	assert.equal(messageIdFromHeaders("Subject: x\r\n"), undefined)
})
