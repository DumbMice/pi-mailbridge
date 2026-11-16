// Our daemon must not go through a proxy — and nothing else should change.
//
// pi installs `undici`'s `EnvHttpProxyAgent` as the global dispatcher, so with `HTTP_PROXY` set and
// loopback absent from `NO_PROXY`, every `fetch` — `http://127.0.0.1:4177` included — is tunnelled
// through the proxy and times out. A socks proxy asked to reach 127.0.0.1 simply never answers, so
// the daemon looks unreachable while it is answering in sub-millisecond time. A live session was
// unusable because of it.
//
// The fix is the standard mechanism: `NO_PROXY`. `NO_PROXY` entries take an optional port, so the
// exemption is the daemon's own endpoint (`127.0.0.1:4177`), not loopback at large: another local
// service on another port keeps going through the proxy exactly as before, and a remote
// `daemon.host` is never exempted at all.
//
// undici re-reads `no_proxy` on every dispatch (`#noProxyChanged` → re-parse), so this takes effect
// on the dispatcher pi already built, and the user's existing list is extended, never replaced.

/** `[::1]` → `::1`, `LOCALHOST.` → `localhost`: the form undici compares against. */
function normalizeHost(host: string): string {
	return host
		.trim()
		.replace(/^\[|]$/g, "")
		.replace(/\.+$/, "")
		.toLowerCase()
}

/**
 * Loopback in any of its forms: `localhost` and its subdomains, `::1`, and the whole of
 * 127.0.0.0/8 - `daemon.host` may be `127.0.0.2` to dodge a port clash.
 */
export function isLoopbackHost(host: string): boolean {
	const name = normalizeHost(host)
	if (name === "localhost" || name.endsWith(".localhost")) return true
	if (name === "::1" || name === "0:0:0:0:0:0:0:1") return true
	const quad = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
	return quad !== null && quad.slice(1).every((octet) => Number(octet) <= 255)
}

/** The variable undici reads first: lowercase `no_proxy` wins over `NO_PROXY`. */
function proxyVariableName(env: NodeJS.ProcessEnv): "no_proxy" | "NO_PROXY" {
	if (env.no_proxy !== undefined) return "no_proxy"
	return "NO_PROXY"
}

/** Split a `NO_PROXY` value the way undici does. */
function entries(value: string): string[] {
	return value
		.split(/[,\s]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")
}

/** `[::1]:4177` and `::1:4177` are the same entry; comparison ignores case and trailing dots. */
function entryKey(entry: string): string {
	return entry.toLowerCase().replace(/^\[|]/g, "").replace(/\.+$/, "")
}

/** `host:port`, with brackets when the host is IPv6 (`[::1]:4177` is what undici parses). */
export function noProxyEntryFor(host: string, port: number): string {
	const name = normalizeHost(host)
	return name.includes(":") ? `[${name}]:${port}` : `${name}:${port}`
}

/**
 * Add the daemon's own endpoint to `NO_PROXY`, and nothing else. Idempotent; returns `true` when
 * the variable changed. A non-loopback daemon is left proxied on purpose: that traffic is meant to
 * go through the proxy like any other internet request.
 */
export function ensureDaemonExemptFromProxy(baseUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
	let url: URL
	try {
		url = new URL(baseUrl)
	} catch {
		return false // an unparseable base URL is reported by the request itself
	}
	if (!isLoopbackHost(url.hostname)) return false
	const entry = noProxyEntryFor(url.hostname, url.port === "" ? 80 : Number(url.port))

	const name = proxyVariableName(env)
	const current = env[name] ?? ""
	if (entries(current).some((existing) => entryKey(existing) === entryKey(entry))) return false
	const existing = current.trim() === "" ? [] : [current.trim()]
	env[name] = [...existing, entry].join(",")
	return true
}
