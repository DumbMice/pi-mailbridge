import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
	CLAIM_TTL_MS,
	ackPending,
	addPending,
	claimPending,
	getPending,
	listPending,
	listPendingForSession,
	pendingSize,
} from "../src/store/pending-store.ts"
import { advanceCursor, readCursor, resetCursor } from "../src/store/uid-cursor.ts"
import { isJournaled, journal, journalSize } from "../src/store/journal.ts"

function env(): NodeJS.ProcessEnv {
	return { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-")) }
}

const rec = (uid: number, sessionId = "s1") => ({
	uid,
	sessionId,
	from: "you@example.com",
	subject: "re",
	body: "do it",
	receivedAt: 1,
})

test("pending: add, read, list by session", () => {
	const e = env()
	addPending(e, rec(1, "s1"))
	addPending(e, rec(2, "s2"))
	assert.equal(pendingSize(e), 2)
	assert.equal(getPending(e, 2)?.sessionId, "s2")
	assert.deepEqual(listPendingForSession(e, "s2").map((r) => r.uid), [2])
})

test("pending: add is idempotent on replay (same uid replaces)", () => {
	const e = env()
	addPending(e, rec(1))
	addPending(e, { ...rec(1), body: "second" })
	assert.equal(pendingSize(e), 1)
	assert.equal(getPending(e, 1)?.body, "second")
})

test("pending: claim is exclusive, re-claim by same instance is fine", () => {
	const e = env()
	addPending(e, rec(1))
	assert.deepEqual(claimPending(e, 1, "A"), { ok: true })
	assert.deepEqual(claimPending(e, 1, "A"), { ok: true })
	assert.deepEqual(claimPending(e, 1, "B"), { ok: false, reason: "claimed-by-other" })
	assert.deepEqual(claimPending(e, 99, "A"), { ok: false, reason: "not-found" })
})

test("pending: an abandoned claim expires and may be re-taken", () => {
	const e = env()
	addPending(e, rec(1))
	const t0 = 1_000_000
	claimPending(e, 1, "A", t0)
	// Still held just before the TTL.
	assert.deepEqual(claimPending(e, 1, "B", t0 + CLAIM_TTL_MS - 1), { ok: false, reason: "claimed-by-other" })
	// Expired: another instance may take over.
	assert.deepEqual(claimPending(e, 1, "B", t0 + CLAIM_TTL_MS + 1), { ok: true })
})

test("pending: only the claimant may ack", () => {
	const e = env()
	addPending(e, rec(1))
	claimPending(e, 1, "A")
	assert.equal(ackPending(e, 1, "B"), false, "non-claimant ack refused")
	assert.equal(pendingSize(e), 1, "record survives a refused ack")
	assert.equal(ackPending(e, 1, "A"), true)
	assert.equal(pendingSize(e), 0)
})

test("uid cursor: monotonic, never moves backwards", () => {
	const e = env()
	assert.equal(readCursor(e), 0)
	assert.equal(advanceCursor(e, 10), 10)
	assert.equal(advanceCursor(e, 5), 10, "lower uid is ignored")
	assert.equal(readCursor(e), 10)
	assert.equal(advanceCursor(e, 11), 11)
})

test("uid cursor: corrupt file degrades to 0 instead of throwing", () => {
	const e = env()
	resetCursor(e, 7)
	assert.equal(readCursor(e), 7)
	e.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "pmb-"))
	assert.equal(readCursor(e), 0)
})

test("journal: dedupes and reports first-insert", () => {
	const e = env()
	assert.equal(isJournaled(e, 5), false)
	assert.equal(journal(e, 5), true)
	assert.equal(journal(e, 5), false, "second insert is a no-op")
	assert.equal(isJournaled(e, 5), true)
	assert.equal(journalSize(e), 1)
})

test("stores are isolated per state dir", () => {
	const a = env()
	const b = env()
	addPending(a, rec(1))
	journal(a, 1)
	advanceCursor(a, 1)
	assert.equal(listPending(b).length, 0)
	assert.equal(isJournaled(b, 1), false)
	assert.equal(readCursor(b), 0)
})
