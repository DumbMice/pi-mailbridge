import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadConfig } from "../src/core/config.ts"
import { configPath } from "../src/store/paths.ts"


test("a string allowFrom is rejected at load instead of killing the scan per message", () => {
	// A string satisfies the .length check below, so this passed validation and then threw
	// inside the allowlist test for every message: the scan died silently and the mailbox
	// stopped, with the cursor never advancing.
	const dir = mkdtempSync(join(tmpdir(), "pmb-config-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })
	writeFileSync(configPath(env), JSON.stringify({ security: { allowFrom: "me@example.com" } }))
	const cfg = loadConfig(env)
	assert.deepEqual(cfg.security.allowFrom, [], "coerced to fail-closed")
	assert.ok(cfg.warnings.some((w) => w.includes("allowFrom must be an array")))
})

test("a non-numeric debounceMs falls back and warns", () => {
	const dir = mkdtempSync(join(tmpdir(), "pmb-config-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })
	writeFileSync(configPath(env), JSON.stringify({ notify: { debounceMs: "soon" } }))
	const cfg = loadConfig(env)
	assert.equal(cfg.notify.debounceMs, 10_000)
	assert.ok(cfg.warnings.some((w) => w.includes("debounceMs")))
})

test("PI_MAILBRIDGE_EXIT_WHEN_IDLE=false keeps a supervised daemon resident", () => {
	// The shipped systemd unit uses Restart=always, so a daemon that exits for idleness
	// would restart forever. The override is what makes that unit correct.
	assert.equal(loadConfig({ PI_MAILBRIDGE_EXIT_WHEN_IDLE: "false" }).daemon.exitWhenIdle, false)
	assert.equal(loadConfig({ PI_MAILBRIDGE_EXIT_WHEN_IDLE: "0" }).daemon.exitWhenIdle, false)
	assert.equal(loadConfig({ PI_MAILBRIDGE_EXIT_WHEN_IDLE: "true" }).daemon.exitWhenIdle, true)
})
