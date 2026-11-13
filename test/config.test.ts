import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadConfig } from "../src/core/config.ts"
import { checkProblems } from "../src/daemon/main.ts"
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

test("a non-loopback daemon.host warns, because nothing else would say so", () => {
	// SECURITY.md says "do not"; a hand-edited config got no feedback at all, while the port
	// right beside it was validated.
	const load = (host: string) => {
		const dir = mkdtempSync(join(tmpdir(), "cfg-host-"))
		const env = { XDG_CONFIG_HOME: dir }
		mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })
		writeFileSync(configPath(env), JSON.stringify({ daemon: { host } }))
		return loadConfig(env)
	}
	const exposed = load("0.0.0.0")
	assert.ok(exposed.warnings.some((w) => /daemon\.host/.test(w) && /not loopback/.test(w)))
	assert.equal(exposed.daemon.host, "0.0.0.0", "the value is kept; this is a warning, not a repair")
	// And the warning is a *problem*, not a note: `checkProblems` is what makes
	// `pi-mailbridge --check` exit non-zero, and exposing the HTTP surface must not pass a gate.
	assert.ok(
		checkProblems(exposed).some((p) => /daemon\.host/.test(p)),
		"the headless check must fail on a non-loopback host",
	)

	for (const host of ["127.0.0.1", "::1", "localhost"]) {
		const quiet = load(host)
		assert.ok(!quiet.warnings.some((w) => /daemon\.host/.test(w)), `${host} must not warn`)
	}
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
		// The old form was `.replace("mail.smtp","mail.smtp")`, a no-op, so `mail` passed on
		// "mail.to is required" even if the loop never warned about the section.
		assert.ok(
			loaded.warnings.some((w) => new RegExp(`^repaired: ${name.replace(".", "\\.")} must be an object`).test(w)),
			`${name} must warn as repaired, got: ${loaded.warnings.join(" | ")}`,
		)
	}
})

test("a partial section from the env merge still gets its defaults", () => {
	// `{"daemon": null}` plus a daemon env var leaves a daemon record with no host
	// and no port, which would bind an ephemeral port and drop the "port is the lock" invariant.
	const dir = mkdtempSync(join(tmpdir(), "cfg-null-env-"))
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })
	writeFileSync(configPath({ XDG_CONFIG_HOME: dir }), JSON.stringify({ daemon: null }))

	const config = loadConfig({ XDG_CONFIG_HOME: dir, PI_MAILBRIDGE_PORT: "5000" })
	assert.equal(config.daemon.host, "127.0.0.1", "defaults fill the hole")
	assert.equal(config.daemon.port, 5000, "and the env value still wins")
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

test("a repaired section does not fail --check, because the daemon still runs", async () => {
	// --check folds every warning into a problem and exits non-zero; the shipped unit runs it as
	// ExecStartPre. A repaired config is usable, so refusing to start it is wrong.
	const { checkProblems } = await import("../src/daemon/main.ts")
	const dir = mkdtempSync(join(tmpdir(), "cfg-repaired-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })
	writeFileSync(configPath(env), JSON.stringify({ tuning: null }))

	const config = loadConfig(env)
	assert.ok(config.warnings.some((w) => w.startsWith("repaired: tuning")))
	assert.equal(
		checkProblems(config).some((p) => /tuning must be an object/.test(p)),
		false,
		"a repaired section must not block startup",
	)
})

test("the attachment budget is validated, and the default is provider-safe", () => {
	const dir = mkdtempSync(join(tmpdir(), "cfg-attach-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })

	assert.equal(loadConfig(env).notify.maxAttachmentMb, 18, "default")
	for (const bad of [0, -1, 100, "20", null]) {
		writeFileSync(configPath(env), JSON.stringify({ notify: { maxAttachmentMb: bad } }))
		const config = loadConfig(env)
		assert.equal(config.notify.maxAttachmentMb, 18, `maxAttachmentMb: ${String(bad)} is refused`)
		assert.ok(config.warnings.some((w) => /maxAttachmentMb/.test(w)))
	}
	writeFileSync(configPath(env), JSON.stringify({ notify: { maxAttachmentMb: 45 } }))
	assert.equal(loadConfig(env).notify.maxAttachmentMb, 45, "a QQ-sized budget is allowed")
})

test("an idle timeout that would kill the daemon, and a TTL that would never expire", () => {
	// `idleTimeoutSecs: 0` makes the daemon exit ~1 s after the first ping (looks like a crash
	// loop, respawn throttled to a minute); `tokenTtlHours: "abc"` makes a route never expire.
	const dir = mkdtempSync(join(tmpdir(), "cfg-timeouts-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })

	for (const bad of [0, -5, "120", null]) {
		writeFileSync(configPath(env), JSON.stringify({ daemon: { idleTimeoutSecs: bad } }))
		const config = loadConfig(env)
		assert.equal(config.daemon.idleTimeoutSecs, 120, `idleTimeoutSecs: ${String(bad)}`)
		assert.ok(config.warnings.some((w) => /idleTimeoutSecs/.test(w)))
	}

	for (const bad of [0, "720", Number.NaN]) {
		writeFileSync(configPath(env), JSON.stringify({ security: { tokenTtlHours: bad } }))
		const config = loadConfig(env)
		assert.equal(config.security.tokenTtlHours, 720, `tokenTtlHours: ${String(bad)}`)
		assert.ok(config.warnings.some((w) => /tokenTtlHours/.test(w)))
	}
})

test("an idle timeout below the ping period is refused, because it would flap", () => {
	// A timeout shorter than the session's poll interval reaps the daemon between pings: it
	// serves ~6 s, dies, respawns at most once a minute, and says nothing. 30 s is 3x the poll.
	const dir = mkdtempSync(join(tmpdir(), "cfg-idle-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })

	for (const short of [5, 9, 10, 29]) {
		writeFileSync(configPath(env), JSON.stringify({ daemon: { idleTimeoutSecs: short } }))
		const config = loadConfig(env)
		assert.equal(config.daemon.idleTimeoutSecs, 120, `idleTimeoutSecs: ${short} would flap`)
		assert.ok(config.warnings.some((w) => /idleTimeoutSecs/.test(w)))
	}
	writeFileSync(configPath(env), JSON.stringify({ daemon: { idleTimeoutSecs: 30 } }))
	assert.equal(loadConfig(env).daemon.idleTimeoutSecs, 30, "30 s is allowed")
})

test("a hand-edited mail.to that is not an address is reported", () => {
	// setup validates it, but a typo in config.json is otherwise silent until something tries to
	// send - and then only in the daemon's log.
	const dir = mkdtempSync(join(tmpdir(), "cfg-to-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })
	writeFileSync(configPath(env), JSON.stringify({ mail: { to: "you-at-example.com" } }))
	assert.ok(loadConfig(env).warnings.some((w) => /mail\.to does not look like/.test(w)))
})
