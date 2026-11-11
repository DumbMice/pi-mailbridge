// One-outstanding-decision registry.
//
// Why this exists: `request_decision` emails the human and ends the turn. If the
// agent calls it twice for the same session, the human gets two emails for one
// decision and can only answer one of them. The registry reserves a slot per
// session so the second call is refused before any mail is sent.
//
// Scope note: this is intentionally **in memory**, owned by the daemon. A daemon
// restart drops reservations — that is acceptable, because a reply is keyed by
// its own UID in the pending store, not by a reservation. A dropped reservation
// can therefore never lose a reply; it can only allow a duplicate *question*.
//
// Bounds: entries expire by TTL and the map has a hard cap, because the
// /register endpoint is reachable by any local session.

export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_MAX_ENTRIES = 10_000

export interface RegisterResult {
	/** The session already had an outstanding decision. */
	alreadyPending: boolean
	/** The cap was hit; the new entry was NOT admitted. */
	full: boolean
}

export interface Registry {
	register(sessionId: string): RegisterResult
	release(sessionId: string): void
	has(sessionId: string): boolean
	size(): number
	/** Live session ids, for `/mailbridge` output. */
	list(): string[]
}

export interface RegistryOptions {
	ttlMs?: number
	maxEntries?: number
	now?: () => number
}

export function createRegistry(options: RegistryOptions = {}): Registry {
	const ttlMs = options.ttlMs ?? REGISTRY_TTL_MS
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
	const now = options.now ?? (() => Date.now())

	/** sessionId -> last refresh time */
	const entries = new Map<string, number>()

	/** Lazy prune: a dead entry can never be served after its TTL. */
	function prune(): void {
		const cutoff = now() - ttlMs
		for (const [id, at] of entries) {
			if (at < cutoff) entries.delete(id)
		}
	}

	return {
		register(sessionId) {
			prune()
			const existing = entries.get(sessionId)
			if (existing !== undefined) {
				entries.set(sessionId, now()) // refresh TTL
				return { alreadyPending: true, full: false }
			}
			if (entries.size >= maxEntries) {
				return { alreadyPending: false, full: true }
			}
			entries.set(sessionId, now())
			return { alreadyPending: false, full: false }
		},

		release(sessionId) {
			entries.delete(sessionId)
		},

		has(sessionId) {
			prune()
			return entries.has(sessionId)
		},

		size() {
			prune()
			return entries.size
		},

		list() {
			prune()
			return [...entries.keys()]
		},
	}
}
