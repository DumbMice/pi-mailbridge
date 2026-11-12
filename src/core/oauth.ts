// OAuth2 access-token supply for XOAUTH2 (Outlook).
//
// Microsoft retired SMTP basic auth for outlook.com/hotmail on 2024-09-16, so an
// app password is not an option there. Two flows are built in - device code
// (oauth-device.ts) and OpenID Connect (oauth-openid.ts) - and token acquisition can also
// be delegated to a configurable command whose stdout is the token. This module is the
// caching/retry layer shared by all three.
//
// Two design rules:
//   1. The command is executed with `execFile` and an argv array — never a shell
//      — so a token or a path containing shell metacharacters cannot be
//      reinterpreted as syntax.
//   2. A broken command disables the provider instead of being retried forever.
//      The daemon would otherwise spawn a failing process on every scan.

import { execFile } from "node:child_process"

export interface ExecResult {
	stdout: string
}

export type ExecFileLike = (file: string, args: string[]) => Promise<ExecResult>

const DEFAULT_TIMEOUT_MS = 10_000

/** Default executor: argv only, bounded output, hard timeout. */
export const defaultExec: ExecFileLike = (file, args) =>
	new Promise((resolve, reject) => {
		execFile(file, args, { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 1 << 20, shell: false }, (error, stdout) => {
			if (error) {
				reject(error)
				return
			}
			resolve({ stdout: stdout.toString() })
		})
	})

export interface TokenProvider {
	/** Current access token, fetching only when stale. */
	getToken(): Promise<string>
	/** Force the next getToken() to re-run the command (after a 401). */
	invalidate(): void
	/** True once the command has failed past the retry budget. */
	isDisabled(): boolean
	/** Diagnostics for `/mailbridge`: never the token itself. */
	state(): { cached: boolean; disabled: boolean; failures: number }
}

export interface CommandTokenProviderOptions {
	/** argv; argv[0] is the executable. */
	command: readonly string[]
	exec?: ExecFileLike
	now?: () => number
	/** How long a fetched token is considered fresh. Default 50 minutes. */
	ttlMs?: number
	/** Consecutive failures allowed before disabling. Default 1 (fail fast). */
	maxConsecutiveFailures?: number
}

const DEFAULT_TTL_MS = 50 * 60 * 1000

export function createCommandTokenProvider(options: CommandTokenProviderOptions): TokenProvider {
	const { command } = options
	const exec = options.exec ?? defaultExec
	const now = options.now ?? (() => Date.now())
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
	// "A broken command should not be retried forever" is right; disabling after ONE failure
	// is not - a DNS blip or a momentary exec failure then stops all mail until a restart.
	// Three consecutive failures is still quick to notice and survives a transient one.
	const maxFailures = options.maxConsecutiveFailures ?? 3

	let token: string | undefined
	let fetchedAt = 0
	let failures = 0
	let disabled = false
	let inFlight: Promise<string> | undefined

	function describeCommand(): string {
		// Only argv[0]; later args may contain secrets (client ids, paths).
		return command[0] ? `${command[0]} …` : "(empty command)"
	}

	async function fetchToken(): Promise<string> {
		if (!command.length) {
			disabled = true
			throw new Error("pi-mailbridge: mail.smtp.tokenCommand is empty but authType is XOAUTH2")
		}
		try {
			const { stdout } = await exec(command[0]!, command.slice(1))
			const value = stdout.trim().split(/\r?\n/).pop()?.trim() ?? ""
			if (!value) throw new Error("command produced no output")
			failures = 0
			token = value
			fetchedAt = now()
			return value
		} catch (error) {
			failures++
			if (failures >= maxFailures) disabled = true
			const reason = error instanceof Error ? error.message : String(error)
			const suffix = disabled
				? " — OAuth2 is now disabled for this session; fix mail.smtp.tokenCommand and restart"
				: ` — will retry on next use (${failures}/${maxFailures})`
			throw new Error(`pi-mailbridge: OAuth2 token command failed (${describeCommand()}): ${reason}${suffix}`)
		}
	}

	return {
		async getToken() {
			if (disabled) {
				throw new Error(
					`pi-mailbridge: OAuth2 token provider disabled after ${failures} failure(s) (${describeCommand()}); re-authenticate and restart`,
				)
			}
			if (token && now() - fetchedAt < ttlMs) return token
			// Collapse concurrent callers onto one exec.
			if (!inFlight) {
				inFlight = fetchToken().finally(() => {
					inFlight = undefined
				})
			}
			return inFlight
		},

		invalidate() {
			token = undefined
			fetchedAt = 0
		},

		isDisabled() {
			return disabled
		},

		state() {
			return { cached: token !== undefined && now() - fetchedAt < ttlMs, disabled, failures }
		},
	}
}

// ---------------------------------------------------------------------------
// Auth-failure detection + one-shot refresh
// ---------------------------------------------------------------------------

/** SMTP/IMAP auth failures as surfacing from the transport or a provider API. */
const AUTH_ERROR_RE = /(\b401\b|\b535\b|\b534\b|invalid.?credentials?|InvalidAuthenticationToken|AUTHENTICATIONFAILED|token.?(expired|invalid))/i

export function isAuthError(error: unknown): boolean {
	const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
	return AUTH_ERROR_RE.test(text)
}

/**
 * Run `use(token)`; on an auth error invalidate and retry exactly once.
 *
 * One retry, not a loop: a second failure means the credential is genuinely bad,
 * and retrying forever would hammer the provider and get the account locked.
 */
export async function withFreshToken<T>(
	provider: TokenProvider,
	use: (accessToken: string) => Promise<T>,
	isAuth: (error: unknown) => boolean = isAuthError,
): Promise<T> {
	const first = await provider.getToken()
	try {
		return await use(first)
	} catch (error) {
		if (!isAuth(error)) throw error
		provider.invalidate()
		const second = await provider.getToken()
		return use(second)
	}
}
