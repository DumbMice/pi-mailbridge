import { test } from "node:test"
import assert from "node:assert/strict"

import type { ResolvedConfig } from "../src/core/config.ts"
import { buildTransportOptions, sendMail, type TransportLike } from "../src/core/mailer.ts"

function config(over: Partial<ResolvedConfig["mail"]["smtp"]> = {}): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "pi@example.com", password: "x", folder: "INBOX" },
			smtp: {
				host: "smtp.example.com",
				port: 465,
				secure: true,
				user: "pi@example.com",
				password: "app-password",
				authType: "LOGIN",
				...over,
			},
			to: "you@example.com",
		},
		security: { allowFrom: ["you@example.com"], requireDmarcPass: true, trustedAuthservId: "mx.example.com", tokenTtlHours: 24 },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false, subject: "pi" },
		tuning: { idleRenewMs: 1, autoIdleDelayMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
	}
}

function fakeTransport() {
	const sent: Record<string, unknown>[] = []
	const options: Record<string, unknown>[] = []
	const factory = (opts: Record<string, unknown>): TransportLike => {
		options.push(opts)
		return {
			async sendMail(mail) {
				sent.push(mail as Record<string, unknown>)
				return { messageId: "<x@y>" }
			},
		}
	}
	return { sent, options, factory }
}

test("LOGIN: message fields reach the transport unchanged", async () => {
	const t = fakeTransport()
	await sendMail(config(), { to: "you@example.com", subject: "[pi:a.b] pi: finished", text: "done: 3 turns" }, { transportFactory: t.factory })

	assert.equal(t.sent.length, 1)
	assert.deepEqual(t.sent[0], {
		from: "pi@example.com",
		to: "you@example.com",
		subject: "[pi:a.b] pi: finished",
		text: "done: 3 turns",
	})
})

test("LOGIN: transport options use user/pass with the configured host", async () => {
	const t = fakeTransport()
	await sendMail(config(), { to: "you@example.com", subject: "s", text: "b" }, { transportFactory: t.factory })
	assert.deepEqual(t.options[0], {
		host: "smtp.example.com",
		port: 465,
		secure: true,
		auth: { user: "pi@example.com", pass: "app-password" },
	})
})

test("from defaults to the SMTP user but can be overridden", async () => {
	const t = fakeTransport()
	const cfg = config()
	await sendMail(cfg, { to: "a@b.co", subject: "s", text: "b" }, { transportFactory: t.factory })
	await sendMail(cfg, { to: "a@b.co", subject: "s", text: "b", from: "other@example.com" }, { transportFactory: t.factory })
	assert.equal(t.sent[0]!.from, "pi@example.com")
	assert.equal(t.sent[1]!.from, "other@example.com")
})

test("XOAUTH2: auth carries accessToken and never a password", async () => {
	const t = fakeTransport()
	const cfg = config({ authType: "XOAUTH2" })
	await sendMail(cfg, { to: "you@example.com", subject: "s", text: "b" }, {
		transportFactory: t.factory,
		getAccessToken: async () => "ya29.TOKEN",
	})
	const auth = t.options[0]!.auth as Record<string, unknown>
	assert.equal(auth.type, "OAuth2")
	assert.equal(auth.accessToken, "ya29.TOKEN")
	assert.equal(auth.pass, undefined, "must not fall back to a password")
})

test("XOAUTH2 without a token provider fails with an actionable error", async () => {
	const t = fakeTransport()
	await assert.rejects(
		() => sendMail(config({ authType: "XOAUTH2" }), { to: "you@example.com", subject: "s", text: "b" }, { transportFactory: t.factory }),
		/TokenProvider|token provider|tokenCommand/i,
	)
	assert.equal(t.sent.length, 0)
})

test("XOAUTH2 with an empty token fails before sending", async () => {
	const t = fakeTransport()
	await assert.rejects(
		() =>
			sendMail(config({ authType: "XOAUTH2" }), { to: "you@example.com", subject: "s", text: "b" }, {
				transportFactory: t.factory,
				getAccessToken: async () => "",
			}),
		/empty token/,
	)
	assert.equal(t.sent.length, 0)
})

test("a transport failure propagates instead of being swallowed", async () => {
	const factory = (): TransportLike => ({
		async sendMail() {
			throw new Error("535 auth failed")
		},
	})
	await assert.rejects(
		() => sendMail(config(), { to: "you@example.com", subject: "s", text: "b" }, { transportFactory: factory }),
		/535 auth failed/,
	)
})

test("missing smtp host is rejected before the transport is built", async () => {
	let built = 0
	const factory = (): TransportLike => {
		built++
		return { async sendMail() {} }
	}
	const cfg = config({ host: "" })
	await assert.rejects(() => sendMail(cfg, { to: "you@example.com", subject: "s", text: "b" }, { transportFactory: factory }), /smtp.host/)
	assert.equal(built, 0)
})

test("buildTransportOptions is inspectable without sending", async () => {
	const opts = await buildTransportOptions(config())
	assert.equal(opts.host, "smtp.example.com")
	assert.equal((opts.auth as Record<string, unknown>).pass, "app-password")
})
