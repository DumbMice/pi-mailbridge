import { test } from "node:test"
import assert from "node:assert/strict"

import {
	MAIL_REFUSED_SUBCOMMANDS,
	MAIL_SAFE_SUBCOMMANDS,
	parseMailCommand,
} from "../src/core/mail-command.ts"
import { parseMailbridgeCommand } from "../src/core/commands.ts"

test("a bare command reply is a command", () => {
	assert.deepEqual(parseMailCommand("/mailbridge on"), { name: "mailbridge", args: "on", sub: "on" })
	assert.deepEqual(parseMailCommand("  /mailbridge off \r\n"), {
		name: "mailbridge",
		args: "off",
		sub: "off",
	})
	assert.deepEqual(parseMailCommand("/MAILBRIDGE ON")?.sub, "on")
	// The old top-level names are gone, and must not be mistaken for commands.
	assert.equal(parseMailCommand("/back"), undefined)
	assert.equal(parseMailCommand("/afk"), undefined)
	// Bare `/mailbridge` prints status, as at the prompt.
	assert.deepEqual(parseMailCommand("/mailbridge"), { name: "mailbridge", args: "", sub: "status" })
	assert.equal(parseMailCommand("/mailbridge status")?.sub, "status")
	assert.equal(parseMailCommand("/mailbridge  check  ")?.sub, "check")
})

test("anything longer than one line is a message, not an instruction", () => {
	// A reply quotes the original; the quote must never be executed.
	assert.equal(parseMailCommand("please do this\n/mailbridge on"), undefined)
	assert.equal(parseMailCommand("> /mailbridge on"), undefined)
	// A command on the first line with anything after it is a message: otherwise a signature or a
	// "thanks!" appended by the phone would still execute the command.
	assert.equal(parseMailCommand("/mailbridge on\nthanks!"), undefined)
	// Trailing blank lines are not a second instruction.
	assert.equal(parseMailCommand("/mailbridge on\n\n")?.sub, "on")
	assert.equal(parseMailCommand("Yesterday, pi wrote:\n/mailbridge on"), undefined)
	assert.equal(parseMailCommand("hello there"), undefined)
	assert.equal(parseMailCommand(""), undefined)
})

test("commands that reconfigure the machine are never runnable by mail", () => {
	// Mail is authenticated by the allowlist (and, in the one-mailbox layout, without DMARC), so
	// a spoofed From must not be able to reconfigure setup, credentials or the process.
	for (const sub of ["setup", "auth", "restart", "prime"]) {
		assert.equal(parseMailCommand(`/mailbridge ${sub}`), undefined, `${sub} must stay text`)

	}
	assert.equal(parseMailCommand("/mailbridge setup evil@example.com to evil@example.com"), undefined)
	// Read-only and harmless ones still work.
	for (const sub of ["on", "off", "status", "check", "smoke", "help"]) {
		assert.equal(parseMailCommand(`/mailbridge ${sub}`)?.sub, sub)
	}
	assert.equal(parseMailCommand("/mailbridge nonsense"), undefined)
	// No safe subcommand takes an argument, so a leftover word means the human wrote a sentence:
	// it must reach the agent instead of flipping the mode and dropping their words.
	assert.equal(parseMailCommand("/mailbridge off thanks, the deploy is still broken"), undefined)
	assert.equal(parseMailCommand("/mailbridge on\u2028the deploy is still broken"), undefined)
	assert.equal(parseMailCommand("/unknown"), undefined)
})

test("the two parsers agree, so a validated command cannot dispatch as something else", () => {
	// dispatchMailCommand validates `sub` here, then the handler re-parses the raw args with
	// parseMailbridgeCommand. That is safe only while both tokenize identically.
	for (const sub of MAIL_SAFE_SUBCOMMANDS) {
		const parsed = parseMailCommand(`/mailbridge ${sub}`)
		assert.equal(parsed?.sub, sub)
		assert.equal(parseMailbridgeCommand(sub).sub, sub, `${sub} must re-parse to itself`)
	}
	for (const sub of MAIL_REFUSED_SUBCOMMANDS) {
		assert.equal(parseMailCommand(`/mailbridge ${sub}`), undefined, `${sub} must never parse as a command`)
	}
})
