// Loopback must not go through a proxy.
//
// pi installs `undici`'s `EnvHttpProxyAgent` as the global dispatcher, so every `fetch` in the
// agent process — including `http://127.0.0.1:4177` — is routed through `HTTP_PROXY` when that
// variable is set and `NO_PROXY` does not exclude loopback. A socks proxy asked to reach
// 127.0.0.1 simply times out, so the daemon looks unreachable while it is answering in
// sub-millisecond time. (`node:http` does not proxy, but a second HTTP client just to dodge a
// configuration problem is not the fix.)
//
// The fix is the standard one: loopback belongs in `NO_PROXY`. undici re-reads `NO_PROXY` on
// every dispatch (`#noProxyChanged` → re-parse), so adding the entries here takes effect for the
// dispatcher pi already built, and for any dispatcher built later. It also fixes every other
// loopback call in the process, which is why it is done for the whole process rather than for
// our requests alone.
//
// The user's list is extended, never replaced: an `*` wildcard, a corporate gateway list, or a
// deliberate `example.com` exclusion all keep working, and a list that already covers loopback is
// left byte-for-byte alone.

const LOOPBACK = ["localhost", "127.0.0.1", "::1"] as const

/** `[::1]` → `::1`, `LOCALHOST.` → `localhost`: the form undici compares against. */
function normalizeHost(host: string): string {
	return host
		.trim()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/, "")
		.toLowerCase()
}

/**
 * Loopback in any of its forms: `localhost` and its subdomains, `::1`, and the whole of
 * 127.0.0.0/8 - `daemon.host` may be `127.0.0.2` to dodge a port clash, and that must not be
 * proxied either.
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

/** Split a `NO_PROXY` value the way undici does, dropping empties and brackets. */
function entries(value: string): string[] {
	return value
		.split(/[,\s]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")
		.map((entry) => entry.replace(/^\[|\]$/g, "").toLowerCase())
}

/**
 * Ensure `NO_PROXY` excludes loopback, so a global proxy dispatcher cannot swallow our own
 * daemon calls. Idempotent and safe to call repeatedly. Returns `true` when the variable was
 * changed.
 *
 * `*:*` is a host:port pair for a specific port; we only add bare hosts, which match any port.
 */
export function ensureLoopbackExemptFromProxy(
	env: NodeJS.ProcessEnv = process.env,
	/** The host the client is actually configured for; ignored unless it is loopback. */
	extraHosts: readonly string[] = [],
): boolean {
	const name = proxyVariableName(env)
	const current = env[name] ?? ""
	const present = new Set(entries(current))
	const wanted = [...LOOPBACK, ...extraHosts.filter(isLoopbackHost).map(normalizeHost)]
	const missing = wanted.filter((host) => !present.has(host))
	if (missing.length === 0) return false
	const existing = current.trim() === "" ? [] : [current.trim()]
	env[name] = [...existing, ...missing].join(",")
	return true
}
