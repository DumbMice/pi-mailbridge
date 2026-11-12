// HMAC-signed routing tokens.
//
// A signed token is the fallback routing form: it is minted when no local route id is
// available (see store/routes.ts), and lifted back out of replies. It answers exactly one question: "which session did this mail come from?"
// It is ROUTING, not AUTHORIZATION — see docs/SECURITY.md §2.2.
//
// Two wire formats, because subjects are user-visible and the first one was ugly:
//
//   v2 (current)  [pi:<payload>.<mac>]
//     payload = base64url( [0x02][16 session uuid][3 expiry minutes][2 device hash] )
//     mac     = base64url(HMAC-SHA256(secret, payload)) truncated to 6 bytes
//     → 30 + 1 + 8 = 39 characters, so a whole subject stays under ~90
//
//   v2-legacy (21-byte payload, minted before expiry went minute-granular)
//     payload = base64url( [0x02][16 session uuid][2 expiry days][2 device hash] )
//     → 28 + 1 + 8 = 37 characters. Still verified: a notification sent minutes before
//       an upgrade keeps working.
//
//   v1 (legacy)   base64url(JSON {s,e,d}) + '.' + 16-byte mac
//     → ~130 characters. Still verified, so tokens already in flight keep working.
//
// A non-UUID session id (tests, synthetic sessions) has no compact form, so those
// keep using v1.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/** MAC length for v2. 48 bits is ample for an online-verifiable routing token. */
const MAC_BYTES_V2 = 6
/** MAC length for v1, kept for compatibility with tokens already sent. */
const MAC_BYTES_V1 = 16
/** Tokens older than this are refused even when the MAC is valid. */
export const DEFAULT_TOKEN_TTL_HOURS = 30 * 24

const V2 = 0x02
/**
 * [version][16 session][3 expiry][2 device]
 *
 * Expiry is minutes since the epoch: three bytes covers ~31 years, and a day of
 * granularity (two bytes) let a token expire up to 24 h earlier than configured.
 */
const V2_PAYLOAD_BYTES = 1 + 16 + 3 + 2
/**
 * Expiry is minutes since 2020, not since 1970: three bytes reaches ~2052 from here, where
 * minutes since 1970 topped out in 2001 and silently clamped every token to "expired".
 */
const MINUTE_EPOCH = Date.UTC(2020, 0, 1)

export interface TokenBody {
	/** session id */
	s: string
	/** expiry, epoch ms */
	e: number
	/** minting device, when known */
	d?: string
}

export const TOKEN_RE = /\[\s*pi:([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*\]/i

function mac(secret: Buffer, payload: string, bytes: number): string {
	return createHmac("sha256", secret).update(payload).digest().subarray(0, bytes).toString("base64url")
}

/** 32 hex characters (with or without dashes) → 16 bytes, else undefined. */
function uuidToBytes(sessionId: string): Buffer | undefined {
	const hex = sessionId.replace(/-/g, "")
	if (!/^[0-9a-fA-F]{32}$/.test(hex)) return undefined
	return Buffer.from(hex, "hex")
}

function bytesToUuid(bytes: Buffer): string {
	const hex = bytes.toString("hex")
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Stable 2-byte fingerprint of a device name; enough to route, not to identify.
 * All-zero means "no device claim", which must not read as a mismatch.
 */
function deviceHash(device: string): Buffer {
	return createHash("sha256").update(device.toLowerCase()).digest().subarray(0, 2)
}

const NO_DEVICE = Buffer.alloc(2)

export interface SignOptions {
	ttlHours?: number
	now?: number
	device?: string
}

export function signToken(sessionId: string, secret: Buffer, opts: SignOptions = {}): string {
	const now = opts.now ?? Date.now()
	const expiresAt = now + (opts.ttlHours ?? DEFAULT_TOKEN_TTL_HOURS) * 3600_000

	const compactSession = uuidToBytes(sessionId)
	if (compactSession) {
		const payload = Buffer.alloc(V2_PAYLOAD_BYTES)
		payload[0] = V2
		compactSession.copy(payload, 1)
		const minutes = Math.floor((expiresAt - MINUTE_EPOCH) / 60_000)
		payload.writeUIntBE(Math.max(0, Math.min(0xffffff, minutes)), 17, 3)
		;(opts.device ? deviceHash(opts.device) : NO_DEVICE).copy(payload, 20)
		const encoded = payload.toString("base64url")
		return `${encoded}.${mac(secret, encoded, MAC_BYTES_V2)}`
	}

	// v1: no compact form for an arbitrary session id.
	const body: TokenBody = { s: sessionId, e: expiresAt, ...(opts.device ? { d: opts.device } : {}) }
	const payload = Buffer.from(JSON.stringify(body)).toString("base64url")
	return `${payload}.${mac(secret, payload, MAC_BYTES_V1)}`
}

export type VerifyResult =
	| {
			ok: true
			sessionId: string
			/** Full device name, when the format carries one (v1). */
			device?: string
			/**
			 * True/false when the caller supplied its own device to compare against;
			 * undefined when the token or the caller carries no device, meaning "no
			 * opinion" rather than "mismatch".
			 */
			deviceMatches?: boolean
	  }
	| { ok: false; reason: "malformed" | "bad-mac" | "expired" }

function splitToken(token: string): { payload: string; given: string } | undefined {
	const dot = token.lastIndexOf(".")
	if (dot <= 0 || dot === token.length - 1) return undefined
	return { payload: token.slice(0, dot), given: token.slice(dot + 1) }
}

function macMatches(given: string, expected: string): boolean {
	const a = Buffer.from(given)
	const b = Buffer.from(expected)
	return a.length === b.length && timingSafeEqual(a, b)
}

export function verifyToken(token: string, secret: Buffer, now: number = Date.now(), device?: string): VerifyResult {
	const parts = splitToken(token)
	if (!parts) return { ok: false, reason: "malformed" }
	const { payload, given } = parts

	let bytes: Buffer
	try {
		bytes = Buffer.from(payload, "base64url")
	} catch {
		return { ok: false, reason: "malformed" }
	}

	const fingerprintOf = (at: number): Buffer => bytes.subarray(at, at + 2)

	// --- v2: compact binary payload ---
	if (bytes.length === V2_PAYLOAD_BYTES && bytes[0] === V2) {
		if (!macMatches(given, mac(secret, payload, MAC_BYTES_V2))) return { ok: false, reason: "bad-mac" }
		const expiresAt = MINUTE_EPOCH + bytes.readUIntBE(17, 3) * 60_000
		if (expiresAt <= now) return { ok: false, reason: "expired" }
		const fingerprint = fingerprintOf(20)
		const claimsDevice = !fingerprint.equals(NO_DEVICE)
		const deviceMatches = device && claimsDevice ? fingerprint.equals(deviceHash(device)) : undefined
		return {
			ok: true,
			sessionId: bytesToUuid(bytes.subarray(1, 17)),
			...(deviceMatches === undefined ? {} : { deviceMatches }),
		}
	}

	// --- v2-legacy: same shape with two-byte day expiry, minted before the layout change ---
	if (bytes.length === 21 && bytes[0] === V2) {
		if (!macMatches(given, mac(secret, payload, MAC_BYTES_V2))) return { ok: false, reason: "bad-mac" }
		const expiresAt = bytes.readUInt16BE(17) * 86_400_000
		if (expiresAt <= now) return { ok: false, reason: "expired" }
		const fingerprint = fingerprintOf(19)
		const claimsDevice = !fingerprint.equals(NO_DEVICE)
		const deviceMatches = device && claimsDevice ? fingerprint.equals(deviceHash(device)) : undefined
		return {
			ok: true,
			sessionId: bytesToUuid(bytes.subarray(1, 17)),
			...(deviceMatches === undefined ? {} : { deviceMatches }),
		}
	}

	// --- v1: JSON payload ---
	if (!macMatches(given, mac(secret, payload, MAC_BYTES_V1))) return { ok: false, reason: "bad-mac" }
	let body: TokenBody
	try {
		body = JSON.parse(bytes.toString("utf8")) as TokenBody
	} catch {
		return { ok: false, reason: "malformed" }
	}
	if (typeof body?.s !== "string" || typeof body?.e !== "number") return { ok: false, reason: "malformed" }
	if (body.e <= now) return { ok: false, reason: "expired" }
	const claimedDevice = typeof body.d === "string" && body.d ? body.d : undefined
	const deviceMatches = claimedDevice && device ? claimedDevice === device : undefined
	return {
		ok: true,
		sessionId: body.s,
		...(claimedDevice ? { device: claimedDevice } : {}),
		...(deviceMatches === undefined ? {} : { deviceMatches }),
	}
}

/** Prefix a human subject with the signed token. */
export function stampSubject(sessionId: string, subject: string, secret: Buffer, opts?: SignOptions): string {
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
	device?: string,
): { sessionId: string; device?: string; deviceMatches?: boolean } | undefined {
	if (!subject) return undefined
	const m = TOKEN_RE.exec(subject)
	if (!m?.[1]) return undefined
	const result = verifyToken(m[1], secret, now, device)
	if (!result.ok) return undefined
	return {
		sessionId: result.sessionId,
		...(result.device ? { device: result.device } : {}),
		...(result.deviceMatches === undefined ? {} : { deviceMatches: result.deviceMatches }),
	}
}

/** Convenience wrapper for callers that only need the session id. */
export function sessionIdFromSubject(subject: string | undefined | null, secret: Buffer, now?: number): string | undefined {
	return tokenFromSubject(subject, secret, now)?.sessionId
}

/** Shared secret material. 32 bytes. */
export function newSecret(): Buffer {
	return randomBytes(32)
}
