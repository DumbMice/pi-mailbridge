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
	/**
	 * Which OAuth preset fits, when we can tell.
	 * `microsoft-365` means a work/school tenant (authority: organizations),
	 * `microsoft` means consumer outlook.com/hotmail (authority: consumers).
	 */
	provider: "microsoft" | "microsoft-365" | "google" | "other"
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

/**
 * Provider-specific auth defaults.
 *
 * Google advertises OAuth2 in its published settings, but for a personal mailbox
 * an app password is strictly simpler: Google OAuth for mail scopes is *restricted*
 * (app verification plus an annual CASA assessment to publish), and a consent
 * screen left in "Testing" issues refresh tokens that expire after **7 days** —
 * fatal for a daemon that must run unattended.
 *
 * Microsoft has no equivalent: app passwords were retired on 2024-09-16, so XOAUTH2
 * is the only path there.
 */
function applyProviderDefaults(discovered: Discovered): Discovered {
	if (discovered.provider === "google") return { ...discovered, authType: "LOGIN" }
	return discovered
}

export interface DiscoverOptions {
	/** Injected for tests; defaults to global fetch. */
	fetchImpl?: typeof fetch
	/** ISPDB base; overridable so tests never touch the network. */
	baseUrl?: string
	timeoutMs?: number
}

const ISPDB = "https://autoconfig.thunderbird.net/v1.1"

/**
 * A work/school Microsoft 365 tenant mailbox. These have no ISPDB entry and an
 * arbitrary subdomain, so the suffix is the signal: `something.onmicrosoft.com`.
 * The SMTP host differs from the consumer one (`smtp.office365.com`, not
 * `smtp-mail.outlook.com`) and the authority is `organizations`.
 */
export const M365_PROVIDER: Discovered = {
	imap: { host: "outlook.office365.com", port: 993, secure: true },
	smtp: { host: "smtp.office365.com", port: 587, secure: false },
	authType: "XOAUTH2",
	provider: "microsoft-365",
}

/** Built-in fallback lookup, including the Microsoft 365 suffix rule. */
function knownProvider(domain: string): Discovered | undefined {
	const exact = KNOWN_PROVIDERS[domain.toLowerCase()]
	if (exact) return exact
	if (domain.toLowerCase().endsWith(".onmicrosoft.com")) return M365_PROVIDER
	return undefined
}

/**
 * Built-in fallback for the provider families this package is used with.
 *
 * ISPDB is authoritative and current, so it is always tried first; this map only
 * matters when it is unreachable or missing an entry. It also means the common
 * cases work with no network at all.
 */
export const KNOWN_PROVIDERS: Record<string, Omit<Discovered, "provider"> & { provider: Discovered["provider"] }> = {
	"hotmail.com": {
		imap: { host: "outlook.office365.com", port: 993, secure: true },
		smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
		authType: "XOAUTH2",
		provider: "microsoft",
	},
	"outlook.com": {
		imap: { host: "outlook.office365.com", port: 993, secure: true },
		smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
		authType: "XOAUTH2",
		provider: "microsoft",
	},
	"live.com": {
		imap: { host: "outlook.office365.com", port: 993, secure: true },
		smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
		authType: "XOAUTH2",
		provider: "microsoft",
	},
	"msn.com": {
		imap: { host: "outlook.office365.com", port: 993, secure: true },
		smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
		authType: "XOAUTH2",
		provider: "microsoft",
	},
	// Chinese providers: the practical choice where Google is unreachable. All four
	// authenticate with an app-specific code (授权码) as a password, so no OAuth app
	// is needed. NetEase (163/126) requires the IMAP ID command, which imapflow
	// sends automatically when the server advertises ID.
	"qq.com": {
		imap: { host: "imap.qq.com", port: 993, secure: true },
		smtp: { host: "smtp.qq.com", port: 465, secure: true },
		authType: "LOGIN",
		provider: "other",
	},
	"foxmail.com": {
		imap: { host: "imap.qq.com", port: 993, secure: true },
		smtp: { host: "smtp.qq.com", port: 465, secure: true },
		authType: "LOGIN",
		provider: "other",
	},
	"163.com": {
		imap: { host: "imap.163.com", port: 993, secure: true },
		smtp: { host: "smtp.163.com", port: 465, secure: true },
		authType: "LOGIN",
		provider: "other",
	},
	"126.com": {
		imap: { host: "imap.126.com", port: 993, secure: true },
		smtp: { host: "smtp.126.com", port: 465, secure: true },
		authType: "LOGIN",
		provider: "other",
	},
	// NetEase's other free domains: same service, no waiting period.
	"yeah.net": {
		imap: { host: "imap.yeah.net", port: 993, secure: true },
		smtp: { host: "smtp.yeah.net", port: 465, secure: true },
		authType: "LOGIN",
		provider: "other",
	},
	"188.com": {
		imap: { host: "imap.188.com", port: 993, secure: true },
		smtp: { host: "smtp.188.com", port: 465, secure: true },
		authType: "LOGIN",
		provider: "other",
	},
	"gmail.com": {
		imap: { host: "imap.gmail.com", port: 993, secure: true },
		smtp: { host: "smtp.gmail.com", port: 465, secure: true },
		authType: "XOAUTH2",
		provider: "google",
	},
	"googlemail.com": {
		imap: { host: "imap.gmail.com", port: 993, secure: true },
		smtp: { host: "smtp.gmail.com", port: 465, secure: true },
		authType: "XOAUTH2",
		provider: "google",
	},
}

/** Look a domain up in ISPDB. Returns undefined when the domain is unknown. */
export async function discoverDomain(domain: string, options: DiscoverOptions = {}): Promise<Discovered | undefined> {
	const doFetch = options.fetchImpl ?? fetch
	const base = options.baseUrl ?? ISPDB
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
	try {
		const response = await doFetch(`${base}/${encodeURIComponent(domain)}`, { signal: controller.signal })
		const parsed = response.ok ? (parseAutoconfig(await response.text()) ?? knownProvider(domain)) : knownProvider(domain)
		return parsed ? applyProviderDefaults(parsed) : undefined
	} catch {
		// Offline or blocked: fall back to the built-in table before giving up.
		const known = knownProvider(domain)
		return known ? applyProviderDefaults(known) : undefined
	} finally {
		clearTimeout(timer)
	}
}

export function domainOf(address: string): string | undefined {
	const at = address.lastIndexOf("@")
	if (at <= 0 || at === address.length - 1) return undefined
	// A trailing dot is a valid FQDN form but never what a person means to type.
	return address.slice(at + 1).trim().toLowerCase().replace(/\.+$/, "") || undefined
}

/** Scope presets, kept here so setup and docs cannot drift apart. */
export const OAUTH_SCOPE = {
	microsoft:
		"offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
	/** Same delegated scopes; the tenant, not the resource, is what differs. */
	"microsoft-365":
		"offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
	google: "https://mail.google.com/ offline_access",
} as const

export const OAUTH_ISSUER = {
	/** consumer outlook.com / hotmail */
	microsoft: "https://login.microsoftonline.com/consumers/v2.0",
	/** work or school tenant, incl. a Developer Program sandbox */
	"microsoft-365": "https://login.microsoftonline.com/organizations/v2.0",
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
	// Only attach an OAuth preset when OAuth is actually the chosen mechanism,
	// otherwise a Gmail app-password setup would ship a clientId nobody needs.
	const oauthPreset =
		discovered.authType === "XOAUTH2" &&
		(discovered.provider === "microsoft" || discovered.provider === "microsoft-365" || discovered.provider === "google")
			? discovered.provider
			: undefined

	// QQ rewrites the Message-ID we stamp (measured live), which silently breaks the reply-chain
	// fallback. Naming the Sent folder makes `setup` record the delivered id instead, so the
	// documented fallback works out of the box on the provider we know does this.
	const rewritesMessageId = /(^|\.)(qq|foxmail)\.com$/i.test(discovered.imap.host)

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
				...(rewritesMessageId ? { sentFolder: "Sent Messages" } : {}),
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
			// Single-mailbox mode sends and receives from one address, so the human's reply
			// is a self-addressed message the provider may deliver without an
			// Authentication-Results header at all (QQ does not add one to QQ->QQ mail).
			// Requiring DMARC there rejects every genuine reply, so it is off for that shape
			// and on everywhere else. The allowlist, loop guard and two self-echo guards
			// still apply; setup says so and `--check` warns if both are set.
			requireDmarcPass: !sameAddress,
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
