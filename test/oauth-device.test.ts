import { test } from "node:test"
import { createCommandTokenProvider } from "../src/core/oauth.ts"
import assert from "node:assert/strict"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDeviceCodeProvider, type OAuthClient, type OAuthTokens } from "../src/core/oauth-device.ts"
import { isAuthError, withFreshToken } from "../src/core/oauth.ts"
import { fileTokenStore, memoryTokenStore } from "../src/store/oauth-store.ts"
import { toDeviceAuthorization, toOAuthTokens } from "../src/core/oauth-openid.ts"

const NOW = 1_700_000_000_000

function tokens(over: Partial<OAuthTokens> = {}): OAuthTokens {
	return { accessToken: "at-1", refreshToken: "rt-1", expiresAt: NOW + 3600_000, ...over }
}

function fakeClient(over: { refresh?: () => Promise<OAuthTokens>; poll?: () => Promise<OAuthTokens> } = {}) {
	const calls: string[] = []
	const client: OAuthClient = {
		async deviceAuthorization() {
			calls.push("deviceAuthorization")
			return { verificationUri: "https://example.test/device?code=abcd", userCode: "abcd" }
		},
		async pollDeviceAuthorization() {
			calls.push("poll")
			return over.poll ? over.poll() : tokens()
		},
		async refresh(refreshToken) {
			calls.push(`refresh:${refreshToken}`)
			return over.refresh ? over.refresh() : tokens({ accessToken: "at-2", refreshToken: "rt-2" })
		},
	}
	return { client, calls }
}

test("device login persists a refresh token and yields an access token", async () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-oauth-")) }
	const store = fileTokenStore(env)
	const { client, calls } = fakeClient()
	const provider = createDeviceCodeProvider({ client, store, now: () => NOW })

	const auth = await provider.login()
	assert.match(auth.verificationUri, /example\.test/)
	assert.deepEqual(calls, ["deviceAuthorization", "poll"])

	const stored = store.read()
	assert.equal(stored?.refreshToken, "rt-1")
	// The file must not be world-readable.
	assert.equal(statSync(join(env.XDG_STATE_HOME!, "pi-mailbridge", "oauth.json")).mode & 0o777, 0o600)

	assert.equal(await provider.getToken(), "at-1", "cached right after login")
})

test("a login without offline_access fails loudly", async () => {
	const store = memoryTokenStore()
	const { client } = fakeClient({ poll: async () => tokens({ refreshToken: undefined }) })
	const provider = createDeviceCodeProvider({ client, store, now: () => NOW })
	await assert.rejects(() => provider.login(), /offline_access/)
})

test("the access token is cached until it nears expiry", async () => {
	let clock = NOW
	const store = memoryTokenStore({ refreshToken: "rt-1", accessToken: "at-stored", expiresAt: NOW + 3600_000 })
	const { client, calls } = fakeClient()
	const provider = createDeviceCodeProvider({ client, store, now: () => clock })

	assert.equal(await provider.getToken(), "at-stored", "used from the store")
	assert.deepEqual(calls, [], "no network")

	clock = NOW + 3600_000 // at expiry
	assert.equal(await provider.getToken(), "at-2", "refreshed")
	assert.deepEqual(calls, ["refresh:rt-1"])
})

test("a rotated refresh token is persisted", async () => {
	const store = memoryTokenStore({ refreshToken: "rt-old", expiresAt: 0 })
	const { client } = fakeClient()
	const provider = createDeviceCodeProvider({ client, store, now: () => NOW })
	await provider.getToken()
	assert.equal(store.value()?.refreshToken, "rt-2", "provider rotated it")
})

test("no refresh token means a clear instruction, not a silent failure", async () => {
	const store = memoryTokenStore()
	const { client, calls } = fakeClient()
	const provider = createDeviceCodeProvider({ client, store, now: () => NOW })
	await assert.rejects(() => provider.getToken(), /--auth/)
	assert.deepEqual(calls, [], "no network attempted")
})

test("a failed refresh disables the provider instead of retrying forever", async () => {
	const store = memoryTokenStore({ refreshToken: "rt-1", expiresAt: 0 })
	const { client, calls } = fakeClient({ refresh: async () => { throw new Error("invalid_grant") } })
	const provider = createDeviceCodeProvider({ client, store, now: () => NOW })

	await assert.rejects(() => provider.getToken(), /refresh failed/)
	assert.equal(provider.isDisabled(), true)
	const before = calls.length
	await assert.rejects(() => provider.getToken(), /disabled/)
	assert.equal(calls.length, before, "no further refresh attempts")
})

test("concurrent callers collapse onto one refresh", async () => {
	const store = memoryTokenStore({ refreshToken: "rt-1", expiresAt: 0 })
	const { client, calls } = fakeClient()
	const provider = createDeviceCodeProvider({ client, store, now: () => NOW })
	const all = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()])
	assert.deepEqual(all, ["at-2", "at-2", "at-2"])
	assert.equal(calls.filter((c) => c.startsWith("refresh")).length, 1)
})

test("withFreshToken refreshes once on a 401 from the mail server", async () => {
	const store = memoryTokenStore({ refreshToken: "rt-1", accessToken: "at-old", expiresAt: NOW + 3600_000 })
	const { client, calls } = fakeClient()
	const provider = createDeviceCodeProvider({ client, store, now: () => NOW })

	let attempt = 0
	const seen: string[] = []
	const result = await withFreshToken(provider, async (token) => {
		seen.push(token)
		if (attempt++ === 0) throw new Error("AUTHENTICATIONFAILED")
		return "ok"
	})

	assert.equal(result, "ok")
	assert.deepEqual(seen, ["at-old", "at-2"], "invalidate + refresh produced a new token")
	assert.equal(calls.filter((c) => c.startsWith("refresh")).length, 1)
})

test("isAuthError still classifies the usual failures", () => {
	assert.equal(isAuthError(new Error("401 Unauthorized")), true)
	assert.equal(isAuthError(new Error("AUTHENTICATIONFAILED")), true)
	assert.equal(isAuthError(new Error("ECONNRESET")), false)
})

test("token response mapping uses expires_in and keeps refresh_token", () => {
	const mapped = toOAuthTokens(
		{ access_token: "a", refresh_token: "r", expires_in: 120 } as Parameters<typeof toOAuthTokens>[0],
		NOW,
	)
	assert.equal(mapped.accessToken, "a")
	assert.equal(mapped.refreshToken, "r")
	assert.equal(mapped.expiresAt, NOW + 120_000)
})

test("device response prefers the combined verification URL", () => {
	const mapped = toDeviceAuthorization({
		verification_uri: "https://x/device",
		verification_uri_complete: "https://x/device?code=abcd",
		user_code: "abcd",
	} as Parameters<typeof toDeviceAuthorization>[0])
	assert.equal(mapped.verificationUri, "https://x/device?code=abcd")
	assert.equal(mapped.userCode, "abcd")
})

test("a transient refresh failure retries, a revoked grant disables immediately", async () => {
	// One DNS blip used to disable the provider for the process lifetime: the daemon kept
	// running and silently stopped sending mail until a human restarted it.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-oauth-")) }
	const store = fileTokenStore(env)
	store.write({ refreshToken: "rt-0", accessToken: "expired", expiresAt: NOW - 1_000 })
	let mode: "transient" | "revoked" = "transient"
	const { client } = fakeClient({
		refresh: async () => {
			throw new Error(
				mode === "revoked" ? "invalid_grant: refresh token revoked" : "getaddrinfo ENOTFOUND login.microsoftonline.com",
			)
		},
	})
	const provider = createDeviceCodeProvider({ client, store, now: () => NOW })

	await assert.rejects(() => provider.getToken(), /will retry|retrying/i)
	assert.equal(provider.isDisabled(), false, "a network error must not disable it")

	mode = "revoked"
	await assert.rejects(() => provider.getToken(), /re-run/)
	assert.equal(provider.isDisabled(), true, "a revoked grant is fatal")
})

test("a failing token command does not leak its argv", () => {
	// Node's execFile message is "Command failed: <file> <args...>\n<stderr>", and the argv tail
	// is exactly what describeCommand() hides because it may carry a client secret. That message
	// used to reach daemon.log and --check output verbatim.
	const provider = createCommandTokenProvider({
		command: ["ortie", "token", "--client-secret", "s3cr3t-value", "show"],
	})
	return provider
		.getToken()
		.then(() => assert.fail("expected the command to fail"))
		.catch((error: Error) => {
			assert.doesNotMatch(error.message, /s3cr3t-value/, "the secret must not appear")
			assert.match(error.message, /OAuth2 token command failed/, "but the failure is named")
			assert.match(error.message, /ortie/, "and the program is still identified")
		})
})
