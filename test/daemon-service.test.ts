import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ResolvedConfig } from "../src/core/config.ts"
import { addPending, listPending } from "../src/store/pending-store.ts"
import { isJournaled } from "../src/store/journal.ts"
import { readMode } from "../src/store/mode-store.ts"
import { createDaemonService, MAX_BODY_BYTES, type DaemonService } from "../src/daemon/service.ts"

const TOKEN = "test-token-abc"

function config(): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "pi@example.com", password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: "pi@example.com", password: "x", authType: "LOGIN" },
			to: "you@example.com",
		},
		security: { allowFrom: ["you@example.com"], requireDmarcPass: true, trustedAuthservId: "mx.example.com", tokenTtlHours: 24 },
		daemon: { host: "127.0.0.1", port: 0 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false, maxAttachmentMb: 18 },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
	}
}

interface Harness {
	service: DaemonService
	base: string
	env: NodeJS.ProcessEnv
	sent: { to: string; subject: string; text: string; messageId?: string }[]
	markedSeen: number[]
	close(): Promise<void>
}

async function boot(): Promise<Harness> {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-daemon-")) }
	const sent: { to: string; subject: string; text: string; messageId?: string }[] = []
	const markedSeen: number[] = []

	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: {
			uidValidity: () => undefined,
			searchAfter: async () => [],
			fetch: async () => undefined,
			markSeen: async (uid) => {
				markedSeen.push(uid)
			},
		},
		send: async (m) => {
			sent.push(m)
		},
	})

	const { port } = await service.listen(0, "127.0.0.1")
	return {
		service,
		base: `http://127.0.0.1:${port}`,
		env,
		sent,
		markedSeen,
		close: () => service.close(),
	}
}

function auth(extra: Record<string, string> = {}) {
	return { authorization: `Bearer ${TOKEN}`, ...extra }
}

function post(h: Harness, path: string, body: unknown, headers: Record<string, string> = auth()): Promise<Response> {
	return fetch(`${h.base}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) })
}

/** Open an SSE stream and collect raw text. */
function openSse(h: Harness): Promise<{ stop(): void; text(): string }> {
	return new Promise((resolve, reject) => {
		const req = http.get(`${h.base}/events`, { headers: auth() }, (res) => {
			let buf = ""
			res.setEncoding("utf8")
			res.on("data", (chunk: string) => {
				buf += chunk
			})
			resolve({ stop: () => req.destroy(), text: () => buf })
		})
		req.on("error", reject)
	})
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- auth ------------------------------------------------------------------

test("/health is open, everything else needs the bearer token", async () => {
	const h = await boot()
	try {
		assert.equal((await fetch(`${h.base}/health`)).status, 200)
		assert.equal((await fetch(`${h.base}/pending`)).status, 401)
		assert.equal((await post(h, "/claim", { uid: 1, instanceId: "i" }, {})).status, 401)
		// Wrong token is also 401, with no hint about which part failed.
		const wrong = await fetch(`${h.base}/pending`, { headers: { authorization: "Bearer nope" } })
		assert.equal(wrong.status, 401)
		assert.doesNotMatch(await wrong.text(), /token|secret/i)
	} finally {
		await h.close()
	}
})

// --- pending / claim / ack -------------------------------------------------

test("/pending replays durable records for catch-up", async () => {
	const h = await boot()
	try {
		addPending(h.env, { uid: 5, sessionId: "s1", from: "you@example.com", subject: "re", body: "do it", receivedAt: 1 })
		const res = await fetch(`${h.base}/pending`, { headers: auth() })
		assert.equal(res.status, 200)
		const body = (await res.json()) as { pending: { uid: number; sessionId: string }[] }
		assert.equal(body.pending.length, 1)
		assert.equal(body.pending[0]!.uid, 5)
		assert.equal(body.pending[0]!.sessionId, "s1")
	} finally {
		await h.close()
	}
})

test("claim is exclusive across instances", async () => {
	const h = await boot()
	try {
		addPending(h.env, { uid: 7, sessionId: "s1", from: "you@example.com", subject: "re", body: "b", receivedAt: 1 })
		assert.equal((await post(h, "/claim", { uid: 7, instanceId: "A" })).status, 200)
		const second = await post(h, "/claim", { uid: 7, instanceId: "B" })
		assert.equal(second.status, 409)
		assert.match(await second.text(), /claimed-by-other/)
		assert.equal((await post(h, "/claim", { uid: 99, instanceId: "A" })).status, 404)
	} finally {
		await h.close()
	}
})

test("ack removes the record, journals the uid and marks the mail seen", async () => {
	const h = await boot()
	try {
		addPending(h.env, { uid: 9, sessionId: "s1", from: "you@example.com", subject: "re", body: "b", receivedAt: 1 })
		await post(h, "/claim", { uid: 9, instanceId: "A" })

		const res = await post(h, "/ack", { uid: 9, instanceId: "A", sessionId: "s1" })
		assert.equal(res.status, 200)
		assert.equal(listPending(h.env).length, 0, "record removed")
		assert.equal(isJournaled(h.env, 9), true, "uid journaled for replay protection")
		assert.deepEqual(h.markedSeen, [9], "mailbox marked seen only now")
	} finally {
		await h.close()
	}
})

test("a non-claimant cannot ack", async () => {
	const h = await boot()
	try {
		addPending(h.env, { uid: 4, sessionId: "s1", from: "you@example.com", subject: "re", body: "b", receivedAt: 1 })
		await post(h, "/claim", { uid: 4, instanceId: "A" })
		const res = await post(h, "/ack", { uid: 4, instanceId: "B" })
		assert.equal(res.status, 409)
		assert.equal(listPending(h.env).length, 1, "record survives")
		assert.equal(isJournaled(h.env, 4), false)
	} finally {
		await h.close()
	}
})

// --- register --------------------------------------------------------------

test("register reserves once, reports pending the second time, and releases", async () => {
	const h = await boot()
	try {
		const first = await post(h, "/register", { sessionId: "s1" })
		assert.deepEqual(await first.json(), { alreadyPending: false, full: false })

		const second = await post(h, "/register", { sessionId: "s1" })
		assert.deepEqual(await second.json(), { alreadyPending: true, full: false })

		const del = await fetch(`${h.base}/register`, {
			method: "DELETE",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "s1" }),
		})
		assert.equal(del.status, 200)

		const third = await post(h, "/register", { sessionId: "s1" })
		assert.deepEqual(await third.json(), { alreadyPending: false, full: false })
	} finally {
		await h.close()
	}
})

// --- mode + SSE ------------------------------------------------------------

test("POST /mode persists and broadcasts to connected SSE clients", async () => {
	const h = await boot()
	const sse = await openSse(h)
	try {
		await wait(50)
		assert.match(sse.text(), /connected/)
		assert.match(sse.text(), /"type":"mode"/, "initial mode is pushed on connect")

		const res = await post(h, "/mode", { mode: "on" })
		assert.equal(res.status, 200)
		assert.equal(readMode(h.env), "on", "persisted")

		await wait(100)
		assert.match(sse.text(), /"mode":"on"/, "broadcast received")

		const bad = await post(h, "/mode", { mode: "yes" })
		assert.equal(bad.status, 400)
	} finally {
		sse.stop()
		await h.close()
	}
})

test("GET /mode reflects the persisted value", async () => {
	const h = await boot()
	try {
		assert.deepEqual(await (await fetch(`${h.base}/mode`, { headers: auth() })).json(), { mode: "off" })
		await post(h, "/mode", { mode: "on" })
		assert.deepEqual(await (await fetch(`${h.base}/mode`, { headers: auth() })).json(), { mode: "on" })
	} finally {
		await h.close()
	}
})

// --- send ------------------------------------------------------------------

test("/send hands the message to the injected mailer", async () => {
	const h = await boot()
	try {
		const res = await post(h, "/send", { subject: "pi: finished", text: "3 turns" })
		assert.equal(res.status, 200)
		assert.equal(h.sent.length, 1)
		assert.equal(h.sent[0]!.to, "you@example.com")
		assert.equal(h.sent[0]!.subject, "pi: finished")
		assert.equal(h.sent[0]!.text, "3 turns")
		assert.match(String(h.sent[0]!.messageId), /^<[0-9a-f-]{36}@/, "a Message-ID is minted for every send")

		const explicit = await post(h, "/send", { to: "other@example.com", subject: "s", text: "t" })
		assert.equal(explicit.status, 200)
		assert.equal(h.sent[1]!.to, "other@example.com")

		assert.equal((await post(h, "/send", { subject: "", text: "t" })).status, 400)
	} finally {
		await h.close()
	}
})

test("a send failure surfaces as 502 rather than 200", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-daemon-")) }
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => {
			throw new Error("535 auth failed")
		},
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const res = await fetch(`http://127.0.0.1:${port}/send`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ subject: "s", text: "t" }),
		})
		assert.equal(res.status, 502)
		assert.match(await res.text(), /535/)
	} finally {
		await service.close()
	}
})

// --- bounds ----------------------------------------------------------------

test("an oversized body is rejected without crashing the daemon", async () => {
	const h = await boot()
	try {
		const big = "x".repeat(MAX_BODY_BYTES + 1024)
		const res = await fetch(`${h.base}/send`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ subject: "s", text: big }),
		}).catch(() => undefined)
		// Either a 413 or a dropped connection is acceptable; a crash is not.
		if (res) assert.ok(res.status === 413 || res.status === 400, `unexpected status ${res.status}`)
		assert.equal((await fetch(`${h.base}/health`)).status, 200, "daemon still alive")
	} finally {
		await h.close()
	}
})

test("malformed JSON is a 400, unknown route is a 404", async () => {
	const h = await boot()
	try {
		const bad = await fetch(`${h.base}/mode`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: "{not json",
		})
		assert.equal(bad.status, 400)
		assert.equal((await fetch(`${h.base}/nope`, { headers: auth() })).status, 404)
	} finally {
		await h.close()
	}
})

test("/send reports the Message-ID to the caller so it can be recorded", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-daemon-")) }
	const seen: { messageId?: string; subject: string }[] = []
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<m1@pi.local>" }),
		onSent: (info) => seen.push(info),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const res = await fetch(`http://127.0.0.1:${port}/send`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ subject: "[pi:a.b] pi: x", text: "t" }),
		})
		assert.equal(res.status, 200)
		// The id reported is the one we minted and recorded before the send, not whatever the
		// transport says - threading and the echo guard both reference it.
		assert.equal(seen.length, 1)
		assert.match(String(seen[0]!.messageId), /^<[0-9a-f-]{36}@example\.com>$/)
		assert.equal(seen[0]!.subject, "[pi:a.b] pi: x")
	} finally {
		await service.close()
	}
})

test("POST /reload restarts the watcher and requires auth", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-daemon-")) }
	let reloads = 0
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => {},
		reload: async () => {
			reloads++
			return { ok: true }
		},
	})
	const { port } = await service.listen(0, "127.0.0.1")
	const base = `http://127.0.0.1:${port}`
	try {
		assert.equal((await fetch(`${base}/reload`, { method: "POST" })).status, 401)
		assert.equal(reloads, 0, "unauthenticated reload must not run")

		const ok = await fetch(`${base}/reload`, { method: "POST", headers: auth() })
		assert.equal(ok.status, 200)
		assert.equal(reloads, 1)
	} finally {
		await service.close()
	}
})

test("a failed reload surfaces as 500 with the reason", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-daemon-")) }
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => {},
		reload: async () => ({ ok: false, error: "bad config" }),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const res = await fetch(`http://127.0.0.1:${port}/reload`, { method: "POST", headers: auth() })
		assert.equal(res.status, 500)
		assert.match(await res.text(), /bad config/)
	} finally {
		await service.close()
	}
})

test("POST /shutdown acknowledges before exiting, and needs auth", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-daemon-")) }
	let stopped = 0
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => {},
		shutdown: () => {
			stopped++
		},
	})
	const { port } = await service.listen(0, "127.0.0.1")
	const base = `http://127.0.0.1:${port}`
	try {
		assert.equal((await fetch(`${base}/shutdown`, { method: "POST" })).status, 401)
		assert.equal(stopped, 0, "unauthenticated shutdown must not work")

		const ok = await fetch(`${base}/shutdown`, { method: "POST", headers: auth() })
		assert.equal(ok.status, 200, "the client must get an answer before the process exits")
		await new Promise((r) => setTimeout(r, 120))
		assert.equal(stopped, 1)
	} finally {
		await service.close()
	}
})

// --- lifetime: exit when no session is left --------------------------------

function idleRig(over: { exitWhenIdle?: () => boolean; idleTimeoutMs?: number } = {}) {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-idle-")) }
	const state = { stops: 0 }
	const service = createDaemonService({
		config: { ...config(), daemon: { host: "127.0.0.1", port: 0 } },
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => {},
		shutdown: () => {
			state.stops++
		},
		exitWhenIdle: over.exitWhenIdle ?? (() => true),
		idleTimeoutMs: over.idleTimeoutMs ?? 300,
	})
	return { service, state }
}

test("a daemon that no session has ever pinged keeps running", async () => {
	const { service, state } = idleRig({ idleTimeoutMs: 200 })
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		await new Promise((r) => setTimeout(r, 900))
		assert.equal(state.stops, 0, "a systemd-started daemon must not exit just because pi is absent")
	} finally {
		await service.close()
	}
})

test("the daemon exits once every session stops pinging", async () => {
	const { service, state } = idleRig({ idleTimeoutMs: 300 })
	const { port } = await service.listen(0, "127.0.0.1")
	const base = `http://127.0.0.1:${port}`
	try {
		await fetch(`${base}/ping`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ instanceId: "pi-1" }),
		})
		await new Promise((r) => setTimeout(r, 1200))
		assert.equal(state.stops, 1, "no ping for longer than the timeout means exit")
	} finally {
		await service.close()
	}
})

test("a session saying goodbye lets the daemon stop early", async () => {
	const { service, state } = idleRig({ idleTimeoutMs: 60_000 })
	const { port } = await service.listen(0, "127.0.0.1")
	const base = `http://127.0.0.1:${port}`
	const post = (path: string, body: unknown) =>
		fetch(`${base}${path}`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body) })
	try {
		await post("/ping", { instanceId: "pi-1" })
		await post("/ping", { instanceId: "pi-2" })
		const afterBye = await (await post("/bye", { instanceId: "pi-2" })).json()
		assert.equal((afterBye as { clients: number }).clients, 1, "the other session is still live")
		assert.equal(state.stops, 0)
	} finally {
		await service.close()
	}
})

test("exitWhenIdle false keeps a resident daemon resident", async () => {
	const { service, state } = idleRig({ exitWhenIdle: () => false, idleTimeoutMs: 200 })
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		await fetch(`http://127.0.0.1:${port}/ping`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ instanceId: "pi-1" }),
		})
		await new Promise((r) => setTimeout(r, 900))
		assert.equal(state.stops, 0, "systemd mode ignores idleness")
	} finally {
		await service.close()
	}
})

test("ping requires auth", async () => {
	const { service } = idleRig()
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const res = await fetch(`http://127.0.0.1:${port}/ping`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ instanceId: "x" }),
		})
		assert.equal(res.status, 401)
	} finally {
		await service.close()
	}
})

// --- threading: the bug was that nothing was ever recorded ------------------

test("/send records the Message-ID before handing the mail over, and threads it", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-thread-")) }
	const { sessionThread } = await import("../src/store/threads.ts")
	const { readFileSync } = await import("node:fs")
	const { statePath } = await import("../src/store/paths.ts")
	const sent: { subject: string; inReplyTo?: string; references?: string[]; messageId: string; recordedAlready: boolean }[] = []

	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async (message) => {
			// The ordering claim: the store must already know this id when the send starts,
			// because the mail can bounce back into INBOX before it returns.
			const stored = JSON.parse(readFileSync(statePath(env, "threads.json"), "utf8")) as {
				items: { messageId: string }[]
			}
			sent.push({
				subject: message.subject,
				inReplyTo: message.inReplyTo,
				references: message.references,
				messageId: message.messageId,
				recordedAlready: stored.items.some((r) => r.messageId === message.messageId.replace(/[<>]/g, "")),
			})
			return { messageId: message.messageId }
		},
	})
	const { port } = await service.listen(0, "127.0.0.1")
	const base = `http://127.0.0.1:${port}`
	const sendOnce = (subject: string) =>
		fetch(`${base}/send`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ subject, text: "x", sessionId: "sess-thread" }),
		})
	try {
		// A short route id, exactly what production sends - the case that used to record nothing.
		await sendOnce("[pi:c05698] pi: one")
		const first = sent[0]!.messageId.replace(/[<>]/g, "")
		assert.deepEqual(sessionThread(env, "sess-thread"), { rootMessageId: first, lastMessageId: first })
		assert.equal(sent[0]!.recordedAlready, true, "recorded before the transport was called")

		await sendOnce("[pi:c05698] pi: two")
		assert.equal(sent[1]!.inReplyTo, `<${first}>`, "the second answers the first")
		assert.deepEqual(sent[1]!.references, [`<${first}>`], "and references the session root")
		assert.equal(sent[1]!.recordedAlready, true)
	} finally {
		await service.close()
	}
})

test("/send without a sessionId sets no threading headers", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-thread-")) }
	let seen: { inReplyTo?: string } = {}
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async (message) => {
			seen = { inReplyTo: message.inReplyTo }
			return { messageId: "<x@qq.com>" }
		},
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		await fetch(`http://127.0.0.1:${port}/send`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ subject: "pi: x", text: "y" }),
		})
		assert.equal(seen.inReplyTo, undefined)
	} finally {
		await service.close()
	}
})

test("/ack refuses a record nobody claimed, so another session's reply survives", async () => {
	// End-to-end version of the ownership rule: the service must not let an authenticated
	// client consume a reply it never claimed.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-ack-")) }
	const { addPending, pendingSize } = await import("../src/store/pending-store.ts")
	addPending(env, {
		uid: 42,
		sessionId: "victim-session",
		from: "you@example.com",
		subject: "re",
		body: "ship it",
		receivedAt: 1,
	})

	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const res = await fetch(`http://127.0.0.1:${port}/ack`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ uid: 42, instanceId: "attacker-inst", sessionId: "attacker-session" }),
		})
		assert.equal(res.status, 409)
		assert.equal(pendingSize(env), 1, "the victim's reply is still pending")
	} finally {
		await service.close()
	}
})

test("/health reports the last scan's rejection reasons", async () => {
	// The reasons were computed and thrown away. "Why did my reply not arrive" needs them.
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-scan-")) },
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
		scanSummary: () => ({
			at: 1,
			examined: 3,
			persisted: 1,
			rejected: 2,
			reasons: { routed: 2, "not-allowlisted": 1, "dmarc-missing": 1 },
		}),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`)
		const body = (await res.json()) as { lastScan: { reasons: Record<string, number> } }
		assert.equal(body.lastScan.reasons["not-allowlisted"], 1)
		assert.equal(body.lastScan.reasons["dmarc-missing"], 1)
	} finally {
		await service.close()
	}
})

test("POST /mode notifies the daemon so turning it on can rescan", async () => {
	// Without this hook the daemon only scans on a NEW arrival, so a reply that landed
	// while the channel was closed would wait for unrelated mail.
	const seen: string[] = []
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-mode-")) },
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
		onModeChange: (mode) => seen.push(mode),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	const setMode = (mode: string) =>
		fetch(`http://127.0.0.1:${port}/mode`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ mode }),
		})
	try {
		await setMode("on")
		await setMode("off")
		await setMode("on")
		assert.deepEqual(seen, ["on", "off", "on"], "the daemon sees every transition")
	} finally {
		await service.close()
	}
})

test("/send uses the CURRENT config after a reload, not the snapshot it started with", async () => {
	// A documented re-setup changes the human's address. The service used to hold the
	// config it was built with, so notifications kept going to the old mailbox - agent
	// output delivered to an address the user had just replaced.
	let current = config()
	const sent: { to: string }[] = []
	const service = createDaemonService({
		config: config(),
		getConfig: () => current,
		token: TOKEN,
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-livecfg-")) },
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async (message) => {
			sent.push({ to: message.to })
			return { messageId: "<x@qq.com>" }
		},
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const post = (body: Record<string, unknown>) =>
			fetch(`http://127.0.0.1:${port}/send`, {
				method: "POST",
				headers: { ...auth(), "content-type": "application/json" },
				body: JSON.stringify(body),
			})
		await post({ subject: "pi: one", text: "a" })
		current = config()
		current.mail.to = "new-address@example.com"
		await post({ subject: "pi: two", text: "b" })
		assert.deepEqual(sent.map((s) => s.to), ["you@example.com", "new-address@example.com"])
	} finally {
		await service.close()
	}
})

test("/health reports when the daemon read its config", async () => {
	// The extension compares this with the file's mtime to decide whether to reload a daemon
	// that was holding a config older than the file.
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-cfgstamp-")) },
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
		configLoadedAt: () => 1234,
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const body = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { configLoadedAt: number }
		assert.equal(body.configLoadedAt, 1234)
	} finally {
		await service.close()
	}
})

test("the scan uses the source's UIDVALIDITY, so a renumbered mailbox is not skipped", async () => {
	// The journal is keyed by UID space. If the scan does not pass the source's uidValidity,
	// old entries suppress new mail - and the guard is silently inert. MailSource makes the
	// member required so an omission is a type error; this proves the scan actually uses it.
	const { journal } = await import("../src/store/journal.ts")
	const { recordOutbound } = await import("../src/store/threads.ts")
	const { scanAndProcess } = await import("../src/daemon/process.ts")
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-uidv-")) }
	// Acked under the OLD numbering.
	journal(env, 1, 1111)
	// A route for the reply, so the scan reaches persistence rather than no-token.
	recordOutbound(env, { messageId: "<root@example.com>", sessionId: "sess-1", device: "test-device", subject: "x" })

	const r = await scanAndProcess(config(), {
		secret: Buffer.alloc(32, 3),
		env,
		source: {
			uidValidity: () => 2222,
			searchAfter: async () => [1],
			fetch: async () => ({
				uid: 1,
				from: "you@example.com",
				subject: "Re: pi: x",
				text: "yes",
				headers: { authResults: ["mx.example.com; dmarc=pass"], inReplyTo: "<root@example.com>" },
				receivedAt: 1,
			}),
		},
	})
	assert.equal(r.reasons["journaled"], undefined, "a UID from another space must not be skipped")
	assert.equal(r.persisted, 1)
})

test("/ack refuses a record from a space the mailbox has left", async () => {
	// A caller and a record can agree with each other while both belong to a numbering the
	// mailbox left. Acking would delete the record, journal a UID that now means something
	// else, and mark that message \Seen.
	const { addPending, claimPending } = await import("../src/store/pending-store.ts")
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-ackspace-")) }
	addPending(env, {
		uid: 5,
		sessionId: "sess-1",
		from: "you@example.com",
		subject: "re",
		body: "yes",
		receivedAt: 1,
		uidValidity: 1111,
	})
	claimPending(env, 5, "inst", Date.now(), 1111, 1111)
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => 2222, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const res = await fetch(`http://127.0.0.1:${port}/ack`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ uid: 5, instanceId: "inst", uidValidity: 1111 }),
		})
		assert.equal(res.status, 409, "the record is stale against the mailbox")
		const body = (await res.json()) as { error?: { code?: string } }
		assert.equal(body.error?.code, "stale-space", "and the code names the reason")
		const { isJournaled } = await import("../src/store/journal.ts")
		assert.equal(isJournaled(env, 5, 2222), false, "nothing journaled in the live space")
	} finally {
		await service.close()
	}
})

test("/ack frees the record's decision slot", async () => {
	// Wrong id here leaves the session told it has an outstanding decision for up to a day.
	const { addPending, claimPending } = await import("../src/store/pending-store.ts")
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-acksess-")) }
	addPending(env, {
		uid: 3,
		sessionId: "sess-owner",
		from: "you@example.com",
		subject: "re",
		body: "yes",
		receivedAt: 1,
	})
	claimPending(env, 3, "inst")
	const released: string[] = []
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
		registry: {
			list: () => [],
			reserve: () => ({ ok: true }),
			release: (sessionId: string) => {
				released.push(sessionId)
			},
		} as never,
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		await fetch(`http://127.0.0.1:${port}/ack`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ uid: 3, instanceId: "inst" }),
		})
		assert.deepEqual(released, ["sess-owner"], "the record's session, not the body's")
	} finally {
		await service.close()
	}
})

test("a malformed request target does not crash the daemon", async () => {
	// `new URL` runs before authentication and Node accepts absolute-form targets, so
	// `GET http://[` threw inside the async handler. Nothing caught it and Node's default is
	// to exit - one unauthenticated request killed the bridge.
	const { request } = await import("node:http")
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-url-")) },
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
	})
	const rejections: unknown[] = []
	const onRejection = (error: unknown): void => {
		rejections.push(error)
	}
	process.on("unhandledRejection", onRejection)
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		await new Promise<void>((resolve) => {
			const req = request({ host: "127.0.0.1", port, path: "http://[", method: "GET" }, () => resolve())
			req.on("error", () => resolve())
			req.end()
		})
		await new Promise((r) => setTimeout(r, 50))
		assert.deepEqual(rejections, [], "no unhandled rejection")
		// And the daemon still answers.
		const health = await fetch(`http://127.0.0.1:${port}/health`)
		assert.equal(health.status, 200)
	} finally {
		process.off("unhandledRejection", onRejection)
		await service.close()
	}
})

test("the SSE client cap is enforced", async () => {
	// Bounded resources are a stated invariant; the cap was untested.
	const { MAX_SSE_CLIENTS } = await import("../src/daemon/service.ts")
	const { request } = await import("node:http")
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-sse-")) },
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	const openStreams: { destroy(): void }[] = []
	const open = (): Promise<number> =>
		new Promise((resolve) => {
			let status = -1
			const req = request(
				{ host: "127.0.0.1", port, path: "/events", method: "GET", headers: { authorization: `Bearer ${TOKEN}` } },
				(res) => {
					status = res.statusCode ?? 0
					if (status === 200) openStreams.push(res)
					res.resume()
					resolve(status)
				},
			)
			req.on("error", () => resolve(-1))
			req.end()
		})
	try {
		const statuses: number[] = []
		for (let i = 0; i < MAX_SSE_CLIENTS + 1; i++) statuses.push(await open())
		assert.equal(statuses.filter((s) => s === 503).length, 1, "exactly one client is refused")
		assert.equal(statuses.filter((s) => s === 200).length, MAX_SSE_CLIENTS)
	} finally {
		for (const res of openStreams) res.destroy()
		await service.close()
	}
})

test("/health reports whether IMAP is connected", async () => {
	// A revoked credential leaves the daemon running and looking healthy; without this the
	// user sees "daemon healthy, last scan N minutes ago" and nothing else.
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-imap-")) },
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
		imapHealthy: () => false,
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const body = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { imap: string }
		assert.equal(body.imap, "disconnected")
	} finally {
		await service.close()
	}
})

test("an internal failure is a 500, not a 400", async () => {
	// Reporting a store write failure as "bad request" sends incident triage the wrong way.
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-500-")) },
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
		registry: {
			list: () => {
				throw new Error("disk on fire")
			},
			reserve: () => ({ ok: true }),
			release: () => {},
		} as never,
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const res = await fetch(`http://127.0.0.1:${port}/register`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "s" }),
		})
		assert.equal(res.status, 500)
	} finally {
		await service.close()
	}
})

test("a malformed body is still a 400", async () => {
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-400-")) },
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	try {
		const res = await fetch(`http://127.0.0.1:${port}/send`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			body: "{ not json",
		})
		assert.equal(res.status, 400)
	} finally {
		await service.close()
	}
})

test("a store write failure is a 500 even though the path says .json", async () => {
	// The previous classifier matched the substring "json" and so reported EACCES on
	// threads.json as a bad request - the exact case the split was written for.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-eacces-")) }
	const { chmodSync } = await import("node:fs")
	const { statePath } = await import("../src/store/paths.ts")
	const { addPending } = await import("../src/store/pending-store.ts")
	// A record so /ack has something to remove, then make the dir unwritable.
	addPending(env, { uid: 1, sessionId: "s", from: "you@example.com", subject: "x", body: "y", receivedAt: 1 })
	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: { uidValidity: () => undefined, searchAfter: async () => [], fetch: async () => undefined },
		send: async () => ({ messageId: "<x@qq.com>" }),
	})
	const { port } = await service.listen(0, "127.0.0.1")
	const dir = join(statePath(env, "x"), "..")
	try {
		chmodSync(dir, 0o500)
		const res = await fetch(`http://127.0.0.1:${port}/send`, {
			method: "POST",
			headers: { ...auth(), "content-type": "application/json" },
			// A sessionId makes the daemon record the outbound id in threads.json, which now fails.
			body: JSON.stringify({ subject: "[pi:abc123] x", text: "y", sessionId: "s" }),
		})
		assert.equal(res.status, 500, `a write failure must not read as bad_request (got ${res.status})`)
	} finally {
		chmodSync(dir, 0o700)
		await service.close()
	}
})
