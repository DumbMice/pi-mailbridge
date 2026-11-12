// Short routing ids.
//
// The signed token proved out but cost ~42 characters of base64 in every subject
// line, which is most of what a mail client shows. Since the routing state is
// already local (per-daemon cursor, journal, pending store, thread ids), the subject
// only needs a local lookup key.
//
// So: mint a 6-hex-character id, remember which session it belongs to, and put
// `[pi:a1b2c3]` in the subject. Twelve characters instead of forty-two.
//
// What this gives up and why it is acceptable:
//   - The tag is not self-describing, so another machine cannot resolve it. That is
//     already true of thread ids, and correct: a device must not act on another
//     device's mail.
//   - The tag is not signed. It does not need to be: it is only a lookup key, and an
//     unknown key resolves to nothing. Authorization is still the sender allowlist
//     plus DMARC (docs/SECURITY.md §2.2).
//
// Signed tokens keep working: messages minted before this change still route.

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"

import { statePath } from "./paths.ts"

/** Keep this many live routes. One per session (reused and refreshed), not per mail. */
export const ROUTES_CAP = 2_000
/** 6 hex characters: 16.7M values, ample for one mailbox's notifications. */
const ID_BYTES = 3
const ID_HEX = ID_BYTES * 2

/** 6 hex normally; 8 is the rare collision fallback further down, and must still match. */
export const ROUTE_RE = /\[\s*pi:([0-9a-f]{6,8})\s*\]/i

export interface RouteRecord {
	id: string
	sessionId: string
	device?: string
	/** Epoch ms; the route stops resolving after this. */
	expiresAt: number
	subject: string
}

interface RoutesFile {
	items: RouteRecord[]
}

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, "routes.json")
}

function load(env: NodeJS.ProcessEnv): RouteRecord[] {
	const p = path(env)
	try {
		if (!existsSync(p)) return []
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<RoutesFile>
		if (!Array.isArray(parsed?.items)) return []
		return parsed.items.filter(
			(r): r is RouteRecord =>
				typeof r?.id === "string" && typeof r?.sessionId === "string" && typeof r?.expiresAt === "number",
		)
	} catch {
		return []
	}
}

/**
 * Cross-process lock around the read-modify-write.
 *
 * routes.json is the one store written by every pi process, not just the daemon. Without a
 * lock two sessions settling at once each write their whole in-memory copy and one route is
 * lost - and a lost route means a reply falls back to the threading chain, or to `no-token`.
 * The lock is an O_EXCL file, removed on release and stolen if a holder died.
 */
/**
 * A lock older than this is treated as abandoned by a process that died holding it.
 * Legitimate holds are single-digit milliseconds; this is only reached by a dead holder or a
 * process stalled for seconds, which cannot be told apart without an OS-level flock.
 */
const LOCK_STALE_MS = 3_000
/** Retry budget must exceed the stale threshold, or a stale lock can never be stolen. */
const LOCK_ATTEMPTS = 900
const LOCK_SLEEP_MS = 5

function withLock<T>(env: NodeJS.ProcessEnv, run: () => T): T {
	const lock = statePath(env, "routes.lock")
	mkdirSync(dirname(lock), { recursive: true, mode: 0o700 })
	// The owner is written into the file so a release only removes a lock it still holds.
	const owner = `${process.pid}:${randomBytes(6).toString("hex")}`
	const sleep = (): void => {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_SLEEP_MS)
	}
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		try {
			const fd = openSync(lock, "wx", 0o600)
			try {
				writeSync(fd, owner)
			} catch {
				/* the owner tag is a nicety; the lock itself is the guarantee */
			}
			try {
				return run()
			} finally {
				closeSync(fd)
				// Only unlink our own lock: a lock we lost to a steal must not be deleted, or a
				// third writer walks into a critical section another process is still inside.
				try {
					if (readFileSync(lock, "utf8") === owner) unlinkSync(lock)
				} catch {
					/* already gone */
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			// Steal only a lock old enough to belong to a dead holder, and steal it by
			// *renaming* it aside: rename is atomic, so two stealers cannot both succeed (the
			// loser gets ENOENT). The previous unlink-based steal let a second stealer delete
			// the lock the first had just created, putting both writers in the critical section.
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
					const aside = `${lock}.stale.${process.pid}.${randomBytes(4).toString("hex")}`
					renameSync(lock, aside)
					unlinkSync(aside)
				}
			} catch {
				/* raced with the holder or another stealer: retry */
			}
			sleep()
		}
	}
	throw new Error("pi-mailbridge: routes.json is locked by another process")
}

function save(env: NodeJS.ProcessEnv, items: RouteRecord[]): void {
	const p = path(env)
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tmp = `${p}.${process.pid}.tmp`
	const trimmed = items.length > ROUTES_CAP ? items.slice(items.length - ROUTES_CAP) : items
	writeFileSync(tmp, JSON.stringify({ items: trimmed } satisfies RoutesFile), { mode: 0o600 })
	renameSync(tmp, p)
}

export interface RegisterRouteOptions {
	sessionId: string
	subject: string
	device?: string
	ttlHours?: number
	now?: number
	env?: NodeJS.ProcessEnv
}

/** Mint a route for an outbound notification and return its short id. */
export function registerRoute(options: RegisterRouteOptions): string {
	const env = options.env ?? process.env
	const now = options.now ?? Date.now()
	const ttlHours = options.ttlHours ?? 30 * 24

	return withLock(env, () => registerLocked(options, env, now, ttlHours))
}

function registerLocked(options: RegisterRouteOptions, env: NodeJS.ProcessEnv, now: number, ttlHours: number): string {
	const items = load(env).filter((r) => r.expiresAt > now)
	const taken = new Set(items.map((r) => r.id))

	let id = ""
	for (let attempt = 0; attempt < 32; attempt++) {
		const candidate = randomBytes(ID_BYTES).toString("hex")
		if (!taken.has(candidate)) {
			id = candidate
			break
		}
	}
	// Astronomically unlikely; better to widen than to reuse someone's id.
	if (!id) id = randomBytes(ID_BYTES + 1).toString("hex")

	items.push({
		id,
		sessionId: options.sessionId,
		...(options.device ? { device: options.device } : {}),
		expiresAt: now + ttlHours * 3600_000,
		subject: options.subject,
	})
	save(env, items)
	return id
}

/**
 * One route per **session**, reused and refreshed on every notification.
 *
 * Per-message ids made every subject unique, which defeats the conversation grouping
 * that mail clients do by subject - each notification became its own thread. Keeping the
 * id stable per session means the subject is byte-identical across notifications, so
 * Outlook's conversation topic and Gmail's subject grouping both keep one thread, and
 * the RFC 5322 headers we also set have something stable to point at.
 */
export function ensureRouteForSession(options: RegisterRouteOptions): string {
	const env = options.env ?? process.env
	const now = options.now ?? Date.now()
	const ttlHours = options.ttlHours ?? 30 * 24

	return withLock(env, () => {
	const items = load(env)
	const existing = items.find((r) => r.sessionId === options.sessionId && r.expiresAt > now)
	if (existing) {
		// Refresh so a long-lived session keeps its id, and keep the subject current.
		existing.expiresAt = now + ttlHours * 3600_000
		if (existing.device !== options.device) {
			if (options.device) existing.device = options.device
			else delete existing.device
		}
		existing.subject = options.subject
		save(env, items)
		return existing.id
	}
	// registerLocked, not registerRoute: the lock is not re-entrant.
	return registerLocked(options, env, now, ttlHours)
	})
}

export interface ResolveRouteOptions {
	/** The scanning device; a route minted elsewhere does not resolve here. */
	device?: string
	now?: number
	env?: NodeJS.ProcessEnv
}

/** Look a short id up. Undefined when unknown, expired, or minted elsewhere. */
export function resolveRoute(id: string, options: ResolveRouteOptions = {}): RouteRecord | undefined {
	const env = options.env ?? process.env
	const now = options.now ?? Date.now()
	const normalized = id.trim().toLowerCase()
	const record = load(env).find((r) => r.id === normalized)
	if (!record) return undefined
	if (record.expiresAt <= now) return undefined
	if (record.device && options.device && record.device !== options.device) return undefined
	return record
}

/** Extract the short id from a subject line, if present. */
export function routeIdFromSubject(subject: string | undefined | null): string | undefined {
	if (!subject) return undefined
	return ROUTE_RE.exec(subject)?.[1]?.toLowerCase()
}

export function routeCount(env: NodeJS.ProcessEnv = process.env): number {
	return load(env).length
}
