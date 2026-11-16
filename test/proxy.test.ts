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

import { ensureLoopbackExemptFromProxy } from "../src/core/proxy.ts"

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

test("a proxied loopback call fails until loopback is exempt, then succeeds", async () => {
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
		// `configureHttpDispatcher` does this too: pi keeps `fetch` and the dispatcher on the same
		// undici implementation, so Node's built-in fetch is replaced as well.
		undici.install?.()
		if (undici.fetch === undefined) assert.fail("undici exposed no install(), test would prove nothing")

		// The reason the fix exists: a proxy swallows a healthy loopback daemon, and the probe
		// reports it as unreachable - which is exactly what a live session showed.
		assert.deepEqual(await probeHealthDetail({ baseUrl }), { ok: false })

		assert.equal(ensureLoopbackExemptFromProxy(), true)
		// The dispatcher was built before this call, and undici re-reads NO_PROXY per dispatch, so
		// no rebuild is needed - the same reason the fix works inside a running pi session.
		assert.deepEqual(await probeHealthDetail({ baseUrl }), { ok: true, apiVersion: 1 })
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
