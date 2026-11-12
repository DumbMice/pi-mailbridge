import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_MODE, isMode, readMode, scanningEnabled, writeMode } from "../src/store/mode-store.ts"
import { DEFAULT_MAX_ENTRIES, REGISTRY_TTL_MS, createRegistry } from "../src/store/registry.ts"

const env = () => ({ XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-mode-")) })

// --- mode ------------------------------------------------------------------

test("mode defaults to off when the file is missing", () => {
	const e = env()
	assert.equal(DEFAULT_MODE, "off")
	assert.equal(readMode(e), "off")
})

test("mode round-trips through on and off", () => {
	const e = env()
	assert.equal(writeMode(e, "on"), "on")
	assert.equal(readMode(e), "on")
	assert.equal(writeMode(e, "off"), "off")
	assert.equal(readMode(e), "off")
})

test("mode survives a new env pointing at the same dir (daemon restart)", () => {
	const e = env()
	writeMode(e, "on")
	const reopened = { XDG_STATE_HOME: e.XDG_STATE_HOME }
	assert.equal(readMode(reopened), "on")
})

test("a corrupt mode file degrades to off rather than throwing", () => {
	const e = env()
	writeMode(e, "on")
	writeFileSync(join(e.XDG_STATE_HOME!, "pi-mailbridge", "mode.json"), "{not json")
	assert.equal(readMode(e), "off")
})

test("isMode validates input", () => {
	assert.equal(isMode("on"), true)
	assert.equal(isMode("off"), true)
	for (const bad of ["ON", "yes", "", null, undefined, 1]) assert.equal(isMode(bad), false)
})

// --- registry --------------------------------------------------------------

test("first register reserves, second reports alreadyPending", () => {
	const r = createRegistry()
	assert.deepEqual(r.register("s1"), { alreadyPending: false, full: false })
	assert.deepEqual(r.register("s1"), { alreadyPending: true, full: false })
	assert.equal(r.size(), 1)
})

test("release frees the slot for a new decision", () => {
	const r = createRegistry()
	r.register("s1")
	r.release("s1")
	assert.equal(r.has("s1"), false)
	assert.deepEqual(r.register("s1"), { alreadyPending: false, full: false })
})

test("release is idempotent", () => {
	const r = createRegistry()
	r.release("nope")
	r.release("nope")
	assert.equal(r.size(), 0)
})

test("sessions are independent", () => {
	const r = createRegistry()
	r.register("s1")
	r.register("s2")
	assert.deepEqual(r.register("s1"), { alreadyPending: true, full: false })
	assert.deepEqual(r.register("s2"), { alreadyPending: true, full: false })
	assert.equal(r.size(), 2)
})

test("reservations expire after the TTL", () => {
	let clock = 0
	const r = createRegistry({ ttlMs: 1000, now: () => clock })
	r.register("s1")

	clock = 999
	assert.equal(r.has("s1"), true)

	clock = 1001
	assert.equal(r.has("s1"), false, "expired and pruned")
	assert.deepEqual(r.register("s1"), { alreadyPending: false, full: false })
})

test("re-registering refreshes the TTL", () => {
	let clock = 0
	const r = createRegistry({ ttlMs: 1000, now: () => clock })
	r.register("s1")
	clock = 900
	r.register("s1") // refresh
	clock = 1500
	assert.equal(r.has("s1"), true, "kept alive by the refresh")
})

test("the cap rejects cleanly instead of growing", () => {
	const r = createRegistry({ maxEntries: 2, now: () => 0 })
	assert.deepEqual(r.register("a"), { alreadyPending: false, full: false })
	assert.deepEqual(r.register("b"), { alreadyPending: false, full: false })
	assert.deepEqual(r.register("c"), { alreadyPending: false, full: true })
	assert.equal(r.size(), 2, "cap respected")
	// An existing entry still refreshes even when full.
	assert.deepEqual(r.register("a"), { alreadyPending: true, full: false })
})

test("list reports live sessions only", () => {
	let clock = 0
	const r = createRegistry({ ttlMs: 1000, now: () => clock })
	r.register("s1")
	r.register("s2")
	assert.deepEqual(r.list().sort(), ["s1", "s2"])
	clock = 2000
	assert.deepEqual(r.list(), [])
})

test("defaults are sane", () => {
	assert.equal(REGISTRY_TTL_MS, 24 * 60 * 60 * 1000)
	assert.equal(DEFAULT_MAX_ENTRIES, 10_000)
})

test("scanningEnabled: only 'on' lets the daemon touch the mailbox", () => {
	// The rule /back rests on, in one place.
	assert.equal(scanningEnabled("on"), true)
	assert.equal(scanningEnabled("off"), false)
})
