// The starter's journal: the file that decides whether a mail has already been acted on.
//
// Every case here is a way the feature could start a second session for one request, or lose track of one
// it started.

import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
	JOURNAL_DEFAULTS,
	JournalFullError,
	JournalUntrustedError,
	type JournalFile,
	type RequestRecord,
	alreadySeen,
	isStale,
	mergeJournals,
	readJournal,
	reconcile,
	writeJournal,
} from "../src/starter/journal.ts"
import { statePath } from "../src/store/paths.ts"

const env = () => ({ XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-journal-")) })
const freshEnv = env
const filePath = (e: NodeJS.ProcessEnv) => statePath(e, "starter-journal.json")
const record = (over: Partial<RequestRecord> = {}): RequestRecord => ({
	id: "req-1",
	messageId: "m1@example.com",
	uid: 10,
	uidValidity: 1000,
	receivedAt: 1_700_000_000_000,
	state: "reserved",
	at: 1_700_000_000_000,
	...over,
})

test("a fresh journal is empty and a written one round-trips", () => {
	const e = env()
	assert.deepEqual(readJournal(e), { v: 1, requests: {}, sessions: {} })
	const written = writeJournal(e, { requests: { "req-1": record() }, sessions: {} })
	assert.equal(written.requests["req-1"]?.state, "reserved")
	assert.deepEqual(readJournal(e), written, "and it reads back identical")
})

test("dedupe is by Message-ID and by UID within a UID space", () => {
	const e = env()
	const journal = { requests: { "req-1": record() }, sessions: {} }
	writeJournal(e, journal)
	const read = readJournal(e)
	assert.ok(alreadySeen(read, { messageId: "m1@example.com", uid: 999 }), "same Message-ID, different uid")
	assert.ok(alreadySeen(read, { messageId: "other@example.com", uid: 10, uidValidity: 1000 }), "same uid space")
	// A renumbering gives the same uid a different meaning; that mail is new.
	assert.equal(alreadySeen(read, { messageId: "other@example.com", uid: 10, uidValidity: 2000 }), undefined)
})

test("freshness is the mail's age, and zero disables it", () => {
	const now = 1_700_000_000_000
	const old = { receivedAt: now - 49 * 60 * 60 * 1000 }
	assert.equal(isStale(old, now, 48), true)
	assert.equal(isStale(old, now, 72), false)
	assert.equal(isStale(old, now, 0), false, "0 means no age limit")
})

test("retention prunes terminal records and never a live one", () => {
	const e = env()
	const now = 1_700_000_000_000
	const old = now - 49 * 60 * 60 * 1000
	const written = writeJournal(
		e,
		{
			requests: {
				refused: record({ id: "r1", messageId: "a@x", state: "refused", at: old }),
				ready: record({ id: "r2", messageId: "b@x", state: "ready", at: old }),
				uncertain: record({ id: "r3", messageId: "c@x", state: "uncertain", at: old }),
				fresh: record({ id: "r4", messageId: "d@x", state: "refused", at: now }),
			},
			sessions: {},
		},
		JOURNAL_DEFAULTS,
		now,
	)
	assert.deepEqual(Object.keys(written.requests).sort(), ["fresh", "ready", "uncertain"], "only the old refusal went")
	assert.equal(readJournal(e).requests.ready?.state, "ready", "a live request is never evicted")
})

test("caps never forget a record that is still replayable, and never drop a live one", () => {
	const e = env()
	const now = 1_700_000_000_000
	const day = 24 * 60 * 60 * 1000
	const requests: Record<string, RequestRecord> = {}
	// Inside the horizon: evicting these would let old mail run again, so the write refuses instead.
	for (let i = 0; i < 6; i++) {
		requests[`ref${i}`] = record({ id: `ref${i}`, messageId: `r${i}@x`, state: "refused", at: now - i })
	}
	requests.live = record({ id: "live", messageId: "live@x", state: "ready", at: now - 999 })
	assert.throws(
		() => writeJournal(e, { requests, sessions: {} }, { ...JOURNAL_DEFAULTS, maxRequests: 3 }, now),
		/still replayable/,
	)

	// Past the horizon they are prunable, so the count fits and the live record is untouched.
	const aged: Record<string, RequestRecord> = {}
	for (let i = 0; i < 6; i++) {
		aged[`ref${i}`] = record({ id: `ref${i}`, messageId: `r${i}@x`, state: "refused", at: now - 10 * day })
	}
	aged.live = record({ id: "live", messageId: "live@x", state: "ready", at: now - 999 })
	const written = writeJournal(e, { requests: aged, sessions: {} }, { ...JOURNAL_DEFAULTS, maxRequests: 3 }, now)
	assert.deepEqual(Object.keys(written.requests), ["live"])
})

test("an unreadable journal fails closed, without rewriting it", () => {
	const e = env()
	mkdirSync(join(e.XDG_STATE_HOME, "pi-mailbridge"), { recursive: true })
	writeFileSync(statePath(e, "starter-journal.json"), "not json at all")
	assert.throws(() => readJournal(e), JournalUntrustedError)
	const backups = readdirSync(join(e.XDG_STATE_HOME, "pi-mailbridge")).filter((f) => f.includes(".corrupt-"))
	assert.equal(backups.length, 1, "the bytes are kept for inspection")
	assert.equal(readFileSync(join(e.XDG_STATE_HOME, "pi-mailbridge", backups[0]!), "utf8"), "not json at all")
})

test("a read failure is not corruption: it propagates and the file stays", () => {
	const e = env()
	mkdirSync(join(e.XDG_STATE_HOME, "pi-mailbridge"), { recursive: true })
	mkdirSync(statePath(e, "starter-journal.json"))
	assert.throws(() => readJournal(e), JournalUntrustedError)
	assert.equal(readdirSync(join(e.XDG_STATE_HOME, "pi-mailbridge")).some((f) => f.includes(".corrupt-")), false)
})

test("reconciliation: adopt what started, refuse what did not, never respawn uncertainty", () => {
	const live = [{ tmuxSessionId: "$4", name: "fix-auth" }]

	const reservedStarted = reconcile(record({ state: "reserved", tmuxSessionId: "$4" }), live)
	assert.equal(reservedStarted.action, "adopt", "the spawn won the race")

	const reservedNotStarted = reconcile(record({ state: "reserved", tmuxSessionId: "$5" }), live)
	assert.equal(reservedNotStarted.action, "refuse", "nothing was created")

	const readyGone = reconcile(record({ state: "ready", tmuxSessionId: "$9" }), live)
	assert.equal(readyGone.action, "uncertain", "a session we recorded is gone")

	const uncertain = reconcile(record({ state: "uncertain" }), live)
	assert.equal(uncertain.action, "uncertain", "and is never auto-respawned")
})

test("result delivery is tracked separately from execution", () => {
	const e = env()
	writeJournal(e, { requests: { "req-1": record({ state: "ready" }) }, sessions: {} })
	const first = readJournal(e)
	assert.equal(first.requests["req-1"]?.state, "ready")
	assert.equal(first.requests["req-1"]?.resultSent, undefined, "unsent is the absence of the flag")
	first.requests["req-1"]!.resultSent = true
	writeJournal(e, first)
	assert.equal(readJournal(e).requests["req-1"]?.resultSent, true)
})

test("an unknown state on disk is treated as uncertain, never as ready to run", () => {
	const e = env()
	mkdirSync(join(e.XDG_STATE_HOME, "pi-mailbridge"), { recursive: true })
	writeFileSync(
		statePath(e, "starter-journal.json"),
		JSON.stringify({ v: 1, requests: { r: { ...record(), state: "wild" } }, sessions: {} }),
	)
	assert.equal(readJournal(e).requests.r?.state, "uncertain")
})

test("a corrupt journal stays untrusted across restarts until it is repaired", () => {
	// Renaming the bad file away made the next start see no journal and accept an empty one. The marker is
	// what makes "do not run" outlive a single process.
	const env = freshEnv()
	const file = filePath(env)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, "{not json", { mode: 0o600 })
	assert.throws(() => readJournal(env), /not valid JSON/)
	assert.throws(() => readJournal(env), /marked untrusted/, "the second start must still refuse")
	assert.throws(() => readJournal(env), /starter repair/, "and say how to repair it")
})

test("a malformed record is refused, not silently forgotten", () => {
	// Dropping the entry changed what recovery knows, in the accepting direction.
	const env = freshEnv()
	const file = filePath(env)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, JSON.stringify({ v: 1, requests: { broken: { id: 42 } }, sessions: {} }), { mode: 0o600 })
	assert.throws(() => readJournal(env), /malformed request: broken/)
})

test("a tombstone outlives the acceptance horizon, so old mail is still a replay", () => {
	// 49 hours after it ended, with a 72-hour horizon: pruning the record reopened the mail.
	const env = freshEnv()
	const now = Date.now()
	const ended = now - 49 * 60 * 60 * 1000
	const journal: JournalFile = {
		v: 1,
		requests: {
			old: { id: "old", messageId: "<old@x>", uid: 1, receivedAt: ended, state: "ended", at: ended },
		},
		sessions: {},
	}
	const written = writeJournal(env, journal, { ...JOURNAL_DEFAULTS, requestMaxAgeHours: 72 }, now)
	assert.ok(written.requests.old, "still there, so the same mail is recognised")
	const again = readJournal(env)
	assert.equal(again.requests.old?.messageId, "<old@x>")
})

test("count pressure refuses admission rather than evicting replayable history", () => {
	const env = freshEnv()
	const journal: JournalFile = {
		v: 1,
		requests: {
			a: { id: "a", messageId: "<a@x>", uid: 1, receivedAt: 1, state: "ended", at: 1 },
			b: { id: "b", messageId: "<b@x>", uid: 2, receivedAt: 1, state: "ended", at: 1 },
		},
		sessions: {},
	}
	assert.throws(
		() => writeJournal(env, journal, { ...JOURNAL_DEFAULTS, maxRequests: 1, requestMaxAgeHours: 0 }, Date.now()),
		/Journal at its limit|at its limit/,
	)
})

test("merging keeps both writers' entries and lets the newer one win", () => {
	// The runner and the CLI stop each own part of this file; a plain overwrite lost one of them.
	const disk: JournalFile = {
		v: 1,
		requests: {
			a: record({ id: "a", messageId: "<a@x>", state: "ended", at: 50 }),
			b: record({ id: "b", messageId: "<b@x>", state: "ready", at: 10 }),
		},
		sessions: { gone: { name: "gone", tmuxSessionId: "$1", piSessionId: "pi", requestId: "a", cwd: "/tmp", at: 1, endedAt: 50 } },
	}
	const mine: JournalFile = {
		v: 1,
		requests: {
			// The in-memory view still thinks `a` is ready, and has a brand-new reservation `c`.
			a: record({ id: "a", messageId: "<a@x>", state: "ready", at: 5 }),
			c: record({ id: "c", messageId: "<c@x>", state: "reserved", at: 60 }),
		},
		sessions: {},
	}
	const merged = mergeJournals(disk, mine)
	assert.equal(merged.requests.a?.state, "ended", "the stop is newer than the stale in-memory view")
	assert.equal(merged.requests.b?.state, "ready", "the runner's record the CLI never saw survives")
	assert.equal(merged.requests.c?.state, "reserved", "and the new reservation is not erased")
	assert.equal(merged.sessions.gone?.endedAt, 50)
})

test("a present-but-wrong journal section is corruption, not an empty one", () => {
	const env = freshEnv()
	mkdirSync(dirname(filePath(env)), { recursive: true })
	writeFileSync(filePath(env), JSON.stringify({ v: 1, requests: [], sessions: {} }), { mode: 0o600 })
	assert.throws(() => readJournal(env), /`requests` is not an object/)
})

test("a marker that cannot be written leaves the corrupt journal in place", () => {
	// Marker-before-rename: if the marker write fails (ENOSPC), the original must not have moved, or the
	// next start finds neither and accepts an empty journal.
	const env = freshEnv()
	const file = filePath(env)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, "{not json", { mode: 0o600 })
	// A read-only directory makes both the marker write and the rename fail deterministically.
	chmodSync(dirname(file), 0o500)
	assert.throws(() => readJournal(env), /could not be set aside/)
	assert.equal(existsSync(file), true, "the corrupt bytes are still where they were")
	assert.equal(readFileSync(file, "utf8"), "{not json")
	chmodSync(dirname(file), 0o700)
})

test("delivery evidence survives a merge with a newer in-memory record", () => {
	// During SMTP a CLI stop can write a newer ready/unsent record; the flush's resultSent:true carried an
	// older timestamp, lost the merge, and the result was mailed again.
	const disk: JournalFile = {
		v: 1,
		requests: { r: { id: "r", messageId: "<r@x>", uid: 1, receivedAt: 1, state: "ready", at: 99, resultSent: true } },
		sessions: {},
	}
	const mine: JournalFile = {
		v: 1,
		requests: { r: { id: "r", messageId: "<r@x>", uid: 1, receivedAt: 1, state: "ready", at: 100 } },
		sessions: {},
	}
	assert.equal(mergeJournals(disk, mine).requests.r?.resultSent, true)
})

test("an ended session is retained while its result is still owed", () => {
	// Pruning the session removed the evidence settlement needs, so the request stayed ready for ever.
	const env = freshEnv()
	const now = Date.now()
	const old = now - 365 * 24 * 60 * 60 * 1000
	const journal: JournalFile = {
		v: 1,
		requests: { r: { id: "r", messageId: "<r@x>", uid: 1, receivedAt: old, state: "ready", at: old } },
		sessions: { s: { name: "s", tmuxSessionId: "$1", piSessionId: "pi", requestId: "r", cwd: "/tmp", at: old, endedAt: old } },
	}
	const written = writeJournal(env, journal, JOURNAL_DEFAULTS, now)
	assert.ok(written.sessions.s, "the session is kept while delivery is owed")
	journal.requests.r = { ...journal.requests.r!, resultSent: true, state: "ended" }
	const after = writeJournal(env, journal, JOURNAL_DEFAULTS, now)
	assert.equal(after.sessions.s, undefined, "and it is prunable once the result went out")
})

test("count pressure does not evict the session evidence an owed result needs", () => {
	// The age rule protected it; `cap` then evicted it anyway, and settlement lost the fact the session ended.
	const env = freshEnv()
	const now = Date.now()
	// All three are inside the retention window, so only the cap can remove one: age pruning must not be
	// what makes this pass.
	const journal: JournalFile = {
		v: 1,
		requests: {
			owed: { id: "owed", messageId: "<o@x>", uid: 1, receivedAt: now, state: "ready", at: now },
			live: { id: "live", messageId: "<l@x>", uid: 2, receivedAt: now, state: "ready", at: now },
			gone: { id: "gone", messageId: "<g@x>", uid: 3, receivedAt: now, state: "ended", at: now, resultSent: true },
		},
		sessions: {
			owed: { name: "owed", tmuxSessionId: "$1", piSessionId: "pi", requestId: "owed", cwd: "/tmp", at: now, endedAt: now },
			live: { name: "live", tmuxSessionId: "$2", piSessionId: "pi2", requestId: "live", cwd: "/tmp", at: now },
			settled: { name: "settled", tmuxSessionId: "$3", piSessionId: "pi3", requestId: "gone", cwd: "/tmp", at: now, endedAt: now },
		},
	}
	const written = writeJournal(env, journal, { ...JOURNAL_DEFAULTS, maxSessions: 2 }, now)
	assert.ok(written.sessions.owed, "the owed session survives the cap")
	assert.ok(written.sessions.live, "a live session is never evicted")
	assert.equal(written.sessions.settled, undefined, "a settled one may go")
})

