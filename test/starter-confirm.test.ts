// Result mails: plain text, threaded, budgeted, and never rendered as Markdown.

import { test } from "node:test"
import assert from "node:assert/strict"

import { STARTER_DEFAULTS, type ResolvedConfig } from "../src/core/config.ts"
import { cleanDiagnostic, createConfirmer, renderList, renderRefused, renderStarted, replySubject } from "../src/starter/confirm.ts"

function config(over: Partial<typeof STARTER_DEFAULTS> = {}): ResolvedConfig {
	return {
		mail: {
			imap: { host: "i", port: 993, secure: true, user: "pi@e.com", password: "x", folder: "INBOX" },
			smtp: { host: "s", port: 465, secure: true, user: "pi@e.com", password: "x", authType: "LOGIN" },
			to: "me@e.com",
		},
		device: { name: "dev" },
		security: { allowFrom: ["me@e.com"], requireDmarcPass: true, tokenTtlHours: 1 },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 1, notifyOnAborted: false, maxAttachmentMb: 1 , inlineSvg: true},
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		warnings: [],
		starter: { ...STARTER_DEFAULTS, enabled: true, roots: ["/tmp"], ...over },
	}
}

test("a started result tells the human how to attach and how to stop", () => {
	const text = renderStarted({
		name: "fix-auth",
		cwd: "/tmp/project",
		model: "deepseek/deepseek-flash",
		attachHint: "tmux -L pimail attach -t fix-auth",
		stopText: "stop: fix-auth",
	})
	assert.match(text, /started fix-auth/)
	assert.match(text, /attach: tmux -L pimail attach -t fix-auth/)
	assert.match(text, /stop: reply with "stop: fix-auth"/)
})

test("a refusal names the code, the offender and any candidates, with escapes stripped", () => {
	const text = renderRefused("outside-root", "\u001B[31m/etc\u001B[0m is not under any root", ["/tmp/a", "/tmp/b"])
	assert.doesNotMatch(text, /\u001B/)
	assert.match(text, /refused — outside-root: \/etc is not under any root/)
	assert.match(text, /candidates:\n {2}\/tmp\/a/)
})

test("a list of sessions is a plain table, and empty is stated", () => {
	assert.equal(renderList([]), "[pi-start] no sessions")
	const text = renderList([{ name: "a", id: "$1", cwd: "/tmp", ageHours: 2 }])
	assert.match(text, /a {2}\$1 {2}\/tmp {2}2h/)
})

test("the reply subject does not stack Re:", () => {
	assert.equal(replySubject({ original: "[pi-start] x" }), "Re: [pi-start] x")
	assert.equal(replySubject({ original: "Re: [pi-start] x" }), "Re: [pi-start] x")
	assert.equal(replySubject({ original: undefined }), "Re: no subject")
	assert.equal(replySubject({ original: "   " }), "Re: no subject")
})

test("a diagnostic is capped and stripped of control bytes", () => {
	const dirty = "\u0000\u001B[2Jready\n" + "x".repeat(3000)
	const clean = cleanDiagnostic(dirty, 100)
	assert.doesNotMatch(clean, /[\u0000\u001B]/)
	assert.ok(clean.length <= 101)
	assert.ok(clean.endsWith("…"))
})

test("a result mail is plain, threaded under the request, and addressed from config", async () => {
	const sent: { to: string; subject: string; plain?: boolean; inReplyTo?: string; references?: string[] }[] = []
	const confirmer = createConfirmer(config(), {
		send: async (_cfg, message) => {
			sent.push(message)
		},
	})
	await confirmer.send({ subject: "[pi-start] fix it", text: "[pi-start] started x", inReplyTo: "<req@x>" })
	assert.equal(sent.length, 1)
	assert.equal(sent[0]!.to, "me@e.com", "the recipient comes from config, never from the mail")
	assert.equal(sent[0]!.subject, "Re: [pi-start] fix it")
	assert.equal(sent[0]!.plain, true, "plain: no Markdown rendering, no attachment discovery")
	assert.equal(sent[0]!.inReplyTo, "<req@x>")
	assert.deepEqual(sent[0]!.references, ["<req@x>"])
})

test("the confirmation budget is separate, and a refused send is logged, not thrown", async () => {
	let sends = 0
	const logs: string[] = []
	const confirmer = createConfirmer(config({ confirmationsPerHour: 2 }), {
		send: async () => {
			sends += 1
		},
		now: () => 1_700_000_000_000,
		log: (line) => logs.push(line),
	})
	for (let i = 0; i < 3; i++) {
		await confirmer.send({ subject: "s", text: "t", inReplyTo: `<r${i}@x>` })
	}
	assert.equal(sends, 2, "the third is refused by the budget")
	assert.equal(logs.length, 1)
	assert.match(logs[0]!, /confirmation budget reached/)
	assert.equal(confirmer.sentInWindow(), 2)
})

test("the confirmation mailer receives the XOAUTH2 provider, not just the config", async () => {
	// Without it, SMTP refuses `authType: XOAUTH2` - the IMAP connection would work and every result mail
	// would fail, which is the worst combination: sessions start and nobody is told.
	const sent: unknown[] = []
	const provider = {
		getToken: async () => "token-1",
		invalidate: () => {},
		isDisabled: () => false,
		state: () => ({ cached: true, disabled: false, failures: 0 }),
	}
	const base = config()
	const confirmer = createConfirmer(
		{ ...base, mail: { ...base.mail, smtp: { ...base.mail.smtp, authType: "XOAUTH2" } } },
		{ send: async (_cfg, _message, received) => void sent.push(received), provider },
	)
	assert.equal(await confirmer.send({ subject: "[pi-start] x", text: "ok", inReplyTo: "<m@x>" }), true)
	assert.equal(sent[0], provider, "the provider travels with the message")
})

test("a dedicated starter address becomes Reply-To on results", async () => {
	// Otherwise a normal Reply goes to the SMTP account, and address-authoritative matching rejects the
	// `stop:` the result mail asked for.
	const base = config()
	const seen: { replyTo?: string }[] = []
	const confirmer = createConfirmer(
		{ ...base, starter: { ...base.starter, channel: { ...base.starter.channel, address: "start@example.com" } } },
		{ send: async (_cfg, message) => void seen.push({ replyTo: message.replyTo }) },
	)
	await confirmer.send({ subject: "[pi-start] x", text: "ok", inReplyTo: "<m@x>" })
	assert.equal(seen[0]?.replyTo, "start@example.com")
})

test("the refusal sanitizer strips control bytes before normalising line endings", () => {
	// The old implementation stripped first, so a NUL between CR and LF still collapsed to one newline.
	assert.equal(cleanDiagnostic("a\r\u0000\nb"), "a\nb")
	assert.equal(cleanDiagnostic("a\r\nb"), "a\nb")
})

