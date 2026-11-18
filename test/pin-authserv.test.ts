// Pinning `security.trustedAuthservId` from the provider's own header.
//
// Nobody can be asked to supply this value: it exists only in a delivered message, and guessing it
// pins the wrong thing. `--smoke` reads it from a copy of a mail we sent ourselves - the provider's
// work, not a sender's choice - and this writes it once.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isAuthservId, pinAuthservId } from "../src/store/pin-authserv.ts"
import { configPath } from "../src/store/paths.ts"

function envWith(config: Record<string, unknown>): { env: NodeJS.ProcessEnv; path: string } {
	const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "pmb-pin-")) }
	mkdirSync(join(env.XDG_CONFIG_HOME, "pi-mailbridge"), { recursive: true })
	const path = configPath(env)
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
	return { env, path }
}

const security = { allowFrom: ["me@example.com"], requireDmarcPass: true }

test("pins the authserv-id when DMARC is required and the field is unset", () => {
	const { env, path } = envWith({ security, mail: { to: "me@example.com" } })
	assert.deepEqual(pinAuthservId(env, "MX.QQ.COM"), { pinned: true })
	const written = JSON.parse(readFileSync(path, "utf8")) as { security: Record<string, unknown>; mail: unknown }
	assert.equal(written.security.trustedAuthservId, "mx.qq.com", "lowercased: the comparison is case-insensitive")
	assert.deepEqual(written.mail, { to: "me@example.com" }, "the rest of the file is untouched")
})

test("never overwrites an explicit value", () => {
	// A pin the user chose is a decision; a header we happened to see is not.
	const { env, path } = envWith({ security: { ...security, trustedAuthservId: "mx.chosen.example" } })
	assert.deepEqual(pinAuthservId(env, "mx.qq.com"), { pinned: false, reason: "already-set" })
	const written = JSON.parse(readFileSync(path, "utf8")) as { security: Record<string, unknown> }
	assert.equal(written.security.trustedAuthservId, "mx.chosen.example")
})

test("does nothing when DMARC is not required, or when the copy carried no header", () => {
	const notRequired = envWith({ security: { ...security, requireDmarcPass: false } })
	assert.deepEqual(pinAuthservId(notRequired.env, "mx.qq.com"), { pinned: false, reason: "not-required" })
	const required = envWith({ security })
	assert.deepEqual(pinAuthservId(required.env, undefined), { pinned: false, reason: "no-value" })
	assert.deepEqual(pinAuthservId({ XDG_CONFIG_HOME: join(tmpdir(), "pmb-none") }, "mx.qq.com"), {
		pinned: false,
		reason: "no-config",
	})
})

test("a bare Microsoft mechanism is not an authserv-id", () => {
	// `spf=pass` is the first token of a header with no authserv-id; pinning it would trust nothing while
	// looking like it trusted something.
	assert.equal(isAuthservId("spf=pass"), false)
	assert.equal(isAuthservId("mx.example.com"), true)
	assert.equal(isAuthservId("[2001:db8::1]"), true)
	assert.equal(pinAuthservId(envWith({ security: { requireDmarcPass: true } }).env, "spf=pass").reason, "no-value")
})

