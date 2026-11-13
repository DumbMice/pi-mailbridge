import { test } from "node:test"
import assert from "node:assert/strict"

import { needsRestart, packageVersion } from "../src/core/version.ts"

test("the running build knows its own version", () => {
	// src/core/version.ts is two levels below the package root, like dist/core/version.js.
	assert.match(packageVersion(import.meta.url), /^\d+\.\d+\.\d+/, "a real version, not unknown")
})

test("a daemon from another build is replaced; an old one without the field too", () => {
	assert.equal(needsRestart("0.1.0", "0.1.0"), false)
	assert.equal(needsRestart("0.1.0", "0.0.9"), true, "older daemon")
	assert.equal(needsRestart("0.1.0", "0.2.0"), true, "ahead of us in the same package")
	// A daemon from before /health carried the field: replacing it is the only way to get the
	// new behaviour, and it cannot be resolved against.
	assert.equal(needsRestart("0.1.0", undefined), true)
	assert.equal(needsRestart("0.1.0", ""), true)
	// If this build cannot identify itself, do nothing: killing a daemon on a guess is worse.
	assert.equal(needsRestart("unknown", "0.1.0"), false)
})
