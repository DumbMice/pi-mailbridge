import { test } from "node:test"
import assert from "node:assert/strict"

import { resolveDaemonScript } from "../src/daemon/script.ts"

/** Only these paths exist, like a real tree. */
const existsOnly = (...paths: string[]) => (path: string) => paths.includes(path)

test("a published install resolves the compiled daemon from src/extension.ts", () => {
	// The pi manifest loads src/extension.ts through jiti inside node_modules. Spawning the .ts
	// daemon from there fails with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING - the exact bug
	// that shipped once already, because bin and the unit were fixed and this path was not.
	assert.equal(
		resolveDaemonScript(
			"file:///pkg/src/extension.ts",
			existsOnly("/pkg/dist/daemon/main.js", "/pkg/src/daemon/main.ts"),
		),
		"/pkg/dist/daemon/main.js",
	)
})

test("a checkout without a build falls back to the source", () => {
	assert.equal(
		resolveDaemonScript("file:///repo/src/extension.ts", existsOnly("/repo/src/daemon/main.ts")),
		"/repo/src/daemon/main.ts",
	)
})

test("a compiled module resolves its sibling", () => {
	assert.equal(
		resolveDaemonScript("file:///pkg/dist/extension.js", existsOnly("/pkg/dist/daemon/main.js")),
		"/pkg/dist/daemon/main.js",
	)
})
