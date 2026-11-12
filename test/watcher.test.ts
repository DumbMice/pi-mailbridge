import { test } from "node:test"
import assert from "node:assert/strict"

import type { ResolvedConfig } from "../src/core/config.ts"
import {
	createImapWatcher,
	MAX_MESSAGE_BYTES,
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
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false, maxAttachmentMb: 18 },
		tuning: { idleRenewMs: 1000, backoffInitialMs: 100, backoffMaxMs: 800, ...over },
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

// --- imapflow adapter (guards a real crash fix) ----------------------------

test("the adapter normalizes imapflow's falsy search result", async () => {
	const { adapt } = await import("../src/daemon/imapflow.ts")
	for (const empty of [false, undefined]) {
		const fakeClient = {
			async search() {
				return empty
			},
			on() {},
			usable: true,
		} as never
		const adapted = adapt(fakeClient)
		// Before the adapter, this was `false.filter(...)` -> TypeError on a quiet mailbox.
		assert.deepEqual(await adapted.search({ uid: "1:*" }, { uid: true }), [])
	}
})

test("the adapter passes real results through and exposes usable", async () => {
	const { adapt } = await import("../src/daemon/imapflow.ts")
	const adapted = adapt({ async search() { return [3, 9] }, on() {}, usable: false } as never)
	assert.deepEqual(await adapted.search({ uid: "1:*" }), [3, 9])
	assert.equal(adapted.usable, false)
})

test("the scanner receives Message-ID, which the self-echo guard needs", async () => {
	// Without this header the guard added for threaded notifications is inert in
	// production, however well the scanner tests pass.
	const { toHeaderLike, WANTED_HEADERS } = await import("../src/daemon/watcher.ts")
	assert.ok(WANTED_HEADERS.includes("message-id"), "message-id must be fetched")
	const headers = toHeaderLike({
		from: "you@example.com",
		subject: "re",
		headerValues: new Map([["message-id", ["<abc@qq.com>"]]]),
	})
	assert.equal(headers.messageId, "<abc@qq.com>")
})

test("stop() during a dial logs out the connection that just opened", async () => {
	// stop() nulls `client` before the dial finishes, so its logout is a no-op; without
	// logging out the client we just built, the socket stays open with nothing to close it.
	const t = fakeTimers()
	const log: string[] = []
	let release: () => void = () => {}
	const dialing = new Promise<void>((r) => {
		release = r
	})

	const watcher = createImapWatcher(config(), {
		timers: t.timers,
		factory: () =>
			({
				usable: true,
				async connect() {
					log.push("connect-start")
					await dialing
					log.push("connect-done")
				},
				async logout() {
					log.push("logout")
				},
				async mailboxOpen() {},
				async search() {
					return []
				},
				async fetchOne() {
					return undefined
				},
				on() {},
			}) as never,
		callbacks: { onMail: () => {}, onReady: () => {} },
	})

	const started = watcher.start()
	// Let connect() begin, then stop while it is still awaiting.
	await new Promise((r) => setImmediate(r))
	await watcher.stop()
	release()
	await started

	// stop()'s own teardown already logs out the in-flight client, so `log.includes("logout")`
	// passed even with the fix reverted. The connection that matters is the one whose dial
	// completed after the stop, so require a logout *after* connect-done.
	const done = log.indexOf("connect-done")
	assert.ok(done > -1, `the dial should have completed (saw ${JSON.stringify(log)})`)
	assert.ok(
		log.lastIndexOf("logout") > done,
		`the connection opened after stop() must be logged out (saw ${JSON.stringify(log)})`,
	)
	// The property that actually changed: the watcher must not hand out a dead client.
	// (isHealthy() is already false because `stopped` short-circuits it, so asserting that
	// would pass even on the broken code - the rejects below is what pins the fix.)
	await assert.rejects(() => watcher.searchAfter(0), /not connected/, "a stopped watcher must fail fast")
})

test("a message over the size ceiling is not downloaded", async () => {
	// The full source is fetched before authorization, so an oversized message from any
	// sender would cost the shared daemon a full download and parse.
	const t = fakeTimers()
	let sourceFetches = 0
	const watcher = createImapWatcher(config(), {
		timers: t.timers,
		callbacks: { onMail: () => {}, onReady: () => {} },
		factory: () =>
			({
				usable: true,
				async connect() {},
				async logout() {},
				async mailboxOpen() {},
				async search() {
					return []
				},
				async fetchOne(_uid: number, query: Record<string, unknown>) {
					if (query.source) {
						sourceFetches++
						return { source: Buffer.from("Subject: x\r\n\r\nbody") }
					}
					return { size: MAX_MESSAGE_BYTES + 1, envelope: { subject: "huge" } }
				},
				on() {},
			}) as never,
	})
	await watcher.start()
	const message = await watcher.fetch(1)
	assert.equal(message?.tooLarge, MAX_MESSAGE_BYTES + 1)
	assert.equal(message?.text, "")
	assert.equal(sourceFetches, 0, "the body must not be downloaded")
})

test("the watcher reports the open mailbox's UIDVALIDITY", async () => {
	const t = fakeTimers()
	const watcher = createImapWatcher(config(), {
		timers: t.timers,
		callbacks: { onMail: () => {}, onReady: () => {} },
		factory: () =>
			({
				usable: true,
				mailbox: { uidValidity: 42n },
				async connect() {},
				async logout() {},
				async mailboxOpen() {},
				async search() {
					return []
				},
				async fetchOne() {
					return undefined
				},
				on() {},
			}) as never,
	})
	await watcher.start()
	assert.equal(watcher.uidValidity(), 42, "bigint from imapflow is normalised to a number")
})

test("the real adapter exposes UIDVALIDITY (the guard is not inert in production)", async () => {
	// The watcher reads client.mailbox.uidValidity. adapt() must forward it - a guard that
	// only works with a hand-built fake is no guard at all.
	const fake = {
		connect: async () => {},
		logout: async () => {},
		mailboxOpen: async () => {},
		search: async () => [],
		fetchOne: async () => undefined,
		on: () => {},
		usable: true,
		mailbox: { uidValidity: 987654n, uidNext: 12, exists: 3 },
	}
	const { adapt } = await import("../src/daemon/imapflow.ts")
	const adapted = adapt(fake as never)
	assert.equal(adapted.mailbox?.uidValidity, 987654n, "UIDVALIDITY must reach the watcher")
	// Enumerating the mailbox by hand dropped uidNext after uidValidity; pass it through whole.
	assert.equal(adapted.mailbox?.uidNext, 12, "UIDNEXT must reach the watcher too")

	// imapflow reports `false` when no mailbox is open; that must not look like validity 0.
	const closed = adapt({ ...fake, mailbox: false } as never)
	assert.equal(closed.mailbox, undefined)
})

test("a message whose only body part is HTML still yields text", async () => {
	// mailparser leaves `text` undefined for a multipart message with just a text/html part,
	// and the scanner then rejected the reply as empty-body - permanently, since the cursor had
	// advanced. Reproduced with a parser that mimics mailparser's shape.
	const t = fakeTimers()
	const watcher = createImapWatcher(config(), {
		timers: t.timers,
		callbacks: { onMail: () => {}, onReady: () => {} },
		parser: async () => ({ text: "", html: "<p>yes, <b>ship it</b></p><p>thanks</p>", attachments: [] }),
		factory: () =>
			({
				usable: true,
				async connect() {},
				async logout() {},
				async mailboxOpen() {},
				async search() {
					return []
				},
				async fetchOne() {
					return { source: Buffer.from("Subject: x\r\n\r\n<p>yes</p>") }
				},
				on() {},
			}) as never,
	})
	await watcher.start()
	const message = await watcher.fetch(1)
	assert.match(message?.text ?? "", /yes, ship it/, "the human's words survive")
	assert.match(message?.text ?? "", /thanks/)
})

test("htmlToText keeps text content and drops markup", async () => {
	const { htmlToText } = await import("../src/daemon/watcher.ts")
	const text = htmlToText("<div>Hello <b>you</b></div><br><p>第二行</p><style>x{}</style>")
	assert.match(text, /Hello you/)
	assert.match(text, /第二行/)
	assert.ok(!/[<>]/.test(text), `no tags should remain: ${text}`)
})
