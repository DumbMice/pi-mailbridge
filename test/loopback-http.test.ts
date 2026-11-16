// The daemon transport: `node:http`, package-scoped, proxy-indifferent.
//
// context: with `HTTP_PROXY` set and loopback missing from `NO_PROXY`, pi's global
// `EnvHttpProxyAgent` tunnels `http://127.0.0.1:4177` to the proxy and it times out, so the daemon
// reads as unreachable while it answers in sub-millisecond time. The alternative — appending to
// `NO_PROXY` — works but mutates the environment of the whole pi process and every child it spawns.
// This transport keeps the fix inside the package, so the tests below pin both properties: it is
// not affected by proxy configuration, and it touches no process state.

import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { loopbackFetch } from "../src/daemon/loopback-http.ts"

type Handler = (req: IncomingMessage, res: ServerResponse) => void

async function serve(handler: Handler): Promise<{ url: string; close: () => void }> {
	const server = createServer(handler)
	const port = await new Promise<number>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
	)
	return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}

test("maps status, headers and body to a Response", async () => {
	const s = await serve((_req, res) => {
		res.writeHead(201, { "content-type": "application/json", "x-daemon": "yes" })
		res.end(JSON.stringify({ ok: true }))
	})
	try {
		const response = await loopbackFetch(`${s.url}/health`)
		assert.equal(response.status, 201)
		assert.equal(response.headers.get("x-daemon"), "yes")
		assert.deepEqual(await response.json(), { ok: true })
	} finally {
		s.close()
	}
})

test("sends method, path, query and headers", async () => {
	let seen: { method?: string; url?: string; auth?: string; body?: string } = {}
	const s = await serve((req, res) => {
		let body = ""
		req.on("data", (c: Buffer) => (body += c.toString()))
		req.on("end", () => {
			seen = { method: req.method, url: req.url, auth: req.headers.authorization, body }
			res.writeHead(200).end("ok")
		})
	})
	try {
		await loopbackFetch(`${s.url}/claim?dry=1`, {
			method: "POST",
			headers: { authorization: "Bearer t1" },
			body: JSON.stringify({ uid: 7 }),
		})
		assert.equal(seen.method, "POST")
		assert.equal(seen.url, "/claim?dry=1")
		assert.equal(seen.auth, "Bearer t1")
		assert.equal(seen.body, '{"uid":7}')
	} finally {
		s.close()
	}
})

test("accepts headers as an array or a Headers instance", async () => {
	const seen: Array<Record<string, unknown>> = []
	const s = await serve((req, res) => {
		seen.push({ a: req.headers["x-a"] ?? null, b: req.headers["x-b"] ?? null })
		res.writeHead(200).end("ok")
	})
	try {
		await loopbackFetch(s.url, { headers: [["x-a", "1"]] as unknown as Record<string, string> })
		await loopbackFetch(s.url, { headers: new Headers({ "x-b": "2" }) })
		assert.deepEqual(seen, [{ a: "1", b: null }, { a: null, b: "2" }])
	} finally {
		s.close()
	}
})

test("opens a fresh connection per request rather than pooling", async () => {
	// Node's global agent has `keepAlive: true`; without `agent: false` a socket the daemon closed
	// on restart would fail the next poll tick with ECONNRESET.
	let connections = 0
	const server = createServer((_req, res) => res.writeHead(200).end("ok"))
	server.on("connection", () => {
		connections += 1
	})
	const port = await new Promise<number>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
	)
	try {
		await loopbackFetch(`http://127.0.0.1:${port}`)
		await loopbackFetch(`http://127.0.0.1:${port}`)
		assert.equal(connections, 2, "two requests, two sockets")
	} finally {
		server.close()
	}
})

test("a bodyless status resolves instead of throwing", async () => {
	// `new Response(bytes, { status: 204 })` throws, which would report a valid empty reply as a
	// failed request. The daemon answers 200 everywhere today; this is for the endpoint that is not.
	for (const status of [204, 205, 304]) {
		const s = await serve((_req, res) => {
			res.writeHead(status)
			res.end()
		})
		try {
			const response = await loopbackFetch(s.url)
			assert.equal(response.status, status)
			assert.equal(await response.text(), "")
		} finally {
			s.close()
		}
	}
})

test("a status the Response constructor refuses rejects instead of hanging", async () => {
	// Node's client accepts a 3-digit status the WHATWG constructor rejects (999). The throw happens
	// inside the settle callback, so without a guard it escapes as an uncaught exception and the
	// promise never settles - and the abort listener is already gone, so even abort cannot free it.
	const s = await serve((_req, res) => {
		res.writeHead(999)
		res.end()
	})
	try {
		await assert.rejects(() => loopbackFetch(s.url), /status|invalid/i)
	} finally {
		s.close()
	}
})

test("rejects on connection failure instead of hanging", async () => {
	// Nothing is listening: this is the daemon-down path the probe relies on.
	await assert.rejects(() => loopbackFetch("http://127.0.0.1:1/health"))
})

test("honours an AbortSignal", async () => {
	const s = await serve(() => {
		/* never answers */
	})
	try {
		const controller = new AbortController()
		setTimeout(() => controller.abort(), 20)
		await assert.rejects(
			() => loopbackFetch(s.url, { signal: controller.signal }),
			(error: Error) => error.name === "AbortError",
		)
	} finally {
		s.close()
	}
})

test("an already-aborted signal rejects without opening a socket", async () => {
	let connections = 0
	const server = createServer((_req, res) => res.writeHead(200).end("ok"))
	server.on("connection", () => {
		connections += 1
	})
	const port = await new Promise<number>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
	)
	const controller = new AbortController()
	controller.abort()
	try {
		await assert.rejects(
			() => loopbackFetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal }),
			(error: Error) => error.name === "AbortError",
		)
		assert.equal(connections, 0, "no socket was opened")
	} finally {
		server.close()
	}
})

test("carries a body larger than one chunk", async () => {
	// A 1 MiB payload through a stream: catches a per-chunk `toString()` regression that a short
	// body would hide.
	const payload = "x".repeat(1_000_000)
	const s = await serve((_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end(payload))
	try {
		assert.equal((await (await loopbackFetch(s.url)).text()).length, payload.length)
	} finally {
		s.close()
	}
})

test("does not leave an abort listener on the caller's signal", async () => {
	// Every call registers a listener on a signal the caller may reuse; leaking it would keep the
	// transport alive inside the caller's controller.
	const { getEventListeners } = await import("node:events") as unknown as { getEventListeners: (t: unknown, e: string) => unknown[] }
	const refused = new AbortController()
	await assert.rejects(() => loopbackFetch("http://127.0.0.1:1/health", { signal: refused.signal }), /ECONNREFUSED|connect/)
	assert.equal(getEventListeners(refused.signal, "abort").length, 0, "no listener left on the refused call")
	const controller = new AbortController()

	// and on the refusal path that does not use `finish`: a non-string body.
	const s = await serve((_req, res) => res.writeHead(200).end("ok"))
	try {
		await assert.rejects(
			() => loopbackFetch(s.url, { body: new Uint8Array([1]) as unknown as string, signal: controller.signal }),
			/string bodies only/,
		)
		assert.equal(getEventListeners(controller.signal, "abort").length, 0, "listener removed on the refusal path")
	} finally {
		s.close()
	}
})

test("refuses a Request input instead of ignoring its method and body", async () => {
	// The signature is `typeof fetch`, so a Request type-checks; reading only `.url` would send a
	// bodiless GET that silently differs from what the caller asked for.
	const s = await serve((_req, res) => res.writeHead(200).end("ok"))
	try {
		await assert.rejects(
			() => loopbackFetch(new Request(`${s.url}/claim`, { method: "POST", body: "x" })),
			/not a Request/,
		)
	} finally {
		s.close()
	}
})

test("a body cut short rejects rather than leaving the promise unsettled", async () => {
	// A truncated reply must not wedge the caller's drain: it has to surface as an error.
	const s = await serve((_req, res) => {
		res.writeHead(200, { "content-length": "100" })
		res.write('{"partial":')
		setTimeout(() => res.socket?.destroy(), 10)
	})
	try {
		await assert.rejects(() => loopbackFetch(s.url))
	} finally {
		s.close()
	}
})

test("does not follow redirects", async () => {
	// The daemon never redirects; a 3xx must surface as a status, not a request to another host.
	const elsewhere = await serve((_req, res) => res.writeHead(200).end("wrong host"))
	const s = await serve((_req, res) => res.writeHead(302, { location: elsewhere.url }).end())
	try {
		const response = await loopbackFetch(s.url)
		assert.equal(response.status, 302)
		assert.equal(response.ok, false, "callers treat this as a failed probe")
	} finally {
		s.close()
		elsewhere.close()
	}
})

test("rejects a non-http URL instead of guessing", async () => {
	await assert.rejects(() => loopbackFetch("https://127.0.0.1:4177/health"), /loopback HTTP/)
})

test("resolves an IPv6 literal host", async () => {
	const server = createServer((_req, res) => res.writeHead(200).end("v6"))
	const bound = await new Promise<boolean>((resolve) => {
		server.once("error", () => resolve(false))
		server.listen(0, "::1", () => resolve(true))
	})
	if (!bound) return // a host without IPv6 loopback
	const port = (server.address() as { port: number }).port
	try {
		const response = await loopbackFetch(`http://[::1]:${port}/health`)
		assert.equal(await response.text(), "v6")
	} finally {
		server.close()
	}
})

test("ignores a proxy environment and a poisoned global fetch", async () => {
	// The two ways the bug showed up: HTTP_PROXY set, and (in a live session) a global fetch that
	// refuses loopback. Neither may reach this transport.
	const s = await serve((_req, res) => res.writeHead(200).end("direct"))
	const savedEnv = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY }
	const savedFetch = globalThis.fetch
	try {
		process.env.HTTP_PROXY = "socks5://127.0.0.1:6222"
		process.env.HTTPS_PROXY = "socks5://127.0.0.1:6222"
		delete process.env.NO_PROXY
		globalThis.fetch = (() => Promise.reject(new Error("proxy tunnel refused"))) as typeof fetch

		assert.equal(await (await loopbackFetch(`${s.url}/health`)).text(), "direct")
	} finally {
		globalThis.fetch = savedFetch
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		s.close()
	}
})

test("leaves the environment untouched — the fix is package-scoped", async () => {
	// The rejected alternative appended to NO_PROXY, which every other extension and every child
	// process inherits. This transport must not write process state at all.
	const s = await serve((_req, res) => res.writeHead(200).end("ok"))
	const before = { ...process.env }
	try {
		assert.equal(await (await loopbackFetch(s.url)).text(), "ok")
		assert.deepEqual({ ...process.env }, before, "no variable was added, changed or removed")
	} finally {
		s.close()
	}
})

test("the client and probe use this transport, not the ambient fetch", async () => {
	// The transport being proxy-proof is worth nothing if the call sites keep using `fetch`. pi's
	// global dispatcher made exactly that mistake invisible: every request looked like a network
	// error, so a poisoned `fetch` is a faithful stand-in for the reported bug.
	const { probeHealthDetail, createDaemonClient } = await import("../src/daemon/spawn.ts")
	const s = await serve((req, res) => {
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify(req.url === "/mode" ? { mode: "on" } : { ok: true, apiVersion: 1 }))
	})
	const savedFetch = globalThis.fetch
	const savedEnv = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY }
	try {
		delete process.env.NO_PROXY
		globalThis.fetch = (() => Promise.reject(new Error("proxy tunnel refused"))) as typeof fetch

		assert.deepEqual(await probeHealthDetail({ baseUrl: s.url }), { ok: true, apiVersion: 1 })
		const client = createDaemonClient({ baseUrl: s.url, token: "t" })
		assert.equal((await client.mode()).ok, true)
		assert.equal(process.env.NO_PROXY, undefined, "and nothing was written to the environment")
	} finally {
		globalThis.fetch = savedFetch
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		s.close()
	}
})

test("a reply that streams forever is cut off, not buffered without bound", async () => {
	// A squatter on the port that answers 200 and never ends would otherwise grow the pi process
	// until the caller's abort fired - the body cap is the only bound on bytes.
	const s = await serve((_req, res) => {
		res.writeHead(200)
		const chunk = "x".repeat(64 * 1024)
		const pump = (): void => {
			if (res.write(chunk)) setImmediate(pump)
			else res.once("drain", pump)
		}
		pump()
	})
	try {
		await assert.rejects(() => loopbackFetch(s.url), /larger than/)
	} finally {
		s.close()
	}
})

