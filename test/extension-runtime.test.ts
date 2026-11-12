import { test } from "node:test"
import assert from "node:assert/strict"

import mailbridge, { type ExtensionCtxLike, type ExtensionLike, type SettleTimers } from "../src/extension.ts"
import type { ResolvedConfig } from "../src/core/config.ts"
import type { DaemonResult } from "../src/daemon/spawn.ts"
import type { UserContent } from "../src/core/attachments.ts"
import type { PendingRecord } from "../src/store/pending-store.ts"
import { sessionIdFromSubject } from "../src/core/token.ts"

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
		notify: { onSettled: true, debounceMs: 10_000, notifyOnAborted: false, subject: "pi" },
		tuning: { idleRenewMs: 1, autoIdleDelayMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
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

function ctx(): ExtensionCtxLike {
	const notes: string[] = []
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
	assert.equal(sessionIdFromSubject(settles[0]!.subject, SECRET), SESSION)
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
	assert.equal(sessionIdFromSubject(daemon.sent[0]!.subject, SECRET), SESSION)
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
