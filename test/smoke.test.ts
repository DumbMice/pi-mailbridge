import { test } from "node:test"
import assert from "node:assert/strict"

import { looksLikeOutlookRefusal, runSmoke, type SmokeDeps } from "../src/core/smoke.ts"
import type { ResolvedConfig } from "../src/core/config.ts"

function config(): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "pi@example.com", password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: "pi@example.com", password: "x", authType: "LOGIN" },
			to: "you@example.com",
		},
		device: { name: "dev-box-7" },
		security: { allowFrom: ["you@example.com"], requireDmarcPass: false, tokenTtlHours: 24 },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		warnings: [],
	}
}

interface Rig extends SmokeDeps {
	sent: { to?: string; subject: string; text: string }[]
	closed: number
}

function rig(over: { sendFails?: string; connectFails?: string; count?: number } = {}): Rig {
	const sent: { to?: string; subject: string; text: string }[] = []
	const state = { closed: 0 }
	return {
		sent,
		get closed() {
			return state.closed
		},
		send: async (_c, message) => {
			if (over.sendFails) throw new Error(over.sendFails)
			sent.push(message)
			return { messageId: "<smoke@pi.local>" }
		},
		connect: async () => {
			if (over.connectFails) {
				// A connection that fails on open still must not leak: close is not called,
				// because there is nothing to close yet.
				throw new Error(over.connectFails)
			}
			return {
				count: async () => over.count ?? 5,
				close: async () => {
					state.closed++
				},
			}
		},
	}
}

test("both directions ok reports two successful steps", async () => {
	const r = rig({ count: 1734 })
	const result = await runSmoke(config(), r)

	assert.equal(result.ok, true)
	assert.deepEqual(
		result.steps.map((s) => `${s.step}:${s.ok}`),
		["smtp:true", "imap:true"],
	)
	assert.match(result.steps[0]!.detail, /sent to you@example\.com/)
	assert.match(result.steps[0]!.detail, /smoke@pi\.local/, "the Message-ID is surfaced")
	assert.match(result.steps[1]!.detail, /1734 message\(s\) visible in INBOX/)
	assert.equal(r.sent.length, 1)
	assert.match(r.sent[0]!.text, /dev-box-7/, "the device name identifies which machine tested")
	assert.equal(r.closed, 1, "the IMAP connection is always closed")
})

test("an SMTP failure stops before IMAP and is typed", async () => {
	const r = rig({ sendFails: "connect ECONNREFUSED" })
	const result = await runSmoke(config(), r)

	assert.equal(result.ok, false)
	assert.equal(result.steps.length, 1, "must not probe IMAP after SMTP already failed")
	assert.equal(result.steps[0]!.step, "smtp")
	assert.match(result.steps[0]!.detail, /ECONNREFUSED/)
	assert.equal(result.steps[0]!.hint, undefined, "a network error is not the Outlook refusal")
})

test("an IMAP failure is typed and closes nothing that was never opened", async () => {
	const r = rig({ connectFails: "AUTHENTICATIONFAILED" })
	const result = await runSmoke(config(), r)

	assert.equal(result.ok, false)
	assert.equal(result.steps.map((s) => s.step).join(","), "smtp,imap")
	assert.match(result.steps[1]!.detail, /AUTHENTICATIONFAILED/)
	assert.equal(r.closed, 0)
})

test("the personal-Outlook refusals carry the Graph hint", async () => {
	for (const message of [
		"User is authenticated but not connected.",
		"535 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Mailbox.",
	]) {
		assert.equal(looksLikeOutlookRefusal(message), true, message)
		const r = rig({ sendFails: message })
		const result = await runSmoke(config(), r)
		assert.match(String(result.steps[0]!.hint), /Graph/, `hint missing for: ${message}`)
	}
})

test("looksLikeOutlookRefusal does not fire on ordinary errors", () => {
	assert.equal(looksLikeOutlookRefusal("connect ECONNREFUSED"), false)
	assert.equal(looksLikeOutlookRefusal("getaddrinfo ENOTFOUND"), false)
	assert.equal(looksLikeOutlookRefusal("550 mailbox unavailable"), false)
})

test("smoke touches no store state", async () => {
	// runSmoke takes no env and imports no store: this is a structural guarantee,
	// asserted here so a future refactor cannot quietly start writing cursors.
	const source = await import("node:fs").then((fs) =>
		fs.readFileSync(new URL("../src/core/smoke.ts", import.meta.url), "utf8"),
	)
	const imports = source
		.split("\n")
		.filter((line) => line.trimStart().startsWith("import "))
		.join("\n")
	for (const forbidden of ["pending-store", "uid-cursor", "journal", "threads", "mode-store", "registry"]) {
		assert.ok(!imports.includes(forbidden), `smoke must not import ${forbidden}`)
	}
})

test("smoke reports whether our own headers survive delivery", async () => {
	// Single-mailbox mode rests on the provider keeping the marker or our Message-ID. The probe
	// retries and matches the id we stamped: the copy arrives asynchronously, and reading "the
	// newest message" once produced a false alarm on a live account.
	const cfg = config()
	const single = { ...cfg, mail: { ...cfg.mail, to: cfg.mail.imap.user } }
	const run = (sources: Buffer[]) =>
		runSmoke(single, {
			send: async () => ({ messageId: "<ours@qq.com>" }),
			echoRetryDelaysMs: [0],
			sleep: async () => {},
			connect: async () => ({
				count: async () => 1,
				recentSources: async () => sources,
				close: async () => {},
			}),
		})
	const copy = (lines: string[]): Buffer => Buffer.from(lines.join("\r\n"))

	const marker = (await run([copy(["X-Pi-Mailbridge-Id: <ours@qq.com>", "X-Pi-Mailbridge: notification"])])).steps.find(
		(s) => s.step === "echo",
	)
	assert.equal(marker?.ok, true)
	assert.match(marker!.detail, /marker header survives/)

	const idOnly = (await run([copy(["X-Pi-Mailbridge-Id: <ours@qq.com>"])])).steps.find((s) => s.step === "echo")
	assert.equal(idOnly?.ok, true, "the stamped id alone keeps the guard")
	assert.match(idOnly!.detail, /Message-ID survived/)

	// An unrelated message is not ours: the probe must not judge our headers by it.
	const unrelated = (await run([copy(["X-Pi-Mailbridge-Id: <theirs@qq.com>", "X-Pi-Mailbridge: notification"])])).steps.find(
		(s) => s.step === "echo",
	)
	assert.equal(unrelated?.ok, false)
	assert.match(unrelated!.detail, /did not come back/)
})

test("the echo probe only runs when the notification lands in the watched mailbox", async () => {
	// In layout A the smoke mail goes to the human, so the newest message in our INBOX is
	// unrelated; probing it would report a false alarm about our own marker.
	const cfg = config()
	let probed = 0
	const twoBoxes = { ...cfg, mail: { ...cfg.mail, to: "you@hotmail.com", imap: { ...cfg.mail.imap, user: "pi@qq.com" } } }
	const result = await runSmoke(twoBoxes, {
		send: async () => ({ messageId: "<abc@example.com>" }),
		connect: async () => ({
			count: async () => 1,
			newestHeaders: async () => {
				probed++
				return Buffer.from("X-Pi-Mailbridge: notification")
			},
			close: async () => {},
		}),
	})
	assert.equal(probed, 0, "no probe for two mailboxes")
	assert.equal(result.steps.some((s) => s.step === "echo"), false, "and no echo step")
})
