import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { API_VERSION } from "../src/daemon/api.ts"
import net from "node:net"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { daemonBaseUrl, ensureDaemon, probeHealth } from "../src/daemon/spawn.ts"
import { STARTER_DEFAULTS, type ResolvedConfig } from "../src/core/config.ts"

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
			// A realistic /health: the probe now treats anything without `ok: true` as foreign.
			return new Response(JSON.stringify({ ok: true, apiVersion: API_VERSION }), { status: 200 })
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
				const timer = setTimeout(
					() => resolve(new Response(JSON.stringify({ ok: true, apiVersion: API_VERSION }), { status: 200 })),
					150,
				)
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
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false, maxAttachmentMb: 18 , inlineSvg: true, rasteriseSvg: false},
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		device: { name: "test-device" },
		warnings: [],
		starter: STARTER_DEFAULTS,
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

test("a fork failure is reported, not thrown into pi's process", async () => {
	// spawn() delivers EAGAIN/EMFILE as an `error` event. Without a listener Node rethrows it as
	// an uncaught exception in the *caller* - the pi session - while no daemon was ever started.
	const result = await ensureDaemon({
		baseUrl: daemonBaseUrl(await freePort()),
		scriptPath: "/tmp/does-not-matter.ts",
		spawnImpl: () => {
			let listener: ((error: Error) => void) | undefined
			const child = {
				unref() {},
				on(event: string, fn: (error: Error) => void) {
					if (event === "error") listener = fn
					return child
				},
			}
			// Fail asynchronously, the way a real fork failure arrives.
			setTimeout(() => listener?.(Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" })), 5)
			return child
		},
		fetchImpl: (async () => {
			throw new Error("ECONNREFUSED")
		}) as unknown as typeof fetch,
		waitMs: 500,
		// A real yield, not a microtask: with `async () => {}` the timer below never runs inside the
		// wait window, so `spawnError` stayed unset and this test passed with the error path deleted.
		sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
	})

	assert.equal(result.started, true)
	assert.equal(result.healthy, false, "reported as an unhealthy start, not an exception")
	assert.equal(result.error, "spawn EAGAIN", "the fork failure is reported, not swallowed")
})

test("daemonBaseUrl brackets an IPv6 host so the URL parses", () => {
	// `config.ts` accepts `::1` as a loopback daemon.host without a warning; an unbracketed URL
	// (`http://::1:4177`) does not parse at all, so every probe would report the daemon missing.
	assert.equal(daemonBaseUrl(4177, "::1"), "http://[::1]:4177")
	assert.equal(daemonBaseUrl(4177, "[::1]"), "http://[::1]:4177", "already-bracketed input is not doubled")
	assert.equal(daemonBaseUrl(4177, "127.0.0.1"), "http://127.0.0.1:4177")
	assert.equal(daemonBaseUrl(4177, ""), "http://127.0.0.1:4177", "an empty host falls back rather than building http://:4177")
	assert.equal(daemonBaseUrl(4177, " 127.0.0.1 "), "http://127.0.0.1:4177")
	assert.doesNotThrow(() => new URL(`${daemonBaseUrl(4177, "::1")}/health`))
})

test("a daemon on [::1] answers through the transport", () => {
	// daemonBaseUrl brackets and the transport unbrackets; `service.listen`'s strip has its own test
	// in daemon-service.test.ts (this one binds a bare server, so `listen` is not in the path).
	return (async () => {
		const { createServer } = await import("node:http")
		const { probeHealthDetail } = await import("../src/daemon/spawn.ts")
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ ok: true, apiVersion: 1 }))
		})
		const bound = await new Promise<boolean>((resolve) => {
			server.once("error", () => resolve(false))
			server.listen(0, "::1", () => resolve(true))
		})
		if (!bound) return // a host without IPv6 loopback
		try {
			const port = (server.address() as { port: number }).port
			assert.deepEqual(await probeHealthDetail({ baseUrl: daemonBaseUrl(port, "::1") }), { ok: true, apiVersion: 1 })
		} finally {
			server.close()
		}
	})()
})

test("something that is not our daemon answering 200 is bad_response, not success or network", () => {
	// A dev server squatting `daemon.port` answers 200 to anything. Reporting `ok: true, data: {}`
	// would let `claim`/`ack`/`send` "succeed" with no daemon; reporting `network` points the user at
	// `pi update` for a daemon that is up. Both hide the real cause, which is a wrong port.
	return (async () => {
		const { createServer } = await import("node:http")
		const { createDaemonClient } = await import("../src/daemon/spawn.ts")

		const cases: Array<{ name: string; body: string; type: string }> = [
			{ name: "empty 200", body: "", type: "text/plain" },
			{ name: "html 200", body: "<!doctype html><title>dev</title>", type: "text/html" },
			// Valid JSON with no envelope: the case the envelope check exists for. Without it a
			// squatter answering `{}` made `claim` look confirmed.
			{ name: "json 200 without an envelope", body: "{}", type: "application/json" },
		]
		for (const c of cases) {
			const server = createServer((_req, res) => {
				res.writeHead(200, { "content-type": c.type })
				res.end(c.body)
			})
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
			const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
			try {
				const client = createDaemonClient({ baseUrl, token: "t" })
				const claim = await client.claim(1, "i")
				assert.deepEqual(
					{ ok: claim.ok, code: claim.ok ? undefined : claim.code },
					{ ok: false, code: "bad_response" },
					`${c.name}: claim must not report success`,
				)
				const mode = await client.mode()
				assert.deepEqual(
					{ ok: mode.ok, code: mode.ok ? undefined : mode.code },
					{ ok: false, code: "bad_response" },
					`${c.name}: mode must be neither success nor network`,
				)
			} finally {
				server.close()
			}
		}
	})()
})

test("something else on the port is reported as foreign, not as an old protocol", () => {
	// A dev server squatting daemon.port answers /health with HTML (or an empty 200). Calling that
	// "protocol 0" made the session replace a daemon that was never there: /shutdown POSTed at the
	// squatter once a minute, and "the daemon is still on protocol 0" as the explanation.
	return (async () => {
		const { createServer } = await import("node:http")
		const { probeHealthDetail, ensureDaemon } = await import("../src/daemon/spawn.ts")
		const { apiCompatible } = await import("../src/daemon/api.ts")

		// `{"ok":true}` is the important one: it is the most common health payload there is, and
		// `ok` alone used to be enough to be mistaken for our daemon (protocol 0, then /shutdown).
		const json = (body: string) => ({ "content-type": "application/json", body })
		// `{}` is the case fix (c) exists for: valid JSON, no envelope. It was not covered, which is
		// how the `/register` mismatch slipped through.
		for (const body of ["<!doctype html><title>dev</title>", "", '{"hello":"world"}', '{"ok":true}', "{}"]) {
			const server = createServer((_req, res) => {
				res.writeHead(200, { "content-type": "text/html" })
				res.end(body)
			})
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
			const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
			try {
				const probe = await probeHealthDetail({ baseUrl })
				assert.equal(probe.ok, false, `${JSON.stringify(body)} is not our /health`)
				assert.equal(probe.apiVersion, undefined, "no protocol was observed, so none may be claimed")
				assert.equal(probe.foreign, true, "it answered, so it is not 'nothing is listening'")
				assert.equal(apiCompatible(API_VERSION, probe.apiVersion), false)

				let spawned = 0
				const result = await ensureDaemon({
					baseUrl,
					scriptPath: "/tmp/does-not-matter.ts",
					spawnImpl: (() => {
						spawned += 1
						throw new Error("must not spawn onto a foreign port")
					}) as never,
					waitMs: 10,
					sleep: async () => {},
				})
				assert.equal(spawned, 0, "spawning would collide with the service that owns the port")
				assert.deepEqual({ healthy: result.healthy, foreign: result.foreign }, { healthy: false, foreign: true })
			} finally {
				server.close()
			}
		}
	})()
})

test("a foreign service blocks spawning only while it is there", () => {
	// The refusal must not be sticky: if the squatter goes away, the next probe finds nothing
	// listening and the daemon is spawned as usual. Otherwise one stray service on the port would
	// disable the bridge until pi restarted.
	return (async () => {
		const { createServer } = await import("node:http")
		const { ensureDaemon } = await import("../src/daemon/spawn.ts")
		const squatter = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" })
			res.end("<!doctype html><title>dev</title>")
		})
		await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", () => resolve()))
		const baseUrl = `http://127.0.0.1:${(squatter.address() as { port: number }).port}`

		let spawned = 0
		const spawnImpl = (() => {
			spawned += 1
			return { unref() {} }
		}) as never
		try {
			const blocked = await ensureDaemon({ baseUrl, scriptPath: "/tmp/x.ts", spawnImpl, waitMs: 10, sleep: async () => {} })
			assert.deepEqual({ healthy: blocked.healthy, foreign: blocked.foreign, spawned }, { healthy: false, foreign: true, spawned: 0 })
		} finally {
			squatter.close()
		}

		// Port free again: nothing answers, so the normal spawn path runs (and this stub fails the
		// post-spawn probe, which is fine - what matters is that it was attempted).
		const after = await ensureDaemon({ baseUrl, scriptPath: "/tmp/x.ts", spawnImpl, waitMs: 10, sleep: async () => {} })
		assert.equal(spawned, 1, "the refusal was not sticky: a spawn was attempted once the squatter left")
		assert.equal(after.foreign, undefined)
	})()
})

test("a non-2xx answer on /health is a stranger, but a 5xx may be our own", async () => {
	// A 401/404/503 responder is somebody else's service: folding it into "nothing answered" spawns
	// a daemon every backoff, and the child exits 0 on EADDRINUSE against a port nobody names.
	// A 5xx stays "nothing usable" — that can be our daemon failing its own handler.
	const { createServer } = await import("node:http")
	const { probeHealthDetail } = await import("../src/daemon/spawn.ts")
	for (const [status, foreign] of [
		[401, true],
		[404, true],
		[503, true],
		[301, true],
		[502, true],
		[500, false],
	] as const) {
		const server = createServer((_req, res) => {
			res.writeHead(status)
			res.end()
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
		try {
			const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
			const probe = await probeHealthDetail({ baseUrl })
			assert.equal(probe.ok, false, `${status} is not a healthy daemon`)
			assert.equal(probe.foreign === true, foreign, `${status} foreign=${foreign}`)
		} finally {
			server.close()
		}
	}
})

test("our own daemon shapes are never foreign, including an old protocol", async () => {
	// The discriminator must not misread a daemon we shipped: pre-apiVersion daemons send `ok`+`mode`,
	// and every daemon sends `mode`.
	const { createServer } = await import("node:http")
	const { probeHealthDetail } = await import("../src/daemon/spawn.ts")
	const bodies: Array<{ body: Record<string, unknown>; apiVersion?: number }> = [
		{ body: { ok: true, apiVersion: 1, mode: "on", capabilities: ["health"] }, apiVersion: 1 },
		{ body: { ok: true, apiVersion: 0, mode: "on" }, apiVersion: 0 },
		{ body: { ok: true, mode: "on" }, apiVersion: undefined },
	]
	for (const { body, apiVersion } of bodies) {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify(body))
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
		try {
			const probe = await probeHealthDetail({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
			assert.equal(probe.ok, true, `${JSON.stringify(body)} is our daemon`)
			assert.equal(probe.foreign, undefined)
			assert.equal(probe.apiVersion, apiVersion)
		} finally {
			server.close()
		}
	}
})

test("an unbuilt install reports a reinstall message instead of spawning a .ts in node_modules", async () => {
	// The real spawn is what fails there (Node refuses type stripping under node_modules), and the
	// daemon's stderr is in a log file the user will not read.
	const { ensureDaemon } = await import("../src/daemon/spawn.ts")
	const port = await freePort()
	const result = await ensureDaemon({
		baseUrl: daemonBaseUrl(port),
		scriptPath: "/p/node_modules/@dumbmice/pi-mailbridge/src/daemon/main.ts",
		waitMs: 10,
		sleep: async () => {},
	})
	assert.equal(result.started, false)
	assert.match(result.error ?? "", /reinstall the package/)
})

test("a probe that times out is not reported as a stranger", () => {
	// `{ok:false, foreign:true}` would tell the user to change daemon.port when the daemon is only
	// slow or loaded - the wrong-advice class this probe exists to remove.
	return (async () => {
		const { probeHealthDetail } = await import("../src/daemon/spawn.ts")
		const probe = await probeHealthDetail({
			baseUrl: "http://127.0.0.1:1",
			timeoutMs: 5,
			// A slow daemon that never answers, honouring the abort like the real transport does.
			fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
				})) as unknown as typeof fetch,
		})
		assert.deepEqual(probe, { ok: false })
	})()
})

