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
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false, subject: "pi" },
		tuning: { idleRenewMs: 1, autoIdleDelayMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
	}
}

interface Harness {
	service: DaemonService
	base: string
	env: NodeJS.ProcessEnv
	sent: { to: string; subject: string; text: string }[]
	markedSeen: number[]
	close(): Promise<void>
}

async function boot(): Promise<Harness> {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-daemon-")) }
	const sent: { to: string; subject: string; text: string }[] = []
	const markedSeen: number[] = []

	const service = createDaemonService({
		config: config(),
		token: TOKEN,
		env,
		source: {
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
		assert.deepEqual(h.sent, [{ to: "you@example.com", subject: "pi: finished", text: "3 turns" }])

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
		source: { searchAfter: async () => [], fetch: async () => undefined },
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
		source: { searchAfter: async () => [], fetch: async () => undefined },
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
		assert.deepEqual(seen, [{ messageId: "<m1@pi.local>", subject: "[pi:a.b] pi: x" }])
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
		source: { searchAfter: async () => [], fetch: async () => undefined },
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
		source: { searchAfter: async () => [], fetch: async () => undefined },
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
