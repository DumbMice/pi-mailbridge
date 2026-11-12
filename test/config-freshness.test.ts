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

test("a daemon that reports nothing, or no config file, is left alone", () => {
	assert.equal(shouldReloadConfig({ configLoadedAt: null, configMtimeMs: loaded }), false)
	assert.equal(shouldReloadConfig({ configLoadedAt: loaded, configMtimeMs: null }), false)
	assert.equal(shouldReloadConfig({ configLoadedAt: undefined, configMtimeMs: undefined }), false)
})
