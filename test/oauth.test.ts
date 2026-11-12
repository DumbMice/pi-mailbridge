import { test } from "node:test"
import assert from "node:assert/strict"

import {
	createCommandTokenProvider,
	defaultExec,
	isAuthError,
	withFreshToken,
	type ExecFileLike,
} from "../src/core/oauth.ts"

function fakeExec(outputs: (string | Error)[]) {
	const calls: { file: string; args: string[] }[] = []
	let i = 0
	const exec: ExecFileLike = async (file, args) => {
		calls.push({ file, args })
		const next = outputs[Math.min(i++, outputs.length - 1)]
		if (next instanceof Error) throw next
		return { stdout: next ?? "" }
	}
	return { calls, exec }
}

test("command is executed as argv, never through a shell", async () => {
	const f = fakeExec(["tok-1"])
	const p = createCommandTokenProvider({ command: ["ortie", "token", "show", "-a", "outlook"], exec: f.exec })
	assert.equal(await p.getToken(), "tok-1")
	assert.deepEqual(f.calls[0], { file: "ortie", args: ["token", "show", "-a", "outlook"] })
})

test("defaultExec does not let argv be reinterpreted as shell syntax", async () => {
	// If this went through a shell, `printf %s 'a; echo PWNED'` would print twice.
	const payload = "a; echo PWNED"
	const { stdout } = await defaultExec("printf", ["%s", payload])
	assert.equal(stdout, payload, "metacharacters must stay literal")
})

test("token is cached until it goes stale", async () => {
	let clock = 1_000_000
	const f = fakeExec(["tok-1", "tok-2"])
	const p = createCommandTokenProvider({ command: ["broker"], exec: f.exec, now: () => clock, ttlMs: 10_000 })

	assert.equal(await p.getToken(), "tok-1")
	clock += 9_999
	assert.equal(await p.getToken(), "tok-1", "still fresh")
	assert.equal(f.calls.length, 1, "no second exec")

	clock += 2
	assert.equal(await p.getToken(), "tok-2", "refetched after TTL")
	assert.equal(f.calls.length, 2)
})

test("concurrent callers collapse onto a single exec", async () => {
	const f = fakeExec(["tok-1"])
	const p = createCommandTokenProvider({ command: ["broker"], exec: f.exec })
	const results = await Promise.all([p.getToken(), p.getToken(), p.getToken()])
	assert.deepEqual(results, ["tok-1", "tok-1", "tok-1"])
	assert.equal(f.calls.length, 1)
})

test("only the last line of output is used", async () => {
	const f = fakeExec(["warning: refresh soon\ntok-final\n"])
	const p = createCommandTokenProvider({ command: ["broker"], exec: f.exec })
	assert.equal(await p.getToken(), "tok-final")
})

test("a failing command produces an actionable error, and disables only after the budget", async () => {
	// One ENOENT is often transient (an exec hiccup, a briefly missing PATH entry). Disabling
	// on the first failure stopped all mail until a restart, so the budget is three.
	const f = fakeExec([new Error("ENOENT: ortie not found")])
	const p = createCommandTokenProvider({ command: ["ortie", "token", "show"], exec: f.exec })

	for (let attempt = 1; attempt <= 2; attempt++) {
		await assert.rejects(() => p.getToken(), (e: Error) => {
			assert.match(e.message, /OAuth2 token command failed/)
			assert.match(e.message, /ortie/)
			assert.match(e.message, /ENOENT/)
			assert.match(e.message, /will retry on next use/, "says it will retry")
			return true
		})
		assert.equal(p.isDisabled(), false, "still enabled after a transient failure")
	}

	await assert.rejects(() => p.getToken(), /disabled/)
	assert.equal(p.isDisabled(), true)

	// Disabled means no further process spawns — this is the anti-loop guard.
	const before = f.calls.length
	await assert.rejects(() => p.getToken(), /disabled/)
	assert.equal(f.calls.length, before, "no exec after disabling")
})

test("an empty command is rejected without spawning anything", async () => {
	const f = fakeExec(["unused"])
	const p = createCommandTokenProvider({ command: [], exec: f.exec })
	await assert.rejects(() => p.getToken(), /tokenCommand is empty/)
	assert.equal(f.calls.length, 0)
})

test("empty output counts as a failure", async () => {
	const f = fakeExec(["   \n  "])
	const p = createCommandTokenProvider({ command: ["broker"], exec: f.exec })
	for (let i = 0; i < 3; i++) await assert.rejects(() => p.getToken(), /failed/)
	assert.equal(p.isDisabled(), true, "disabled only after the budget")
})

test("a successful fetch after a transient failure resets the failure count", async () => {
	const f = fakeExec([new Error("blip"), "tok-ok"])
	const p = createCommandTokenProvider({ command: ["broker"], exec: f.exec, maxConsecutiveFailures: 2 })
	await assert.rejects(() => p.getToken())
	assert.equal(p.isDisabled(), false, "one failure of two allowed")
	const tok = await p.getToken()
	assert.equal(tok, "tok-ok")
	assert.equal(p.state().failures, 0)
})

test("withFreshToken refreshes exactly once on an auth error", async () => {
	const f = fakeExec(["tok-old", "tok-new"])
	const p = createCommandTokenProvider({ command: ["broker"], exec: f.exec })

	const seen: string[] = []
	let attempt = 0
	const result = await withFreshToken(p, async (token) => {
		seen.push(token)
		if (attempt++ === 0) throw new Error("SMTP 535 5.7.3 Authentication unsuccessful")
		return "sent"
	})

	assert.equal(result, "sent")
	assert.deepEqual(seen, ["tok-old", "tok-new"], "retried with a fresh token")
	assert.equal(f.calls.length, 2)
})

test("withFreshToken does not retry non-auth errors", async () => {
	const f = fakeExec(["tok"])
	const p = createCommandTokenProvider({ command: ["broker"], exec: f.exec })
	let calls = 0
	await assert.rejects(
		() =>
			withFreshToken(p, async () => {
				calls++
				throw new Error("ECONNREFUSED")
			}),
		/ECONNREFUSED/,
	)
	assert.equal(calls, 1, "no retry for a network error")
	assert.equal(f.calls.length, 1, "no token refresh")
})

test("withFreshToken stops after one refresh even if it fails again", async () => {
	const f = fakeExec(["tok-1", "tok-2"])
	const p = createCommandTokenProvider({ command: ["broker"], exec: f.exec })
	let calls = 0
	await assert.rejects(
		() =>
			withFreshToken(p, async () => {
				calls++
				throw new Error("401 Unauthorized")
			}),
		/401/,
	)
	assert.equal(calls, 2, "exactly one retry")
})

test("isAuthError recognizes the usual auth failures only", () => {
	assert.equal(isAuthError(new Error("401 Unauthorized")), true)
	assert.equal(isAuthError(new Error("535 5.7.3 Authentication unsuccessful")), true)
	assert.equal(isAuthError(new Error("AUTHENTICATIONFAILED")), true)
	assert.equal(isAuthError(new Error("InvalidAuthenticationToken")), true)
	assert.equal(isAuthError(new Error("ECONNREFUSED")), false)
	assert.equal(isAuthError(new Error("550 mailbox unavailable")), false)
})
