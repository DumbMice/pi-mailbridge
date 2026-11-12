import { test } from "node:test"
import assert from "node:assert/strict"

import { createScanQueue } from "../src/daemon/scan-queue.ts"

const tick = () => new Promise((r) => setImmediate(r))

test("scans never overlap", async () => {
	// Two scans that both pass the journal check before either persists would inject the
	// same reply twice - the one failure the design cannot undo.
	let running = 0
	let maxRunning = 0
	const seen: string[] = []
	const scan = createScanQueue(async (why) => {
		running++
		maxRunning = Math.max(maxRunning, running)
		seen.push(why)
		await tick()
		await tick()
		running--
	})

	await Promise.all([scan("idle"), scan("mode-on"), scan("catch-up")])
	assert.equal(maxRunning, 1, "only one scan ran at a time")
})

test("a burst of requests coalesces into one follow-up", async () => {
	let calls = 0
	const scan = createScanQueue(async () => {
		calls++
		await tick()
	})
	await Promise.all([scan("a"), scan("b"), scan("c"), scan("d")])
	// The first runs, the rest collapse into a single queued scan.
	assert.equal(calls, 2)
})

test("a failing scan does not poison the queue", async () => {
	let calls = 0
	const scan = createScanQueue(async (why) => {
		calls++
		if (why === "boom") throw new Error("scan failed")
	})
	await scan("boom")
	await scan("after")
	assert.equal(calls, 2)
	assert.equal(scan.busy(), false)
})

test("a request arriving during the follow-up still runs", async () => {
	let calls = 0
	const scan = createScanQueue(async () => {
		calls++
		await tick()
	})
	const first = scan("a")
	const second = scan("b")
	const third = scan("c")
	await Promise.all([first, second, third])
	await scan("d")
	assert.equal(calls, 3)
})
