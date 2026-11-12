import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { applyUidValidity, createSourceProxy, type ProxyTarget } from "../src/daemon/source-proxy.ts"
import { advanceCursor, readCursor, syncUidValidity } from "../src/store/uid-cursor.ts"
import { journal, journalSize } from "../src/store/journal.ts"
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
