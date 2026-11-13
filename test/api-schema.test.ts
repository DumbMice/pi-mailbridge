import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { API_VERSION, CAPABILITIES, ENDPOINTS, apiCompatible } from "../src/daemon/api.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

test("the endpoint list is the surface the daemon actually serves", () => {
	// Snapshot: adding or removing an endpoint is a deliberate edit here, and a breaking change
	// to one of them is an API_VERSION bump (AGENTS.md "Compatibility").
	const service = readFileSync(`${root}/src/daemon/service.ts`, "utf8")
	const served = [...service.matchAll(/case "(GET|POST|DELETE) (\/[a-z]+)"/g)].map(
		(m) => `${m[1]} ${m[2]}`,
	)
	// /health is unauthenticated, so it is handled before the auth switch rather than as a case.
	if (/url\.pathname === "\/health"/.test(service)) served.push("GET /health")
	assert.deepEqual(served.sort(), [...ENDPOINTS].sort(), "service.ts and api.ts disagree")
	assert.equal(API_VERSION, 1, "bumping this is a deliberate act")
})

test("compatibility is protocol equality, not a range", () => {
	// Strict equality, like the local-daemon contracts we modelled on: a mismatch is replaced,
	// never negotiated down.
	assert.equal(apiCompatible(1, 1), true)
	assert.equal(apiCompatible(1, 2), false)
	assert.equal(apiCompatible(1, 0), false)
	// A daemon from before the field existed is protocol 0, not "probably fine".
	assert.equal(apiCompatible(1, undefined), false)
})

test("the capability list is a subset of what the base contract promises", () => {
	assert.ok(CAPABILITIES.includes("health"), "health is the foundation")
	assert.equal(new Set(CAPABILITIES).size, CAPABILITIES.length, "no duplicates")
	// Additive features live here; a client must check before using one.
	assert.ok(CAPABILITIES.length >= 3)
})
