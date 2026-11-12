import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
	MAX_ATTACHMENTS,
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
		raw({ filename: `f${i}.png`, contentType: i === 0 ? "application/zip" : "image/png" }),
	)
	const { accepted, dropped } = selectAttachments(items)
	assert.equal(accepted.length, MAX_ATTACHMENTS)
	assert.equal(dropped[0]!.reason, "mime-not-allowed", "first rejection is the bad mime")
	assert.ok(dropped.some((d) => d.reason === "too-many"))
})

test("total size over the cap is refused", () => {
	const big = Buffer.alloc(MAX_TOTAL_BYTES - 10, 1)
	const extra = Buffer.alloc(100, 2)
	const { accepted, dropped } = selectAttachments([
		raw({ filename: "big.png", content: big }),
		raw({ filename: "extra.png", content: extra }),
	])
	assert.equal(accepted.length, 1, "the first fits")
	assert.deepEqual(dropped.map((d) => d.name), ["extra.png"])
	assert.equal(dropped[0]!.reason, "too-large")
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
