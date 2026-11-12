import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ensureRouteForSession, registerRoute, resolveRoute, routeIdFromSubject, ROUTE_RE, routeCount } from "../src/store/routes.ts"
import { buildSettleSubject } from "../src/core/settle.ts"
import { stampSubject } from "../src/core/token.ts"

const env = () => ({ XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-routes-")) })
const SESSION = "01a1c453-f2fc-7169-8c89-69c93fa1a152"

test("a route id is six hex characters and resolves back", () => {
	const e = env()
	const id = registerRoute({ sessionId: SESSION, subject: "pi: x", device: "dev-box-7", env: e })
	assert.match(id, /^[0-9a-f]{6}$/)
	assert.equal(resolveRoute(id, { device: "dev-box-7", env: e })?.sessionId, SESSION)
})

test("an unknown id resolves to nothing", () => {
	const e = env()
	assert.equal(resolveRoute("abcdef", { env: e }), undefined)
})

test("a route expires", () => {
	const e = env()
	const id = registerRoute({ sessionId: SESSION, subject: "x", env: e, ttlHours: 1, now: 0 })
	assert.ok(resolveRoute(id, { env: e, now: 0 }))
	assert.equal(resolveRoute(id, { env: e, now: 2 * 3600_000 }), undefined)
})

test("a route minted for another device does not resolve here", () => {
	const e = env()
	const id = registerRoute({ sessionId: SESSION, subject: "x", device: "dev-box-7", env: e })
	assert.equal(resolveRoute(id, { device: "other-box", env: e }), undefined)
	assert.ok(resolveRoute(id, { device: "dev-box-7", env: e }))
})

test("ids do not collide across many registrations", () => {
	const e = env()
	const ids = new Set<string>()
	for (let i = 0; i < 200; i++) ids.add(registerRoute({ sessionId: SESSION, subject: `n${i}`, env: e }))
	assert.equal(ids.size, 200)
	assert.equal(routeCount(e), 200)
})

test("expired routes are pruned when a new one is registered", () => {
	const e = env()
	registerRoute({ sessionId: SESSION, subject: "old", env: e, ttlHours: 1, now: 0 })
	assert.equal(routeCount(e), 1)
	registerRoute({ sessionId: SESSION, subject: "new", env: e, now: 10 * 86_400_000 })
	assert.equal(routeCount(e), 1, "the expired one is dropped")
})

test("a short tag is not confused with a signed token", () => {
	assert.equal(routeIdFromSubject("Re: [pi:a1b2c3] pi: x"), "a1b2c3")
	assert.equal(routeIdFromSubject("[pi:AgGhxFPy_HFpjIlpyT-hoVJRP2HY.e2uUO7fw] pi: x"), undefined)
	assert.equal(routeIdFromSubject("no tag here"), undefined)
	assert.equal(routeIdFromSubject(undefined), undefined)
})

test("the whole subject stays short", () => {
	const e = env()
	const context = {
		sessionId: SESSION,
		sessionName: "fix-login",
		device: "ybc-linux",
		cwd: "/home/ybc/Work/proj",
		lastAssistantText: "done",
		turns: 3,
	}
	const id = registerRoute({ sessionId: SESSION, subject: "pi: ctx", device: "ybc-linux", env: e })
	const subject = buildSettleSubject(context, Buffer.alloc(32, 1), id)

	assert.match(subject, ROUTE_RE)
	assert.ok(
		subject.length <= 70,
		`subject should stay readable in a notification preview, got ${subject.length}: ${subject}`,
	)
	assert.match(subject, /fix-login @ ybc-linux is waiting for you/)

	// And the old signed form is still available as a fallback, just longer.
	const long = buildSettleSubject(context, Buffer.alloc(32, 1))
	assert.ok(long.length > subject.length)
	assert.match(long, /^\[pi:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\]/)
})

// --- one route per session, so the subject is stable ----------------------

test("a session keeps one route id across many notifications", () => {
	const e = env()
	const first = ensureRouteForSession({ sessionId: SESSION, subject: "pi: fix-login", device: "ybc-linux", env: e })
	const second = ensureRouteForSession({ sessionId: SESSION, subject: "pi: fix-login", device: "ybc-linux", env: e })
	const third = ensureRouteForSession({ sessionId: SESSION, subject: "pi: fix-login", device: "ybc-linux", env: e })

	assert.equal(first, second)
	assert.equal(second, third)
	assert.equal(routeCount(e), 1, "one route, not one per message")
})

test("distinct sessions get distinct routes", () => {
	const e = env()
	const a = ensureRouteForSession({ sessionId: SESSION, subject: "a", env: e })
	const b = ensureRouteForSession({ sessionId: "other-session", subject: "b", env: e })
	assert.notEqual(a, b)
})

test("reusing a route refreshes its expiry", () => {
	const e = env()
	const id = ensureRouteForSession({ sessionId: SESSION, subject: "x", env: e, ttlHours: 1, now: 0 })
	ensureRouteForSession({ sessionId: SESSION, subject: "x", env: e, ttlHours: 1, now: 3_000_000 })
	assert.ok(resolveRoute(id, { env: e, now: 3_500_000 }), "still live after the refresh")
})

test("a stable route means an identical subject, which is what clients group on", () => {
	const e = env()
	const context = {
		sessionId: SESSION,
		sessionName: "fix-login",
		device: "ybc-linux",
		cwd: "/home/ybc",
		lastAssistantText: "turn one",
		turns: 1,
	}
	const secret = Buffer.alloc(32, 1)

	const firstTag = ensureRouteForSession({ sessionId: SESSION, subject: "pi: ctx", device: "ybc-linux", env: e })
	const first = buildSettleSubject(context, secret, firstTag)
	const secondTag = ensureRouteForSession({ sessionId: SESSION, subject: "pi: ctx", device: "ybc-linux", env: e })
	const second = buildSettleSubject({ ...context, lastAssistantText: "turn two", turns: 2 }, secret, secondTag)

	assert.equal(first, second, "threading by conversation topic needs a byte-identical subject")
})

test("an 8-hex collision fallback is still matchable", async () => {
	// The collision fallback mints 8 hex; ROUTE_RE used to accept exactly 6, so such an id
	// could never be read back out of a subject and its session's replies were dropped.
	const { ROUTE_RE: pattern } = await import("../src/store/routes.ts")
	assert.equal(pattern.exec("[pi:abcdef12] pi: x")?.[1], "abcdef12")
	assert.equal(pattern.exec("[pi:abcdef] pi: x")?.[1], "abcdef")
})

test("the configured TTL bounds a route as well as a token", async () => {
	const e = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-routes-")) }
	const t0 = Date.UTC(2026, 0, 1)
	const id = ensureRouteForSession({ sessionId: "01a1c453-f2fc-7169-8c89-69c93fa1a152", subject: "x", env: e, now: t0, ttlHours: 1 })
	assert.ok(resolveRoute(id, { env: e, now: t0 + 59 * 60_000 }))
	assert.equal(resolveRoute(id, { env: e, now: t0 + 61 * 60_000 }), undefined)
})

test("concurrent route minting from separate processes loses nothing", async () => {
	// routes.json is the one store written by every pi process. Without a lock, two sessions
	// settling at once each wrote their whole copy and one route vanished - so the reply fell
	// back to the threading chain, or to no-token. The processes must run concurrently for
	// this to mean anything.
	const e = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-routes-lock-")) }
	const moduleUrl = new URL("../src/store/routes.ts", import.meta.url).href
	const script = `
		import { ensureRouteForSession } from ${JSON.stringify(moduleUrl)}
		const env = { XDG_STATE_HOME: ${JSON.stringify(e.XDG_STATE_HOME)} }
		const tag = process.argv[process.argv.length - 1]
		for (let i = 0; i < 60; i++) ensureRouteForSession({ sessionId: tag + "-" + i, subject: "x", env })
	`
	const { spawn } = await import("node:child_process")
	const statuses = await Promise.all(
		["a", "b", "c", "d"].map(
			(tag) =>
				new Promise<number>((resolve) => {
					const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, tag], {
						stdio: "ignore",
					})
					child.on("exit", (code) => resolve(code ?? 1))
				}),
		),
	)
	assert.deepEqual(statuses, [0, 0, 0, 0], "all four writers succeeded")
	const { routeCount } = await import("../src/store/routes.ts")
	assert.equal(routeCount(e), 240, "every route survived")
})

test("a lock left by a dead process is stolen within the retry budget", async () => {
	// The budget used to be ~1 s while a lock was only stealable after 5 s, so a writer killed
	// inside the lock made the next notification fail outright for those 5 s.
	const { statePath } = await import("../src/store/paths.ts")
	const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs")
	const e = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-lock-")) }
	const lock = statePath(e, "routes.lock")
	mkdirSync(join(e.XDG_STATE_HOME!, "pi-mailbridge"), { recursive: true })
	writeFileSync(lock, "99999:deadbeef", { mode: 0o600 })
	const old = new Date(Date.now() - 5_000)
	utimesSync(lock, old, old)

	const id = ensureRouteForSession({ sessionId: "s1", subject: "x", env: e })
	assert.match(id, /^[0-9a-f]{6}$/, "minting succeeded despite the stale lock")
})

