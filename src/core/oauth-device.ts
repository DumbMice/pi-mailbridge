// Device-code OAuth2 — one auth path for every provider.
//
// Microsoft killed app passwords for outlook.com; Gmail keeps them but discourages
// them; self-hosted boxes may move to OAuth2 next. Rather than write a flow per
// provider, this module speaks plain OAuth2 **device authorization** (RFC 8628),
// which every provider we care about supports:
//
//   Microsoft (consumers or any tenant)  https://login.microsoftonline.com/consumers/v2.0
//   Google                              https://accounts.google.com
//   any OIDC                            your issuer
//
// The flow is deliberately the *pull* variant: no redirect URI, no local listener,
// no browser on the daemon box. You approve on whatever device you like — which is
// also why the rest of this package can be driven from any device with email.
//
// openid-client is reached through an adapter (see core/oauth-openid.ts) so the
// provider itself is testable and the library stays swappable.

import type { TokenProvider } from "./oauth.ts"

export interface OAuthConfig {
	/** Issuer / discovery base URL, e.g. https://login.microsoftonline.com/consumers/v2.0 */
	issuer: string
	clientId: string
	/** Omit for a public client using PKCE-style device flow. */
	clientSecret?: string
	/** Space-separated scopes, e.g. "offline_access https://outlook.office.com/IMAP.AccessAsUser.All" */
	scope: string
}

export interface OAuthTokens {
	accessToken: string
	refreshToken?: string
	/** Epoch ms when accessToken expires. */
	expiresAt: number
}

/** What the human has to see to approve the login. */
export interface DeviceAuthorization {
	verificationUri: string
	/** Short code to type, if the provider uses one. */
	userCode: string
}

/** The OAuth client surface this module needs. */
export interface OAuthClient {
	deviceAuthorization(): Promise<DeviceAuthorization>
	/** Polls until the human approves or the code expires. */
	pollDeviceAuthorization(): Promise<OAuthTokens>
	refresh(refreshToken: string): Promise<OAuthTokens>
}

/** Persisted tokens. Only the refresh token matters long-term. */
export interface StoredTokens {
	refreshToken?: string
	accessToken?: string
	expiresAt?: number
}

export interface TokenStore {
	read(): StoredTokens | undefined
	write(tokens: StoredTokens): void
}

export interface DeviceCodeProviderOptions {
	client: OAuthClient
	store: TokenStore
	now?: () => number
	/** Refresh this long before expiry rather than at it. */
	skewMs?: number
}

const DEFAULT_SKEW_MS = 60_000

/**
 * A `TokenProvider` backed by the device-code grant.
 *
 * Resolution order: cached access token -> stored refresh token -> fail with an
 * instruction to run the login command. It never silently degrades to a password:
 * half-configured auth is worse than a clear error.
 */
export function createDeviceCodeProvider(options: DeviceCodeProviderOptions): TokenProvider & {
	/** Run the interactive login once and persist the refresh token. */
	login(): Promise<DeviceAuthorization>
} {
	const { client, store } = options
	const now = options.now ?? (() => Date.now())
	const skew = options.skewMs ?? DEFAULT_SKEW_MS

	let cached: OAuthTokens | undefined
	let failures = 0
	let disabled = false
	let inFlight: Promise<string> | undefined

	function fresh(tokens: StoredTokens | OAuthTokens | undefined): boolean {
		return Boolean(tokens?.accessToken && tokens.expiresAt && tokens.expiresAt - skew > now())
	}

	async function acquire(): Promise<string> {
		const stored = store.read()

		if (fresh(stored)) {
			cached = { accessToken: stored!.accessToken!, expiresAt: stored!.expiresAt! }
			return cached.accessToken
		}

		if (!stored?.refreshToken) {
			disabled = true
			throw new Error(
				"pi-mailbridge: not authorised yet — run `pi-mailbridge --auth` once to approve device login, or set mail.*.tokenCommand",
			)
		}

		try {
			const refreshed = await client.refresh(stored.refreshToken)
			cached = refreshed
			store.write({
				...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : { refreshToken: stored.refreshToken }),
				accessToken: refreshed.accessToken,
				expiresAt: refreshed.expiresAt,
			})
			failures = 0
			return refreshed.accessToken
		} catch (error) {
			failures++
			disabled = true
			const reason = error instanceof Error ? error.message : String(error)
			throw new Error(`pi-mailbridge: OAuth2 token refresh failed: ${reason} — re-run \`pi-mailbridge --auth\``)
		}
	}

	return {
		async getToken() {
			if (cached && fresh(cached)) return cached.accessToken
			if (disabled) {
				throw new Error(
					`pi-mailbridge: OAuth2 is disabled after ${failures} failure(s) — re-run \`pi-mailbridge --auth\``,
				)
			}
			if (!inFlight) {
				inFlight = acquire().finally(() => {
					inFlight = undefined
				})
			}
			return inFlight
		},

		invalidate() {
			cached = undefined
			const stored = store.read()
			if (stored) store.write({ ...stored, accessToken: undefined, expiresAt: undefined })
		},

		isDisabled() {
			return disabled
		},

		state() {
			return { cached: Boolean(cached && fresh(cached)), disabled, failures }
		},

		async login() {
			const authorization = await client.deviceAuthorization()
			const tokens = await client.pollDeviceAuthorization()
			if (!tokens.refreshToken) {
				throw new Error(
					"pi-mailbridge: the provider returned no refresh_token — make sure `offline_access` is in oauth.scope",
				)
			}
			cached = tokens
			store.write({ refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt })
			return authorization
		},
	}
}
