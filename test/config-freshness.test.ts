import { test } from "node:test"
import assert from "node:assert/strict"

import { shouldReloadConfig } from "../src/core/config-freshness.ts"

const loaded = Date.UTC(2026, 0, 1)

test("a config written after the daemon read it forces a reload", () => {
	assert.equal(shouldReloadConfig({ configLoadedAt: loaded, configMtimeMs: loaded + 60_000 }), true)
})

test("an unchanged or older config does not reload", () => {
	assert.equal(shouldReloadConfig({ configLoadedAt: loaded, configMtimeMs: loaded }), false, "same file, same mtime")
	assert.equal(shouldReloadConfig({ configLoadedAt: loaded, configMtimeMs: loaded - 60_000 }), false)
})

test("a newer mtime is newer content, however close", () => {
	// A tolerance here permanently missed a config saved twice by an editor - the failure
	// this check exists to prevent.
	assert.equal(shouldReloadConfig({ configLoadedAt: loaded, configMtimeMs: loaded + 200 }), true)
})

test("no config file means nothing to do", () => {
	assert.equal(shouldReloadConfig({ configLoadedAt: loaded, configMtimeMs: null }), false)
	assert.equal(shouldReloadConfig({ configLoadedAt: undefined, configMtimeMs: undefined }), false)
})

test("a daemon running on defaults (stamp 0) reloads when a config file appears", () => {
	// 0 is not "nothing to compare": it means the daemon loaded with no file.
	assert.equal(shouldReloadConfig({ configLoadedAt: 0, configMtimeMs: loaded }), true)
})
