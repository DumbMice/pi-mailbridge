// HMAC-signed routing tokens.
//
// A token is minted into the Subject of every outbound mail and lifted back out
// of replies. It answers exactly one question: "which session did this mail come
// from?" It is ROUTING, not AUTHORIZATION — see docs/SECURITY.md §2.2.
//
// Wire format inside the subject:  [pi:<payload>.<mac>] <subject>
//   payload = base64url(JSON.stringify({ s: sessionId, e: expiresAtMs }))
//   mac     = base64url(HMAC-SHA256(secret, payload))  truncated to 16 bytes
//
// Truncation keeps subjects short; 128 bits is far beyond brute-force reach for
// an offline verifier, and expiry bounds the window anyway.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/** 16 bytes → 22 base64url chars. */
const MAC_BYTES = 16
/** Tokens older than this are refused even when the MAC is valid. */
export const DEFAULT_TOKEN_TTL_HOURS = 30 * 24

/** Wire shape of the token payload. Short keys keep the subject line short. */
export interface TokenBody {
	/** session id */
	s: string
	/** expiry, epoch ms */
	e: number
	/**
	 * device that minted the token (short hostname). Optional so single-device
	 * installs and tokens minted before devices were tracked still verify.
	 */
	d?: string
}

export const TOKEN_RE = /\[\s*pi:([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*\]/i

function mac(secret: Buffer, payload: string): string {
	return createHmac("sha256", secret).update(payload).digest().subarray(0, MAC_BYTES).toString("base64url")
}

export function signToken(
	sessionId: string,
	secret: Buffer,
	opts: { ttlHours?: number; now?: number; device?: string } = {},
): string {
	const now = opts.now ?? Date.now()
	const ttl = (opts.ttlHours ?? DEFAULT_TOKEN_TTL_HOURS) * 3600_000
	const body: TokenBody = { s: sessionId, e: now + ttl, ...(opts.device ? { d: opts.device } : {}) }
	const payload = Buffer.from(JSON.stringify(body)).toString("base64url")
	return `${payload}.${mac(secret, payload)}`
}

export type VerifyResult =
	| { ok: true; sessionId: string; device?: string }
	| { ok: false; reason: "malformed" | "bad-mac" | "expired" }

export function verifyToken(token: string, secret: Buffer, now: number = Date.now()): VerifyResult {
	const dot = token.lastIndexOf(".")
	if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" }
	const payload = token.slice(0, dot)
	const given = token.slice(dot + 1)

	const expected = mac(secret, payload)
	const a = Buffer.from(given)
	const b = Buffer.from(expected)
	// Length check first: timingSafeEqual throws on length mismatch.
	if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad-mac" }

	let body: TokenBody
	try {
		body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenBody
	} catch {
		return { ok: false, reason: "malformed" }
	}
	if (typeof body?.s !== "string" || typeof body?.e !== "number") return { ok: false, reason: "malformed" }
	if (body.e <= now) return { ok: false, reason: "expired" }
	return { ok: true, sessionId: body.s, ...(typeof body.d === "string" && body.d ? { device: body.d } : {}) }
}

/** Prefix a human subject with the signed token. */
export function stampSubject(
	sessionId: string,
	subject: string,
	secret: Buffer,
	opts?: { ttlHours?: number; now?: number; device?: string },
): string {
	return `[pi:${signToken(sessionId, secret, opts)}] ${subject}`
}

/**
 * Pull a verified routing token out of a subject line.
 * Tolerates client prefixes (`Re:`, `RE:`, `AW:`, `Re[2]:`) because the token is
 * matched anywhere in the subject, not anchored.
 */
export function tokenFromSubject(
	subject: string | undefined | null,
	secret: Buffer,
	now?: number,
): { sessionId: string; device?: string } | undefined {
	if (!subject) return undefined
	const m = TOKEN_RE.exec(subject)
	if (!m?.[1]) return undefined
	const result = verifyToken(m[1], secret, now)
	if (!result.ok) return undefined
	return { sessionId: result.sessionId, ...(result.device ? { device: result.device } : {}) }
}

/** Convenience wrapper for callers that only need the session id. */
export function sessionIdFromSubject(subject: string | undefined | null, secret: Buffer, now?: number): string | undefined {
	return tokenFromSubject(subject, secret, now)?.sessionId
}

/** Shared secret material. 32 bytes. */
export function newSecret(): Buffer {
	return randomBytes(32)
}
