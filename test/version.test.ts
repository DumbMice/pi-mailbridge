import { test } from "node:test"
import assert from "node:assert/strict"

import { packageVersion } from "../src/core/version.ts"

test("the running build knows its own version", () => {
	// src/core/version.ts is one or two levels below the package root depending on whether this
	// is a checkout or the compiled dist; the walk-up handles both.
	assert.match(packageVersion(import.meta.url), /^\d+\.\d+\.\d+/, "a real version, not unknown")
	assert.match(packageVersion(new URL("../src/extension.ts", import.meta.url)), /^\d+\.\d+\.\d+/, "from the extension too")
})
