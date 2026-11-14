import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
	ATTACHMENT_DIR_MAX_BYTES,
	attachmentRoot,
	pruneInboundFiles,
	safeName,
	saveInboundFiles,
} from "../src/store/attachment-files.ts"

const env = () => ({ XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-files-")) })

test("a document is written under the state dir, 0600, and its path returned", () => {
	const e = env()
	const saved = saveInboundFiles(e, { uid: 42, uidValidity: 7 }, [
		{ name: "deck.pptx", mimeType: "application/vnd.ms-powerpoint", size: 5, content: Buffer.from("hello") },
	])
	assert.equal(saved.length, 1)
	assert.equal(saved[0]!.name, "deck.pptx")
	assert.ok(saved[0]!.path.startsWith(attachmentRoot(e)), "inside the attachment root")
	assert.equal(readFileSync(saved[0]!.path, "utf8"), "hello")
	assert.equal(statSync(saved[0]!.path).mode & 0o777, 0o600, "not world-readable")
})

test("a hostile filename cannot leave the directory or overwrite a sibling", () => {
	const e = env()
	const saved = saveInboundFiles(e, { uid: 1 }, [
		{ name: "../../etc/passwd", mimeType: "application/pdf", size: 1, content: Buffer.from("a") },
		{ name: "report.pdf", mimeType: "application/pdf", size: 1, content: Buffer.from("b") },
		{ name: "report.pdf", mimeType: "application/pdf", size: 1, content: Buffer.from("c") },
	])
	assert.equal(saved.length, 3)
	for (const file of saved) {
		assert.equal(join(attachmentRoot(e), "0-1"), join(file.path, ".."), `${file.path} stays in its message dir`)
	}
	assert.deepEqual(
		saved.map((f) => f.name),
		["passwd", "report.pdf", "report-2.pdf"],
		"traversal stripped, duplicates suffixed rather than overwritten",
	)
	assert.equal(readFileSync(saved[1]!.path, "utf8"), "b", "the first report survived")
	assert.equal(readFileSync(saved[2]!.path, "utf8"), "c", "and the second is beside it")
})

test("safeName keeps the extension and drops control characters", () => {
	assert.equal(safeName("Quarterly Report.pdf", "x"), "Quarterly Report.pdf")
	assert.equal(safeName("a\u0000b\u001f.pdf", "x"), "a-b-.pdf")
	assert.equal(safeName("...hidden", "x"), "hidden")
	assert.equal(safeName("", "file-1"), "file-1")
	assert.ok(safeName("n".repeat(500) + ".pdf", "x").length <= 120)
})

test("old documents are pruned, and the directory is bounded in bytes", () => {
	const e = env()
	const old = saveInboundFiles(e, { uid: 1, uidValidity: 1 }, [
		{ name: "old.pdf", mimeType: "application/pdf", size: 4, content: Buffer.from("1234") },
	])
	const fresh = saveInboundFiles(e, { uid: 2, uidValidity: 1 }, [
		{ name: "new.pdf", mimeType: "application/pdf", size: 4, content: Buffer.from("1234") },
	])
	// Age the first message's file well past the ceiling; pruning removes the whole directory.
	const oldDir = dirname(old[0]!.path)
	const ancient = new Date(Date.now() - 30 * 24 * 3600_000)
	utimesSync(old[0]!.path, ancient, ancient)

	assert.equal(pruneInboundFiles(e, { now: Date.now() }), 1, "the aged one goes")
	assert.ok(!existsSync(old[0]!.path), "the file is gone")
	assert.ok(!existsSync(oldDir), "and its directory with it")
	assert.ok(existsSync(fresh[0]!.path), "the fresh one stays")

	// Byte ceiling: two more files, then a cap that only fits one.
	saveInboundFiles(e, { uid: 3 }, [{ name: "big.pdf", mimeType: "application/pdf", size: 1, content: Buffer.from("x") }])
	const before = readdirSync(attachmentRoot(e)).length
	assert.ok(before >= 2)
	pruneInboundFiles(e, { maxBytes: 1 })
	assert.ok(readdirSync(attachmentRoot(e)).length < before, "pruned down to the byte ceiling")
	assert.ok(ATTACHMENT_DIR_MAX_BYTES > 0)
})

test("re-scanning the same UID does not accumulate copies", () => {
	// A crash before the cursor moved re-scans the same message; the directory is reused, so the
	// file is overwritten rather than duplicated.
	const e = env()
	const files = [{ name: "a.pdf", mimeType: "application/pdf", size: 1, content: Buffer.from("1") }]
	saveInboundFiles(e, { uid: 9 }, files)
	saveInboundFiles(e, { uid: 9 }, files)
	const dir = join(attachmentRoot(e), "0-9")
	assert.deepEqual(readdirSync(dir), ["a.pdf"])
})
