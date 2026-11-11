// openid-client adapter.
//
// The one place that knows the OAuth library's API. Types are derived from the
// library itself (`Awaited<ReturnType<...>>`) so a major bump fails the build here
// rather than producing silently wrong field names.

import * as oidc from "openid-client"

import type { DeviceAuthorization, OAuthClient, OAuthConfig, OAuthTokens } from "./oauth-device.ts"

type DeviceResponse = Awaited<ReturnType<typeof oidc.initiateDeviceAuthorization>>
type TokenResponse = Awaited<ReturnType<typeof oidc.pollDeviceAuthorizationGrant>>

/** Map an OAuth token response onto our shape. */
export function toOAuthTokens(tokens: TokenResponse, now: number = Date.now()): OAuthTokens {
	const lifetime = typeof tokens.expires_in === "number" ? tokens.expires_in : 3600
	return {
		accessToken: tokens.access_token,
		...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
		expiresAt: now + lifetime * 1000,
	}
}

/** Human-facing part of a device authorization response. */
export function toDeviceAuthorization(response: DeviceResponse): DeviceAuthorization {
	return {
		// Prefer the combined URL when the provider offers one: fewer typos.
		verificationUri: response.verification_uri_complete ?? response.verification_uri,
		userCode: response.user_code,
	}
}

/**
 * Build a real OAuth client for `config`.
 * Async because discovery fetches the provider metadata.
 */
export async function createOpenidClient(config: OAuthConfig, now: () => number = Date.now): Promise<OAuthClient> {
	const issuer = new URL(config.issuer)
	const configuration = await oidc.discovery(issuer, config.clientId, config.clientSecret)

	let pending: DeviceResponse | undefined

	return {
		async deviceAuthorization() {
			pending = await oidc.initiateDeviceAuthorization(configuration, { scope: config.scope })
			return toDeviceAuthorization(pending)
		},

		async pollDeviceAuthorization() {
			if (!pending) throw new Error("pi-mailbridge: deviceAuthorization() must run before polling")
			const tokens = await oidc.pollDeviceAuthorizationGrant(configuration, pending)
			return toOAuthTokens(tokens, now())
		},

		async refresh(refreshToken: string) {
			const tokens = await oidc.refreshTokenGrant(configuration, refreshToken)
			return toOAuthTokens(tokens, now())
		},
	}
}

/**
 * Provider presets.
 *
 * Scopes are the ones that actually work for IMAP/SMTP XOAUTH2 — the Graph scopes
 * are different, and mixing them is the most common cause of "token works but the
 * server rejects it".
 */
export const OAUTH_PRESETS = {
	microsoft: {
		issuer: "https://login.microsoftonline.com/consumers/v2.0",
		scope: "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
	},
	"microsoft-365": {
		issuer: "https://login.microsoftonline.com/organizations/v2.0",
		scope: "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
	},
	google: {
		issuer: "https://accounts.google.com",
		scope: "https://mail.google.com/ offline_access",
	},
} as const

export type OAuthPreset = keyof typeof OAUTH_PRESETS
