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
//   * no content decompression — the daemon sends plain JSON with no `content-encoding`
//     (see `daemon/api.ts`); a compressed response would be returned as raw bytes, so if the daemon
//     ever starts compressing, add `node:zlib` here rather than switching back to `fetch`;
//   * no connection pooling — one socket per request, closed by the server's `connection: close`
//     or by us; at this request rate pooling buys nothing.
//
// It does honour `init.signal` (the callers' own timeouts), and it rejects if the response stream
// breaks mid-body — otherwise a truncated reply would leave the promise unsettled forever, and the
// caller's drain with it.

import { request as httpRequest, type IncomingMessage } from "node:http"

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

		let settled = false
		const finish = (fn: () => void): void => {
			if (settled) return
			settled = true
			cleanup()
			fn()
		}

		const request = httpRequest(
			{
				hostname: unbracket(url.hostname),
				port: url.port === "" ? 80 : Number(url.port),
				path: `${url.pathname}${url.search}`,
				method: init?.method ?? "GET",
				headers: headerRecord(init?.headers as HeaderInit),
			},
			(response: IncomingMessage) => {
				const chunks: Buffer[] = []
				response.on("data", (chunk: Buffer) => chunks.push(chunk))
				response.on("end", () =>
					finish(() =>
						resolve(
							new Response(Buffer.concat(chunks), {
								status: response.statusCode ?? 502,
								// `headers`, not a spread: spreading into ResponseInit drops them silently.
								headers: response.headers as unknown as Record<string, string>,
							}),
						),
					),
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
		if (typeof body === "string") request.write(body)
		else if (body !== undefined && body !== null) {
			reject(new TypeError("loopbackFetch accepts string bodies only"))
			request.destroy()
			return
		}
		request.end()
	})
