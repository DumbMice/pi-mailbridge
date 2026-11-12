import { test } from "node:test"
import assert from "node:assert/strict"

import { shouldReloadConfig } from "../src/core/config-freshness.ts"

const loaded = Date.UTC(2026, 0, 1)

test("a config written after the daemon read it forces a reload", () => {
	assert.equal(shouldReloadConfig({ configLoadedAt: loaded, configMtimeMs: loaded + 60_000 }), true)
})

test("an unchanged (or older) config does not", () => {
	assert.equal(shouldReloadConfig({ configLoadedAt: loaded, configMtimeMs: loaded - 60_000 }), false)
	assert.equal(shouldReloadConfig({ configLoadedAt: loaded, configMtimeMs: loaded + 200 }), false, "sub-second writes are the same config")
})

test("no config file means nothing to do", () => {
	assert.equal(shouldReloadConfig({ configLoadedAt: loaded, configMtimeMs: null }), false)
	assert.equal(shouldReloadConfig({ configLoadedAt: undefined, configMtimeMs: undefined }), false)
})

test("a daemon running on defaults (stamp 0) reloads when a config file appears", () => {
	// 0 is not "nothing to compare": it means the daemon loaded with no file. Treating it as
	// absent made this permanent - a headless --setup afterwards was never picked up.
	assert.equal(shouldReloadConfig({ configLoadedAt: 0, configMtimeMs: loaded }), true)
})
