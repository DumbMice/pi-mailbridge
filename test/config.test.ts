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

test("a null section warns instead of throwing, as loadConfig promises", () => {
	// `{"daemon": null}` is an ordinary "I meant the defaults" edit. It used to crash
	// loadConfig, which takes down both the daemon and the pi extension at activation.
	const dir = mkdtempSync(join(tmpdir(), "cfg-null-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })
	writeFileSync(configPath(env), JSON.stringify({ daemon: null, mail: { imap: null, to: "you@example.com" } }))

	const config = loadConfig(env)
	assert.equal(config.daemon.scanIntervalSecs, 60)
	assert.ok(config.mail.imap, "mail.imap is repaired, not left null")
	assert.ok(config.warnings.some((w) => /daemon must be an object/.test(w)))
	assert.ok(config.warnings.some((w) => /mail\.imap must be an object/.test(w)))
})

test("every section survives a null, not just the ones that were patched", () => {
	// The first fix guarded three sections and claimed the class was gone; a reviewer found
	// mail.smtp throwing, tuning killing the daemon at boot, and security/notify silently
	// losing their defaults (DMARC off, settle notifications off) with no warning.
	const dir = mkdtempSync(join(tmpdir(), "cfg-all-null-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })

	const cases: Array<[string, Record<string, unknown>, (c: ReturnType<typeof loadConfig>) => void]> = [
		["mail.smtp", { mail: { smtp: null } }, (c) => assert.equal(c.mail.smtp.authType, "LOGIN")],
		["tuning", { tuning: null }, (c) => assert.equal(c.tuning.idleRenewMs, 25 * 60 * 1000)],
		["notify", { notify: null }, (c) => assert.equal(c.notify.onSettled, true)],
		["security", { security: null }, (c) => assert.equal(c.security.requireDmarcPass, true)],
		["device", { device: null }, (c) => assert.ok(c.device.name.length > 0)],
		["mail", { mail: null }, (c) => assert.ok(c.mail.imap && c.mail.smtp)],
	]
	for (const [name, config, check] of cases) {
		writeFileSync(configPath(env), JSON.stringify(config))
		const loaded = loadConfig(env)
		check(loaded)
		assert.ok(
			loaded.warnings.some((w) => w.startsWith(name.replace("mail.smtp", "mail.smtp"))),
			`${name} must warn, got: ${loaded.warnings.join(" | ")}`,
		)
	}
})

test("a partial section from the env merge still gets its defaults", () => {
	// `{"daemon": null}` plus PI_MAILBRIDGE_EXIT_WHEN_IDLE leaves a daemon record with no host
	// and no port, which would bind an ephemeral port and drop the "port is the lock" invariant.
	const dir = mkdtempSync(join(tmpdir(), "cfg-null-env-"))
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })
	writeFileSync(configPath({ XDG_CONFIG_HOME: dir }), JSON.stringify({ daemon: null }))

	const config = loadConfig({ XDG_CONFIG_HOME: dir, PI_MAILBRIDGE_EXIT_WHEN_IDLE: "false" })
	assert.equal(config.daemon.host, "127.0.0.1")
	assert.equal(config.daemon.port, 4177)
	assert.equal(config.daemon.exitWhenIdle, false, "the env value still wins")
})

test("scanIntervalSecs: null is refused, because Number(null) is 0", () => {
	// 0 is the documented "disable the sweep". A null must not be read as that choice.
	const dir = mkdtempSync(join(tmpdir(), "cfg-null-int-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })

	for (const value of [null, "60", Number.NaN, -5]) {
		writeFileSync(configPath(env), JSON.stringify({ daemon: { scanIntervalSecs: value } }))
		const config = loadConfig(env)
		assert.equal(config.daemon.scanIntervalSecs, 60, `scanIntervalSecs: ${String(value)} must not disable the sweep`)
	}
	writeFileSync(configPath(env), JSON.stringify({ daemon: { scanIntervalSecs: 0 } }))
	assert.equal(loadConfig(env).daemon.scanIntervalSecs, 0, "an explicit 0 still means off")
})
