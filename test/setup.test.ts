import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runSetup } from "../src/core/setup.ts"

const env = () => ({ XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "pmb-setup-")) })

const offline = (async () => {
	throw new Error("ENOTFOUND")
}) as unknown as typeof fetch

test("a hostname with no dot is explained, not just refused", async () => {
	const e = env()
	const result = await runSetup({ address: "pi@hotmail", env: e, fetchImpl: offline })

	assert.equal(result.ok, false)
	assert.match(result.steps.join("\n"), /is not a domain/i)
	assert.match(String(result.next), /hotmail\.com/, "must tell them what to write")
	// And it must not have written anything.
	assert.throws(() => readFileSync(join(e.XDG_CONFIG_HOME!, "pi-mailbridge", "config.json")))
})

test("a full hotmail.com address works even offline (built-in provider table)", async () => {
	const e = env()
	const result = await runSetup({ address: "pi-x@hotmail.com", to: "me@hotmail.com", env: e, fetchImpl: offline })

	assert.equal(result.ok, true, result.steps.join("\n"))
	assert.match(result.steps.join("\n"), /outlook\.office365\.com:993/)

	const written = JSON.parse(readFileSync(join(e.XDG_CONFIG_HOME!, "pi-mailbridge", "config.json"), "utf8"))
	assert.equal(written.mail.imap.host, "outlook.office365.com")
	assert.equal(written.mail.imap.authType, "XOAUTH2")
	assert.equal(written.mail.to, "me@hotmail.com")
	assert.equal(written.security.allowSelfReplies, false, "layout A: different addresses")
	assert.equal(written.oauth.issuer, "https://login.microsoftonline.com/consumers/v2.0")
	assert.match(String(result.next), /client id/i)
})

test("an existing config needs force", async () => {
	const e = env()
	const first = await runSetup({ address: "pi@hotmail.com", to: "me@hotmail.com", env: e, fetchImpl: offline })
	assert.equal(first.ok, true)

	const second = await runSetup({ address: "pi@hotmail.com", to: "me@hotmail.com", env: e, fetchImpl: offline })
	assert.equal(second.ok, false)
	assert.match(String(second.next), /force/)

	const forced = await runSetup({ address: "pi@hotmail.com", to: "me@hotmail.com", env: e, fetchImpl: offline, force: true })
	assert.equal(forced.ok, true)
})

test("an unknown domain still fails clearly", async () => {
	const e = env()
	const result = await runSetup({ address: "pi@mail.example.org", env: e, fetchImpl: offline })
	assert.equal(result.ok, false)
	assert.match(result.steps.join("\n"), /no published mail settings/)
})
