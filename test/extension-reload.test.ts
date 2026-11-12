import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import mailbridge from "../src/extension.ts"
import { configPath } from "../src/store/paths.ts"
import type { ResolvedConfig } from "../src/core/config.ts"

// The extension must not adopt a daemon whose config predates the file: that is how a
// replaced address keeps receiving the agent's mail.

const SECRET = Buffer.alloc(32, 4)

function config(): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "pi@example.com", password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: "pi@example.com", password: "x", authType: "LOGIN" },
			to: "you@example.com",
		},
		security: { allowFrom: ["you@example.com"], requireDmarcPass: true, trustedAuthservId: "mx.example.com", tokenTtlHours: 24 },
		daemon: { host: "127.0.0.1", port: 4177, exitWhenIdle: true, idleTimeoutSecs: 120 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false, maxAttachmentMb: 18 },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
	}
}

function harness(configLoadedAt: number, opts: { reloadOk?: boolean; reloadHangs?: boolean } = {}) {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-stale-")) }
	const configDirEnv = { ...env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "pmb-stale-cfg-")) }
	const file = configPath(configDirEnv)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, JSON.stringify({ mail: { to: "you@example.com" } }))

	const events = new Map<string, (event: Record<string, unknown>, ctx: unknown) => unknown>()
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
	const dialled: string[] = []
	const notes: string[] = []
	let reloads = 0
	const client = {
		health: async () => ({ ok: true as const, data: { ok: true, mode: "on", pending: 0, configLoadedAt } }),
		mode: async () => ({ ok: true as const, data: { mode: "off" as const } }),
		pending: async () => ({ ok: true as const, data: { pending: [] } }),
		ping: async () => ({ ok: true as const, data: { ok: true, clients: 1 } }),
		bye: async () => ({ ok: true as const, data: { ok: true } }),
		claim: async () => ({ ok: true as const, data: { ok: true } }),
		ack: async () => ({ ok: true as const, data: { ok: true } }),
		register: async () => ({ ok: true as const, data: { alreadyPending: false, full: false } }),
		release: async () => ({ ok: true as const, data: { ok: true } }),
		send: async () => ({ ok: true as const, data: { ok: true } }),
		reload: () => {
			reloads++
			if (opts.reloadHangs) return new Promise<never>(() => {})
			return Promise.resolve(
				opts.reloadOk === false
					? ({ ok: false as const, status: 500, code: "reload_failed" } as const)
					: ({ ok: true as const, data: { ok: true } } as const),
			)
		},
		shutdown: async () => ({ ok: true as const, data: { ok: true } }),
	}

	const pi = {
		on(name: string, handler: (event: Record<string, unknown>, ctx: unknown) => unknown) {
			events.set(name, handler)
		},
		registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, spec.handler)
		},
		registerTool() {},
		sendUserMessage() {},
	}
	const ctx = {
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "sess-1", getName: () => "x" },
		ui: { notify: (m: string) => notes.push(m) },
	}
	const mutableConfig = config()
	mailbridge(pi as never, {
		env: configDirEnv,
		// Same object every time: `currentBaseUrl()` reads whatever the last load returned.
		loadConfig: () => mutableConfig,
		secret: () => SECRET,
		makeClient: (base: string) => {
			dialled.push(base)
			return client as never
		},
		ensureDaemon: async (base: string) => {
			dialled.push(base)
			return true
		},
		timers: { setTimeout: () => 1, clearTimeout: () => {} },
		pollMs: 60_000,
	})
	return {
		events,
		ctx,
		notes,
		reloadCount: () => reloads,
		dialledAt: () => dialled,
		setPort: (port: number) => {
			mutableConfig.daemon.port = port
		},
		runCommand: (sub: string) => commands.get("mailbridge")!(sub, ctx),
	}
}

test("a daemon holding an older config than the file is asked to reload", async () => {
	// mtime is "now"; the daemon reports having loaded a minute ago.
	const h = harness(Date.now() - 60_000)
	await h.events.get("session_start")!({}, h.ctx)
	// reloadIfStale is fire-and-forget; let it settle.
	await new Promise((r) => setTimeout(r, 20))
	assert.equal(h.reloadCount(), 1, "the stale daemon must be reloaded")
})

test("a daemon that already read the current file is left alone", async () => {
	const h = harness(Date.now() + 60_000)
	await h.events.get("session_start")!({}, h.ctx)
	await new Promise((r) => setTimeout(r, 20))
	assert.equal(h.reloadCount(), 0)
})

test("a refused reload is surfaced, not swallowed", async () => {
	const h = harness(Date.now() - 60_000, { reloadOk: false })
	await h.events.get("session_start")!({}, h.ctx)
	await new Promise((r) => setTimeout(r, 20))
	assert.ok(
		h.notes.some((n) => /could not reload/.test(n)),
		`the user must be told (notes: ${JSON.stringify(h.notes)})`,
	)
})

test("session_start settles even when the reload hangs", async () => {
	// A wrong host can make the daemon's IMAP dial take imapflow's whole connect timeout, so
	// the reload must not be awaited. The previous version of this test awaited
	// Promise.resolve(handlerPromise), which is the handler's own promise - it passed even
	// with `await` restored.
	const h = harness(Date.now() - 60_000, { reloadHangs: true })
	const started = h.events.get("session_start")!({}, h.ctx)
	const winner = await Promise.race([
		Promise.resolve(started).then(() => "settled"),
		new Promise((r) => setTimeout(() => r("still-running"), 50)),
	])
	assert.equal(winner, "settled", "session_start must not await a hanging reload")
	assert.equal(h.reloadCount(), 1, "but it must have started one")
})

test("the daemon URL follows the config, so a changed port is dialled", async () => {
	// daemon.port is a documented key. The URL used to be computed once at extension load, so
	// editing the port left every probe - including /mailbridge restart, the documented
	// remedy - dialling the old one, which reports "daemon did not come back" forever.
	const h = harness(Date.now() + 60_000)
	await h.events.get("session_start")!({}, h.ctx)
	assert.deepEqual(h.dialledAt().slice(0, 1), ["http://127.0.0.1:4177"], `starts on the configured port (dialled: ${JSON.stringify(h.dialledAt())})`)

	// A command reloads the config; the next daemon dial must use the new port.
	h.setPort(4199)
	await h.runCommand("restart")
	assert.ok(
		h.dialledAt().some((url) => url.endsWith(":4199")),
		`the daemon URL must follow the config (dialled: ${JSON.stringify(h.dialledAt())})`,
	)
})

test("status reports the address the live client was built with", async () => {
	// After a port edit the config says 4199 but the running client still dials 4177. Printing
	// the config's address would attribute a health answer to a port it never came from.
	const h = harness(Date.now() + 60_000)
	await h.events.get("session_start")!({}, h.ctx)
	h.setPort(4199)
	await h.runCommand("status")
	assert.ok(
		h.notes.some((n) => n.includes(":4177")),
		`status must name the client's address (notes: ${JSON.stringify(h.notes)})`,
	)
	assert.ok(
		!h.notes.some((n) => n.includes(":4199")),
		"and must not claim an address the client is not using",
	)
})
