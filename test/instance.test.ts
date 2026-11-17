// This run's daemon-facing identity.
//
// The daemon keys a session's email-mode override on it and keeps it for 24 h, refreshing it on every
// ping. A pid alone is not an identity: pids are recycled, and a session killed with SIGKILL never
// sends `/bye`, so its override outlives it - a later process with the same pid would inherit a
// decision it never made, in either direction.

import assert from "node:assert/strict"
import { test } from "node:test"

import { sessionInstanceId } from "../src/core/instance.ts"

test("the identity carries the pid and a per-run suffix", () => {
	const id = sessionInstanceId(4242, () => "deadbeef")
	assert.equal(id, "pi-4242-deadbeef")
	assert.match(sessionInstanceId(), /^pi-\d+-[0-9a-f]{8}$/, "the real id has 4 random bytes in hex")
})

test("two runs never share an identity, even with the same pid", () => {
	// The defect this prevents: an override keyed on `pi-<pid>` survives a SIGKILL, and the next
	// process that receives that pid inherits it - quiet without asking, or mailing without asking.
	const a = sessionInstanceId(4242, () => "aaaaaaaa")
	const b = sessionInstanceId(4242, () => "bbbbbbbb")
	assert.notEqual(a, b)
	assert.deepEqual(
		new Set(Array.from({ length: 50 }, () => sessionInstanceId())).size,
		50,
		"and consecutive calls differ in practice",
	)
})
