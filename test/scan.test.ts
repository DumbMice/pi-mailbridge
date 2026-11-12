import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ResolvedConfig } from "../src/core/config.ts"
import { signToken } from "../src/core/token.ts"
import { scanAndProcess, type MailSource, type RawMessage } from "../src/daemon/process.ts"
import { addPending, getPending, PENDING_CAP } from "../src/store/pending-store.ts"
import { listPending } from "../src/store/pending-store.ts"
import { journal } from "../src/store/journal.ts"
import { readCursor } from "../src/store/uid-cursor.ts"
import { recordOutbound } from "../src/store/threads.ts"

const SECRET = Buffer.alloc(32, 3)
const SESSION = "01a1c453-f2fc-7169-8c89-69c93fa1a152"
const ALLOWED = "you@example.com"
/** The pi mailbox itself — distinct from the human, so the loop guard has something to catch. */
const MAILBOX = "pi@example.com"

function config(over: Partial<ResolvedConfig["security"]> = {}): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: MAILBOX, password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: MAILBOX, password: "x", authType: "LOGIN" },
			to: MAILBOX,
		},
		security: {
			allowFrom: [ALLOWED],
			requireDmarcPass: true,
			trustedAuthservId: "mx.example.com",
			tokenTtlHours: 24,
			...over,
		},
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
	}
}

function tokenSubject(sessionId = SESSION): string {
	return `[pi:${signToken(sessionId, SECRET)}] pi: finished`
}

const GOOD_AR = "mx.example.com; spf=pass; dkim=pass; dmarc=pass header.from=example.com"

function msg(uid: number, over: Partial<RawMessage> = {}): RawMessage {
	return {
		uid,
		from: ALLOWED,
		subject: tokenSubject(),
		text: "yes, ship it",
		headers: { authResults: [GOOD_AR] },
		receivedAt: 1_700_000_000_000,
		...over,
	}
}

function source(messages: RawMessage[], opts: { failFetchAt?: number } = {}): MailSource & { seen: number[] } {
	const seen: number[] = []
	return {
		seen,
		async searchAfter(afterUid: number) {
			return messages.filter((m) => m.uid > afterUid).map((m) => m.uid)
		},
		async fetch(uid: number) {
			seen.push(uid)
			if (opts.failFetchAt === uid) throw new Error("transient IMAP failure")
			return messages.find((m) => m.uid === uid)
		},
	}
}

const env = () => ({ XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-scan-")) })

test("happy path: authorized + valid token → persisted, cursor advances", async () => {
	const e = env()
	const r = await scanAndProcess(config(), { source: source([msg(7)]), secret: SECRET, env: e })

	assert.equal(r.examined, 1)
	assert.equal(r.persisted, 1)
	assert.equal(r.cursor, 7)
	assert.equal(readCursor(e), 7)

	const pending = listPending(e)
	assert.equal(pending.length, 1)
	assert.equal(pending[0]!.sessionId, SESSION)
	assert.equal(pending[0]!.from, ALLOWED)
	assert.equal(pending[0]!.body, "yes, ship it")
})

test("quoted text is stripped before the body is stored", async () => {
	const e = env()
	const text = ["LGTM, merge it.", "", "On Tue, pi <pi@example.com> wrote:", "> please review"].join("\n")
	await scanAndProcess(config(), { source: source([msg(1, { text })]), secret: SECRET, env: e })
	assert.equal(listPending(e)[0]!.body, "LGTM, merge it.")
})

test("a fully-quoted reply is rejected as empty-body", async () => {
	const e = env()
	const text = "> yes, ship it\n> on two lines"
	const r = await scanAndProcess(config(), { source: source([msg(1, { text })]), secret: SECRET, env: e })
	assert.equal(r.reasons["empty-body"], 1)
	assert.equal(listPending(e).length, 0, "must not replay the quoted original")
})

test("sender outside the allowlist is rejected and cursor advances", async () => {
	const e = env()
	const r = await scanAndProcess(config(), {
		source: source([msg(1, { from: "attacker@evil.example" })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.persisted, 0)
	assert.equal(r.rejected, 1)
	assert.equal(r.reasons["not-allowlisted"], 1)
	assert.equal(listPending(e).length, 0)
	assert.equal(readCursor(e), 1, "cursor must move past a terminal rejection")
})

test("DMARC failure is rejected even from an allowlisted sender", async () => {
	const e = env()
	const r = await scanAndProcess(config(), {
		source: source([msg(1, { headers: { authResults: ["mx.example.com; dmarc=fail header.from=example.com"] } })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["dmarc-failed"], 1)
	assert.equal(listPending(e).length, 0)
})

test("a forged top Authentication-Results header does not authorize", async () => {
	const e = env()
	// Attacker's own relay says pass; our relay's header says fail.
	const r = await scanAndProcess(config(), {
		source: source([
			msg(1, {
				headers: {
					authResults: [
						"attacker.example; dmarc=pass header.from=example.com",
						"mx.example.com; dmarc=fail header.from=example.com",
					],
				},
			}),
		]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.persisted, 0, "forged AR must not authorize")
	assert.equal(r.reasons["dmarc-failed"], 1)
})

test("missing our relay's AR header fails closed", async () => {
	const e = env()
	const r = await scanAndProcess(config(), {
		source: source([msg(1, { headers: { authResults: ["someone.else; dmarc=pass"] } })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["dmarc-missing"], 1)
	assert.equal(listPending(e).length, 0)
})

test("a message with no routing token is not ours", async () => {
	const e = env()
	const r = await scanAndProcess(config(), {
		source: source([msg(1, { subject: "unrelated mail" })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["no-token"], 1)
	assert.equal(listPending(e).length, 0)
})

test("a token signed with another key is rejected", async () => {
	const e = env()
	const forged = `[pi:${signToken(SESSION, Buffer.alloc(32, 9))}] pi: finished`
	const r = await scanAndProcess(config(), { source: source([msg(1, { subject: forged })]), secret: SECRET, env: e })
	assert.equal(r.reasons["no-token"], 1)
	assert.equal(listPending(e).length, 0)
})

test("machine-generated mail is rejected (loop guard)", async () => {
	const e = env()
	const r = await scanAndProcess(config(), {
		source: source([msg(1, { headers: { authResults: [GOOD_AR], autoSubmitted: "auto-replied" } })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["auto-generated"], 1)
})

test("mail from our own address is rejected (loop guard)", async () => {
	const e = env()
	const r = await scanAndProcess(config(), { source: source([msg(1, { from: MAILBOX })]), secret: SECRET, env: e })
	assert.equal(r.reasons["self"], 1)
})

test("an acked uid is skipped, not delivered twice", async () => {
	const e = env()
	journal(e, 4)
	const r = await scanAndProcess(config(), { source: source([msg(4)]), secret: SECRET, env: e })
	assert.equal(r.skipped, 1)
	assert.equal(r.reasons["journaled"], 1)
	assert.equal(listPending(e).length, 0)
	assert.equal(readCursor(e), 4)
})

test("a vanished message does not block the cursor", async () => {
	const e = env()
	const src: MailSource = { searchAfter: async () => [3], fetch: async () => undefined }
	const r = await scanAndProcess(config(), { source: src, secret: SECRET, env: e })
	assert.equal(r.reasons["vanished"], 1)
	assert.equal(readCursor(e), 3)
})

test("a transient fetch error stops the scan with the cursor before it", async () => {
	const e = env()
	const src = source([msg(1), msg(2), msg(3)], { failFetchAt: 2 })
	await assert.rejects(() => scanAndProcess(config(), { source: src, secret: SECRET, env: e }), /transient/)
	// uid 1 was fully handled, so the cursor sits at 1 and 2/3 are retried next scan.
	assert.equal(readCursor(e), 1)
	assert.equal(listPending(e).length, 1)
})

test("incremental: a second scan only looks past the cursor", async () => {
	const e = env()
	const all = [msg(1), msg(2)]
	const src = source(all)
	await scanAndProcess(config(), { source: src, secret: SECRET, env: e })
	src.seen.length = 0
	const r2 = await scanAndProcess(config(), { source: src, secret: SECRET, env: e })
	assert.equal(r2.examined, 0, "nothing new past the cursor")
	assert.deepEqual(src.seen, [], "no redundant fetches")
})

test("the human's own address is NOT treated as a loop (mail.to is the recipient)", async () => {
	const e = env()
	// config.mail.to = the human, and the human is the sender of a genuine reply.
	const r = await scanAndProcess(config(), { source: source([msg(7, { from: ALLOWED })]), secret: SECRET, env: e })
	assert.equal(r.reasons["self"], undefined, "must not be rejected as a self-loop")
	assert.equal(r.persisted, 1)
})

test("allowlist empty fails closed", async () => {
	const e = env()
	const r = await scanAndProcess(config({ allowFrom: [] }), { source: source([msg(1)]), secret: SECRET, env: e })
	assert.equal(r.reasons["allowlist-empty"], 1)
	assert.equal(listPending(e).length, 0)
})

test("a token minted for another device is rejected and not stored", async () => {
	const e = env()
	const foreign = `[pi:${signToken(SESSION, SECRET, { device: "someone-elses-laptop" })}] pi: finished`
	const r = await scanAndProcess(config(), { source: source([msg(1, { subject: foreign })]), secret: SECRET, env: e })
	assert.equal(r.reasons["other-device"], 1)
	assert.equal(listPending(e).length, 0, "must not hold a stale copy of another device's reply")
	assert.equal(readCursor(e), 1, "cursor advances so it is not refetched")
})

test("a token for THIS device is accepted", async () => {
	const e = env()
	const mine = `[pi:${signToken(SESSION, SECRET, { device: "test-device" })}] pi: finished`
	const r = await scanAndProcess(config(), { source: source([msg(1, { subject: mine })]), secret: SECRET, env: e })
	assert.equal(r.persisted, 1)
	assert.equal(listPending(e)[0]!.sessionId, SESSION)
})

test("a token with no device still works (single-device installs)", async () => {
	const e = env()
	// tokenSubject() signs without a device claim.
	const r = await scanAndProcess(config(), { source: source([msg(1)]), secret: SECRET, env: e })
	assert.equal(r.persisted, 1, "pre-device tokens must not be rejected")
})

// --- reply-chain fallback (In-Reply-To / References) ----------------------

test("a reply with no token still routes via In-Reply-To", async () => {
	const e = env()
	recordOutbound(e, { messageId: "<out-1@pi.local>", sessionId: SESSION, device: "test-device", subject: "pi: x" })
	const r = await scanAndProcess(config(), {
		source: source([msg(1, { subject: "Re: pi: x", headers: { authResults: [GOOD_AR], inReplyTo: "<out-1@pi.local>" } })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.persisted, 1, "the reply chain identifies the session")
	assert.equal(r.reasons["threaded"], 1)
	assert.equal(listPending(e)[0]!.sessionId, SESSION)
})

test("a reply whose subject was edited still routes via References", async () => {
	const e = env()
	recordOutbound(e, { messageId: "<out-2@pi.local>", sessionId: SESSION, device: "test-device", subject: "pi: y" })
	const r = await scanAndProcess(config(), {
		source: source([
			msg(1, {
				subject: "unrelated subject now",
				headers: {
					authResults: [GOOD_AR],
					references: ["<older@x> <out-2@pi.local>"],
				},
			}),
		]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.persisted, 1, "References is the chain and must be honoured")
	assert.equal(listPending(e)[0]!.sessionId, SESSION)
})

test("the token wins over the chain when both are present", async () => {
	const e = env()
	recordOutbound(e, { messageId: "<out-3@pi.local>", sessionId: "session-from-chain", device: "test-device", subject: "x" })
	const otherSession = "01a1c453-f2fc-7169-8c89-69c93fa1a999"
	const signed = `[pi:${signToken(otherSession, SECRET)}] pi: finished`
	const r = await scanAndProcess(config(), {
		source: source([msg(1, { subject: signed, headers: { authResults: [GOOD_AR], inReplyTo: "<out-3@pi.local>" } })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.persisted, 1)
	assert.equal(listPending(e)[0]!.sessionId, otherSession, "signed token is authoritative")
})

test("an unknown In-Reply-To is rejected as no-token", async () => {
	const e = env()
	const r = await scanAndProcess(config(), {
		source: source([msg(1, { subject: "Re: nothing", headers: { authResults: [GOOD_AR], inReplyTo: "<stranger@elsewhere>" } })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["no-token"], 1)
	assert.equal(listPending(e).length, 0)
})

test("a threaded reply recorded for another device is rejected", async () => {
	const e = env()
	recordOutbound(e, { messageId: "<out-4@pi.local>", sessionId: SESSION, device: "other-machine", subject: "x" })
	const r = await scanAndProcess(config(), {
		source: source([msg(1, { subject: "Re: x", headers: { authResults: [GOOD_AR], inReplyTo: "<out-4@pi.local>" } })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["other-device"], 1)
	assert.equal(listPending(e).length, 0)
})

test("header threading can be disabled", async () => {
	const e = env()
	recordOutbound(e, { messageId: "<out-5@pi.local>", sessionId: SESSION, device: "test-device", subject: "x" })
	const r = await scanAndProcess(config({ allowHeaderThreading: false }), {
		source: source([msg(1, { subject: "Re: x", headers: { authResults: [GOOD_AR], inReplyTo: "<out-5@pi.local>" } })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["no-token"], 1)
})

// --- single-mailbox mode (one address for both roles) ---------------------

test("a reply from the mailbox's own address is rejected by default", async () => {
	const e = env()
	const r = await scanAndProcess(config(), { source: source([msg(1, { from: MAILBOX })]), secret: SECRET, env: e })
	assert.equal(r.reasons["self"], 1)
	assert.equal(listPending(e).length, 0)
})

test("single-mailbox mode accepts a genuine reply from the same address", async () => {
	const e = env()
	const r = await scanAndProcess(
		config({ allowSelfReplies: true, allowFrom: [MAILBOX] }),
		{ source: source([msg(1, { from: MAILBOX, headers: { authResults: [GOOD_AR], inReplyTo: "<out-9@pi.local>" } })]), secret: SECRET, env: e },
	)
	assert.equal(r.persisted, 1, "the human replying from their own mailbox must work")
	assert.equal(listPending(e)[0]!.sessionId, SESSION)
})

test("single-mailbox mode still rejects our own notification echo", async () => {
	const e = env()
	// Our outbound notification carries a token but no In-Reply-To.
	const r = await scanAndProcess(config({ allowSelfReplies: true, allowFrom: [MAILBOX] }), {
		source: source([msg(1, { from: MAILBOX })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["self-echo"], 1, "must not inject our own sent mail as a reply")
	assert.equal(listPending(e).length, 0)
})

test("a sovereign-cloud oauth issuer is flagged as unusable for global Outlook", async () => {
	const { loadConfig } = await import("../src/core/config.ts")
	const env = {
		XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "pmb-cfg-")),
		PI_MAILBRIDGE_IMAP_HOST: "outlook.office365.com",
		PI_MAILBRIDGE_IMAP_USER: "pi@hotmail.com",
		PI_MAILBRIDGE_SMTP_HOST: "smtp-mail.outlook.com",
		PI_MAILBRIDGE_TO: "me@hotmail.com",
	} as NodeJS.ProcessEnv
	const { mkdirSync, writeFileSync } = await import("node:fs")
	mkdirSync(join(env.XDG_CONFIG_HOME!, "pi-mailbridge"), { recursive: true })
	writeFileSync(
		join(env.XDG_CONFIG_HOME!, "pi-mailbridge", "config.json"),
		JSON.stringify({
			mail: {
				imap: { host: "outlook.office365.com", port: 993, secure: true, user: "pi@hotmail.com", password: "", folder: "INBOX", authType: "XOAUTH2" },
				smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false, user: "pi@hotmail.com", password: "", authType: "XOAUTH2" },
				to: "me@hotmail.com",
			},
			security: { allowFrom: ["me@hotmail.com"], requireDmarcPass: false },
			oauth: {
				issuer: "https://login.partner.microsoftonline.cn/consumers/v2.0",
				clientId: "x",
				scope: "offline_access",
			},
		}),
	)
	const warnings = loadConfig(env).warnings.join("\n")
	assert.match(warnings, /Azure China|21Vianet|sovereign/)
})

test("an unknown route id falls through to the reply chain instead of dropping the reply", async () => {
	const e = env()
	// A recorded outbound id, so the chain can identify the session.
	recordOutbound(e, { messageId: "<root@qq.com>", sessionId: SESSION, device: "test-device", subject: "x" })
	// A route id that does not exist locally (expired, or minted on another machine).
	const r = await scanAndProcess(config(), {
		source: source([
			msg(1, {
				subject: "Re: [pi:ffffff] pi: x",
				headers: { authResults: [GOOD_AR], inReplyTo: "<root@qq.com>" },
			}),
		]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["route-miss"], 1, "the miss is recorded")
	assert.equal(r.persisted, 1, "and the reply still arrives via the chain")
	assert.equal(listPending(e)[0]!.sessionId, SESSION)
})

test("our own threaded notification is not injected as a reply", async () => {
	// Threading put In-Reply-To on every notification after the first, which is the very
	// header the single-mailbox guard used to tell a reply from an echo. The outbound
	// registry is the reliable discriminator, and it is checked before routing.
	const e = env()
	const cfg = config()
	cfg.security.allowSelfReplies = true
	cfg.security.allowFrom = [cfg.mail.smtp.user]
	// The notification we sent, recorded when it went out.
	recordOutbound(e, { messageId: "<ours-2@qq.com>", sessionId: SESSION, device: "test-device", subject: "x" })

	const r = await scanAndProcess(cfg, {
		source: source([
			msg(1, {
				from: cfg.mail.smtp.user,
				subject: "Re: [pi:ffffff] pi: x",
				headers: { authResults: [GOOD_AR], messageId: "<ours-2@qq.com>", inReplyTo: "<ours-1@qq.com>" },
			}),
		]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["self-echo"], 1, "rejected as our own mail")
	assert.equal(r.persisted, 0, "and never injected")
})

test("the reply chain ages out with the configured TTL", async () => {
	// The chain is a routing rule like the other two, so it must carry the same replay
	// bound: a re-sent copy of an old notification must not route forever.
	const e = env()
	recordOutbound(e, { messageId: "<old@qq.com>", sessionId: SESSION, device: "test-device", subject: "x" })
	// Backdate the record well past the TTL.
	const { readFileSync, writeFileSync } = await import("node:fs")
	const { statePath } = await import("../src/store/paths.ts")
	const file = statePath(e, "threads.json")
	const stored = JSON.parse(readFileSync(file, "utf8")) as { items: { createdAt: number }[] }
	for (const item of stored.items) item.createdAt = Date.now() - 40 * 86_400_000
	writeFileSync(file, JSON.stringify(stored))

	const r = await scanAndProcess(config(), {
		source: source([
			msg(1, { subject: "Re: pi: x", headers: { authResults: [GOOD_AR], inReplyTo: "<old@qq.com>" } }),
		]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.persisted, 0, "a stale chain must not route a reply")
	assert.equal(r.reasons["no-token"], 1)
})

test("a message carrying our own marker header is never ingested", async () => {
	// The deterministic half of the self-echo guard: even if the outbound id was never
	// recorded (a send that lost the race), the marker we stamp says "this is ours".
	const e = env()
	const cfg = config()
	cfg.security.allowSelfReplies = true
	cfg.security.allowFrom = [cfg.mail.smtp.user]
	const r = await scanAndProcess(cfg, {
		source: source([
			msg(1, {
				from: cfg.mail.smtp.user,
				subject: "[pi:abcdef] pi: waiting for you",
				headers: {
					authResults: [GOOD_AR],
					messageId: "<unknown@qq.com>",
					inReplyTo: "<older@qq.com>",
					piMailbridge: "notification",
				},
			}),
		]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["self-echo"], 1)
	assert.equal(r.persisted, 0)
})

test("a reply that is only an attachment is kept", async () => {
	// The headline case: reply from a phone with a screenshot and no text. The body check
	// used to run first, so the mail was rejected as empty-body, the attachment stayed
	// unread on the server, and the cursor moved past it.
	const e = env()
	// Minimal PNG signature + a byte, which is what the sniffer accepts.
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
	const r = await scanAndProcess(config(), {
		source: source([
			msg(1, { text: "", attachments: [{ filename: "shot.png", contentType: "image/png", content: png }] }),
		]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.persisted, 1, "attachment-only reply is accepted")
	const record = listPending(e)[0]!
	assert.equal(record.body, "", "no prose")
	assert.equal(record.attachments?.length, 1)
	assert.equal(record.attachments?.[0]?.name, "shot.png")
})

test("an empty reply with no usable attachment is still rejected", async () => {
	const e = env()
	const r = await scanAndProcess(config(), {
		source: source([msg(1, { text: "   ", attachments: [] })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["empty-body"], 1)
	assert.equal(r.persisted, 0)
})

test("a full pending store does not advance the cursor past the undelivered mail", async () => {
	// Refusing at insertion is only safe if the scanner retries: it must leave the cursor
	// where it is, so the same UID comes back instead of being lost behind a full queue.
	const e = env()
	for (let uid = 1; uid <= PENDING_CAP; uid++) {
		addPending(e, {
			uid,
			sessionId: "other",
			from: "you@example.com",
			subject: "x",
			body: "y",
			receivedAt: 1,
		})
	}
	const { readCursor } = await import("../src/store/uid-cursor.ts")
	const beforeCursor = readCursor(e)
	const r = await scanAndProcess(config(), { source: source([msg(PENDING_CAP + 1)]), secret: SECRET, env: e })
	assert.equal(r.reasons["pending-full"], 1)
	assert.equal(r.persisted, 0)
	assert.equal(readCursor(e), beforeCursor, "cursor must not move past a record we could not store")
})

test("a bounce or postmaster sender is never treated as a reply", async () => {
	// SECURITY.md lists this under "what this package will never do"; it was not checked.
	// A bounce quoting our notification carries the route id, so without this it routes.
	for (const from of ["MAILER-DAEMON@example.com", "postmaster@example.com"]) {
		const e = env()
		const r = await scanAndProcess(config(), {
			source: source([msg(1, { from, subject: "[pi:abcdef] pi: x" })]),
			secret: SECRET,
			env: e,
		})
		assert.equal(r.reasons["auto-generated"], 1, `${from} must be refused`)
		assert.equal(r.persisted, 0)
	}
})

test("pending-full stops the batch so a later UID cannot advance the cursor past it", async () => {
	// `continue` looked fine on a single-message batch, but the cursor is monotonic: a later
	// UID that persists would jump over the refused one, losing it for good.
	const e = env()
	for (let uid = 1; uid <= PENDING_CAP; uid++) {
		addPending(e, { uid, sessionId: "other", from: "you@example.com", subject: "x", body: "y", receivedAt: 1 })
	}
	const { readCursor } = await import("../src/store/uid-cursor.ts")
	const before = readCursor(e)
	const r = await scanAndProcess(config(), {
		// The first is refused (full); the second would persist if the loop continued.
		source: source([msg(PENDING_CAP + 1), msg(PENDING_CAP + 2, { text: "second" })]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.reasons["pending-full"], 1)
	assert.equal(readCursor(e), before, "the cursor must not move at all")
	assert.equal(getPending(e, PENDING_CAP + 2), undefined, "and the later UID must not be persisted")
})

test("single-mailbox QQ: a self-addressed reply with no Authentication-Results is accepted", async () => {
	// QQ does not stamp Authentication-Results on QQ->QQ mail (docs/OAUTH.md). With the old
	// setup default (requireDmarcPass always true) every genuine reply was rejected
	// dmarc-missing and the cursor moved past it - a lost reply per turn.
	const e = env()
	const cfg = config()
	cfg.mail.smtp.user = "you@qq.com"
	cfg.mail.imap.user = "you@qq.com"
	cfg.mail.to = "you@qq.com"
	cfg.security.allowFrom = ["you@qq.com"]
	cfg.security.allowSelfReplies = true
	cfg.security.requireDmarcPass = false // what setup now writes for one address
	recordOutbound(e, { messageId: "<root@qq.com>", sessionId: SESSION, device: "test-device", subject: "x" })

	const r = await scanAndProcess(cfg, {
		source: source([
			msg(1, {
				from: "you@qq.com",
				subject: "Re: [pi:abcdef] pi: x",
				text: "yes ship it",
				// No authResults at all - exactly what QQ delivers for self-mail.
				headers: { inReplyTo: "<root@qq.com>" },
			}),
		]),
		secret: SECRET,
		env: e,
	})
	assert.equal(r.persisted, 1, `the reply must be delivered (reasons: ${JSON.stringify(r.reasons)})`)
	assert.equal(listPending(e)[0]?.sessionId, SESSION)
})
