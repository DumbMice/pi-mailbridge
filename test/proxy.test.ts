// Loopback must never be proxied.
//
// pi installs `undici`'s `EnvHttpProxyAgent` as the global dispatcher, so every `fetch` in the
// agent process - `http://127.0.0.1:4177` included - is tunnelled through `HTTP_PROXY` when that
// variable is set and `NO_PROXY` does not exclude loopback. A proxy asked to reach 127.0.0.1 just
// times out, so the daemon looks unreachable while it is answering in sub-millisecond time. A live
// session was unusable because of it.
//
// The fix is the standard one: `NO_PROXY`. These tests pin both halves - the environment edit, and
// the fact that the real dispatcher then lets loopback through.

import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"

import { ensureLoopbackExemptFromProxy, isLoopbackHost } from "../src/core/proxy.ts"

/** A pristine env: two keys, nothing inherited from the developer's shell. */
function freshEnv(): NodeJS.ProcessEnv {
	return {}
}

test("adds loopback when NO_PROXY is not set", () => {
	const env = freshEnv()
	assert.equal(ensureLoopbackExemptFromProxy(env), true)
	assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1")
	assert.equal(env.no_proxy, undefined, "does not shadow the variable undici reads first")
})

test("extends the user's list instead of replacing it", () => {
	const env = { NO_PROXY: "*.corp.example,example.com" }
	assert.equal(ensureLoopbackExemptFromProxy(env), true)
	const entries = env.NO_PROXY?.split(",") ?? []
	assert.deepEqual(entries.slice(0, 2), ["*.corp.example", "example.com"], "existing entries kept in order")
	assert.deepEqual(entries.slice(2), ["localhost", "127.0.0.1", "::1"])
})

test("keeps a wildcard entry, which already exempts everything", () => {
	const env = { NO_PROXY: "*" }
	assert.equal(ensureLoopbackExemptFromProxy(env), true, "the loopback names are added, the wildcard untouched")
	assert.deepEqual(env.NO_PROXY?.split(",").slice(0, 1), ["*"])
})

test("is idempotent and leaves a complete list byte-for-byte alone", () => {
	const env = freshEnv()
	ensureLoopbackExemptFromProxy(env)
	const once = env.NO_PROXY
	assert.equal(ensureLoopbackExemptFromProxy(env), false)
	assert.equal(env.NO_PROXY, once, "no rewriting on the second call")
})

test("recognises loopback written in brackets or uppercase", () => {
	const env = { NO_PROXY: " [::1] , LOCALHOST,127.0.0.1 " }
	assert.equal(ensureLoopbackExemptFromProxy(env), false)
	assert.equal(env.NO_PROXY, " [::1] , LOCALHOST,127.0.0.1 ", "an already-correct list is not reformatted")
})

test("writes to no_proxy when that is the variable in use", () => {
	// undici reads `process.env.no_proxy ?? process.env.NO_PROXY`: the lowercase name wins, so
	// adding to NO_PROXY here would be invisible to it.
	const env: NodeJS.ProcessEnv = { no_proxy: "example.com" }
	assert.equal(ensureLoopbackExemptFromProxy(env), true)
	assert.equal(env.no_proxy, "example.com,localhost,127.0.0.1,::1")
	assert.equal(env.NO_PROXY, undefined)
})

test("a proxy swallows a healthy loopback daemon until loopback is exempt", async () => {
	// The real thing: `undici`'s env dispatcher with HTTP_PROXY pointing at a closed port, which is
	// what pi builds. Nothing here is mocked.
	const undici = await import("undici")
	const { probeHealthDetail } = await import("../src/daemon/spawn.ts")

	const server = createServer((req, res) => {
		if (req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ ok: true, apiVersion: 1, mode: "on", pending: 0 }))
			return
		}
		res.writeHead(404).end()
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
	const port = (server.address() as { port: number }).port
	const baseUrl = `http://127.0.0.1:${port}`

	const savedEnv = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
	const savedDispatcher = undici.getGlobalDispatcher()
	const savedFetch = globalThis.fetch
	try {
		// A closed port: the tunnel attempt fails immediately instead of waiting for a timeout.
		process.env.HTTP_PROXY = "http://127.0.0.1:1"
		delete process.env.NO_PROXY
		delete process.env.no_proxy
		undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ proxyTunnel: true }))
		undici.install?.()

		// The bug, reproduced: a healthy daemon is unreachable through a proxy.
		await assert.rejects(fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) }))

		// The client exempts the host it is configured for, so the probe gets through - and it does
		// so without the extension having run, which is what makes a stale dispatcher harmless.
		assert.deepEqual(await probeHealthDetail({ baseUrl }), { ok: true, apiVersion: 1 })
		assert.ok((process.env.NO_PROXY ?? "").split(",").includes("127.0.0.1"), "and it recorded the exemption")
	} finally {
		undici.setGlobalDispatcher(savedDispatcher)
		globalThis.fetch = savedFetch
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		server.close()
	}
})

test("recognises every form of loopback, and nothing else", () => {
	const loopback = ["localhost", "LOCALHOST.", "[::1]", "::1", "127.0.0.1", "127.0.0.2", "127.255.255.254", "pi.localhost"]
	const remote = ["example.com", "10.1.2.3", "192.168.0.1", "[2001:db8::1]", "127.0.0.256", "127.0.0", "loopback", ""]
	for (const host of loopback) assert.equal(isLoopbackHost(host), true, `${host} is loopback`)
	for (const host of remote) assert.equal(isLoopbackHost(host), false, `${host} is not loopback`)
})

test("exempts a loopback host that is not one of the three default names", () => {
	// `daemon.host: 127.0.0.2` dodges a port clash and must not be tunnelled through the proxy.
	const env = freshEnv()
	assert.equal(ensureLoopbackExemptFromProxy(env, ["127.0.0.2"]), true)
	assert.deepEqual(env.NO_PROXY?.split(","), ["localhost", "127.0.0.1", "::1", "127.0.0.2"])
})

test("never exempts a remote daemon host, which is meant to use the proxy", () => {
	const env = freshEnv()
	ensureLoopbackExemptFromProxy(env, ["daemon.example.com", "10.1.2.3", "192.168.0.1"])
	assert.deepEqual(env.NO_PROXY?.split(","), ["localhost", "127.0.0.1", "::1"], "no remote host is exempted")
})

test("a real proxy is still used for everything that is not loopback", async () => {
	// The whole point of the fix is that it only removes loopback from the proxy. Assert both
	// halves against a proxy that really receives the traffic.
	const undici = await import("undici")
	const { probeHealthDetail } = await import("../src/daemon/spawn.ts")

	const seen: string[] = []
	const proxy = createServer((req, res) => {
		seen.push(`plain ${req.url ?? ""}`)
		res.writeHead(502).end()
	})
	proxy.on("connect", (req: { url?: string }, socket: { destroy: () => void }) => {
		seen.push(req.url ?? "")
		socket.destroy() // refuse the tunnel: the request must fail, but it must have arrived
	})
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()))

	const local = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ ok: true, apiVersion: 1 }))
	})
	await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", () => resolve()))

	const savedEnv = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
	const savedDispatcher = undici.getGlobalDispatcher()
	const savedFetch = globalThis.fetch
	try {
		process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
		delete process.env.NO_PROXY
		delete process.env.no_proxy
		undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ proxyTunnel: true }))
		undici.install?.()

		ensureLoopbackExemptFromProxy()

		const localPort = (local.address() as { port: number }).port
		assert.deepEqual(await probeHealthDetail({ baseUrl: `http://127.0.0.1:${localPort}` }), { ok: true, apiVersion: 1 })
		assert.deepEqual(seen, [], "loopback went direct")

		// A host on the internet: the proxy must be consulted, and the request must not succeed.
		await assert.rejects(fetch("http://example.invalid/", { signal: AbortSignal.timeout(2_000) }))
		assert.deepEqual(seen, ["example.invalid:80"], "the proxy still carries non-loopback traffic")
	} finally {
		undici.setGlobalDispatcher(savedDispatcher)
		globalThis.fetch = savedFetch
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		local.close()
		proxy.close()
	}
})

test("a daemon on 127.0.0.2 is reachable through a proxy environment", async () => {
	// The narrow version of the original bug: loopback that is not one of the three default names.
	const undici = await import("undici")
	const { probeHealthDetail, createDaemonClient } = await import("../src/daemon/spawn.ts")

	const server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(req.url === "/mode" ? { mode: "on" } : { ok: true, apiVersion: 1 }))
	})
	const bound = await new Promise<boolean>((resolve) => {
		server.once("error", () => resolve(false))
		server.listen(0, "127.0.0.2", () => resolve(true))
	})
	if (!bound) return // a host without the wider 127/8 range

	const seen: string[] = []
	const proxy = createServer((_req, res) => res.writeHead(502).end())
	proxy.on("connect", (req: { url?: string }, socket: { destroy: () => void }) => {
		seen.push(req.url ?? "")
		socket.destroy()
	})
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()))

	const savedEnv = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
	const savedDispatcher = undici.getGlobalDispatcher()
	const savedFetch = globalThis.fetch
	try {
		process.env.HTTP_PROXY = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
		delete process.env.NO_PROXY
		delete process.env.no_proxy
		undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ proxyTunnel: true }))
		undici.install?.()

		const baseUrl = `http://127.0.0.2:${(server.address() as { port: number }).port}`

		// Each entry point is checked from a clean slate, so neither can lean on the other.
		const client = createDaemonClient({ baseUrl, token: "t" })
		assert.equal((await client.mode()).ok, true, "the typed client exempts the host it is configured for")

		delete process.env.NO_PROXY
		assert.deepEqual(await probeHealthDetail({ baseUrl }), { ok: true, apiVersion: 1 }, "and so does the probe")

		assert.deepEqual(seen, [], "the proxy never saw either")
	} finally {
		undici.setGlobalDispatcher(savedDispatcher)
		globalThis.fetch = savedFetch
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		server.close()
		proxy.close()
	}
})

