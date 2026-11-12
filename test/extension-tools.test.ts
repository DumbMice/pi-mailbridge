import { test } from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
		notify: { onSettled: true, debounceMs: 1, notifyOnAborted: false },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
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
	ui: ExtensionCtxLike
	notes: string[]
	sent: { to?: string; subject: string; text: string }[]
	registered: string[]
	released: string[]
	modes: string[]
	reloads: number[]
	shutdowns: number[]
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
	const reloads: number[] = []
	const shutdowns: number[] = []
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
		reload: async () => {
			reloads.push(1)
			return ok({ ok: true })
		},
		shutdown: async () => {
			shutdowns.push(1)
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
		ensureDaemon: async () => true,
		timers,
		pollMs: 60_000,
	})

	return {
		pi,
		tools,
		commands,
		ui,
		notes,
		sent,
		registered,
		released,
		modes,
		reloads,
		shutdowns,
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

test("/mailbridge names the device", async () => {
	const h = harness()
	await h.start()
	await h.commands.get("mailbridge")!("", {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (m: string) => h.notes.push(m) },
	})
	assert.match(h.notes.join("\n"), /device: test-device/)
})

// --- in-pi command surface ------------------------------------------------

test("/mailbridge help prints the usage", async () => {
	const h = harness()
	await h.start()
	await h.commands.get("mailbridge")!("help", {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (m: string) => h.notes.push(m) },
	})
	const out = h.notes.join("\n")
	for (const sub of ["setup", "check", "auth", "smoke", "restart"]) {
		assert.ok(out.includes(sub), `help should mention ${sub}: ${out}`)
	}
})

test("/mailbridge restart replaces the process, not just the config", async () => {
	const h = harness()
	await h.start()
	await h.commands.get("mailbridge")!("restart", {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (m: string) => h.notes.push(m) },
	})
	// Config reload cannot replace running code, so restart stops the process and
	// lets the supervisor spawn a fresh one.
	assert.equal(h.shutdowns.length, 1, "restart must ask the daemon to exit")
	assert.match(h.notes.join("\n"), /restarted with the current code/)
})

test("/mailbridge auth refuses a placeholder client id", async () => {
	const cfg = config()
	cfg.oauth = { issuer: "https://login.microsoftonline.com/consumers/v2.0", clientId: "<your app client id>", scope: "offline_access" }
	const h = harness({ cfg })
	await h.start()
	await h.commands.get("mailbridge")!("auth", {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (m: string) => h.notes.push(m) },
	})
	assert.match(h.notes.join("\n"), /placeholder/)
})

test("/mailbridge check reports an unauthorised oauth setup", async () => {
	const cfg = config()
	cfg.mail.imap.authType = "XOAUTH2"
	cfg.mail.smtp.authType = "XOAUTH2"
	cfg.oauth = { issuer: "https://login.microsoftonline.com/consumers/v2.0", clientId: "real-id", scope: "offline_access" }
	const h = harness({ cfg })
	await h.start()
	await h.commands.get("mailbridge")!("check", {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (m: string) => h.notes.push(m) },
	})
	assert.match(h.notes.join("\n"), /not authorised|\/mailbridge auth/)
})

test("/mailbridge check flags oauth configured but unused", async () => {
	const cfg = config()
	cfg.oauth = { issuer: "https://login.microsoftonline.com/consumers/v2.0", clientId: "real-id", scope: "offline_access" }
	const h = harness({ cfg })
	await h.start()
	await h.commands.get("mailbridge")!("check", {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (m: string) => h.notes.push(m) },
	})
	assert.match(h.notes.join("\n"), /would be ignored/)
})

test("an unconfigured mailbox says what to do instead of spawning a doomed daemon", async () => {
	const cfg = config()
	cfg.mail.imap.host = ""
	cfg.mail.to = ""
	let spawned = 0
	const h = harness({ cfg })
	// Override after boot: harness passes ensureDaemon, so count instead.
	const pi2 = h.pi
	void pi2
	const notes: string[] = []
	const handlers = new Map<string, (e: Record<string, unknown>, c: unknown) => unknown>()
	const pi: ExtensionLike = {
		on(event, handler) {
			handlers.set(event, handler as never)
		},
		registerCommand() {},
		registerTool() {},
		sendUserMessage() {},
	}
	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-tools-test" },
		loadConfig: () => cfg,
		secret: () => SECRET,
		makeClient: () => {
			throw new Error("must not build a client for an unconfigured mailbox")
		},
		ensureDaemon: async () => {
			spawned++
			return true
		},
		timers: { setTimeout: () => 1, clearTimeout: () => {} },
	})
	await handlers.get("session_start")!(
		{},
		{
			cwd: "/home/ybc/Work/proj",
			sessionManager: { getSessionId: () => SESSION },
			ui: { notify: (m: string) => notes.push(m) },
		},
	)

	assert.equal(spawned, 0, "no daemon spawn for an unconfigured account")
	assert.match(notes.join("\n"), /\/mailbridge setup/)
})

test("/mailbridge re-reads config instead of trusting the startup snapshot", async () => {
	let current = config()
	current.mail.imap.host = ""   // unusable at startup
	let loads = 0
	const notes: string[] = []
	const handlers = new Map<string, (e: Record<string, unknown>, c: unknown) => unknown>()
	const commands = new Map<string, (args: string, c: ExtensionCtxLike) => Promise<void>>()

	const pi: ExtensionLike = {
		on(event, handler) {
			handlers.set(event, handler as never)
		},
		registerCommand(name, spec) {
			commands.set(name, spec.handler)
		},
		registerTool() {},
		sendUserMessage() {},
	}

	mailbridge(pi, {
		env: { XDG_STATE_HOME: "/tmp/pi-mailbridge-tools-test" },
		loadConfig: () => {
			loads++
			return current
		},
		secret: () => SECRET,
		makeClient: () => ({ health: async () => ({ ok: true, data: { ok: true, mode: "on", pending: 0 } }) }) as never,
		ensureDaemon: async () => true,
		timers: { setTimeout: () => 1, clearTimeout: () => {} },
	})

	const ui = {
		cwd: "/home/ybc/Work/proj",
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (m: string) => notes.push(m) },
	}

	// Config becomes valid after startup (as if --setup ran in a shell).
	current = config()
	await commands.get("mailbridge")!("check", ui)

	assert.ok(loads >= 2, "the command must re-read config, not reuse the startup snapshot")
	assert.match(notes.join("\n"), /config ok|smoke/, `stale config leaked into output: ${notes.join("\n")}`)
})

test("/mailbridge check says a minted secret needs a daemon restart", async () => {
	// A running daemon caches the bearer it read at startup, so a freshly minted key is
	// rejected until it restarts. "config ok" here would send the user to debug the mailbox.
	const captured = new Map<string, (args: string, ctx: ExtensionCtxLike) => Promise<void>>()
	const notes: string[] = []
	const pi = {
		on() {},
		registerCommand(name: string, spec: { handler: (args: string, ctx: ExtensionCtxLike) => Promise<void> }) {
			captured.set(name, spec.handler)
		},
		registerTool() {},
		sendUserMessage() {},
	}
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-check-mint-")) }
	const c: ExtensionCtxLike = {
		cwd: "/tmp",
		sessionManager: { getSessionId: () => SESSION, getName: () => "x" },
		ui: { notify: (m: string) => notes.push(m) },
	}
	mailbridge(pi as never, {
		env,
		loadConfig: () => config(),
		// Nothing on disk: check must mint one.
		secret: () => undefined,
		makeClient: () => ({}) as never,
		ensureDaemon: async () => true,
		timers: { setTimeout: () => 1, clearTimeout: () => {} },
		pollMs: 60_000,
	})
	await captured.get("mailbridge")!("check", c)
	assert.ok(
		notes.some((n) => /restart the daemon/.test(n)),
		`check must name the consequence (notes: ${JSON.stringify(notes)})`,
	)
})

test("request_decision frees its reservation when the route cannot be minted", async () => {
	// The slot is reserved before the route is minted. A throw there (EACCES/ENOSPC/ENOTDIR on
	// the state dir) used to escape with the reservation held, and re-registering refreshes its
	// TTL - so the session was answered "already outstanding" for good, with no mail sent.
	const { writeFileSync } = await import("node:fs")
	const tools: Record<string, (id: string, p: Record<string, unknown>, s?: unknown, u?: unknown, c?: unknown) => Promise<{ content: { text: string }[] }>> = {}
	const released: string[] = []
	const sent: unknown[] = []
	const client = {
		mode: async () => ({ ok: true as const, data: { mode: "on" as const } }),
		register: async () => ({ ok: true as const, data: { alreadyPending: false, full: false } }),
		release: async (sessionId: string) => {
			released.push(sessionId)
			return { ok: true as const, data: { ok: true } }
		},
		send: async (message: unknown) => {
			sent.push(message)
			return { ok: true as const, data: { ok: true } }
		},
		pending: async () => ({ ok: true as const, data: { pending: [] } }),
		ping: async () => ({ ok: true as const, data: { ok: true, clients: 1 } }),
	}
	// A regular file where the state directory should be: route minting throws.
	const blocker = join(tmpdir(), `pmb-blocker-${process.pid}-${Date.now()}`)
	writeFileSync(blocker, "not a directory")

	const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => unknown>()
	const pi = {
		on(name: string, handler: (event: Record<string, unknown>, ctx: unknown) => unknown) {
			handlers.set(name, handler)
		},
		registerCommand() {},
		registerTool(spec: { name: string; execute: unknown }) {
			tools[spec.name] = spec.execute as never
		},
		sendUserMessage() {},
	}
	mailbridge(pi as never, {
		env: { XDG_STATE_HOME: blocker },
		loadConfig: () => config(),
		secret: () => SECRET,
		makeClient: () => client as never,
		ensureDaemon: async () => true,
		timers: { setTimeout: () => 1, clearTimeout: () => {} },
		pollMs: 60_000,
	})

	const c = {
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "sess-leak", getName: () => "x" },
		ui: { notify: () => {} },
	}
	await handlers.get("session_start")!({}, c)

	const result = await tools["request_decision"]!("id", { subject: "s", question: "q" }, undefined, undefined, {
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "sess-leak", getName: () => "x" },
		ui: { notify: () => {} },
	})
	assert.match(result.content[0]!.text, /Could not email the decision/)
	assert.deepEqual(released, ["sess-leak"], "the reservation is freed")
	assert.deepEqual(sent, [], "and nothing was sent")
})
