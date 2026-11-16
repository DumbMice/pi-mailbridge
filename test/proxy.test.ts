// Our daemon must not go through a proxy; nothing else should change.
//
// pi installs `undici`'s `EnvHttpProxyAgent` as the global dispatcher, so with `HTTP_PROXY` set and
// loopback absent from `NO_PROXY`, every `fetch` - `http://127.0.0.1:4177` included - is tunnelled
// through the proxy and times out. A live session was unusable because of it: "daemon:
// unreachable" while the daemon answered in half a millisecond.
//
// The fix is the standard mechanism, `NO_PROXY`, scoped by port to the daemon's own endpoint. These
// tests pin both halves: our daemon is exempt, and everything else - another loopback port
// included - still goes through the proxy.

import assert from "node:assert/strict"
import { test } from "node:test"
import net from "node:net"
import { createServer } from "node:http"

import { ensureDaemonExemptFromProxy, isLoopbackHost, noProxyEntryFor } from "../src/core/proxy.ts"

/** A pristine env: nothing inherited from the developer's shell. */
function freshEnv(): NodeJS.ProcessEnv {
	return {}
}

test("exempts the daemon endpoint by host and port", () => {
	const env = freshEnv()
	assert.equal(ensureDaemonExemptFromProxy("http://127.0.0.1:4177", env), true)
	assert.equal(env.NO_PROXY, "127.0.0.1:4177", "the port is part of the entry, so other ports stay proxied")
	assert.equal(env.no_proxy, undefined, "does not shadow the variable undici reads first")
})

test("extends the user's list instead of replacing it", () => {
	const env = { NO_PROXY: "*.corp.example,example.com" }
	assert.equal(ensureDaemonExemptFromProxy("http://127.0.0.1:4177", env), true)
	assert.deepEqual(env.NO_PROXY?.split(","), ["*.corp.example", "example.com", "127.0.0.1:4177"])
})

test("is idempotent and leaves an already-exempt list alone", () => {
	const env = freshEnv()
	ensureDaemonExemptFromProxy("http://127.0.0.1:4177", env)
	const once = env.NO_PROXY
	assert.equal(ensureDaemonExemptFromProxy("http://127.0.0.1:4177", env), false)
	assert.equal(env.NO_PROXY, once)
})

test("brackets an IPv6 entry, and treats an equivalent one as the same", () => {
	const env = freshEnv()
	assert.equal(ensureDaemonExemptFromProxy("http://[::1]:4177", env), true)
	assert.equal(env.NO_PROXY, "[::1]:4177")
	assert.equal(ensureDaemonExemptFromProxy("http://[::1]:4177", env), false, "no duplicate")
	env.NO_PROXY = "::1:4177"
	assert.equal(ensureDaemonExemptFromProxy("http://[::1]:4177", env), false, "unbracketed form already covers it")
})

test("exempts loopback in its other forms, with the configured port", () => {
	const env = freshEnv()
	ensureDaemonExemptFromProxy("http://127.0.0.2:5000", env)
	assert.equal(env.NO_PROXY, "127.0.0.2:5000")
	const env2 = freshEnv()
	ensureDaemonExemptFromProxy("http://pi-mailbridge.localhost:4177", env2)
	assert.equal(env2.NO_PROXY, "pi-mailbridge.localhost:4177")
})

test("never exempts a remote daemon host, which is meant to use the proxy", () => {
	const env = freshEnv()
	assert.equal(ensureDaemonExemptFromProxy("http://daemon.example.com:4177", env), false)
	assert.equal(ensureDaemonExemptFromProxy("http://10.1.2.3:4177", env), false)
	assert.equal(env.NO_PROXY, undefined)
})

test("writes to no_proxy when that is the variable in use", () => {
	// undici reads `process.env.no_proxy ?? process.env.NO_PROXY`: the lowercase name wins, so
	// adding to NO_PROXY here would be invisible to it.
	const env: NodeJS.ProcessEnv = { no_proxy: "example.com" }
	assert.equal(ensureDaemonExemptFromProxy("http://127.0.0.1:4177", env), true)
	assert.equal(env.no_proxy, "example.com,127.0.0.1:4177")
	assert.equal(env.NO_PROXY, undefined)
})

test("an unparseable base URL changes nothing", () => {
	const env = freshEnv()
	assert.equal(ensureDaemonExemptFromProxy("not a url", env), false)
	assert.equal(env.NO_PROXY, undefined)
})

test("recognises every form of loopback, and nothing else", () => {
	const loopback = ["localhost", "LOCALHOST.", "[::1]", "::1", "127.0.0.1", "127.0.0.2", "127.255.255.254", "pi.localhost"]
	const remote = ["example.com", "10.1.2.3", "192.168.0.1", "[2001:db8::1]", "127.0.0.256", "127.0.0", "loopback", ""]
	for (const host of loopback) assert.equal(isLoopbackHost(host), true, `${host} is loopback`)
	for (const host of remote) assert.equal(isLoopbackHost(host), false, `${host} is not loopback`)
})

test("noProxyEntryFor abbreviates nothing", () => {
	assert.equal(noProxyEntryFor("127.0.0.1", 4177), "127.0.0.1:4177")
	assert.equal(noProxyEntryFor("[::1]", 4177), "[::1]:4177")
	assert.equal(noProxyEntryFor("LocalHost.", 80), "localhost:80")
})

/** A forwarding proxy: records the CONNECT targets, then really dials them. */
async function startProxy(): Promise<{ port: number; seen: string[]; close: () => void }> {
	const seen: string[] = []
	const proxy = createServer((_req, res) => res.writeHead(405).end())
	proxy.on("connect", (req, socket) => {
		seen.push(req.url ?? "")
		const [host, port] = (req.url ?? "").split(":")
		const upstream = net.connect(Number(port), host === "localhost" ? "127.0.0.1" : host, () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
			upstream.pipe(socket)
			socket.pipe(upstream)
		})
		upstream.on("error", () => socket.destroy())
		socket.on("error", () => upstream.destroy())
	})
	const port = await new Promise<number>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as { port: number }).port)))
	return { port, seen, close: () => proxy.close() }
}

test("our daemon goes direct while another local port still uses the proxy", async () => {
	// The whole point of port-scoping: the exemption is our endpoint, not loopback at large.
	const undici = await import("undici")
	const { probeHealthDetail, createDaemonClient } = await import("../src/daemon/spawn.ts")
	const proxy = await startProxy()

	const json = (_req: unknown, res: { writeHead: (n: number, h?: Record<string, string>) => void; end: (b: string) => void }): void => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ ok: true, apiVersion: 1 }))
	}
	const daemon = createServer((req, res) => {
		if (req.url === "/mode") {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ mode: "on" }))
			return
		}
		json(req, res)
	})
	const otherService = createServer((_req, res) => res.writeHead(200).end("other"))
	const daemonPort = await new Promise<number>((resolve) => daemon.listen(0, "127.0.0.1", () => resolve((daemon.address() as { port: number }).port)))
	const otherPort = await new Promise<number>((resolve) => otherService.listen(0, "127.0.0.1", () => resolve((otherService.address() as { port: number }).port)))

	const savedEnv = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
	const savedDispatcher = undici.getGlobalDispatcher()
	const savedFetch = globalThis.fetch
	try {
		process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
		delete process.env.NO_PROXY
		delete process.env.no_proxy
		undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ proxyTunnel: true }))
		undici.install?.()

		// Both entry points, each from a clean slate, so neither can lean on the other.
		const client = createDaemonClient({ baseUrl: `http://127.0.0.1:${daemonPort}`, token: "t" })
		assert.equal((await client.mode()).ok, true, "the typed client exempts its own endpoint")

		delete process.env.NO_PROXY
		assert.deepEqual(await probeHealthDetail({ baseUrl: `http://127.0.0.1:${daemonPort}` }), { ok: true, apiVersion: 1 }, "so does the probe")
		assert.deepEqual(proxy.seen, [], "the daemon went direct")

		// Another service on another loopback port is not our business: it keeps the proxy.
		assert.equal(await (await fetch(`http://127.0.0.1:${otherPort}/`)).text(), "other")
		assert.deepEqual(proxy.seen, [`127.0.0.1:${otherPort}`], "only our endpoint was exempted")
	} finally {
		undici.setGlobalDispatcher(savedDispatcher)
		globalThis.fetch = savedFetch
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		daemon.close()
		otherService.close()
		proxy.close()
	}
})

test("a real proxy still carries internet traffic after the exemption", async () => {
	const undici = await import("undici")
	const proxy = await startProxy()
	// A host that resolves nowhere: the request must fail, but the proxy must have seen it.
	const savedEnv = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
	const savedDispatcher = undici.getGlobalDispatcher()
	const savedFetch = globalThis.fetch
	try {
		process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
		delete process.env.NO_PROXY
		undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ proxyTunnel: true }))
		undici.install?.()

		assert.equal(ensureDaemonExemptFromProxy("http://127.0.0.1:4177"), true)
		await assert.rejects(fetch("http://example.invalid/", { signal: AbortSignal.timeout(2_000) }))
		assert.deepEqual(proxy.seen, ["example.invalid:80"], "the proxy still carries non-loopback traffic")
	} finally {
		undici.setGlobalDispatcher(savedDispatcher)
		globalThis.fetch = savedFetch
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		proxy.close()
	}
})
