import { test } from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"

import mailbridge, { type ExtensionCtxLike, type ExtensionLike, type SettleTimers } from "../src/extension.ts"
import type { ResolvedConfig } from "../src/core/config.ts"
import type { DaemonResult } from "../src/daemon/spawn.ts"
import type { UserContent } from "../src/core/attachments.ts"
import type { PendingRecord } from "../src/store/pending-store.ts"
import { sessionIdFromSubject } from "../src/core/token.ts"
import { resolveRoute, routeIdFromSubject } from "../src/store/routes.ts"

const SECRET = Buffer.alloc(32, 4)
const SESSION = "sess-abc"

function config(): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "pi@example.com", password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: "pi@example.com", password: "x", authType: "LOGIN" },
			to: "you@example.com",
		},
		security: { allowFrom: ["you@example.com"], requireDmarcPass: false, tokenTtlHours: 24 },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 10_000, notifyOnAborted: false },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
	}
}

interface FakePi extends ExtensionLike {
	events: string[]
	commands: string[]
	tools: string[]
	handlers: Map<string, (event: Record<string, unknown>, ctx: ExtensionCtxLike) => unknown>
	fire(event: string, payload?: Record<string, unknown>): Promise<void>
	sent: string[]
}

function fakePi(ctx: ExtensionCtxLike): FakePi {
	const events: string[] = []
	const commands: string[] = []
	const tools: string[] = []
	const handlers = new Map<string, (event: Record<string, unknown>, ctx: ExtensionCtxLike) => unknown>()
	const sent: string[] = []
	const pi: FakePi = {
		events,
		commands,
		tools,
		handlers,
		sent,
		on(event, handler) {
			events.push(event)
			handlers.set(event, handler)
		},
		registerCommand(name) {
			commands.push(name)
		},
		registerTool(spec) {
			tools.push(spec.name)
		},
		sendUserMessage(content) {
			sent.push(
				typeof content === "string"
					? content
					: content
							.map((c: UserContent) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`))
							.join("\n"),
			)
		},
		async fire(event, payload = {}) {
			await handlers.get(event)?.(payload, ctx)
		},
	}
	return pi
}

function ctx(notes: string[] = []): ExtensionCtxLike {
	return {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION, getName: () => "fix-login" },
		ui: {
			notify(message: string) {
				notes.push(message)
			},
		},
	}
}

function fakeTimers() {
	const queue: { handler: () => void; ms: number }[] = []
	const timers: SettleTimers = {
		setTimeout(handler, ms) {
			queue.push({ handler, ms })
			return queue.length
		},
		clearTimeout() {},
	}
	return { queue, timers }
}

interface FakeDaemon {
	client: ReturnType<typeof import("../src/daemon/spawn.ts").createDaemonClient>
	sent: { to?: string; subject: string; text: string }[]
	modes: string[]
	registered: string[]
	released: string[]
	acked: number[]
	pendingRecords: PendingRecord[]
}

function fakeDaemon(over: { mode?: "on" | "off"; pending?: PendingRecord[]; sendOk?: boolean } = {}): FakeDaemon {
	const sent: { to?: string; subject: string; text: string }[] = []
	const modes: string[] = []
	const registered: string[] = []
	const released: string[] = []
	const acked: number[] = []
	let currentMode = over.mode ?? "on"
	const pendingRecords = over.pending ?? []

	const ok = <T>(data: T): DaemonResult<T> => ({ ok: true, data })

	const client = {
		health: async () => ok({ ok: true, mode: currentMode, pending: pendingRecords.length }),
		pending: async () => ok({ pending: pendingRecords }),
		mode: async () => ok({ mode: currentMode }),
		setMode: async (mode: "on" | "off") => {
			currentMode = mode
			modes.push(mode)
			return ok({ mode })
		},
		// The tick's first call. Without it the whole tick threw and the swallow-all catch
		// hid it, so gate tests passed for the wrong reason.
		ping: async () => ok({ ok: true, clients: 1 }),
		claim: async () => ok({ ok: true }),
		ack: async (uid: number) => {
			acked.push(uid)
			return ok({ ok: true })
		},
		register: async (sessionId: string) => {
			registered.push(sessionId)
			return ok({ alreadyPending: false, full: false })
		},
		release: async (sessionId: string) => {
			released.push(sessionId)
			return ok({ ok: true })
		},
		send: async (message: { to?: string; subject: string; text: string }) => {
			if (over.sendOk === false) return { ok: false as const, status: 502, code: "send_failed" }
			sent.push(message)
			return ok({ ok: true })
		},
	}

	return { client: client as never, sent, modes, registered, released, acked, pendingRecords }
}

function boot(daemon: FakeDaemon, timers: SettleTimers, c = ctx()) {
	const pi = fakePi(c)
	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" },
		loadConfig: config,
		secret: () => SECRET,
		makeClient: () => daemon.client,
		ensureDaemon: async () => true,
		timers,
		pollMs: 60_000,
	})
	return pi
}

// --- registration surface --------------------------------------------------

test("registers agent_settled and never agent_end", () => {
	const t = fakeTimers()
	const pi = boot(fakeDaemon(), t.timers)
	assert.ok(pi.events.includes("agent_settled"), "must react to settle")
	assert.ok(!pi.events.includes("agent_end"), "agent_end is not a finished signal and must not be wired")
})

test("registers the three commands and the two tools", () => {
	const pi = boot(fakeDaemon(), fakeTimers().timers)
	assert.deepEqual(pi.commands.sort(), ["afk", "back", "mailbridge"])
	assert.deepEqual(pi.tools.sort(), ["notify_user", "request_decision"])
})

// --- settle notification ---------------------------------------------------

test("agent_settled schedules exactly one email with a routing token", async () => {
	const t = fakeTimers()
	const daemon = fakeDaemon()
	const pi = boot(daemon, t.timers)
	await pi.fire("session_start")

	await pi.fire("agent_settled", { aborted: false })
	const settleTimers = t.queue.filter((q) => q.ms === 10_000)
	assert.equal(settleTimers.length, 1, "debounce timer armed")

	settleTimers[0]!.handler()
	await new Promise((r) => setImmediate(r))

	const settles = daemon.sent.filter((m) => /is waiting for you/.test(m.subject))
	assert.equal(settles.length, 1)

	// Subjects now carry a short local route id, not a base64 blob.
	const tag = routeIdFromSubject(settles[0]!.subject)
	assert.ok(tag, `expected a short [pi:xxxxxx] tag in: ${settles[0]!.subject}`)
	assert.ok(settles[0]!.subject.length < 90, `subject should stay readable, got ${settles[0]!.subject.length} chars`)
	assert.equal(
		resolveRoute(tag, { env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" }, device: "test-device" })?.sessionId,
		SESSION,
		"the short id must resolve back to this session",
	)
	assert.match(settles[0]!.text, /fix-login/)
})

test("an aborted settle does not schedule mail", async () => {
	const t = fakeTimers()
	const daemon = fakeDaemon()
	const pi = boot(daemon, t.timers)
	await pi.fire("session_start")

	await pi.fire("agent_settled", { aborted: true })
	assert.equal(t.queue.filter((q) => q.ms === 10_000).length, 0)
})

test("email mode off suppresses the settle mail", async () => {
	const t = fakeTimers()
	const daemon = fakeDaemon({ mode: "off" })
	const pi = boot(daemon, t.timers)
	await pi.fire("session_start")

	await pi.fire("agent_settled", { aborted: false })
	assert.equal(t.queue.filter((q) => q.ms === 10_000).length, 0)
	assert.equal(daemon.sent.length, 0)
})

// --- commands --------------------------------------------------------------

test("/afk and /back push the mode through the daemon", async () => {
	const daemon = fakeDaemon({ mode: "off" })
	const captured = new Map<string, (args: string, ctx: ExtensionCtxLike) => Promise<void>>()
	const pi = fakePi(ctx())
	pi.registerCommand = (name, spec) => {
		captured.set(name, spec.handler)
	}
	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" },
		loadConfig: config,
		secret: () => SECRET,
		makeClient: () => daemon.client,
		ensureDaemon: async () => true,
		timers: fakeTimers().timers,
		pollMs: 60_000,
	})
	// session_start is what wires the daemon client and seeds the mode mirror.
	await pi.fire("session_start")

	await captured.get("afk")!("", ctx())
	await captured.get("back")!("", ctx())
	assert.deepEqual(daemon.modes, ["on", "off"])
})

// --- tools -----------------------------------------------------------------

test("request_decision refuses when email mode is off", async () => {
	const daemon = fakeDaemon({ mode: "off" })
	const specs: Record<string, (id: string, p: Record<string, unknown>, s: unknown, u: unknown, c: ExtensionCtxLike) => Promise<{ content: { text: string }[] }>> = {}
	const pi = fakePi(ctx())
	pi.registerTool = (spec) => {
		specs[spec.name] = spec.execute as never
	}
	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" },
		loadConfig: config,
		secret: () => SECRET,
		makeClient: () => daemon.client,
		ensureDaemon: async () => true,
		timers: fakeTimers().timers,
	})
	await pi.fire("session_start")

	const result = await specs["request_decision"]!("id", { subject: "s", question: "q" }, undefined, undefined, ctx())
	assert.match(result.content[0]!.text, /Email mode is off/)
	assert.deepEqual(daemon.registered, [], "no reservation made")
	assert.deepEqual(daemon.sent, [])
})

test("request_decision reserves, sends, and a second call is refused", async () => {
	const daemon = fakeDaemon()
	const specs: Record<string, (id: string, p: Record<string, unknown>, s: unknown, u: unknown, c: ExtensionCtxLike) => Promise<{ content: { text: string }[] }>> = {}
	const pi = fakePi(ctx())
	pi.registerTool = (spec) => {
		specs[spec.name] = spec.execute as never
	}
	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" },
		loadConfig: config,
		secret: () => SECRET,
		makeClient: () => daemon.client,
		ensureDaemon: async () => true,
		timers: fakeTimers().timers,
	})
	await pi.fire("session_start")

	const result = await specs["request_decision"]!(
		"id",
		{ subject: "Ship it?", question: "Deploy now?", options: ["yes", "no"], recommendation: "yes" },
		undefined,
		undefined,
		ctx(),
	)
	assert.match(result.content[0]!.text, /Emailed the decision/)
	assert.deepEqual(daemon.registered, [SESSION])
	assert.equal(daemon.sent.length, 1)
	const decisionTag = routeIdFromSubject(daemon.sent[0]!.subject)
	assert.ok(decisionTag, `expected a short tag in: ${daemon.sent[0]!.subject}`)
	assert.equal(
		resolveRoute(decisionTag, { env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" }, device: "test-device" })
			?.sessionId,
		SESSION,
	)
	assert.match(daemon.sent[0]!.text, /yes.*no/s)
})

test("request_decision releases the slot when the send fails", async () => {
	const daemon = fakeDaemon({ sendOk: false })
	const specs: Record<string, (id: string, p: Record<string, unknown>, s: unknown, u: unknown, c: ExtensionCtxLike) => Promise<{ content: { text: string }[] }>> = {}
	const pi = fakePi(ctx())
	pi.registerTool = (spec) => {
		specs[spec.name] = spec.execute as never
	}
	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" },
		loadConfig: config,
		secret: () => SECRET,
		makeClient: () => daemon.client,
		ensureDaemon: async () => true,
		timers: fakeTimers().timers,
	})
	await pi.fire("session_start")

	const result = await specs["request_decision"]!("id", { subject: "s", question: "q" }, undefined, undefined, ctx())
	assert.match(result.content[0]!.text, /Could not send/)
	assert.deepEqual(daemon.released, [SESSION], "reservation released on failure")
})

test("reply deliveries are injected as follow-ups and acked", async () => {
	const record: PendingRecord = { uid: 7, sessionId: SESSION, from: "you@example.com", subject: "re", body: "go ahead", receivedAt: 1 }
	const daemon = fakeDaemon({ pending: [record] })
	const pi = boot(daemon, fakeTimers().timers)
	await pi.fire("session_start")

	assert.deepEqual(pi.sent, ["go ahead"], "injected into the session")
	assert.deepEqual(daemon.acked, [7], "acked after injection")
})

// --- the notification must carry what the agent actually said --------------

function ctxWithBranch(messages: { role: string; content: unknown }[]): ExtensionCtxLike {
	return {
		cwd: "/home/ybc/Work/proj",
		sessionManager: {
			getSessionId: () => SESSION,
			getName: () => "fix-login",
			getBranch: () => messages.map((message) => ({ type: "message", message })),
		},
		ui: { notify() {} },
	}
}

test("the settle email carries the assistant's last text", async () => {
	const t = fakeTimers()
	const daemon = fakeDaemon()
	const c = ctxWithBranch([
		{ role: "user", content: [{ type: "text", text: "fix the bug" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal reasoning" },
				{ type: "text", text: "Done: the failing test passes now." },
				{ type: "toolCall", name: "bash" },
			],
		},
	])

	const pi = fakePi(c)
	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" },
		loadConfig: config,
		secret: () => SECRET,
		makeClient: () => daemon.client,
		ensureDaemon: async () => true,
		timers: t.timers,
		pollMs: 60_000,
	})
	await pi.fire("session_start")
	await pi.fire("agent_settled", { aborted: false })
	t.queue.filter((q) => q.ms === 10_000)[0]!.handler()
	await new Promise((r) => setImmediate(r))

	const mail = daemon.sent.filter((m) => /is waiting for you/.test(m.subject))[0]
	assert.ok(mail, "a notification should have been sent")
	assert.match(mail.text, /Done: the failing test passes now\./, "the answer is the point of the email")
	assert.doesNotMatch(mail.text, /internal reasoning/, "thinking is not the answer")
	assert.doesNotMatch(mail.text, /produced no text/)
	assert.match(mail.text, /turns: 1/)
})

test("with no assistant text the placeholder is honest", async () => {
	const t = fakeTimers()
	const daemon = fakeDaemon()
	const pi = fakePi(ctxWithBranch([{ role: "user", content: [{ type: "text", text: "hi" }] }]))
	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" },
		loadConfig: config,
		secret: () => SECRET,
		makeClient: () => daemon.client,
		ensureDaemon: async () => true,
		timers: t.timers,
		pollMs: 60_000,
	})
	await pi.fire("session_start")
	await pi.fire("agent_settled", { aborted: false })
	t.queue.filter((q) => q.ms === 10_000)[0]!.handler()
	await new Promise((r) => setImmediate(r))

	const mail = daemon.sent.filter((m) => /is waiting for you/.test(m.subject))[0]
	assert.ok(mail, "a notification should have been sent")
	assert.match(mail.text, /produced no text/)
})

// --- the poll supervises the daemon ---------------------------------------

test("a poll that finds the daemon gone restarts it instead of idling forever", async () => {
	const t = fakeTimers()
	let daemonUp = false
	let respawns = 0
	let pings = 0

	// A client that reports the daemon down until it is respawned.
	const flaky = {
		health: async () => (daemonUp ? { ok: true as const, data: { ok: true, mode: "on", pending: 0 } } : { ok: false as const, status: 0 }),
		mode: async () => (daemonUp ? { ok: true as const, data: { mode: "on" as const } } : { ok: false as const, status: 0 }),
		pending: async () => (daemonUp ? { ok: true as const, data: { pending: [] } } : { ok: false as const, status: 0 }),
		ping: async () => {
			pings++
			return daemonUp ? { ok: true as const, data: { ok: true, clients: 1 } } : { ok: false as const, status: 0, code: "network" }
		},
		bye: async () => ({ ok: true as const, data: { ok: true, clients: 0 } }),
		claim: async () => ({ ok: true as const, data: { ok: true } }),
		ack: async () => ({ ok: true as const, data: { ok: true } }),
		register: async () => ({ ok: true as const, data: { alreadyPending: false, full: false } }),
		release: async () => ({ ok: true as const, data: { ok: true } }),
		send: async () => ({ ok: true as const, data: { ok: true } }),
		reload: async () => ({ ok: true as const, data: { ok: true } }),
		shutdown: async () => ({ ok: true as const, data: { ok: true } }),
	}

	const pi = fakePi(ctxWithBranch([{ role: "assistant", content: [{ type: "text", text: "done" }] }]))
	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" },
		loadConfig: config,
		secret: () => SECRET,
		makeClient: () => flaky as never,
		ensureDaemon: async () => {
			respawns++
			daemonUp = true
			return true
		},
		timers: t.timers,
		pollMs: 10_000,
	})

	await pi.fire("session_start")
	assert.equal(respawns, 1, "the first start spawns it")

	// The daemon dies; the next poll must notice and bring it back.
	daemonUp = false
	const ticks = t.queue.filter((q) => q.ms === 10_000)
	assert.ok(ticks.length > 0, "a poll is scheduled")
	ticks[0]!.handler()
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))

	assert.equal(respawns, 2, "the poll respawned the daemon")
	assert.ok(pings >= 1)

	// The bug this guards: the failed-ping branch used to return before re-arming, so one
	// transient failure stopped polling (and therefore notification and delivery) forever.
	const rearmed = t.queue.filter((q) => q.ms === 10_000)
	assert.ok(rearmed.length >= 2, "the poll must re-arm after a failed ping")
})

test("a throttled respawn still re-arms the poll", async () => {
	const t = fakeTimers()
	let daemonUp = true
	let respawns = 0

	const client = {
		health: async () => ({ ok: true as const, data: { ok: true, mode: "on", pending: 0 } }),
		mode: async () => ({ ok: true as const, data: { mode: "on" as const } }),
		pending: async () => ({ ok: true as const, data: { pending: [] } }),
		ping: async () => (daemonUp ? { ok: true as const, data: { ok: true, clients: 1 } } : { ok: false as const, status: 0 }),
		bye: async () => ({ ok: true as const, data: { ok: true, clients: 0 } }),
		claim: async () => ({ ok: true as const, data: { ok: true } }),
		ack: async () => ({ ok: true as const, data: { ok: true } }),
		register: async () => ({ ok: true as const, data: { alreadyPending: false, full: false } }),
		release: async () => ({ ok: true as const, data: { ok: true } }),
		send: async () => ({ ok: true as const, data: { ok: true } }),
		reload: async () => ({ ok: true as const, data: { ok: true } }),
		shutdown: async () => ({ ok: true as const, data: { ok: true } }),
	}

	const pi = fakePi(ctxWithBranch([]))
	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-extension-test" },
		loadConfig: config,
		secret: () => SECRET,
		makeClient: () => client as never,
		ensureDaemon: async () => {
			respawns++
			return true
		},
		timers: t.timers,
		pollMs: 10_000,
	})
	await pi.fire("session_start")
	assert.equal(respawns, 1)

	// Daemon dies and the respawn is throttled (a second failure within the backoff window).
	daemonUp = false
	t.queue.filter((q) => q.ms === 10_000)[0]!.handler()
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))

	const before = t.queue.filter((q) => q.ms === 10_000).length
	assert.ok(before >= 2, "even a throttled tick re-arms")
})

test("a refused send is surfaced to the user, not silently dropped", async () => {
	// The idle notification is the one mail this product exists to deliver. Previously the
	// client's {ok:false} was discarded here, so a refusal vanished without a trace.
	const t = fakeTimers()
	const notes: string[] = []
	const daemon = fakeDaemon({ sendOk: false })
	const pi = boot(daemon, t.timers, ctx(notes))
	await pi.fire("session_start")

	await pi.fire("agent_settled", { aborted: false })
	t.queue.filter((q) => q.ms === 10_000)[0]!.handler()
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))

	assert.ok(
		notes.some((n) => /could not send/.test(n)),
		`the user must be told the notification failed (notifications: ${JSON.stringify(notes)})`,
	)
})

test("while email mode is off, a queued reply is not claimed or injected", async () => {
	// SECURITY.md promised that /back closes the control channel. Mode used to gate only
	// outbound mail, so a reply sent while "off" was still claimed and injected.
	const t = fakeTimers()
	const daemon = fakeDaemon({
		mode: "off",
		pending: [
			{ uid: 7, sessionId: SESSION, from: "you@example.com", subject: "re", body: "do it", receivedAt: 1 },
		],
	})
	const pi = boot(daemon, t.timers)
	await pi.fire("session_start")

	// Run a poll tick.
	t.queue.filter((q) => q.ms === 60_000)[0]!.handler()
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))

	assert.deepEqual(daemon.acked, [], "nothing was claimed-and-acked while off")
	assert.deepEqual(pi.sent, [], "nothing reached the session")
})

test("with ping present, the per-tick gate still blocks a claim while mode is off", async () => {
	// The earlier version of the /back test passed because fakeDaemon had no ping(): the
	// tick threw on its first statement and the swallow-all catch ate it.
	const t = fakeTimers()
	const daemon = fakeDaemon({
		mode: "off",
		pending: [
			{ uid: 8, sessionId: SESSION, from: "you@example.com", subject: "re", body: "do it", receivedAt: 1 },
		],
	})
	const pi = boot(daemon, t.timers)
	await pi.fire("session_start")

	t.queue.filter((q) => q.ms === 60_000)[0]!.handler()
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))

	assert.deepEqual(daemon.acked, [], "no claim while the channel is closed")
	assert.deepEqual(pi.sent, [])

	// Turn it on: the next tick delivers.
	daemon.client.setMode?.("on")
	t.queue.filter((q) => q.ms === 60_000).at(-1)!.handler()
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))
	assert.deepEqual(daemon.acked, [8], "delivered once the channel reopens")
})

test("a machine with no secret yet still starts the daemon and the poll loop", async () => {
	// The extension used to bail out with "start the daemon once to create it" - but the
	// daemon can only be started by this code, so a fresh install was a deadlock: no daemon,
	// no notifier, no first notification, and the documented recovery did not help either.
	const t = fakeTimers()
	const notes: string[] = []
	const daemon = fakeDaemon()
	let spawned = 0
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-bootstrap-")) }
	const { readSecret } = await import("../src/store/secret.ts")
	const pi = fakePi(ctx(notes))
	mailbridge(pi, {
		env,
		// Reads the file each time, so the key the extension mints is visible afterwards -
		// which is exactly how production behaves.
		secret: () => readSecret(env),
		loadConfig: config,
		makeClient: () => daemon.client,
		ensureDaemon: async () => {
			spawned++
			return true
		},
		timers: t.timers,
		pollMs: 60_000,
	})
	await pi.fire("session_start")

	assert.equal(spawned, 1, "the daemon is started on a first run")
	assert.ok(
		!notes.some((n) => /no shared secret/.test(n)),
		`must not bail out for a missing secret (notifications: ${JSON.stringify(notes)})`,
	)
	// And the poll loop is armed, which is what proves startRuntime ran.
	assert.ok(t.queue.some((q) => q.ms === 60_000), "the poll loop is running")
})

test("a session that started before the config existed can recover via /mailbridge restart", async () => {
	// Fresh install: session_start runs with no usable config and returns early, so no
	// client, notifier or poll loop is ever built. Every later command used `client ? ... : skip`,
	// so the session stayed dead and the first notification never happened. Restart must wire it.
	const captured = new Map<string, (args: string, ctx: ExtensionCtxLike) => Promise<void>>()
	const t = fakeTimers()
	const notes: string[] = []
	const daemon = fakeDaemon()
	let spawned = 0
	const pi = fakePi(ctx(notes))
	pi.registerCommand = (name, spec) => {
		captured.set(name, spec.handler)
	}
	mailbridge(pi, {
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-recover-")) },
		// No usable mailbox at session start.
		loadConfig: () => ({ ...config(), mail: { ...config().mail, to: "", imap: { ...config().mail.imap, host: "", user: "" } } }),
		secret: () => SECRET,
		makeClient: () => daemon.client,
		ensureDaemon: async () => {
			spawned++
			return true
		},
		timers: t.timers,
		pollMs: 60_000,
	})
	await pi.fire("session_start")
	assert.equal(spawned, 0, `nothing is started without a config (spawned=${spawned})`)
	assert.ok(!t.queue.some((q) => q.ms === 60_000), "and no poll loop is armed")

	// The user runs the command that starts the daemon.
	await captured.get("mailbridge")!("restart", ctx(notes))

	assert.ok(
		t.queue.some((q) => q.ms === 60_000),
		`restart must wire the poll loop (spawned=${spawned}, notes=${JSON.stringify(notes)})`,
	)
	// Called at least once by restart and again by the runtime bootstrap.
	assert.ok(spawned >= 1, `the injected ensureDaemon must be used (spawned=${spawned})`)
})
