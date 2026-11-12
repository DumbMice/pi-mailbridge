import { test } from "node:test"
import assert from "node:assert/strict"

import { isSubcommand, parseMailbridgeCommand, USAGE } from "../src/core/commands.ts"

test("bare /mailbridge is a status request", () => {
	assert.deepEqual(parseMailbridgeCommand(""), { sub: "status", force: false })
	assert.deepEqual(parseMailbridgeCommand("   "), { sub: "status", force: false })
})

test("each documented subcommand parses", () => {
	for (const sub of ["status", "check", "auth", "smoke", "restart", "help"] as const) {
		assert.equal(parseMailbridgeCommand(sub).sub, sub)
		assert.equal(parseMailbridgeCommand(sub.toUpperCase()).sub, sub, "case insensitive")
	}
})

test("setup takes an address, an optional to, and a force flag", () => {
	assert.deepEqual(parseMailbridgeCommand("setup pi@outlook.com"), {
		sub: "setup",
		address: "pi@outlook.com",
		force: false,
	})

	assert.deepEqual(parseMailbridgeCommand("setup pi@outlook.com to me@outlook.com"), {
		sub: "setup",
		address: "pi@outlook.com",
		to: "me@outlook.com",
		force: false,
	})

	assert.deepEqual(parseMailbridgeCommand("setup pi@outlook.com --to me@outlook.com force"), {
		sub: "setup",
		address: "pi@outlook.com",
		to: "me@outlook.com",
		force: true,
	})
})

test("an unknown subcommand falls back to help instead of acting", () => {
	// Must not be treated as an address or silently run status.
	assert.equal(parseMailbridgeCommand("frobnicate").sub, "help")
	assert.equal(parseMailbridgeCommand("setup").sub, "setup")
	assert.equal(parseMailbridgeCommand("setup").address, undefined)
})

test("non-address words are ignored, not mistaken for the pi address", () => {
	const parsed = parseMailbridgeCommand("setup --verbose --force pi@x.com")
	assert.equal(parsed.address, "pi@x.com")
	assert.equal(parsed.force, true)
	assert.equal(parsed.to, undefined)
})

test("the second address is only used via 'to', never positionally", () => {
	const parsed = parseMailbridgeCommand("setup pi@x.com me@y.com")
	assert.equal(parsed.address, "pi@x.com")
	assert.equal(parsed.to, undefined, "a bare second address must not silently become the human's")
})

test("isSubcommand guards the union", () => {
	assert.equal(isSubcommand("smoke"), true)
	assert.equal(isSubcommand("nope"), false)
})

test("usage lists every subcommand", () => {
	for (const sub of ["setup", "check", "auth", "smoke", "restart"]) {
		assert.ok(USAGE.includes(sub), `usage should mention ${sub}`)
	}
})

test("prime is a first-class subcommand", () => {
	assert.equal(parseMailbridgeCommand("prime").sub, "prime")
	assert.equal(isSubcommand("prime"), true)
	assert.match(USAGE, /prime/)
})
