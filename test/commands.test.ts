import { test } from "node:test"
import assert from "node:assert/strict"

import { completeSubcommand, isSubcommand, parseMailbridgeCommand, SUBCOMMAND_INFO, USAGE } from "../src/core/commands.ts"

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

test("Tab offers the subcommands, filtered by what has been typed", () => {
	// pi calls this hook when the user presses Tab after `/mailbridge `; without it the argument
	// position is silent, which is what this test exists to keep from coming back.
	const all = completeSubcommand("")
	assert.ok(all, "an empty prefix lists everything")
	assert.deepEqual(
		all.map((i) => i.value),
		SUBCOMMAND_INFO.map((c) => c.name),
		"every subcommand, in usage order",
	)
	assert.ok(all.every((i) => i.label === i.value && (i.description ?? "").length > 0), "each carries its hint")

	assert.deepEqual(completeSubcommand("s")?.map((i) => i.value), ["status", "setup", "smoke"])
	assert.deepEqual(completeSubcommand("of")?.map((i) => i.value), ["off"])
	assert.deepEqual(completeSubcommand("REST")?.map((i) => i.value), ["restart"], "case-insensitive")

	// A leading space is still the first word (an accidental extra space must not kill completion);
	// pi passes the whole argument text after the first space, so it can start with one.
	assert.deepEqual(completeSubcommand("  of")?.map((i) => i.value), ["off"])
	assert.deepEqual(completeSubcommand("\tof")?.map((i) => i.value), ["off"])

	// After a space the user is typing an argument, not a subcommand: no suggestions.
	assert.equal(completeSubcommand("off "), null)
	assert.equal(completeSubcommand("setup me@example.com"), null)
	assert.equal(completeSubcommand("frobnicate"), null, "nothing matches")
})

test("the usage text, the whitelist and the completion are one list", () => {
	// They were three hand-written lists; this is the guard that keeps a new subcommand from being
	// documented but unparseable, or completable but unknown.
	for (const command of SUBCOMMAND_INFO) {
		assert.ok(isSubcommand(command.name), `${command.name} parses`)
		assert.ok(USAGE.includes(command.name), `${command.name} appears in the usage text`)
		assert.ok(completeSubcommand(command.name)?.some((i) => i.value === command.name), `${command.name} completes`)
	}
})

test("the usage text aligns every description in one column", () => {
	// The alignment was off by one for `status` alone after the text started being generated from
	// the table; the column is part of what makes the list readable, so it gets an assertion.
	const lines = USAGE.split("\n")
	const column = "/mailbridge".length + 23
	const status = lines.find((l) => l.includes("status (the default)"))
	assert.equal(status?.indexOf("status (the default)"), column, `status line: ${status}`)

	for (const command of SUBCOMMAND_INFO) {
		if (command.name === "status") continue
		const line = lines.find((l) => l.startsWith(`/mailbridge ${command.name} `))
		assert.ok(line, `a line for ${command.name}`)
		// `setup` carries a signature longer than the column, so its description follows with a
		// two-space gap rather than padding - the same rule `usageLine` applies.
		const args = (command as { args?: string }).args
		const head = `/mailbridge ${command.name}${args ? ` ${args}` : ""}`
		const expected = Math.max(column, head.length + 2)
		assert.equal(line.indexOf(command.hint), expected, `${command.name} aligns: ${line}`)
	}
})

test("a completion description fits the line pi draws it on", () => {
	// pi renders a suggestion's description on one line and truncates it with no ellipsis; the
	// longest hint must survive the narrowest slash-menu layout (primary column 12, width 80).
	const widest = Math.max(...SUBCOMMAND_INFO.map((c) => c.hint.length))
	assert.ok(widest <= 60, `longest hint is ${widest} characters`)
	for (const item of completeSubcommand("") ?? []) {
		assert.ok((item.description ?? "").length <= 60, `${item.value}: ${item.description}`)
	}
})

