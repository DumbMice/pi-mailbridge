// Two cursors over one mailbox, and no shared writes.
//
// The starter must not move the daemon's cursor, and the daemon's UIDVALIDITY check must not delete
// records on the starter's behalf. That is only true if the cursor's file is a parameter.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCursorStore, daemonCursor, readCursor } from "../src/store/uid-cursor.ts"
import { statePath } from "../src/store/paths.ts"

const env = () => ({ XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-cursor-")) })

test("the starter's cursor is a different file and moves independently", () => {
	const e = env()
	const starter = createCursorStore("starter-cursor.json")

	daemonCursor.advance(e, 42)
	starter.advance(e, 7)

	assert.equal(readCursor(e), 42, "the daemon's cursor is untouched by the starter")
	assert.equal(starter.read(e), 7)
	assert.equal(JSON.parse(readFileSync(statePath(e, "uid-cursor.json"), "utf8")).lastUid, 42)
	assert.equal(JSON.parse(readFileSync(statePath(e, "starter-cursor.json"), "utf8")).lastUid, 7)
})

test("a UIDVALIDITY reset on one store does not reset the other", () => {
	const e = env()
	const starter = createCursorStore("starter-cursor.json")
	starter.sync(e, 1111)
	starter.advance(e, 30)
	daemonCursor.sync(e, 2222)
	daemonCursor.advance(e, 99)

	assert.equal(starter.sync(e, 3333), true, "the starter's space changed, so its cursor resets")
	assert.equal(starter.read(e), 0)
	assert.equal(readCursor(e), 99, "and the daemon keeps its own UID space and cursor")
})

test("both stores share the state-file discipline", () => {
	const e = env()
	const starter = createCursorStore("starter-cursor.json")
	starter.markPrimed(e)
	assert.equal(starter.isPrimed(e), true)
	assert.equal(daemonCursor.isPrimed(e), false, "priming one watcher says nothing about the other")
	starter.advance(e, 5)
	assert.equal(starter.read(e), 5, "primed survives an advance")
	assert.equal(starter.advance(e, 3), 5, "and the cursor is monotonic")
	starter.reset(e, 1)
	assert.equal(starter.read(e), 1)
})
