// The helper is only useful if it runs. pi loads this file at startup and the proxy dispatcher is
// already installed by then, so the call has to happen at module scope in `extension.ts` - not in
// the activate hook, which may never run, and not in a `setup` path that a session never takes.
//
// This test would pass with the helper implemented and never called, so it asserts the wiring:
// importing the extension is the only action, and `NO_PROXY` must change as a side effect.

import assert from "node:assert/strict"
import { test } from "node:test"

test("loading the extension exempts loopback from the proxy", async () => {
	const saved = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }
	try {
		process.env.HTTP_PROXY = "http://127.0.0.1:1"
		delete process.env.NO_PROXY
		delete process.env.no_proxy

		// No call, no activate hook, no fake `pi`: just the import, the way pi loads it.
		await import("../src/extension.ts")

		const entries = (process.env.NO_PROXY ?? "").split(",")
		assert.deepEqual(entries, ["localhost", "127.0.0.1", "::1"], "loopback must be exempt once the module has loaded")
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
})
