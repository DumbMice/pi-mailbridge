import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
	CLAIM_TTL_MS,
	PENDING_CAP,
	ackPending,
	addPending,
	claimPending,
	getPending,
	listPending,
	listPendingForSession,
	pendingSize,
} from "../src/store/pending-store.ts"
import { advanceCursor, readCursor, resetCursor } from "../src/store/uid-cursor.ts"
import { statePath } from "../src/store/paths.ts"
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
	assert.equal(ackPending(e, 1, "B").ok, false, "non-claimant ack refused")
	assert.equal(pendingSize(e), 1, "record survives a refused ack")
	const acked = ackPending(e, 1, "A")
	assert.equal(acked.ok, true)
	assert.equal(acked.ok && acked.sessionId, "s1", "the record's session is returned")
	assert.equal(pendingSize(e), 0)
})

test("pending: an unclaimed record cannot be acked", () => {
	// The escape hatch this closes: with two sessions on one machine, any authenticated
	// client could ack - and therefore delete, journal and mark Seen - a reply the victim
	// had not claimed yet. Nothing re-reads it, so the mail was simply lost.
	const e = env()
	addPending(e, rec(1))
	assert.deepEqual(ackPending(e, 1, "anyone"), { ok: false, reason: "not-claimed" })
	assert.equal(pendingSize(e), 1, "the unclaimed reply must survive")
	assert.equal(ackPending(e, 1, "anyone").ok, false)
	assert.equal(pendingSize(e), 1)
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

// --- session threading -----------------------------------------------------

test("sessionThread reports the root and the latest message id", async () => {
	const { recordOutbound, sessionThread } = await import("../src/store/threads.ts")
	const e = env()
	recordOutbound(e, { messageId: "<a@qq.com>", sessionId: "s1", subject: "one" })
	recordOutbound(e, { messageId: "<b@qq.com>", sessionId: "s1", subject: "two" })
	recordOutbound(e, { messageId: "<c@qq.com>", sessionId: "s2", subject: "other" })

	assert.deepEqual(sessionThread(e, "s1"), { rootMessageId: "a@qq.com", lastMessageId: "b@qq.com" })
	assert.deepEqual(sessionThread(e, "s2"), { rootMessageId: "c@qq.com", lastMessageId: "c@qq.com" })
	assert.deepEqual(sessionThread(e, "unknown"), {})
})

test("pending: a full store refuses new records instead of dropping old ones", () => {
	// The old save() sliced from the front, and those records were already accepted and
	// unjournalled - they vanished with no log and no way to recover them.
	const e = env()
	for (let uid = 1; uid <= PENDING_CAP; uid++) addPending(e, rec(uid))
	assert.equal(pendingSize(e), PENDING_CAP)

	const refused = addPending(e, rec(PENDING_CAP + 1))
	assert.deepEqual(refused, { ok: false, reason: "full" })
	assert.equal(pendingSize(e), PENDING_CAP, "nothing was discarded to make room")
	assert.ok(getPending(e, 1), "the oldest record survives")
	assert.equal(getPending(e, PENDING_CAP + 1), undefined)
})

test("pending: replaying an existing uid is allowed even at the cap", () => {
	const e = env()
	for (let uid = 1; uid <= PENDING_CAP; uid++) addPending(e, rec(uid))
	const replaced = addPending(e, { ...rec(5), body: "edited" })
	assert.equal(replaced.ok, true)
	assert.equal(getPending(e, 5)?.body, "edited")
	assert.equal(pendingSize(e), PENDING_CAP)
})

test("an over-cap file on disk is preserved, not trimmed on the next write", () => {
	// The old save() sliced from the front. addPending now refuses at the cap, so the trim
	// is unreachable from the public API - which is exactly why the invariant needs a test
	// that writes the file directly.
	const e = env()
	const records = Array.from({ length: PENDING_CAP + 5 }, (_, i) => rec(i + 1))
	const file = statePath(e, "pending.json")
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, JSON.stringify({ items: records }))
	assert.equal(pendingSize(e), PENDING_CAP + 5, "reading does not trim")

	claimPending(e, 1, "A")
	ackPending(e, 1, "A")
	assert.equal(pendingSize(e), PENDING_CAP + 4, "an ack removes exactly one record")
	assert.ok(getPending(e, 2), "the oldest remaining record is still there")
})

test("uid cursor: a changed UIDVALIDITY resets it, an unchanged one does not", async () => {
	const { syncUidValidity } = await import("../src/store/uid-cursor.ts")
	const e = env()
	advanceCursor(e, 500)
	// First observation just records the value - an upgrade must not re-scan the mailbox.
	assert.equal(syncUidValidity(e, 1234), false)
	assert.equal(readCursor(e), 500)
	// Same value: nothing to do.
	assert.equal(syncUidValidity(e, 1234), false)
	assert.equal(readCursor(e), 500)
	// A recreated folder renumbers from 1: reset, or every future message is skipped.
	assert.equal(syncUidValidity(e, 5678), true)
	assert.equal(readCursor(e), 0)
	// Unknown validity changes nothing.
	assert.equal(syncUidValidity(e, undefined), false)
})

test("journal: a UIDVALIDITY change does not let an old journal suppress new mail", async () => {
	// The reset exists because the folder was renumbered. A journal keyed on bare UIDs then
	// speaks for a space it knows nothing about, and the first N new replies are skipped as
	// "already acked" - silent loss in the exact event the reset handles.
	const { isJournaled, journal, journalSize } = await import("../src/store/journal.ts")
	const e = env()
	for (const uid of [1, 2, 3]) journal(e, uid, 1111)
	assert.equal(journalSize(e), 3)
	assert.equal(isJournaled(e, 1, 1111), true, "same space still dedupes")

	// New numbering: nothing is suppressed.
	assert.equal(isJournaled(e, 1, 2222), false)
	assert.equal(isJournaled(e, 2, 2222), false)
	assert.equal(isJournaled(e, 3, 2222), false)

	// Writing in the new space starts a fresh journal rather than mixing the two.
	journal(e, 1, 2222)
	assert.equal(journalSize(e), 1)
	assert.equal(isJournaled(e, 2, 2222), false)
})

test("a re-indexed mailbox does not let an old UID collide with a new one", async () => {
	// Records are keyed by UID. After a renumbering, new mail at UID 7 would replace a queued
	// reply that was also UID 7 in the old space - silently discarding it.
	const { dropPendingFromOtherSpaces } = await import("../src/store/pending-store.ts")
	const e = env()
	addPending(e, { ...rec(7), uidValidity: 1111 })
	addPending(e, { ...rec(8), uidValidity: 1111 })
	addPending(e, { ...rec(9), uidValidity: 2222 })
	assert.equal(pendingSize(e), 3)

	assert.equal(dropPendingFromOtherSpaces(e, 2222), 2, "both old-space records are dropped")
	assert.equal(pendingSize(e), 1)
	assert.equal(getPending(e, 9)?.uidValidity, 2222)
})

test("uid cursor: a first observation resets when the cursor is outside the new UID space", async () => {
	// Upgrading from a cursor file with no UIDVALIDITY normally keeps the cursor. But a cursor
	// at or past the mailbox's next UID cannot belong to this numbering - the folder was
	// renumbered while we were not watching, and keeping it would skip everything for ever.
	const { syncUidValidity } = await import("../src/store/uid-cursor.ts")
	const e = env()
	advanceCursor(e, 500)
	assert.equal(syncUidValidity(e, 1234, 800), false, "cursor inside the space: keep it")

	const e2 = env()
	advanceCursor(e2, 500)
	assert.equal(syncUidValidity(e2, 1234, 120), true, "cursor past uidNext: reset")
	assert.equal(readCursor(e2), 0)
})
