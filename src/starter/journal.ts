// The starter's durable request journal.
//
// This is the file that decides whether a mail has already been acted on, so its failure modes are the
// feature's failure modes:
//
//   * **reserve before acting.** The identity of the session (pi session id, tmux id) is written while
//     the request is still `reserved`, before anything is spawned. A crash then leaves a record that
//     says what *should* exist, which is the only way recovery can tell "nothing started" from
//     "something started and we did not hear back".
//   * **uncertain is a state, not a retry.** A request whose outcome cannot be established is marked
//     `uncertain` and is never automatically spawned again: guessing wrong prints a second session or
//     loses the first.
//   * **result delivery is tracked separately from execution.** A crash between the side effect and the
//     confirmation mail leaves `state: ready, resultSent: false`, which is retried once - not a
//     re-spawn.
//   * **retention never evicts a live request.** Terminal records age out; anything unresolved, or
//     anything owning a live session, stays. Evicting a `ready` record would let the same mail start a
//     second session after a cursor loss.
//   * **an unreadable journal fails closed.** If it cannot be trusted, the starter refuses to run:
//     continuing could re-execute every request in the mailbox.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { statePath } from "../store/paths.ts"
import { STATE_VERSION, StateVersionError, checkStateVersion, stamp } from "../store/schema.ts"

export type RequestState =
	| "admitted"
	| "reserved"
	| "spawning"
	| "spawned"
	| "ready"
	| "refused"
	| "uncertain"
	| "ended"

/** States that may still become a running session. Never evicted, never retried automatically. */
const LIVE_STATES: readonly RequestState[] = ["admitted", "reserved", "spawning", "spawned", "ready", "uncertain"]
const TERMINAL_STATES: readonly RequestState[] = ["refused", "ended"]

export interface RequestRecord {
	id: string
	/** The mail's Message-ID, braces stripped. One request per id. */
	messageId: string
	uid: number
	uidValidity?: number
	/** IMAP INTERNALDATE, ms. Freshness is the mail's age, not when we happened to fetch it. */
	receivedAt: number
	state: RequestState
	/** Last transition, ms. */
	at: number
	/** Persisted before execution, so recovery can look for *this* session rather than guess. */
	piSessionId?: string
	tmuxId?: string
	tmuxSessionId?: string
	/** The name we chose before spawning: recovery matches the live child by this, not by a reusable `$N`. */
	tmuxName?: string
	/** When a spawn was attempted (ms). The hourly budget counts attempts, so a stop cannot refund one. */
	launchedAt?: number
	name?: string
	cwd?: string
	model?: string
	/** Refusal code and detail, or the uncertainty's explanation. */
	reason?: string
	/** Separate from `state`: the side effect may have happened while the mail did not. */
	resultSent?: boolean
}

export interface SessionRecord {
	name: string
	tmuxSessionId: string
	piSessionId: string
	requestId: string
	cwd: string
	model?: string
	at: number
	endedAt?: number
}

export interface JournalFile {
	v?: number
	requests: Record<string, RequestRecord>
	sessions: Record<string, SessionRecord>
}

export class JournalUntrustedError extends Error {
	readonly backup?: string
	constructor(message: string, backup?: string) {
		super(message)
		this.name = "JournalUntrustedError"
		this.backup = backup
	}
}

export interface JournalOptions {
	/** Terminal records older than this are pruned. Live ones never are. */
	retentionHours: number
	maxRequests: number
	maxSessions: number
	/** The acceptance horizon in hours (0 = unlimited). Tombstones live at least this long. */
	requestMaxAgeHours: number
}

export const JOURNAL_DEFAULTS: JournalOptions = { retentionHours: 48, maxRequests: 500, maxSessions: 200, requestMaxAgeHours: 48 }

export class JournalFullError extends Error {}

const FILE = "starter-journal.json"

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, FILE)
}

function empty(): JournalFile {
	return { ...stamp(), requests: {}, sessions: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A state we understand; anything else is treated as `uncertain` on read (never silently re-run). */
function asState(value: unknown): RequestState {
	return typeof value === "string" && [...LIVE_STATES, ...TERMINAL_STATES].includes(value as RequestState)
		? (value as RequestState)
		: "uncertain"
}

function normaliseRequest(raw: unknown): RequestRecord | undefined {
	if (!isRecord(raw)) return undefined
	if (typeof raw.id !== "string" || typeof raw.messageId !== "string") return undefined
	if (typeof raw.uid !== "number" || typeof raw.receivedAt !== "number") return undefined
	return {
		id: raw.id,
		messageId: raw.messageId,
		uid: raw.uid,
		...(typeof raw.uidValidity === "number" ? { uidValidity: raw.uidValidity } : {}),
		receivedAt: raw.receivedAt,
		state: asState(raw.state),
		at: typeof raw.at === "number" ? raw.at : raw.receivedAt,
		...(typeof raw.piSessionId === "string" ? { piSessionId: raw.piSessionId } : {}),
		...(typeof raw.tmuxId === "string" ? { tmuxId: raw.tmuxId } : {}),
		...(typeof raw.tmuxSessionId === "string" ? { tmuxSessionId: raw.tmuxSessionId } : {}),
		...(typeof raw.name === "string" ? { name: raw.name } : {}),
		...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}),
		...(typeof raw.model === "string" ? { model: raw.model } : {}),
		...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
		...(raw.resultSent === true ? { resultSent: true } : {}),
	}
}

function normaliseSession(raw: unknown): SessionRecord | undefined {
	if (!isRecord(raw)) return undefined
	if (typeof raw.name !== "string" || typeof raw.tmuxSessionId !== "string" || typeof raw.requestId !== "string") {
		return undefined
	}
	return {
		name: raw.name,
		tmuxSessionId: raw.tmuxSessionId,
		piSessionId: typeof raw.piSessionId === "string" ? raw.piSessionId : "",
		requestId: raw.requestId,
		cwd: typeof raw.cwd === "string" ? raw.cwd : "",
		...(typeof raw.model === "string" ? { model: raw.model } : {}),
		at: typeof raw.at === "number" ? raw.at : 0,
		...(typeof raw.endedAt === "number" ? { endedAt: raw.endedAt } : {}),
	}
}

/**
 * Read the journal, or refuse.
 *
 * A parse failure is kept aside (the bytes may be the only record of what ran) and the caller refuses to
 * start. A read failure - EACCES, EISDIR - is not corruption and must not be rewritten either, so it
 * propagates. Both end in "do not run", which is the safe direction for a file that authorizes execution.
 */
export function readJournal(env: NodeJS.ProcessEnv = process.env): JournalFile {
	const file = path(env)
	// Checked before the file: a corrupt journal was renamed away, so its absence is not a clean start.
	if (existsSync(`${file}.failed`)) {
		const reason = (() => {
			try {
				return readFileSync(`${file}.failed`, "utf8").trim()
			} catch {
				return "a previous read failed"
			}
		})()
		throw new JournalUntrustedError(
			`starter journal is marked untrusted (${reason}); run \`pi-mailbridge starter repair\` after inspecting it`,
		)
	}
	if (!existsSync(file)) return empty()
	let text: string
	try {
		text = readFileSync(file, "utf8")
	} catch (error) {
		throw new JournalUntrustedError(`starter journal could not be read: ${(error as Error).message}`)
	}
	const marker = `${file}.failed`
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		const backup = `${file}.corrupt-${Date.now()}`
		try {
			renameSync(file, backup)
			writeFileSync(marker, `not valid JSON; the bytes are in ${backup}`, { mode: 0o600 })
		} catch {
			throw new JournalUntrustedError("starter journal is not valid JSON and could not be set aside")
		}
		throw new JournalUntrustedError("starter journal is not valid JSON - it was set aside; inspect it before restarting", backup)
	}
	if (!isRecord(parsed)) throw new JournalUntrustedError("starter journal is not an object")
	try {
		checkStateVersion(FILE, parsed)
	} catch (error) {
		if (error instanceof StateVersionError) throw new JournalUntrustedError(error.message)
		throw error
	}
	const requests: Record<string, RequestRecord> = {}
	const sessions: Record<string, SessionRecord> = {}
	// A malformed entry is not a reason to forget it: dropping one silently changes what recovery knows,
	// and the file is the only evidence of what may be running. Refuse, and name the entry.
	const rawRequests = isRecord(parsed.requests) ? parsed.requests : {}
	for (const [id, value] of Object.entries(rawRequests)) {
		const record = normaliseRequest(value)
		if (!record) throw new JournalUntrustedError(`starter journal has a malformed request: ${id}`)
		requests[id] = record
	}
	const rawSessions = isRecord(parsed.sessions) ? parsed.sessions : {}
	for (const [name, value] of Object.entries(rawSessions)) {
		const record = normaliseSession(value)
		if (!record) throw new JournalUntrustedError(`starter journal has a malformed session: ${name}`)
		sessions[name] = record
	}
	return { ...stamp(), requests, sessions }
}

/**
 * Write the journal, pruning what is safe to prune.
 *
 * Terminal requests age out after the retention window; live ones do not. Sessions are kept for the same
 * window after they end, so `list:` can say "ended" instead of forgetting, and so a reused name cannot
 * silently point at a session we no longer track.
 */
export function writeJournal(
	env: NodeJS.ProcessEnv,
	journal: JournalFile,
	options: JournalOptions = JOURNAL_DEFAULTS,
	now = Date.now(),
): JournalFile {
	// A terminal record is what makes a replay a replay. Pruning it after 48 h while the acceptance horizon
	// is longer (or unlimited) reopened old mail, so the longer of the two wins.
	const horizonHours = options.requestMaxAgeHours === 0 ? Number.POSITIVE_INFINITY : Math.max(options.retentionHours, options.requestMaxAgeHours)
	const cutoff = now - horizonHours * 60 * 60 * 1000
	const requests: Record<string, RequestRecord> = {}
	for (const [id, record] of Object.entries(journal.requests)) {
		const terminal = TERMINAL_STATES.includes(record.state)
		if (terminal && record.at < cutoff) continue
		requests[id] = record
	}
	const sessions: Record<string, SessionRecord> = {}
	for (const [name, record] of Object.entries(journal.sessions)) {
		if (record.endedAt !== undefined && record.endedAt < cutoff) continue
		sessions[name] = record
	}
	// Everything still in the map survived the horizon, so all of it is replayable: count pressure refuses
	// admission rather than forgetting a record that would let old mail run twice.
	if (Object.keys(requests).length > options.maxRequests) {
		throw new JournalFullError(`starter journal is at its limit (${options.maxRequests}); every entry is still replayable`)
	}
	cap(sessions, options.maxSessions, (s) => s.endedAt !== undefined)

	const body: JournalFile = { ...stamp(), requests, sessions }
	const file = path(env)
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
	const tmp = `${file}.${process.pid}.tmp`
	writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
	renameSync(tmp, file)
	return body
}

/** Evict the oldest *evictable* entries until the cap is met; never a live one. */
/** Evict evictable entries; false when the cap is still exceeded (nothing left that may be dropped). */
function cap<T extends { at: number }>(record: Record<string, T>, max: number, evictable: (value: T) => boolean): boolean {
	const ids = Object.keys(record)
	if (ids.length <= max) return true
	const oldest = ids
		.filter((id) => evictable(record[id]!))
		.sort((a, b) => (record[a]!.at ?? 0) - (record[b]!.at ?? 0))
	for (const id of oldest) {
		if (Object.keys(record).length <= max) break
		delete record[id]
	}
	return Object.keys(record).length <= max
}

/**
 * Merge two views of the journal, newest-wins per entry.
 *
 * The runner keeps the journal in memory while the CLI stop reads and rewrites the file; without a merge,
 * whichever saved last erased the other's change (a stop undone by the next scan, or a fresh reservation
 * wiped by a stop). Entries are keyed by id/name and compared by their own timestamps, so both survive.
 */
export function mergeJournals(disk: JournalFile, mine: JournalFile): JournalFile {
	const newer = <T extends { at: number; endedAt?: number }>(a: T | undefined, b: T | undefined): T | undefined => {
		if (!a) return b
		if (!b) return a
		const aAt = Math.max(a.at, a.endedAt ?? 0)
		const bAt = Math.max(b.at, b.endedAt ?? 0)
		return bAt >= aAt ? b : a
	}
	const requests: Record<string, RequestRecord> = { ...disk.requests }
	for (const [id, record] of Object.entries(mine.requests)) requests[id] = newer(requests[id], record)!
	const sessions: Record<string, SessionRecord> = { ...disk.sessions }
	for (const [name, record] of Object.entries(mine.sessions)) sessions[name] = newer(sessions[name], record)!
	return { ...stamp(), requests, sessions }
}

/** Has this mail already been seen? By Message-ID, and by UID within its UID space (renumber-safe). */
export function alreadySeen(
	journal: JournalFile,
	mail: { messageId: string; uid: number; uidValidity?: number },
): RequestRecord | undefined {
	for (const record of Object.values(journal.requests)) {
		if (record.messageId === mail.messageId) return record
		if (record.uid === mail.uid && record.uidValidity !== undefined && record.uidValidity === mail.uidValidity) {
			return record
		}
	}
	return undefined
}

/** Is the mail too old to act on? Freshness is the mail's age (`INTERNALDATE`), not fetch time. */
export function isStale(record: Pick<RequestRecord, "receivedAt">, now: number, maxAgeHours: number): boolean {
	if (maxAgeHours <= 0) return false
	return now - record.receivedAt > maxAgeHours * 60 * 60 * 1000
}

export type Reconciliation =
	| { action: "adopt"; record: RequestRecord; tmuxSessionId?: string }
	| { action: "refuse"; record: RequestRecord; reason: string }
	| { action: "uncertain"; record: RequestRecord; reason: string }

/**
 * What to do with a request that was interrupted, given what is running now.
 *
 * `live` are the tmux sessions that exist, by id. The rules are deliberately conservative:
 *
 *   admitted/reserved, nothing started  -> refuse (nothing to adopt, and re-running is not this function's job)
 *   reserved with a matching live session -> adopt: the spawn won the race, we just did not hear back
 *   reserved with no session             -> refuse (the spawn did not happen)
 *   uncertain                            -> stay uncertain; never respawn automatically
 */
export function reconcile(
	record: RequestRecord,
	live: { tmuxSessionId: string; name: string }[],
): Reconciliation {
	if (record.state === "uncertain") {
		return { action: "uncertain", record, reason: "an earlier outcome could not be established" }
	}
	// Identity is the id we recorded *or* the name we reserved before spawning. The name is the only fact a
	// record saved in the crash window has: requiring `$N` there declared a live child nonexistent.
	const found =
		(record.tmuxSessionId ? live.find((s) => s.tmuxSessionId === record.tmuxSessionId) : undefined) ??
		(record.tmuxName ? live.find((s) => s.name === record.tmuxName) : undefined) ??
		(record.name ? live.find((s) => s.name === record.name) : undefined)
	if (record.state === "ready" || record.state === "spawned") {
		return found
			? { action: "adopt", record, tmuxSessionId: found.tmuxSessionId }
			: { action: "uncertain", record, reason: "the session we recorded is gone" }
	}
	if (record.state === "spawning") {
		// Spawn was attempted and we never learned the outcome: refuse would assert something we do not know.
		return found
			? { action: "adopt", record, tmuxSessionId: found.tmuxSessionId }
			: { action: "uncertain", record, reason: "the spawn may or may not have created a session" }
	}
	if (record.state === "reserved") {
		// Nothing was attempted, so there is nothing to be uncertain about.
		return found
			? { action: "adopt", record, tmuxSessionId: found.tmuxSessionId }
			: { action: "refuse", record, reason: "the spawn was never attempted" }
	}
	return { action: "refuse", record, reason: `nothing to recover from state ${record.state}` }
}
