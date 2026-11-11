// Layered configuration. Later layers win; invalid values are reported rather
// than thrown, so a typo never takes a session down mid-run.

import { existsSync, readFileSync } from "node:fs"

import { configPath } from "../store/paths.ts"

export interface ImapConfig {
	host: string
	port: number
	secure: boolean
	user: string
	password: string
	folder: string
	/** "XOAUTH2" needs a token command (Outlook). "LOGIN" uses an app password. */
	authType?: "LOGIN" | "XOAUTH2"
	/** argv whose stdout is an access token. Required when authType is XOAUTH2. */
	tokenCommand?: string[]
}

export interface SmtpConfig {
	host: string
	port: number
	secure: boolean
	user: string
	password: string
	/** "XOAUTH2" needs an OAuth broker; "LOGIN" is a provider app password. */
	authType?: "LOGIN" | "XOAUTH2"
	/** argv whose stdout is an access token. Required when authType is XOAUTH2. */
	tokenCommand?: string[]
}

export interface ResolvedConfig {
	mail: { imap: ImapConfig; smtp: SmtpConfig; to: string }
	security: {
		allowFrom: string[]
		requireDmarcPass: boolean
		/** Only AR headers whose authserv-id equals this are trusted. See SECURITY.md §2.1. */
		trustedAuthservId?: string
		tokenTtlHours: number
	}
	daemon: { host: string; port: number }
	notify: { onSettled: boolean; debounceMs: number; notifyOnAborted: boolean; subject: string }
	tuning: { idleRenewMs: number; autoIdleDelayMs: number; backoffInitialMs: number; backoffMaxMs: number }
	/** Human-readable problems found while loading; surfaced by `/mailbridge`. */
	warnings: string[]
}

const DEFAULTS: Omit<ResolvedConfig, "warnings"> = {
	mail: {
		imap: { host: "", port: 993, secure: true, user: "", password: "", folder: "INBOX" },
		smtp: { host: "", port: 465, secure: true, user: "", password: "", authType: "LOGIN" },
		to: "",
	},
	security: { allowFrom: [], requireDmarcPass: true, tokenTtlHours: 30 * 24 },
	daemon: { host: "127.0.0.1", port: 4177 },
	notify: { onSettled: true, debounceMs: 10_000, notifyOnAborted: false, subject: "pi: finished" },
	tuning: {
		idleRenewMs: 25 * 60 * 1000,
		autoIdleDelayMs: 1000,
		backoffInitialMs: 1000,
		backoffMaxMs: 60_000,
	},
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Parse a token command from env: JSON array, or comma-separated argv. */
function parseArgv(raw: string): string[] {
	const trimmed = raw.trim()
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed)
			if (Array.isArray(parsed)) return parsed.map(String)
		} catch {
			/* fall through to comma splitting */
		}
	}
	return trimmed
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
}

/** Shallow-by-section merge: enough for this config shape, and predictable. */
function merge(base: any, over: any): any {
	if (!isRecord(base) || !isRecord(over)) return over ?? base
	const out: Record<string, unknown> = { ...base }
	for (const [k, v] of Object.entries(over)) {
		out[k] = isRecord(v) && isRecord(base[k]) ? merge(base[k], v) : v
	}
	return out
}

function readJson(path: string, warnings: string[]): Record<string, unknown> {
	if (!existsSync(path)) return {}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"))
		return isRecord(parsed) ? parsed : {}
	} catch (error) {
		warnings.push(`${path}: ${(error as Error).message}`)
		return {}
	}
}

function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
	const o: Record<string, unknown> = {}
	const set = (path: string[], value: unknown) => {
		if (value === undefined) return
		let cur = o
		for (const key of path.slice(0, -1)) {
			cur[key] ??= {}
			cur = cur[key] as Record<string, unknown>
		}
		cur[path[path.length - 1]!] = value
	}
	set(["mail", "imap", "host"], env.PI_MAILBRIDGE_IMAP_HOST)
	set(["mail", "imap", "user"], env.PI_MAILBRIDGE_IMAP_USER)
	set(["mail", "imap", "password"], env.PI_MAILBRIDGE_IMAP_PASS)
	set(["mail", "smtp", "host"], env.PI_MAILBRIDGE_SMTP_HOST)
	set(["mail", "smtp", "user"], env.PI_MAILBRIDGE_SMTP_USER)
	set(["mail", "smtp", "password"], env.PI_MAILBRIDGE_SMTP_PASS)
	set(["mail", "to"], env.PI_MAILBRIDGE_TO)
	set(["daemon", "port"], env.PI_MAILBRIDGE_PORT)
	// Token commands are argv lists; accept JSON or a comma-separated argv.
	if (env.PI_MAILBRIDGE_IMAP_TOKEN_CMD) set(["mail", "imap", "tokenCommand"], parseArgv(env.PI_MAILBRIDGE_IMAP_TOKEN_CMD))
	if (env.PI_MAILBRIDGE_SMTP_TOKEN_CMD) set(["mail", "smtp", "tokenCommand"], parseArgv(env.PI_MAILBRIDGE_SMTP_TOKEN_CMD))
	return o
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
	const warnings: string[] = []
	let cfg: any = DEFAULTS
	cfg = merge(cfg, readJson(configPath(env), warnings))
	cfg = merge(cfg, envOverrides(env))
	const resolved: ResolvedConfig = { ...cfg, warnings }

	// Validation that must not throw in-process.
	const imap = resolved.mail.imap
	if (!imap.host || !imap.user) warnings.push("mail.imap.host and mail.imap.user are required")
	if (!resolved.mail.to) warnings.push("mail.to is required")
	if (resolved.security.allowFrom.length === 0) {
		warnings.push("security.allowFrom is empty — every sender will be rejected (fail closed)")
	}
	if (!resolved.security.trustedAuthservId && resolved.security.requireDmarcPass) {
		warnings.push("security.trustedAuthservId unset — DMARC cannot be pinned safely; treating as unreachable")
	}
	// XOAUTH2 without a command can never authenticate.
	for (const side of ["imap", "smtp"] as const) {
		const account = resolved.mail[side]
		if (account.authType === "XOAUTH2" && !account.tokenCommand?.length) {
			warnings.push(`mail.${side}.authType is XOAUTH2 but mail.${side}.tokenCommand is empty`)
		}
		if (account.authType === "XOAUTH2" && account.password) {
			warnings.push(`mail.${side}.password is set but authType is XOAUTH2 — the password will be ignored`)
		}
	}
	return resolved
}

export function hasUsableMailConfig(c: ResolvedConfig): boolean {
	return Boolean(c.mail.imap.host && c.mail.imap.user && c.mail.smtp.host && c.mail.to)
}
