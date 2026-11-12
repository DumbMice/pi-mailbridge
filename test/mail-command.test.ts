import { test } from "node:test"
import assert from "node:assert/strict"

import { isRefusedSubcommand, parseMailCommand } from "../src/core/mail-command.ts"

test("a bare command reply is a command", () => {
	assert.deepEqual(parseMailCommand("/back"), { name: "back", args: "" })
	assert.deepEqual(parseMailCommand("  /afk \r\n"), { name: "afk", args: "" })
	assert.deepEqual(parseMailCommand("/BACK"), { name: "back", args: "" })
	// Bare `/mailbridge` prints status, as at the prompt.
	assert.deepEqual(parseMailCommand("/mailbridge"), { name: "mailbridge", args: "", sub: "status" })
	assert.equal(parseMailCommand("/mailbridge status")?.sub, "status")
	assert.equal(parseMailCommand("/mailbridge  check  ")?.sub, "check")
})

test("anything longer than one line is a message, not an instruction", () => {
	// A reply quotes the original; the quote must never be executed.
	assert.equal(parseMailCommand("please do this\n/back"), undefined)
	assert.equal(parseMailCommand("> /back"), undefined)
	// A command on the first line with anything after it is a message: otherwise a signature or a
	// "thanks!" appended by the phone would still execute the command.
	assert.equal(parseMailCommand("/back\nthanks!"), undefined)
	// Trailing blank lines are not a second instruction.
	assert.equal(parseMailCommand("/back\n\n")?.name, "back")
	assert.equal(parseMailCommand("On 1 Jan, pi wrote:\n/back"), undefined)
	assert.equal(parseMailCommand("hello there"), undefined)
	assert.equal(parseMailCommand(""), undefined)
})

test("commands that reconfigure the machine are never runnable by mail", () => {
	// Mail is authenticated by the allowlist (and, in the one-mailbox layout, without DMARC), so
	// a spoofed From must not be able to reconfigure setup, credentials or the process.
	for (const sub of ["setup", "auth", "restart", "prime"]) {
		assert.equal(parseMailCommand(`/mailbridge ${sub}`), undefined, `${sub} must stay text`)
		assert.equal(isRefusedSubcommand(sub), true)
	}
	assert.equal(parseMailCommand("/mailbridge setup evil@example.com to evil@example.com"), undefined)
	// Read-only and harmless ones still work.
	for (const sub of ["status", "check", "smoke", "help"]) {
		assert.equal(parseMailCommand(`/mailbridge ${sub}`)?.sub, sub)
	}
	assert.equal(parseMailCommand("/mailbridge nonsense"), undefined)
	assert.equal(parseMailCommand("/unknown"), undefined)
})
