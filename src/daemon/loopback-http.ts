// The transport for our own daemon: `node:http`, deliberately not `fetch`.
//
// pi installs `undici`'s `EnvHttpProxyAgent` as the global dispatcher, so with `HTTP_PROXY` set and
// loopback absent from `NO_PROXY`, every `fetch` — `http://127.0.0.1:4177` included — is tunnelled
// through the proxy and times out. A socks proxy asked to reach 127.0.0.1 never answers, so the
// daemon looks unreachable while it responds in sub-millisecond time. A live session was unusable
// because of it. That was measured, not theorised: panel "daemon: unreachable", `/health` 200 in
// 0.5 ms from a shell.
//
// Why a transport instead of `NO_PROXY`:
//
//   * `NO_PROXY` is process-global. Appending to it works, and that was the first fix, but it
//     mutates the environment of the whole pi process — other extensions, and every child process
//     spawned later (the bash tool included) inherit the entry. A package should not edit process
//     state to serve one endpoint.
//   * `fetch(url, { dispatcher })` would scope the override to one request, which is the documented
//     undici escape hatch, but it needs `undici` as a *runtime* dependency and the agent must come
//     from the same undici implementation as the global `fetch`. pi's own source warns that Node's
//     bundled fetch and npm undici diverge, so that call can throw exactly when it matters.
//   * `node:http` has no proxy semantics at all: the socket is opened to the host and port given.
//     Loopback-only, one endpoint, a handful of requests a minute — the cost of owning the client
//     is small and fully covered by tests.
//
// What this transport deliberately does not do, because the daemon never needs it:
//
//   * no redirects — a 3xx surfaces as `ok: false` rather than being followed to another host;
//   * no content decompression — the JSON endpoints send no `content-encoding`; a compressed reply
//     would be returned as raw bytes, so if the daemon ever starts compressing, add `node:zlib` here
//     rather than switching back to `fetch`;
//   * no streaming — the body is buffered until `end`. `/events` is SSE and is deliberately not
//     consumed by this client (sessions poll `/pending`); wiring a push client through it would
//     hang until the caller's abort fires;
//   * no connection pooling — `agent: false` asks for a one-shot agent per request. Node's global
//     agent has `keepAlive: true`, so omitting the option would silently pool sockets to the daemon;
//     a socket the daemon closed on `/mailbridge restart` would then fail the next request with
//     ECONNRESET inside a poll tick. At this request rate the extra TCP handshake on loopback costs
//     nothing.
//
// It does honour `init.signal` (the callers' own timeouts), and it rejects if the response stream
// breaks mid-body — otherwise a truncated reply would leave the promise unsettled forever, and the
// caller's drain with it. Multi-valued response headers are joined by `Headers` (`set-cookie` is the
// usual casualty); the daemon emits plain JSON only, so this is a documented limit, not a gap.

import { request as httpRequest, type IncomingMessage } from "node:http"

/**
 * Ceiling on a buffered response body. Every real reply is small — `/pending` is bounded by the
 * store's own 8 MB cap — while a squatter on the port that answers `200` and then streams would
 * otherwise grow the pi process until the caller's abort fires.
 */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** `fetch` accepts three header shapes; `node:http` wants the record one. */
type HeaderInit = Record<string, string> | Headers | ReadonlyArray<readonly [string, string]> | undefined

function headerRecord(headers: HeaderInit): Record<string, string> {
	if (headers === undefined) return {}
	if (Array.isArray(headers)) return Object.fromEntries(headers as string[][])
	// A `Headers` instance is not a plain object: it has no enumerable own keys.
	if (typeof (headers as Headers).forEach === "function") {
		const record: Record<string, string> = {}
		;(headers as Headers).forEach((value, key) => {
			record[key] = value
		})
		return record
	}
	return { ...(headers as Record<string, string>) }
}

/** `[::1]` → `::1`: `new URL` keeps the brackets, `getaddrinfo` does not want them. */
function unbracket(hostname: string): string {
	return hostname.replace(/^\[|]$/g, "")
}

/** A `fetch`-shaped function that talks loopback HTTP directly, bypassing any proxy. */
export const loopbackFetch: typeof fetch = (input, init) =>
	new Promise((resolve, reject) => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		let url: URL
		try {
			url = new URL(raw)
		} catch {
			reject(new TypeError(`invalid URL: ${raw}`))
			return
		}
		if (url.protocol !== "http:") {
			reject(new TypeError(`the daemon is loopback HTTP, not ${url.protocol}`))
			return
		}
		if (typeof input !== "string" && !(input instanceof URL)) {
			// The signature is `typeof fetch`, so a `Request` type-checks. Reading only `.url` would
			// silently drop its method and body and send a different request than asked for.
			reject(new TypeError("loopbackFetch takes a URL string or URL, not a Request"))
			return
		}

		let settled = false
		const finish = (fn: () => void): void => {
			if (settled) return
			settled = true
			cleanup()
			// `new Response(...)` throws on a status that forbids a body, among other things. A throw
			// here would escape an event listener as an uncaught exception and leave the promise
			// unsettled - un-abortable too, because the listener is already removed - which is the
			// hang `spawn.ts` documents. It has to surface as a rejection.
			try {
				fn()
			} catch (error) {
				reject(error)
			}
		}

		const request = httpRequest(
			{
				hostname: unbracket(url.hostname),
				port: url.port === "" ? 80 : Number(url.port),
				path: `${url.pathname}${url.search}`,
				method: init?.method ?? "GET",
				headers: headerRecord(init?.headers as HeaderInit),
				// One socket per request; see the header comment.
				agent: false,
			},
			(response: IncomingMessage) => {
				const chunks: Buffer[] = []
				let size = 0
				response.on("data", (chunk: Buffer) => {
					if (settled) return
					size += chunk.length
					if (size > MAX_RESPONSE_BYTES) {
						finish(() => reject(new TypeError(`response body larger than ${MAX_RESPONSE_BYTES} bytes`)))
						response.destroy()
						return
					}
					chunks.push(chunk)
				})
				response.on("end", () =>
					finish(() => {
						const status = response.statusCode ?? 502
						// 204/205/304 may not carry a body: `new Response(bytes, { status: 204 })` throws,
						// which would turn a valid empty reply into a rejected request.
						const bodyless = status === 204 || status === 205 || status === 304
						resolve(
							new Response(bodyless && chunks.length === 0 ? null : Buffer.concat(chunks), {
								status,
								// `headers`, not a spread: spreading into ResponseInit drops them silently.
								headers: response.headers as unknown as Record<string, string>,
							}),
						)
					}),
				)
				// A body cut short (content-length mismatch, server restart) ends the stream with an
				// error rather than "end"; without this the promise never settles.
				response.on("error", (error) => finish(() => reject(error)))
				response.on("aborted", () => finish(() => reject(new Error("response aborted"))))
			},
		)

		request.on("error", (error) => finish(() => reject(error)))

		const signal = init?.signal
		const onAbort = (): void => {
			request.destroy()
			finish(() => reject(new DOMException("aborted", "AbortError")))
		}
		function cleanup(): void {
			if (signal) signal.removeEventListener("abort", onAbort)
		}
		if (signal) {
			if (signal.aborted) {
				onAbort()
				return
			}
			signal.addEventListener("abort", onAbort, { once: true })
		}

		const body = init?.body
		if (typeof body === "string") {
			try {
				request.write(body)
			} catch (error) {
				finish(() => reject(error))
				return
			}
		} else if (body !== undefined && body !== null) {
			// Streams, buffers and FormData are not needed by any caller. Refuse rather than
			// serialise something the daemon would misread - and go through `finish`, so the abort
			// listener does not outlive the call.
			request.destroy()
			finish(() => reject(new TypeError("loopbackFetch accepts string bodies only")))
			return
		}
		try {
			request.end()
		} catch (error) {
			finish(() => reject(error))
		}
	})
