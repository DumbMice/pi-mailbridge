import { test } from "node:test"
import assert from "node:assert/strict"

import { newSecret, sessionIdFromSubject, signToken, stampSubject, verifyToken } from "../src/core/token.ts"

const secret = Buffer.alloc(32, 7)
const other = Buffer.alloc(32, 9)
const SID = "01a1c453-f2fc-7169-8c89-69c93fa1a152"

test("round-trip: sign then verify", () => {
	const token = signToken(SID, secret)
	const r = verifyToken(token, secret)
	assert.equal(r.ok, true)
	assert.equal(r.ok && r.sessionId, SID)
})

test("subject round-trip survives client prefixes", () => {
	const subject = stampSubject(SID, "Fix login", secret)
	assert.match(subject, /^\[pi:/)
	for (const prefix of ["", "Re: ", "RE: ", "AW: ", "Re[2]: ", "Fwd: "]) {
		assert.equal(sessionIdFromSubject(prefix + subject, secret), SID, `prefix ${JSON.stringify(prefix)}`)
	}
})

test("a different secret is rejected", () => {
	const token = signToken(SID, secret)
	const r = verifyToken(token, other)
	assert.deepEqual(r, { ok: false, reason: "bad-mac" })
})

test("tampered payload is rejected", () => {
	const token = signToken(SID, secret)
	const [payload, mac] = token.split(".")
	const forgedPayload = Buffer.from(JSON.stringify({ s: "attacker", e: Date.now() + 1000 })).toString("base64url")
	const r = verifyToken(`${forgedPayload}.${mac}`, secret)
	assert.deepEqual(r, { ok: false, reason: "bad-mac" })
	assert.ok(payload)
})

test("expired token is rejected even with a valid mac", () => {
	const token = signToken(SID, secret, { ttlHours: -1 })
	const r = verifyToken(token, secret)
	assert.deepEqual(r, { ok: false, reason: "expired" })
})

test("malformed input never throws", () => {
	for (const bad of ["", ".", "abc", "abc.", ".abc", "a.b.c"]) {
		assert.doesNotThrow(() => verifyToken(bad, secret))
	}
	assert.equal(sessionIdFromSubject(undefined, secret), undefined)
	assert.equal(sessionIdFromSubject("no token here", secret), undefined)
})

test("newSecret is 32 bytes and unique", () => {
	assert.equal(newSecret().length, 32)
	assert.notDeepEqual(newSecret(), newSecret())
})

test("the configured TTL is honoured, at minute granularity", () => {
	const now = Date.UTC(2026, 0, 1)
	const token = signToken(SID, secret, { now, ttlHours: 1 })
	// The old layout stored whole days, so a 1-hour token could live a whole day.
	assert.equal(verifyToken(token, secret, now + 59 * 60_000).ok, true, "valid after 59 minutes")
	assert.equal(verifyToken(token, secret, now + 61 * 60_000).ok, false, "expired after 61")
})

test("a token minted with the default TTL survives 30 days at the minute-epoch boundary", () => {
	const now = Date.UTC(2026, 0, 1)
	const token = signToken(SID, secret, { now })
	assert.equal(verifyToken(token, secret, now + 29 * 86_400_000).ok, true)
	assert.equal(verifyToken(token, secret, now + 31 * 86_400_000).ok, false)
})
