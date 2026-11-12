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
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
	}
}

function xoauthConfig(): ResolvedConfig {
	return config({ authType: "XOAUTH2", password: undefined })
}

function outbound() {
	return { to: "you@example.com", subject: "pi: x", text: "y" }
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
	// multipart/alternative: text is the fallback, html is what clients render.
	assert.deepEqual(Object.keys(t.sent[0]!).sort(), ["from", "html", "subject", "text", "to"])
	assert.equal(t.sent[0]!.from, "pi@example.com")
	assert.equal(t.sent[0]!.to, "you@example.com")
	assert.equal(t.sent[0]!.subject, "[pi:a.b] pi: finished")
	assert.equal(t.sent[0]!.text, "done: 3 turns")
	assert.match(String(t.sent[0]!.html), /done: 3 turns/)
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

test("sendMail returns the Message-ID so replies can be traced", async () => {
	const factory = (): TransportLike => ({
		async sendMail() {
			return { messageId: "<generated@pi.local>" }
		},
	})
	const result = await sendMail(config(), { to: "you@example.com", subject: "s", text: "b" }, { transportFactory: factory })
	assert.equal(result.messageId, "<generated@pi.local>")
})

test("sendMail tolerates a transport that returns nothing", async () => {
	const factory = (): TransportLike => ({ async sendMail() {} })
	const result = await sendMail(config(), { to: "you@example.com", subject: "s", text: "b" }, { transportFactory: factory })
	assert.deepEqual(result, {})
})

test("threading headers are set when provided", async () => {
	const t = fakeTransport()
	await sendMail(
		config(),
		{
			to: "you@example.com",
			subject: "pi: x",
			text: "b",
			inReplyTo: "<prev@qq.com>",
			references: ["<root@qq.com>"],
		},
		{ transportFactory: t.factory },
	)
	assert.equal(t.sent[0]!.inReplyTo, "<prev@qq.com>")
	assert.equal(t.sent[0]!.references, "<root@qq.com>")
})

test("no threading headers for the first message of a session", async () => {
	const t = fakeTransport()
	await sendMail(config(), { to: "you@example.com", subject: "pi: x", text: "b" }, { transportFactory: t.factory })
	assert.equal(t.sent[0]!.inReplyTo, undefined)
	assert.equal(t.sent[0]!.references, undefined)
})

test("the subject cannot inject a header or exceed the line limit", async () => {
	const { sanitizeSubject } = await import("../src/core/mailer.ts")
	// Subject text can come from notify/send_update params, i.e. model-controlled.
	assert.equal(sanitizeSubject("pi: hello\r\nBcc: attacker@evil.test"), "pi: hello Bcc: attacker@evil.test")
	assert.equal(sanitizeSubject("pi: a\nb\u0000c"), "pi: a b c")
	assert.ok(sanitizeSubject("x".repeat(500)).length <= 200)
})

test("a revoked grant is refreshed once and the send retried", async () => {
	// OAUTH.md promises one refresh on an auth failure; withFreshToken existed and was
	// never called, so a revoked grant failed until a manual re-auth.
	let tokens = 0
	let attempts = 0
	let invalidated = 0
	const result = await sendMail(xoauthConfig(), outbound(), {
		provider: {
			getToken: async () => `tok-${++tokens}`,
			invalidate: () => {
				invalidated++
			},
			isDisabled: () => false,
			state: () => ({ cached: true, disabled: false, failures: 0 }),
		},
		transportFactory: () =>
			({
				sendMail: async (message: { auth?: unknown }) => {
					attempts++
					// The stale token is rejected; the second attempt (fresh) succeeds.
					if (attempts === 1) throw Object.assign(new Error("535 auth failed"), { responseCode: 535 })
					return { messageId: "<ok@qq.com>" }
				},
			}) as never,
	})
	assert.equal(attempts, 2, "retried exactly once")
	assert.equal(invalidated, 1, "the cached token was dropped")
	assert.equal(tokens, 2, "and a new one minted")
	assert.equal(result.messageId, "<ok@qq.com>")
})

test("a non-auth failure is not retried", async () => {
	let attempts = 0
	await assert.rejects(
		sendMail(xoauthConfig(), outbound(), {
			provider: {
				getToken: async () => "tok",
				invalidate: () => {},
				isDisabled: () => false,
				state: () => ({ cached: true, disabled: false, failures: 0 }),
			},
			transportFactory: () =>
				({
					sendMail: async () => {
						attempts++
						throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
					},
				}) as never,
		}),
	)
	assert.equal(attempts, 1)
})
