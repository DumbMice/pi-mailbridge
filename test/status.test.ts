import { test } from "node:test"
import assert from "node:assert/strict"

import { formatScan, type ScanSummary } from "../src/core/status.ts"

const base: ScanSummary = { at: 0, examined: 2, persisted: 1, rejected: 1, reasons: {} }

test("a clean scan prints no rejections and no queue line", () => {
	const lines = formatScan({ ...base, rejected: 0, reasons: { routed: 1 } })
	assert.deepEqual(lines.slice(1), ["rejections: none", "handled: routed 1"])
})

test("a refusal is listed under rejections", () => {
	const lines = formatScan({ ...base, reasons: { "not-allowlisted": 1 } })
	assert.ok(lines.some((l) => l.startsWith("rejections: ") && l.includes("not-allowlisted")))
})

test("route-miss is handled, not rejected: the reply still routed", () => {
	const lines = formatScan({ ...base, rejected: 0, reasons: { "route-miss": 1, threaded: 1 } })
	assert.ok(lines.some((l) => l.startsWith("rejections: none")), lines.join("\n"))
	assert.ok(lines.some((l) => l.startsWith("handled: ") && l.includes("route-miss")))
})

test("an attachment drop is its own line, not a rejection", () => {
	const lines = formatScan({ ...base, reasons: { "attachment-too-large": 1, routed: 1 } })
	assert.ok(lines.some((l) => l === "rejections: none"))
	assert.ok(lines.some((l) => l.startsWith("attachments dropped: ") && l.includes("attachment-too-large")))
})

test("the queue-full line only appears when the queue actually refused something", () => {
	const clean = formatScan({ ...base, rejected: 0, reasons: { routed: 1 } })
	assert.ok(!clean.some((l) => /queue full/.test(l)), "must not claim a full queue after a clean scan")
	const full = formatScan({ ...base, reasons: { "pending-full": 1 } })
	assert.ok(full.some((l) => /queue full/.test(l)), "and must say so when it did")
	assert.ok(!full.some((l) => l.startsWith("rejections: ") && l.includes("pending-full")))
})

test("no summary yet is distinct from an empty one", () => {
	// A daemon that has never scanned is a different state from a quiet one.
	assert.match(formatScan(null)[0]!, /never/i)
	assert.match(formatScan({ checkedAt: Date.UTC(2026, 0, 1) })[0]!, /last checked/i)
})

test("our own echo is handled, not a rejection", () => {
	// One-address installs reject every notification they send; reporting that as a rejection
	// made a healthy setup look broken on every status call.
	const lines = formatScan({ ...base, rejected: 4, reasons: { "self-echo": 4, routed: 1 } })
	assert.ok(lines.some((l) => l.startsWith("rejections: none")), lines.join("\n"))
	assert.ok(lines.some((l) => l.startsWith("handled: ") && l.includes("self-echo")))
})
