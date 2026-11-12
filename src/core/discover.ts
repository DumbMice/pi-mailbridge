// Provider discovery + config synthesis.
//
// The one thing a human cannot avoid is creating the mailbox. Everything after
// that — server names, ports, TLS mode, which auth the provider requires — is
// public data, so we fetch it instead of asking.
//
// Source: Thunderbird's autoconfig service (ISPDB), the same database Mozilla
// ships in Thunderbird. It publishes, for a domain:
//
//   <incomingServer type="imap"> <hostname> <port> <socketType> <authentication>
//   <outgoingServer type="smtp"> <hostname> <port> <socketType> <authentication>
//
// Verified for gmail.com and outlook.com; 404 means "not in the database", not
// "no such provider", so we report it as unknown rather than guessing.

import type { ResolvedConfig } from "./config.ts"

export type AuthMode = "LOGIN" | "XOAUTH2"

export interface Endpoint {
	host: string
	port: number
	/** TLS from the first packet (implicit). False means STARTTLS. */
	secure: boolean
}

export interface Discovered {
	imap: Endpoint
	smtp: Endpoint
	authType: AuthMode
	/** Which OAuth preset fits, when we can tell. */
	provider: "microsoft" | "google" | "other"
	folder?: string
}

/** Parse a Thunderbird `clientConfig` document. Pure, so it is testable. */
export function parseAutoconfig(xml: string): Discovered | undefined {
	const block = (tag: "incomingServer" | "outgoingServer"): string | undefined => {
		// type="imap" / type="smtp" specifically; pop3 must not win.
		const re = new RegExp(`<${tag}\\b[^>]*type="(?:imap|smtp)"[^>]*>([\\s\\S]*?)</${tag}>`, "i")
		return re.exec(xml)?.[1]
	}
	const one = (chunk: string, tag: string): string | undefined =>
		new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, "i").exec(chunk)?.[1]
	const all = (chunk: string, tag: string): string[] =>
		[...chunk.matchAll(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`, "gi"))].map((m) => m[1]!.trim())

	const incoming = block("incomingServer")
	const outgoing = block("outgoingServer")
	if (!incoming || !outgoing) return undefined

	const endpoint = (chunk: string): Endpoint | undefined => {
		const host = one(chunk, "hostname")
		const port = Number(one(chunk, "port"))
		if (!host || !Number.isInteger(port) || port <= 0) return undefined
		const socket = (one(chunk, "socketType") ?? "").toUpperCase()
		return { host, port, secure: socket !== "STARTTLS" }
	}

	const imap = endpoint(incoming)
	const smtp = endpoint(outgoing)
	if (!imap || !smtp) return undefined

	// A provider may advertise several; OAuth2 wins when present because password
	// auth is what every major provider is retiring.
	const auths = [...all(incoming, "authentication"), ...all(outgoing, "authentication")].map((a) => a.toLowerCase())
	const authType: AuthMode = auths.some((a) => a.includes("oauth2")) ? "XOAUTH2" : "LOGIN"

	const host = imap.host.toLowerCase()
	const provider: Discovered["provider"] = /(?:office365|outlook|hotmail|live|msn)\./.test(host)
		? "microsoft"
		: /gmail|googlemail/.test(host)
			? "google"
			: "other"

	return { imap, smtp, authType, provider }
}

export interface DiscoverOptions {
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch
	/** ISPDB base; overridable so tests never touch the network. */
	baseUrl?: string
	timeoutMs?: number
}

const ISPDB = "https://autoconfig.thunderbird.net/v1.1"

/** Look a domain up in ISPDB. Returns undefined when the domain is unknown. */
export async function discoverDomain(domain: string, options: DiscoverOptions = {}): Promise<Discovered | undefined> {
	const doFetch = options.fetchImpl ?? fetch
	const base = options.baseUrl ?? ISPDB
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
	try {
		const response = await doFetch(`${base}/${encodeURIComponent(domain)}`, { signal: controller.signal })
		if (!response.ok) return undefined
		return parseAutoconfig(await response.text())
	} catch {
		return undefined
	} finally {
		clearTimeout(timer)
	}
}

export function domainOf(address: string): string | undefined {
	const at = address.lastIndexOf("@")
	if (at <= 0 || at === address.length - 1) return undefined
	return address.slice(at + 1).trim().toLowerCase()
}

/** Scope presets, kept here so setup and docs cannot drift apart. */
export const OAUTH_SCOPE = {
	microsoft:
		"offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
	google: "https://mail.google.com/ offline_access",
} as const

export const OAUTH_ISSUER = {
	microsoft: "https://login.microsoftonline.com/consumers/v2.0",
	google: "https://accounts.google.com",
} as const

/**
 * Turn discovery into a config the daemon can actually run.
 *
 * `address` is pi's mailbox; `to` is the human. When they differ, the loop guard
 * stays strict; when they are the same, single-mailbox mode is enabled
 * automatically so replies are not rejected as self-loops.
 */
export function buildSetupConfig(
	address: string,
	to: string,
	discovered: Discovered,
): Pick<ResolvedConfig, "mail" | "security" | "oauth"> & { oauth?: { issuer: string; clientId: string; scope: string } } {
	const sameAddress = address.trim().toLowerCase() === to.trim().toLowerCase()
	const oauthPreset =
		discovered.provider === "microsoft" || discovered.provider === "google" ? discovered.provider : undefined

	return {
		mail: {
			imap: {
				host: discovered.imap.host,
				port: discovered.imap.port,
				secure: discovered.imap.secure,
				user: address,
				password: "",
				folder: discovered.folder ?? "INBOX",
				authType: discovered.authType,
			},
			smtp: {
				host: discovered.smtp.host,
				port: discovered.smtp.port,
				secure: discovered.smtp.secure,
				user: address,
				password: "",
				authType: discovered.authType,
			},
			to,
		},
		security: {
			allowFrom: [to],
			requireDmarcPass: true,
			allowHeaderThreading: true,
			allowSelfReplies: sameAddress,
			tokenTtlHours: 30 * 24,
		},
		...(oauthPreset
			? {
					oauth: {
						issuer: OAUTH_ISSUER[oauthPreset],
						clientId: "<your app client id>",
						scope: OAUTH_SCOPE[oauthPreset],
					},
				}
			: {}),
	}
}
