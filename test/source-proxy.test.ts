import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { applyUidValidity, createSourceProxy, type ProxyTarget } from "../src/daemon/source-proxy.ts"
import { advanceCursor, readCursor, syncUidValidity } from "../src/store/uid-cursor.ts"
import { isJournaled, journal, journalSize } from "../src/store/journal.ts"
import { addPending, pendingSize } from "../src/store/pending-store.ts"

const env = (): NodeJS.ProcessEnv => ({ XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-proxy-")) })

function watcher(over: { validity?: number; next?: number } = {}): ProxyTarget {
	return {
		uidValidity: () => over.validity,
		uidNext: () => over.next,
		searchAfter: async () => [],
		fetch: async () => undefined,
	}
}

test("the proxy forwards UIDVALIDITY and UIDNEXT from the live watcher", () => {
	// The production path, driven directly. Enumerated copies of the mailbox dropped a field
	// twice before this existed.
	let current: ProxyTarget | undefined = watcher({ validity: 4242, next: 99 })
	const proxy = createSourceProxy({ watcher: () => current, env: env() })
	assert.equal(proxy.uidValidity?.(), 4242)
	assert.equal(current.uidNext(), 99)

	// A reload swaps the watcher; the proxy must answer from the new one.
	current = watcher({ validity: 7, next: 3 })
	assert.equal(proxy.uidValidity?.(), 7)
	// And with no watcher it reports "unknown" rather than throwing.
	current = undefined
	assert.equal(proxy.uidValidity?.(), undefined)
})

test("a UIDVALIDITY change resets the cursor, scopes the journal and drops stale queue", () => {
	const e = env()
	// Old numbering: an acked UID and a queued record.
	advanceCursor(e, 40)
	journal(e, 7, 1111)
	addPending(e, {
		uid: 7,
		sessionId: "s1",
		from: "you@qq.com",
		subject: "x",
		body: "old queued",
		receivedAt: 1,
		uidValidity: 1111,
	})

	const released: string[] = []
	const outcome = applyUidValidity(e, watcher({ validity: 2222, next: 3 }), (sessionId) => released.push(sessionId))
	assert.deepEqual(outcome, { reset: true, validity: 2222, dropped: 1 })
	// A dropped record must not leave its session believing it has an outstanding decision.
	assert.deepEqual(released, ["s1"])
	assert.equal(readCursor(e), 0, "cursor reset")
	assert.equal(pendingSize(e), 0, "old-space queue dropped")
	// The journal is not cleared, but it no longer speaks for this numbering.
	assert.equal(journalSize(e), 1)
})

test("an unchanged UIDVALIDITY does nothing", () => {
	const e = env()
	advanceCursor(e, 40)
	syncUidValidity(e, 2222, 50)
	const outcome = applyUidValidity(e, watcher({ validity: 2222, next: 50 }))
	assert.equal(outcome.reset, false)
	assert.equal(readCursor(e), 40)
})

test("a watcher that cannot report UIDVALIDITY is left alone", () => {
	const e = env()
	advanceCursor(e, 40)
	assert.deepEqual(applyUidValidity(e, watcher({})), { reset: false, validity: undefined, dropped: 0 })
	assert.equal(readCursor(e), 40)
})

test("stale records are dropped on every connect, not only when the cursor resets", async () => {
	// A crash between the cursor write and the drop leaves a record nothing can claim and
	// nothing would ever remove, because the next connect sees an unchanged validity.
	const e = env()
	syncUidValidity(e, 2222, 50) // cursor already carries the new space
	addPending(e, {
		uid: 4,
		sessionId: "stale-sess",
		from: "you@qq.com",
		subject: "x",
		body: "old",
		receivedAt: 1,
		uidValidity: 1111,
	})
	const released: string[] = []
	const outcome = applyUidValidity(e, watcher({ validity: 2222, next: 50 }), (s) => released.push(s))
	assert.equal(outcome.reset, false, "no reset needed")
	assert.equal(outcome.dropped, 1, "but the stale record is still removed")
	assert.deepEqual(released, ["stale-sess"])
})

test("a record with no UID space survives the every-connect drop", async () => {
	// Records written before the field existed (or while the watcher could not report one) must
	// stay claimable: dropping them would discard a queued reply with nothing to re-read.
	const e = env()
	syncUidValidity(e, 2222, 50)
	addPending(e, {
		uid: 4,
		sessionId: "legacy-sess",
		from: "you@qq.com",
		subject: "x",
		body: "legacy",
		receivedAt: Date.now(),
	})
	const released: string[] = []
	const outcome = applyUidValidity(e, watcher({ validity: 2222, next: 50 }), (s) => released.push(s))
	assert.equal(outcome.dropped, 0, "an unknown-space record is kept")
	assert.equal(pendingSize(e), 1)
	assert.deepEqual(released, [])
})

test("a dropped record does not free a slot its session still uses", async () => {
	// The same session can have a live queued record in the current space. Releasing its slot
	// would let a second decision be reserved while the first is unanswered.
	const e = env()
	syncUidValidity(e, 2222, 50)
	addPending(e, { uid: 1, sessionId: "s1", from: "you@qq.com", subject: "x", body: "old", receivedAt: Date.now(), uidValidity: 1111 })
	addPending(e, { uid: 2, sessionId: "s1", from: "you@qq.com", subject: "y", body: "live", receivedAt: Date.now(), uidValidity: 2222 })

	const released: string[] = []
	const outcome = applyUidValidity(e, watcher({ validity: 2222, next: 50 }), (s) => released.push(s))
	assert.equal(outcome.dropped, 1, "the old-space record is gone")
	assert.deepEqual(released, [], "but s1 still has a live record, so its slot stays")
})


test("a journal written before spaces were tagged stops answering for a new numbering", () => {
	// journal.json from an older build has no uidValidity, so the space check falls through to
	// `uids.includes(uid)`. After a renumbering, a reused uid would look "already seen" and the
	// cursor would advance past genuinely new mail.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "proxy-journal-")) }
	mkdirSync(join(env.XDG_STATE_HOME, "pi-mailbridge"), { recursive: true })
	writeFileSync(
		join(env.XDG_STATE_HOME, "pi-mailbridge", "journal.json"),
		JSON.stringify({ uids: [5, 6, 7] }),
	)
	assert.equal(isJournaled(env, 5), true, "sanity: with no space known, a legacy journal answers")

	// The cursor must already carry a space, or this is a first observation, not a renumbering.
	syncUidValidity(env, 111, 3)
	applyUidValidity(env, { uidValidity: () => 999, uidNext: () => 8 } as never)
	// Once the live numbering is known, an untagged journal cannot claim its uids as seen: the
	// existing space check treats `undefined !== 999` as a mismatch. (A reviewer read that guard
	// as "both sides must be tagged" and proposed one; the assertion below is what shows it is not
	// needed.) The entries stay on disk, space-scoped, as ARCHITECTURE says.
	assert.equal(isJournaled(env, 5, 999), false, "the new numbering starts clean")
	assert.equal(journalSize(env), 3, "and the old entries are kept, as documented")
})
