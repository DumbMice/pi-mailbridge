import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { daemonBaseUrl, ensureDaemon, probeHealth } from "../src/daemon/spawn.ts"
import type { ResolvedConfig } from "../src/core/config.ts"

const MAIN = fileURLToPath(new URL("../src/daemon/main.ts", import.meta.url))

async function freePort(): Promise<number> {
	const server = net.createServer()
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
	const address = server.address()
	await new Promise<void>((resolve) => server.close(() => resolve()))
	if (typeof address !== "object" || !address) throw new Error("no port")
	return address.port
}

interface Rig {
	env: NodeJS.ProcessEnv
	port: number
	baseUrl: string
	cleanup(): void
}

function rig(port: number): Rig {
	const root = mkdtempSync(join(tmpdir(), "pmb-life-"))
	const configDir = join(root, "config", "pi-mailbridge")
	mkdirSync(configDir, { recursive: true })
	// An unreachable IMAP host keeps the watcher in backoff without any network.
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			mail: {
				imap: { host: "127.0.0.1", port: 1, secure: false, user: "pi@example.com", password: "x", folder: "INBOX" },
				smtp: { host: "127.0.0.1", port: 1, secure: false, user: "pi@example.com", password: "x", authType: "LOGIN" },
				to: "you@example.com",
			},
			security: { allowFrom: ["you@example.com"], requireDmarcPass: false },
			daemon: { host: "127.0.0.1", port },
			tuning: { idleRenewMs: 1000, backoffInitialMs: 50, backoffMaxMs: 200 },
		}),
	)
	const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") }
	return { env, port, baseUrl: daemonBaseUrl(port), cleanup: () => {} }
}

function startDaemon(r: Rig): ChildProcess {
	return spawn(process.execPath, ["--experimental-strip-types", MAIN], { env: r.env, stdio: ["ignore", "pipe", "pipe"] })
}

function waitForLine(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = ""
		const timer = setTimeout(() => {
			cleanup()
			reject(new Error(`timeout waiting for ${pattern}; saw: ${buffer.slice(-400)}`))
		}, timeoutMs)
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString()
			if (pattern.test(buffer)) {
				cleanup()
				resolve(buffer)
			}
		}
		const onExit = (code: number | null) => {
			cleanup()
			reject(new Error(`exited (${code}) before matching ${pattern}: ${buffer.slice(-400)}`))
		}
		function cleanup() {
			clearTimeout(timer)
			child.stdout?.off("data", onData)
			child.stderr?.off("data", onData)
			child.off("exit", onExit)
		}
		child.stdout?.on("data", onData)
		child.stderr?.on("data", onData)
		child.on("exit", onExit)
	})
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null) return resolve(child.exitCode)
		const timer = setTimeout(() => reject(new Error("timeout waiting for exit")), timeoutMs)
		child.once("exit", (code) => {
			clearTimeout(timer)
			resolve(code)
		})
	})
}

test("a second daemon exits 0 instead of fighting for the port", { timeout: 40_000 }, async () => {
	const port = await freePort()
	const r = rig(port)
	const first = startDaemon(r)
	try {
		await waitForLine(first, /listening on http/, 20_000)

		// (b) /health answers even though IMAP never connected.
		assert.equal(await probeHealth({ baseUrl: r.baseUrl, timeoutMs: 2000 }), true)

		const second = startDaemon(r)
		const code = await waitForExit(second, 20_000)
		assert.equal(code, 0, "second daemon must exit 0 (single-instance lock)")

		// The original daemon is untouched.
		assert.equal(await probeHealth({ baseUrl: r.baseUrl, timeoutMs: 2000 }), true)
	} finally {
		first.kill("SIGKILL")
	}
})

test("SIGTERM shuts down cleanly within a bound", { timeout: 40_000 }, async () => {
	const port = await freePort()
	const r = rig(port)
	const child = startDaemon(r)
	try {
		await waitForLine(child, /listening on http/, 20_000)
		assert.equal(await probeHealth({ baseUrl: r.baseUrl, timeoutMs: 2000 }), true)

		child.kill("SIGTERM")
		const code = await waitForExit(child, 10_000)
		assert.equal(code, 0, "clean exit on SIGTERM")

		assert.equal(await probeHealth({ baseUrl: r.baseUrl, timeoutMs: 500 }), false, "port released")
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL")
	}
})

test("ensureDaemon reuses a running daemon instead of spawning another", { timeout: 40_000 }, async () => {
	const port = await freePort()
	const r = rig(port)
	const child = startDaemon(r)
	try {
		await waitForLine(child, /listening on http/, 20_000)

		let spawns = 0
		const result = await ensureDaemon({
			baseUrl: r.baseUrl,
			scriptPath: MAIN,
			env: r.env,
			spawnImpl: () => {
				spawns++
				return { unref() {} }
			},
		})
		assert.deepEqual(result, { started: false, healthy: true })
		assert.equal(spawns, 0, "must not spawn when a daemon already answers")
	} finally {
		child.kill("SIGKILL")
	}
})

test("ensureDaemon spawns detached when nothing answers", { timeout: 20_000 }, async () => {
	const port = await freePort()
	let spawnedArgs: string[] = []
	let unrefCalled = false

	// The fake spawn reports healthy on the first probe after spawning.
	let probes = 0
	const result = await ensureDaemon({
		baseUrl: daemonBaseUrl(port),
		scriptPath: "/tmp/does-not-matter.ts",
		spawnImpl: (_cmd, args) => {
			spawnedArgs = args
			return {
				unref() {
					unrefCalled = true
				},
			}
		},
		fetchImpl: (async () => {
			probes++
			// First call (pre-check) fails, afterwards it "is up".
			if (probes === 1) throw new Error("ECONNREFUSED")
			return new Response("{}", { status: 200 })
		}) as unknown as typeof fetch,
		sleep: async () => {},
	})

	assert.deepEqual(result, { started: true, healthy: true })
	assert.equal(unrefCalled, true, "child must be detached from the session")
	assert.ok(spawnedArgs.includes("/tmp/does-not-matter.ts"))
})

test("probeHealth treats refused and hanging daemons as unhealthy", async () => {
	assert.equal(
		await probeHealth({
			baseUrl: "http://127.0.0.1:1",
			timeoutMs: 300,
		}),
		false,
	)
	assert.equal(
		await probeHealth({
			baseUrl: "http://127.0.0.1:1",
			timeoutMs: 100,
			fetchImpl: (async () => {
				throw new Error("nope")
			}) as unknown as typeof fetch,
		}),
		false,
	)
})

test("POST /reload works on a real daemon and needs the bearer token", { timeout: 45_000 }, async () => {
	const port = await freePort()
	const r = rig(port)
	const child = startDaemon(r)
	try {
		await waitForLine(child, /listening on http/, 20_000)

		// The token is the shared secret the daemon wrote on boot.
		const token = readFileSync(join(r.env.XDG_STATE_HOME!, "pi-mailbridge", "secret.key"), "utf8").trim()
		assert.ok(token.length > 20)

		const unauthorised = await fetch(`${r.baseUrl}/reload`, { method: "POST" })
		assert.equal(unauthorised.status, 401, "reload must not be open on loopback")

		const ok = await fetch(`${r.baseUrl}/reload`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
		})
		assert.equal(ok.status, 200, "reload should succeed: config re-read, watcher restarted")

		// Still alive and serving after the watcher was swapped.
		assert.equal(await probeHealth({ baseUrl: r.baseUrl, timeoutMs: 2000 }), true)
	} finally {
		child.kill("SIGTERM")
		await waitForExit(child, 10_000).catch(() => child.kill("SIGKILL"))
	}
})

test("a spawned daemon writes to daemon.log instead of discarding output", async () => {
	const port = await freePort()
	const root = mkdtempSync(join(tmpdir(), "pmb-log-"))
	const env = { ...process.env, XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") }
	const { existsSync } = await import("node:fs")

	let stdio: unknown
	await ensureDaemon({
		baseUrl: daemonBaseUrl(port),
		scriptPath: "/tmp/nope.ts",
		env,
		spawnImpl: (_cmd, _args, opts) => {
			stdio = (opts as { stdio?: unknown }).stdio
			return { unref() {} }
		},
		fetchImpl: (async () => {
			throw new Error("down")
		}) as unknown as typeof fetch,
		sleep: async () => {},
		waitMs: 1,
	})

	// Either a log descriptor or "ignore" if the state dir was unusable; here it must
	// be a descriptor pair, and the file must exist.
	assert.ok(Array.isArray(stdio), "output should be redirected, not ignored")
	assert.equal((stdio as unknown[])[0], "ignore", "stdin stays closed")
	assert.equal(typeof (stdio as unknown[])[1], "number")
	assert.ok(existsSync(join(env.XDG_STATE_HOME, "pi-mailbridge", "daemon.log")))
})

test("a daemon that never answers times out instead of wedging the caller", async () => {
	// Without a ceiling, a drain awaiting /pending never settles, and every later drain in
	// the process rides the same dead promise - delivery stops permanently.
	const { createDaemonClient } = await import("../src/daemon/spawn.ts")
	const client = createDaemonClient({
		baseUrl: "http://127.0.0.1:1",
		token: "t",
		timeoutMs: 20,
		fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const e = new Error("aborted")
					e.name = "AbortError"
					reject(e)
				})
			})) as never,
	})
	const result = await client.pending()
	assert.equal(result.ok, false)
	assert.equal(!result.ok && result.code, "timeout")
})

test("a send outlives the generic ceiling, so a slow relay is not cut off", async () => {
	// The generic ceiling covers /pending; a notification carries inlined images and the
	// daemon awaits the whole SMTP transaction. If /send reused the short budget it would
	// abort mid-transaction and the mail would be reported as failed.
	const { createDaemonClient } = await import("../src/daemon/spawn.ts")
	const client = createDaemonClient({
		baseUrl: "http://127.0.0.1:1",
		token: "t",
		timeoutMs: 40,
		fetchImpl: ((url: string, init?: { signal?: AbortSignal }) => {
			const path = new URL(url).pathname
			if (path === "/pending") {
				// Never answers: only the abort settles it.
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const e = new Error("aborted")
						e.name = "AbortError"
						reject(e)
					})
				})
			}
			// A slow-but-successful send, well past the generic 40 ms budget. It honours the
			// signal, so a short budget really does kill it - that is what makes this test
			// fail when the per-call timeout is removed.
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => resolve(new Response("{}", { status: 200 })), 150)
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(timer)
					const e = new Error("aborted")
					e.name = "AbortError"
					reject(e)
				})
			})
		}) as never,
	})

	const poll = await client.pending()
	assert.equal(!poll.ok && poll.code, "timeout", "the poll uses the short budget")

	const sent = await client.send({ subject: "x", text: "y" })
	assert.equal(sent.ok, true, "the send must not be cut off by the poll budget")
})

test("--check warns when DMARC is required for a single mailbox", async () => {
	// A supervisor typically preflights with `--check`; the in-pi command warned, this did not.
	const { checkProblems } = await import("../src/daemon/main.ts")
	const cfg: ResolvedConfig = {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "pi@example.com", password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: "pi@example.com", password: "x", authType: "LOGIN" },
			to: "you@example.com",
		},
		security: {
			allowFrom: ["you@example.com"],
			requireDmarcPass: true,
			allowSelfReplies: true,
			trustedAuthservId: "mx.example.com",
			tokenTtlHours: 24,
		} as ResolvedConfig["security"],
		daemon: { host: "127.0.0.1", port: 4177, idleTimeoutSecs: 120 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false, maxAttachmentMb: 18 },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
	}
	const problems = checkProblems(cfg)
	assert.ok(
		problems.some((p) => /allowSelfReplies.*requireDmarcPass/s.test(p)),
		`check must warn (problems: ${JSON.stringify(problems)})`,
	)
})

test("the sent copy is read back AFTER the send, not before", async () => {
	// The live bug: capturing first recorded the *previous* notification's id against this
	// session. The order is the fix, so pin it.
	const { sendWithCapture } = await import("../src/daemon/main.ts")
	const order: string[] = []
	const sent = await sendWithCapture(
		{ messageId: "<minted@qq.com>", sessionId: "sess-1", subject: "[pi:abc123] x" },
		async () => {
			order.push("send")
			return "sent-result"
		},
		{
			sentFolder: "Sent Messages",
			capture: async () => {
				order.push("capture")
				return "tencent_x@qq.com"
			},
		},
	)
	assert.equal(sent, "sent-result")
	await new Promise((r) => setImmediate(r))
	assert.deepEqual(order, ["send", "capture"], "send first, then the read-back")
})

test("a failed send skips the read-back", async () => {
	const { sendWithCapture } = await import("../src/daemon/main.ts")
	let captured = 0
	await assert.rejects(
		sendWithCapture(
			{ messageId: "<minted@qq.com>", sessionId: "sess-1", subject: "x" },
			async () => {
				throw new Error("smtp refused")
			},
			{
				sentFolder: "Sent Messages",
				capture: async () => {
					captured++
					return undefined
				},
			},
		),
	)
	await new Promise((r) => setImmediate(r))
	assert.equal(captured, 0, "nothing was sent, so there is nothing to read back")
})

test("no session or no sentFolder means no read-back", async () => {
	const { sendWithCapture } = await import("../src/daemon/main.ts")
	let captured = 0
	const capture = async (): Promise<string | undefined> => {
		captured++
		return undefined
	}
	await sendWithCapture({ messageId: "<m@qq.com>", subject: "x" }, async () => "ok", { sentFolder: "Sent", capture })
	await sendWithCapture(
		{ messageId: "<m@qq.com>", sessionId: "s", subject: "x" },
		async () => "ok",
		{ capture },
	)
	await new Promise((r) => setImmediate(r))
	assert.equal(captured, 0)
})

test("a failed sent-copy read-back is reported, not swallowed", async () => {
	// sendWithCapture is fire-and-forget, so a rejected capture is invisible unless onMissed
	// runs. Nothing referenced onMissed before: deleting the call kept every test green.
	const { sendWithCapture } = await import("../src/daemon/main.ts")
	const message = { messageId: "<m1@example.com>", sessionId: "s1", subject: "hi" }
	let missed = 0

	const ok = await sendWithCapture(message, async () => "sent", {
		sentFolder: "Sent Messages",
		capture: async () => undefined,
		onMissed: () => (missed += 1),
	})
	assert.equal(ok, "sent", "the notification must still be reported as sent")
	await new Promise((r) => setTimeout(r, 0))
	assert.equal(missed, 1, "a missing delivered id counts as missed")

	missed = 0
	await sendWithCapture(message, async () => "sent", {
		sentFolder: "Sent Messages",
		capture: async () => {
			throw new Error("EACCES")
		},
		onMissed: () => (missed += 1),
	})
	await new Promise((r) => setTimeout(r, 0))
	assert.equal(missed, 1, "a rejected capture counts too")

	missed = 0
	await sendWithCapture(message, async () => "sent", {
		sentFolder: "Sent Messages",
		capture: async () => "<delivered@qq.com>",
		onMissed: () => (missed += 1),
	})
	await new Promise((r) => setTimeout(r, 0))
	assert.equal(missed, 0, "a captured id reports nothing")
})

test("a daemon on another protocol is not reused, and is not raced either", async () => {
	// Reusing whatever answers is how a replacement reports success while the old protocol is
	// still being served; spawning beside it just loses the port battle.
	let spawns = 0
	const result = await ensureDaemon({
		baseUrl: daemonBaseUrl(await freePort()),
		scriptPath: "/tmp/does-not-matter.ts",
		spawnImpl: () => {
			spawns += 1
			return { unref() {} }
		},
		fetchImpl: (async () =>
			new Response(JSON.stringify({ ok: true, apiVersion: 2 }), { status: 200 })) as unknown as typeof fetch,
		sleep: async () => {},
	})

	assert.equal(result.started, false)
	assert.equal(result.healthy, false)
	assert.equal(result.incompatible, true, "the reason is reported, not flattened to 'unreachable'")
	assert.equal(spawns, 0, "a live daemon on the same port would only make the child exit")
})
