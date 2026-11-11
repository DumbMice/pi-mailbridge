import { test } from "node:test"
import assert from "node:assert/strict"

import mailbridge, { type ExtensionCtxLike, type ExtensionLike, type SettleTimers } from "../src/extension.ts"
import type { ResolvedConfig } from "../src/core/config.ts"
import type { DaemonResult } from "../src/daemon/spawn.ts"

const SECRET = Buffer.alloc(32, 6)
const SECRET_B64 = SECRET.toString("base64url")
const SESSION = "sess-tools"

function config(over: Partial<ResolvedConfig["security"]> = {}, mailTo = "you@example.com"): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "pi@example.com", password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: "pi@example.com", password: "smtp-secret-pass", authType: "LOGIN" },
			to: mailTo,
		},
		security: { allowFrom: ["you@example.com"], requireDmarcPass: false, tokenTtlHours: 24, ...over },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 1, notifyOnAborted: false, subject: "pi" },
		tuning: { idleRenewMs: 1, autoIdleDelayMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		warnings: [],
	}
}

type ToolFn = (id: string, p: Record<string, unknown>, s: unknown, u: unknown, c: ExtensionCtxLike) => Promise<{
	content: { type?: string; text: string }[]
	details: Record<string, unknown>
}>

interface Harness {
	pi: ExtensionLike
	tools: Record<string, ToolFn>
	commands: Map<string, (args: string, ctx: ExtensionCtxLike) => Promise<void>>
	notes: string[]
	sent: { to?: string; subject: string; text: string }[]
	registered: string[]
	released: string[]
	modes: string[]
	start(): Promise<void>
}

function harness(
	over: {
		mode?: "on" | "off"
		alreadyPending?: boolean
		sendOk?: boolean
		healthOk?: boolean
		registerOk?: boolean
		cfg?: ResolvedConfig
	} = {},
): Harness {
	const notes: string[] = []
	const sent: { to?: string; subject: string; text: string }[] = []
	const registered: string[] = []
	const released: string[] = []
	const modes: string[] = []
	let currentMode = over.mode ?? "on"

	const ok = <T>(data: T): DaemonResult<T> => ({ ok: true, data })
	const client = {
		health: async () =>
			over.healthOk === false
				? ({ ok: false as const, status: 0, code: "network" } as const)
				: ok({ ok: true, mode: currentMode, pending: 2 }),
		pending: async () => (over.healthOk === false ? ({ ok: false as const, status: 0 } as const) : ok({ pending: [] })),
		mode: async () => (over.healthOk === false ? ({ ok: false as const, status: 0 } as const) : ok({ mode: currentMode })),
		setMode: async (mode: "on" | "off") => {
			currentMode = mode
			modes.push(mode)
			return ok({ mode })
		},
		claim: async () => ok({ ok: true }),
		ack: async () => ok({ ok: true }),
		register: async (sessionId: string) => {
			if (over.registerOk === false) return { ok: false as const, status: 503, code: "registry_full" }
			registered.push(sessionId)
			return ok({ alreadyPending: over.alreadyPending ?? false, full: false })
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

	const tools: Record<string, ToolFn> = {}
	const commands = new Map<string, (args: string, ctx: ExtensionCtxLike) => Promise<void>>()
	const handlers = new Map<string, (e: Record<string, unknown>, c: ExtensionCtxLike) => unknown>()

	const pi: ExtensionLike = {
		on(event, handler) {
			handlers.set(event, handler)
		},
		registerCommand(name, spec) {
			commands.set(name, spec.handler)
		},
		registerTool(spec) {
			tools[spec.name] = spec.execute as unknown as ToolFn
		},
		sendUserMessage() {},
	}

	const ui: ExtensionCtxLike = {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION, getName: () => "fix-login" },
		ui: {
			notify(message: string) {
				notes.push(message)
			},
		},
	}

	const timers: SettleTimers = { setTimeout: () => 1, clearTimeout: () => {} }

	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-tools-test" },
		loadConfig: () => over.cfg ?? config(),
		secret: () => SECRET,
		makeClient: () => client as never,
		timers,
		pollMs: 60_000,
	})

	return {
		pi,
		tools,
		commands,
		notes,
		sent,
		registered,
		released,
		modes,
		start: async () => {
			await handlers.get("session_start")?.({}, ui)
		},
	}
}

const call = (h: Harness, name: string, params: Record<string, unknown>) => h.tools[name]!("id", params, undefined, undefined, {
	cwd: "/home/ybc/Work/proj",
	sessionManager: { getSessionId: () => SESSION },
	ui: { notify() {} },
})

// --- #27 request_decision / notify_user -----------------------------------

test("request_decision refuses a second decision for the same session without mailing", async () => {
	const h = harness({ alreadyPending: true })
	await h.start()
	const result = await call(h, "request_decision", { subject: "s", question: "q" })
	assert.match(result.content[0]!.text, /already outstanding/i)
	assert.equal(h.sent.length, 0, "must not mail twice")
})

test("request_decision reports a failed reservation instead of mailing", async () => {
	const h = harness({ registerOk: false })
	await h.start()
	const result = await call(h, "request_decision", { subject: "s", question: "q" })
	assert.match(result.content[0]!.text, /already outstanding|outstanding/i)
	assert.equal(h.sent.length, 0)
})

test("notify_user sends without reserving a decision slot", async () => {
	const h = harness()
	await h.start()
	const result = await call(h, "notify_user", { subject: "progress", message: "3 of 5 done" })
	assert.match(result.content[0]!.text, /Sent/)
	assert.deepEqual(h.registered, [], "no reservation")
	assert.equal(h.sent.length, 1)
	assert.match(h.sent[0]!.text, /3 of 5 done/)
})

test("notify_user refuses when email mode is off", async () => {
	const h = harness({ mode: "off" })
	await h.start()
	const result = await call(h, "notify_user", { subject: "s", message: "m" })
	assert.match(result.content[0]!.text, /Email mode is off/)
	assert.equal(h.sent.length, 0)
})

test("tool output never contains the secret or the SMTP password", async () => {
	const h = harness()
	await h.start()
	const outputs: string[] = []
	for (const [name, params] of [
		["request_decision", { subject: "s", question: "q" }],
		["notify_user", { subject: "s", message: "m" }],
	] as const) {
		const result = await call(h, name, params)
		outputs.push(result.content.map((c) => c.text).join("\n"), JSON.stringify(result.details))
	}
	const blob = outputs.join("\n") + h.sent.map((m) => m.subject + m.text).join("\n")
	assert.ok(!blob.includes(SECRET_B64), "routing secret must not leak")
	assert.ok(!blob.includes("smtp-secret-pass"), "SMTP password must not leak")
})

// --- #28 commands and status ---------------------------------------------

test("/mailbridge reports every status field without leaking the secret", async () => {
	const h = harness()
	await h.start()
	await h.commands.get("mailbridge")!("", {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (m: string) => h.notes.push(m) },
	})

	const report = h.notes.join("\n")
	for (const field of ["daemon:", "mode:", "session:", "secret:", "mailbox:", "allowlist:", "pending replies:"]) {
		assert.ok(report.includes(field), `missing "${field}" in:\n${report}`)
	}
	assert.match(report, /healthy/)
	assert.match(report, /you@example\.com/)
	assert.ok(!report.includes(SECRET_B64), "secret value must never be printed")
})

test("/mailbridge reports an unreachable daemon instead of throwing", async () => {
	const h = harness({ healthOk: false })
	await h.start()
	await assert.doesNotReject(() =>
		h.commands.get("mailbridge")!("", {
			cwd: "/home/ybc/Work/proj",
			sessionManager: { getSessionId: () => SESSION },
			ui: { notify: (m: string) => h.notes.push(m) },
		}),
	)
	const report = h.notes.join("\n")
	assert.match(report, /unreachable/)
})

test("/mailbridge shows an empty allowlist as denying everything", async () => {
	const h = harness({ cfg: config({ allowFrom: [] }) })
	await h.start()
	await h.commands.get("mailbridge")!("", {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (m: string) => h.notes.push(m) },
	})
	assert.match(h.notes.join("\n"), /denies all/)
})

test("/mailbridge with no session id reports (none)", async () => {
	const h = harness()
	await h.start()
	await h.commands.get("mailbridge")!("", {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (m: string) => h.notes.push(m) },
	})
	assert.ok(h.notes.join("\n").includes(SESSION))
})
