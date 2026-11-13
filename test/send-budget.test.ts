import { test } from "node:test"
import assert from "node:assert/strict"

import { createSendBudget } from "../src/daemon/send-budget.ts"

test("ten sends a minute, then refused", () => {
	const budget = createSendBudget({ limit: 10, windowMs: 60_000 })
	const t0 = 1_000_000
	for (let i = 0; i < 10; i += 1) assert.equal(budget.take(t0 + i), true, `send ${i + 1}`)
	assert.equal(budget.take(t0 + 10), false, "the eleventh in the same minute is refused")
	assert.equal(budget.used(t0 + 10), 10)
})

test("the window slides, it is not a hard minute boundary", () => {
	// A loop that starts at :59 must not get 10 more at :00.
	const budget = createSendBudget({ limit: 2, windowMs: 1_000 })
	assert.equal(budget.take(0), true)
	assert.equal(budget.take(500), true)
	assert.equal(budget.take(900), false, "still inside the window")
	assert.equal(budget.take(1_001), true, "the first send has aged out")
})
