import { test } from "node:test"
import assert from "node:assert/strict"

import type { ResolvedConfig } from "../src/core/config.ts"
import {
	createImapWatcher,
	extractHeaders,
	nextBackoff,
	searchRangeFor,
	toHeaderLike,
	type ImapClientLike,
} from "../src/daemon/watcher.ts"

function config(over: Partial<ResolvedConfig["tuning"]> = {}): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "pi@example.com", password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: "pi@example.com", password: "x", authType: "LOGIN" },
			to: "pi@example.com",
		},
		security: { allowFrom: ["you@example.com"], requireDmarcPass: true, trustedAuthservId: "mx.example.com", tokenTtlHours: 24 },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false, subject: "pi" },
		tuning: { idleRenewMs: 1000, autoIdleDelayMs: 1, backoffInitialMs: 100, backoffMaxMs: 800, ...over },
		device: { name: "test-device" },
		warnings: [],
	}
}

function fakeTimers() {
	const scheduled: { handler: () => void; ms: number }[] = []
	const cleared: unknown[] = []
	return {
		scheduled,
		cleared,
		timers: {
			setTimeout(handler: () => void, ms: number) {
				scheduled.push({ handler, ms })
				return scheduled.length
			},
			clearTimeout(handle: unknown) {
				cleared.push(handle)
			},
		},
	}
}

interface FakeClientOptions {
	failConnect?: boolean
	source?: Buffer
	uids?: number[]
}

function fakeFactory(opts: FakeClientOptions = {}) {
	const calls: { search: unknown[]; fetch: unknown[]; opened: string[]; loggedOut: number } = {
		search: [],
		fetch: [],
		opened: [],
		loggedOut: 0,
	}
	let instances = 0
	const listeners = new Map<string, ((...a: unknown[]) => void)[]>()

	const factory = () => {
		instances++
		const client: ImapClientLike = {
			usable: true,
			async connect() {
				if (opts.failConnect) throw new Error("connect refused")
			},
			async logout() {
				calls.loggedOut++
				client.usable = false
			},
			async mailboxOpen(path: string) {
				calls.opened.push(path)
			},
			async search(query, o) {
				calls.search.push({ query, o })
				return opts.uids ?? []
			},
			async fetchOne(uid, query, o) {
				calls.fetch.push({ uid, query, o })
				return { source: opts.source ?? Buffer.from("Subject: x\r\n\r\nbody") }
			},
			on(event, listener) {
				const list = listeners.get(event) ?? []
				list.push(listener)
				listeners.set(event, list)
			},
		}
		return client
	}

	return {
		calls,
		factory,
		get instances() {
			return instances
		},
		fire(event: string) {
			for (const l of listeners.get(event) ?? []) l()
		},
	}
}

// --- pure helpers ----------------------------------------------------------

test("searchRangeFor never emits a range below 1", () => {
	assert.equal(searchRangeFor(0), "1:*")
	assert.equal(searchRangeFor(5), "6:*")
	assert.equal(searchRangeFor(-3), "1:*")
})

test("nextBackoff doubles then clamps at max", () => {
	assert.equal(nextBackoff(0, 100, 800), 100)
	assert.equal(nextBackoff(1, 100, 800), 200)
	assert.equal(nextBackoff(2, 100, 800), 400)
	assert.equal(nextBackoff(3, 100, 800), 800)
	assert.equal(nextBackoff(9, 100, 800), 800, "clamped")
	assert.equal(nextBackoff(999, 100, 800), 800, "extreme attempt stays finite")
})

test("extractHeaders keeps every Authentication-Results in wire order", () => {
	const raw = [
		"From: Ada <You@Example.com>",
		"Subject: re: thing",
		"Authentication-Results: attacker.example; dmarc=pass",
		"Authentication-Results: mx.example.com; dmarc=fail",
		"Received: by mx",
		"",
		"body",
	].join("\r\n")

	const h = extractHeaders(raw)
	assert.deepEqual(h.headerValues.get("authentication-results"), [
		"attacker.example; dmarc=pass",
		"mx.example.com; dmarc=fail",
	])
	assert.equal(h.from, "Ada <You@Example.com>")
	assert.equal(h.subject, "re: thing")
})

test("extractHeaders unfolds continuations", () => {
	const raw = ["Authentication-Results: mx.example.com;", "\tdmarc=pass header.from=example.com", "", "x"].join("\r\n")
	assert.deepEqual(extractHeaders(raw).headerValues.get("authentication-results"), [
		"mx.example.com; dmarc=pass header.from=example.com",
	])
})

test("toHeaderLike exposes the fields authz consumes", () => {
	const h = extractHeaders(
		["From: a@b.co", "Auto-Submitted: auto-replied", "Precedence: bulk", "Authentication-Results: mx.example.com; dmarc=pass", ""].join(
			"\r\n",
		),
	)
	const like = toHeaderLike(h)
	assert.equal(like.from, "a@b.co")
	assert.equal(like.autoSubmitted, "auto-replied")
	assert.equal(like.precedence, "bulk")
	assert.deepEqual(like.authResults, ["mx.example.com; dmarc=pass"])
})

// --- watcher behaviour -----------------------------------------------------

test("start opens the configured folder and reports ready", async () => {
	const fake = fakeFactory()
	let ready = 0
	const w = createImapWatcher(config(), {
		factory: fake.factory,
		callbacks: { onMail: () => {}, onReady: () => ready++ },
		timers: fakeTimers().timers,
	})
	await w.start()
	assert.deepEqual(fake.calls.opened, ["INBOX"])
	assert.equal(ready, 1)
	assert.equal(w.isHealthy(), true)
	await w.stop()
})

test("searchAfter sends the cursor range as a UID search and filters/sorts", async () => {
	const fake = fakeFactory({ uids: [9, 7, 3, 12] })
	const w = createImapWatcher(config(), {
		factory: fake.factory,
		callbacks: { onMail: () => {}, onReady: () => {} },
		timers: fakeTimers().timers,
	})
	await w.start()
	const uids = await w.searchAfter(7)
	assert.deepEqual(uids, [9, 12], "only uids after the cursor, ascending")
	const first = fake.calls.search[0] as { query: { uid: string }; o: { uid: boolean } }
	assert.equal(first.query.uid, "8:*")
	assert.equal(first.o.uid, true)
	await w.stop()
})

test("fetch maps body, from, subject and ordered auth headers", async () => {
	const raw = [
		"From: Ada <you@example.com>",
		"Subject: [pi:abc.def] pi: finished",
		"Authentication-Results: attacker.example; dmarc=pass",
		"Authentication-Results: mx.example.com; dmarc=pass",
		"",
		"yes, ship it",
	].join("\r\n")

	const fake = fakeFactory({ source: Buffer.from(raw) })
	const w = createImapWatcher(config(), {
		factory: fake.factory,
		callbacks: { onMail: () => {}, onReady: () => {} },
		parser: async (buf) => ({ text: buf.toString("utf8").split("\r\n\r\n")[1] ?? "" }),
		timers: fakeTimers().timers,
	})
	await w.start()

	const msg = await w.fetch(42)
	assert.ok(msg)
	assert.equal(msg.uid, 42)
	assert.equal(msg.from, "Ada <you@example.com>")
	assert.equal(msg.subject, "[pi:abc.def] pi: finished")
	assert.equal(msg.text, "yes, ship it")
	assert.deepEqual(msg.headers.authResults, [
		"attacker.example; dmarc=pass",
		"mx.example.com; dmarc=pass",
	], "order preserved so authz can pin the trusted relay")
	await w.stop()
})

test("fetch honours the injected parser (default does not run offline)", async () => {
	let parserCalls = 0
	const fake = fakeFactory()
	const w = createImapWatcher(config(), {
		factory: fake.factory,
		callbacks: { onMail: () => {}, onReady: () => {} },
		parser: async () => {
			parserCalls++
			return { text: "parsed" }
		},
		timers: fakeTimers().timers,
	})
	await w.start()
	assert.equal((await w.fetch(1))?.text, "parsed")
	assert.equal(parserCalls, 1)
	await w.stop()
})

test("a failed connect schedules backoff instead of throwing", async () => {
	const fake = fakeFactory({ failConnect: true })
	const t = fakeTimers()
	let errors = 0
	const w = createImapWatcher(config(), {
		factory: fake.factory,
		callbacks: { onMail: () => {}, onReady: () => {}, onError: () => errors++ },
		timers: t.timers,
	})
	await assert.doesNotReject(() => w.start(), "start must not throw on a dead server")
	assert.equal(errors, 1)
	assert.equal(t.scheduled.length, 1)
	assert.equal(t.scheduled[0]!.ms, 100, "first backoff is backoffInitialMs")
	assert.equal(w.isHealthy(), false)
	await w.stop()
})

test("repeated failures escalate the backoff", async () => {
	const fake = fakeFactory({ failConnect: true })
	const t = fakeTimers()
	const w = createImapWatcher(config(), {
		factory: fake.factory,
		callbacks: { onMail: () => {}, onReady: () => {}, onError: () => {} },
		timers: t.timers,
	})
	await w.start() // attempt 0 -> 100ms
	t.scheduled[0]!.handler() // attempt 1 -> 200ms
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))
	t.scheduled[1]!.handler() // attempt 2 -> 400ms
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))
	assert.deepEqual(t.scheduled.map((s) => s.ms), [100, 200, 400])
	await w.stop()
})

test("stop prevents any further reconnect attempt", async () => {
	const fake = fakeFactory({ failConnect: true })
	const t = fakeTimers()
	const w = createImapWatcher(config(), {
		factory: fake.factory,
		callbacks: { onMail: () => {}, onReady: () => {}, onError: () => {} },
		timers: t.timers,
	})
	await w.start()
	const before = fake.instances
	await w.stop()
	assert.equal(t.cleared.length, 1, "pending reconnect timer cleared")

	// Even if the timer were to fire, the watcher must stay down.
	t.scheduled[0]!.handler()
	await new Promise((r) => setImmediate(r))
	assert.equal(fake.instances, before, "no reconnect after stop")
})

test("exists event triggers onMail; close triggers a reconnect", async () => {
	const fake = fakeFactory()
	const t = fakeTimers()
	let mail = 0
	const w = createImapWatcher(config(), {
		factory: fake.factory,
		callbacks: { onMail: () => mail++, onReady: () => {}, onError: () => {} },
		timers: t.timers,
	})
	await w.start()
	fake.fire("exists")
	assert.equal(mail, 1)
	fake.fire("close")
	assert.equal(t.scheduled.length, 1, "close schedules a reconnect")
	await w.stop()
})

test("searchAfter and fetch throw (not hang) when not connected", async () => {
	const fake = fakeFactory()
	const w = createImapWatcher(config(), {
		factory: fake.factory,
		callbacks: { onMail: () => {}, onReady: () => {} },
		timers: fakeTimers().timers,
	})
	await assert.rejects(() => w.searchAfter(0), /not connected/)
	await assert.rejects(() => w.fetch(1), /not connected/)
})
