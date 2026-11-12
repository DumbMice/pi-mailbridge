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
//     plus pinned DMARC (docs/SECURITY.md §2.2).
//
// Signed tokens keep working: messages minted before this change still route.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { randomBytes } from "node:crypto"

import { statePath } from "./paths.ts"

/** Keep this many live routes. Each maps one outbound notification. */
export const ROUTES_CAP = 2_000
/** 6 hex characters: 16.7M values, ample for one mailbox's notifications. */
const ID_BYTES = 3
const ID_HEX = ID_BYTES * 2

export const ROUTE_RE = /\[\s*pi:([0-9a-f]{6})\s*\]/i

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
