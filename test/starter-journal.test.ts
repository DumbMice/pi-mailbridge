// The starter's journal: the file that decides whether a mail has already been acted on.
//
// Every case here is a way the feature could start a second session for one request, or lose track of one
// it started.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
	JOURNAL_DEFAULTS,
	JournalUntrustedError,
	type RequestRecord,
	alreadySeen,
	isStale,
	readJournal,
	reconcile,
	writeJournal,
} from "../src/starter/journal.ts"
import { statePath } from "../src/store/paths.ts"

const env = () => ({ XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-journal-")) })
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

test("caps evict the oldest terminal record, not a live one", () => {
	const e = env()
	const now = 1_700_000_000_000
	const requests: Record<string, RequestRecord> = {}
	for (let i = 0; i < 6; i++) {
		requests[`ref${i}`] = record({ id: `ref${i}`, messageId: `r${i}@x`, state: "refused", at: now - i })
	}
	requests.live = record({ id: "live", messageId: "live@x", state: "ready", at: now - 999 })
	const written = writeJournal(e, { requests, sessions: {} }, { ...JOURNAL_DEFAULTS, maxRequests: 3 }, now)
	assert.equal(Object.keys(written.requests).length, 3)
	assert.ok(written.requests.live, "the live record survives the cap")
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
