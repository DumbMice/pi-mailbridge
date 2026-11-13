import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { STATE_VERSION, StateVersionError, assertStateReadable, checkStateVersion } from "../src/store/schema.ts"
import { listPending, addPending, pendingSize } from "../src/store/pending-store.ts"
import { journalSize, journal } from "../src/store/journal.ts"
import { readCursor, advanceCursor } from "../src/store/uid-cursor.ts"

function env(): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "state-schema-"))
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })
	return { XDG_STATE_HOME: dir }
}

function path(e: NodeJS.ProcessEnv, name: string): string {
	return join(e.XDG_STATE_HOME!, "pi-mailbridge", name)
}

test("legacy files without a version are read, and upgraded on the next save", () => {
	// Every file on every existing install predates the field. Refusing them would be a
	// migration cliff.
	const e = env()
	writeFileSync(path(e, "pending.json"), JSON.stringify({ items: [] }))
	writeFileSync(path(e, "uid-cursor.json"), JSON.stringify({ lastUid: 3 }))

	assert.equal(pendingSize(e), 0)
	assert.equal(readCursor(e), 3)
	assert.equal(checkStateVersion("pending.json", { items: [] }), STATE_VERSION)

	addPending(e, { uid: 9, sessionId: "s", from: "y@e.com", subject: "a", body: "b", receivedAt: 1 })
	const written = JSON.parse(readFileSync(path(e, "pending.json"), "utf8")) as { v: number }
	assert.equal(written.v, STATE_VERSION, "the next write stamps the current version")
})

test("every versioned store stamps its file", () => {
	const e = env()
	addPending(e, { uid: 1, sessionId: "s", from: "y@e.com", subject: "a", body: "b", receivedAt: 1 })
	journal(e, 1, 42)
	advanceCursor(e, 5)
	for (const name of ["pending.json", "journal.json", "uid-cursor.json"]) {
		const parsed = JSON.parse(readFileSync(path(e, name), "utf8")) as { v?: number }
		assert.equal(parsed.v, STATE_VERSION, `${name} must carry v`)
	}
})

test("a file from a newer build is refused, not filtered", () => {
	// The failure this prevents: read what you understand, save the rest, lose the difference.
	const e = env()
	writeFileSync(path(e, "pending.json"), JSON.stringify({ v: STATE_VERSION + 1, items: [{ future: true }] }))

	assert.throws(() => pendingSize(e), StateVersionError)
	assert.throws(() => listPending(e), StateVersionError)
	// And the file is untouched by the refusal.
	const before = readFileSync(path(e, "pending.json"), "utf8")
	assert.throws(() => addPending(e, { uid: 2, sessionId: "s", from: "y@e.com", subject: "a", body: "b", receivedAt: 1 }))
	assert.equal(readFileSync(path(e, "pending.json"), "utf8"), before)
})

test("the boot probe names the file and refuses the directory", () => {
	const e = env()
	journal(e, 1, 7)
	writeFileSync(path(e, "journal.json"), JSON.stringify({ v: 99, uids: [1] }))
	assert.throws(
		() => assertStateReadable(e),
		(error: unknown) =>
			error instanceof StateVersionError && /journal\.json/.test(error.message) && /99/.test(error.message),
	)

	// A missing or unparsable file is not a version problem; the stores have their own recovery.
	const clean = env()
	writeFileSync(path(clean, "routes.json"), "{not json")
	assert.doesNotThrow(() => assertStateReadable(clean))
})
