import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MAX_FILES_TOTAL_BYTES } from "../src/core/attachments.ts"
import { MAX_MESSAGE_BYTES } from "../src/daemon/watcher.ts"
import {
	MAX_ATTACHMENTS,
	MAX_FILES,
	MAX_FILE_BYTES,
	MAX_NAME_CHARS,
	MAX_TOTAL_BYTES,
	normalizeMime,
	selectAttachments,
	toUserContent,
	type InboundAttachment,
	type RawAttachment,
} from "../src/core/attachments.ts"
import { addPending, listPending } from "../src/store/pending-store.ts"

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
const raw = (over: Partial<RawAttachment> = {}): RawAttachment => ({ filename: "shot.png", contentType: "image/png", content: png, ...over })

test("normalizeMime strips parameters and lowercases", () => {
	assert.equal(normalizeMime("text/plain; charset=utf-8"), "text/plain")
	assert.equal(normalizeMime("IMAGE/PNG"), "image/png")
	assert.equal(normalizeMime(undefined), "")
})

test("an allowed image is accepted", () => {
	const { accepted, dropped } = selectAttachments([raw()])
	assert.equal(accepted.length, 1)
	assert.deepEqual(dropped, [])
	assert.equal(accepted[0]!.mimeType, "image/png")
	assert.equal(accepted[0]!.name, "shot.png")
	assert.equal(accepted[0]!.size, png.length)
	assert.equal(accepted[0]!.data, png.toString("base64"))
})

test("a disallowed mime is dropped with a reason, not silently", () => {
	const { accepted, dropped } = selectAttachments([raw({ filename: "evil.exe", contentType: "application/x-msdownload" })])
	assert.equal(accepted.length, 0)
	assert.deepEqual(dropped, [{ name: "evil.exe", reason: "mime-not-allowed" }])
})

test("mime check happens before the count cap", () => {
	const items = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) =>
		raw({ filename: `f${i}.${i === 0 ? "exe" : "png"}`, contentType: i === 0 ? "application/x-msdownload" : "image/png" }),
	)
	const { accepted, files, dropped } = selectAttachments(items)
	assert.equal(accepted.length, MAX_ATTACHMENTS)
	assert.equal(files.length, 0)
	assert.equal(dropped[0]!.reason, "mime-not-allowed", "first rejection is the bad mime")
	assert.ok(dropped.some((d) => d.reason === "too-many"))
})

test("an image over the inline cap becomes a file instead of being dropped", () => {
	// A 5 MB phone photo cannot be an image part, but it is still a legitimate document - the
	// agent's own read tool can open it. Discarding the human's only attachment was the old
	// behaviour and it lost the reply.
	const big = Buffer.alloc(MAX_TOTAL_BYTES - 10, 1)
	const extra = Buffer.alloc(MAX_TOTAL_BYTES, 2)
	const { accepted, files, dropped } = selectAttachments([
		raw({ filename: "big.png", content: big }),
		raw({ filename: "extra.png", content: extra }),
	])
	assert.equal(accepted.length, 1, "the first is inlined")
	assert.deepEqual(files.map((f) => f.name), ["extra.png"], "the second is handed over as a file")
	assert.deepEqual(dropped, [])
})

test("a PDF is a file, and a presentation too", () => {
	// The reason this feature exists: a reply carrying a deck has to reach the agent.
	const { accepted, files, dropped } = selectAttachments([
		raw({ filename: "report.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.7\n") }),
		raw({
			filename: "deck.pptx",
			contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			content: Buffer.alloc(5_000_000, 2),
		}),
	])
	assert.deepEqual(dropped, [])
	assert.equal(accepted.length, 0, "neither can be a message part")
	assert.deepEqual(files.map((f) => `${f.name}:${f.mimeType}`), [
		"report.pdf:application/pdf",
		"deck.pptx:application/vnd.openxmlformats-officedocument.presentationml.presentation",
	])
	assert.equal(files[1]!.content.length, 5_000_000, "the bytes are handed on, not truncated")
})

test("a reply that obeys every cap still fits under the mail ceiling", () => {
	// The wire carries base64, so the mail ceiling has to be derived from the caps rather than
	// picked: at 32 MB a 25 MB reply was refused before the body downloaded, losing the prose too.
	const encoded = (bytes: number): number => Math.ceil(bytes / 3) * 4
	const worstCase = encoded(MAX_FILES_TOTAL_BYTES) + encoded(MAX_TOTAL_BYTES) + 200 * 1024
	assert.ok(
		worstCase < MAX_MESSAGE_BYTES,
		`a maximum reply is ${Math.round(worstCase / 1024 / 1024)} MB on the wire; the ceiling is ${MAX_MESSAGE_BYTES / 1024 / 1024}`,
	)
})

test("an iPhone HEIC photo is a file: no model reads it, a shell can convert it", () => {
	const { files, dropped } = selectAttachments([
		raw({ filename: "IMG_4021.HEIC", contentType: "image/heic", content: Buffer.alloc(3_000_000, 7) }),
	])
	assert.deepEqual(dropped, [])
	assert.equal(files.length, 1, "delivered as a file rather than dropped")
	assert.equal(files[0]!.mimeType, "image/heic")
})

test("a document over the file cap is refused, and an unknown type stays refused", () => {
	const { files, dropped } = selectAttachments([
		raw({ filename: "huge.pdf", contentType: "application/pdf", content: Buffer.alloc(MAX_FILE_BYTES + 1) }),
		raw({ filename: "setup.exe", contentType: "application/x-msdownload", content: Buffer.from("MZ") }),
	])
	assert.equal(files.length, 0)
	assert.deepEqual(
		dropped.map((d) => `${d.name}:${d.reason}`),
		["huge.pdf:too-large", "setup.exe:mime-not-allowed"],
	)
})

test("the file count and total are capped", () => {
	const one = Buffer.alloc(3 * 1024 * 1024, 1)
	const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => raw({ filename: `f${i}.pdf`, content: one }))
	const { files, dropped } = selectAttachments(many)
	assert.ok(files.length >= 1)
	assert.ok(files.length <= MAX_FILES, `${files.length} files`)
	assert.ok(dropped.length > 0)
	assert.ok(dropped.every((d) => d.reason === "too-large" || d.reason === "too-many"))
})

test("an empty attachment is dropped", () => {
	const { accepted, dropped } = selectAttachments([raw({ content: Buffer.alloc(0) })])
	assert.equal(accepted.length, 0)
	assert.equal(dropped[0]!.reason, "empty")
})

test("a missing filename gets a stable placeholder", () => {
	const { accepted } = selectAttachments([raw({ filename: undefined })])
	assert.match(accepted[0]!.name, /^attachment-\d+$/)
})

test("toUserContent returns a plain string with no attachments", () => {
	assert.equal(toUserContent("hello", []), "hello")
	assert.equal(toUserContent("hello"), "hello")
})

test("an image becomes an ImageContent block with the right mimeType", () => {
	const attachments: InboundAttachment[] = [
		{ name: "shot.png", mimeType: "image/png", size: png.length, data: png.toString("base64") },
	]
	const content = toUserContent("look at this", attachments)
	assert.ok(Array.isArray(content))
	assert.deepEqual(content[0], { type: "text", text: "look at this" })
	assert.deepEqual(content[1], { type: "image", data: png.toString("base64"), mimeType: "image/png" })
})

test("a text attachment is inlined as text", () => {
	const body = Buffer.from("line one\nline two")
	const attachments: InboundAttachment[] = [
		{ name: "log.txt", mimeType: "text/plain", size: body.length, data: body.toString("base64") },
	]
	const content = toUserContent("see log", attachments)
	assert.ok(Array.isArray(content))
	assert.deepEqual(content[1], { type: "text", text: "line one\nline two" })
})

test("attachments survive the pending store round-trip", () => {
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-att-")) }
	const { accepted } = selectAttachments([raw()])
	addPending(env, {
		uid: 1,
		sessionId: "s",
		from: "you@example.com",
		subject: "re",
		body: "see attached",
		attachments: accepted,
		receivedAt: 1,
	})
	const [record] = listPending(env)
	assert.equal(record!.attachments?.length, 1)
	assert.deepEqual(record!.attachments![0], accepted[0])
	// And the reconstructed content still carries the image.
	const content = toUserContent(record!.body, record!.attachments)
	assert.ok(Array.isArray(content))
	assert.equal((content[1] as { type: string }).type, "image")
})

test("an attachment-only reply does not start with an empty text block", () => {
	const content = toUserContent("", [
		{ name: "shot.png", mimeType: "image/png", size: 3, data: "AAAA" },
	])
	assert.ok(Array.isArray(content))
	assert.equal(content.length, 1)
	assert.equal(content[0]!.type, "image")
})

test("an enormous filename is capped, because it is persisted with the record", () => {
	// The MIME filename parameter has no upstream bound, and the name goes into pending.json. A
	// multi-megabyte one could push a record past the store's byte ceiling and be refused forever.
	const huge = "n".repeat(2_000_000)
	const { accepted } = selectAttachments([{ filename: huge, contentType: "image/png", content: Buffer.from("x") }])
	assert.equal(accepted.length, 1)
	assert.ok(accepted[0]!.name.length <= MAX_NAME_CHARS, `capped to ${accepted[0]!.name.length}`)
	// A normal name is untouched, and an absent one still gets a placeholder.
	assert.equal(
		selectAttachments([{ filename: "shot.png", contentType: "image/png", content: Buffer.from("x") }]).accepted[0]!.name,
		"shot.png",
	)
	assert.match(
		selectAttachments([{ contentType: "image/png", content: Buffer.from("x") }]).accepted[0]!.name,
		/^attachment-1$/,
	)
})
