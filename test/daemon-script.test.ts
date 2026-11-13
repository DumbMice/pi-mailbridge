import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveDaemonScript } from "../src/daemon/script.ts"

/** Only these paths exist, like a real tree. */
const existsOnly = (...paths: string[]) => (path: string) => paths.includes(path)

test("a published install resolves the compiled daemon from src/extension.ts", () => {
	// The pi manifest loads src/extension.ts through jiti inside node_modules. Spawning the .ts
	// daemon from there fails with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING - the exact bug
	// that shipped once already, because bin and the unit were fixed and this path was not.
	// The fixture has to live under node_modules: that path segment is the whole reason the
	// compiled entry is the only option there.
	assert.equal(
		resolveDaemonScript(
			"file:///app/node_modules/pi-mailbridge/src/extension.ts",
			existsOnly(
				"/app/node_modules/pi-mailbridge/dist/daemon/main.js",
				"/app/node_modules/pi-mailbridge/src/daemon/main.ts",
			),
		),
		"/app/node_modules/pi-mailbridge/dist/daemon/main.js",
	)
})

test("a checkout without a build falls back to the source", () => {
	assert.equal(
		resolveDaemonScript("file:///repo/src/extension.ts", existsOnly("/repo/src/daemon/main.ts")),
		"/repo/src/daemon/main.ts",
	)
})

test("a checkout prefers its sources to a leftover build", () => {
	// Editing src/daemon/* without rebuilding used to run the old dist - same API_VERSION, so no
	// mismatch, no warning, and the fix looks like it did not work.
	assert.equal(
		resolveDaemonScript(
			"file:///repo/src/extension.ts",
			existsOnly("/repo/src/daemon/main.ts", "/repo/dist/daemon/main.js"),
		),
		"/repo/src/daemon/main.ts",
	)
})

test("an installed package still prefers the build, source present or not", () => {
	assert.equal(
		resolveDaemonScript(
			"file:///app/node_modules/pi-mailbridge/src/extension.ts",
			existsOnly("/app/node_modules/pi-mailbridge/dist/daemon/main.js", "/app/node_modules/pi-mailbridge/src/daemon/main.ts"),
		),
		"/app/node_modules/pi-mailbridge/dist/daemon/main.js",
	)
})

test("a compiled module resolves its sibling", () => {
	assert.equal(
		resolveDaemonScript("file:///pkg/dist/extension.js", existsOnly("/pkg/dist/daemon/main.js")),
		"/pkg/dist/daemon/main.js",
	)
})
