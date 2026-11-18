// Channel matching: who may start a session, and on which machine.

import { test } from "node:test"
import assert from "node:assert/strict"

import { STARTER_DEFAULTS } from "../src/core/config.ts"
import { matchChannel } from "../src/starter/channel.ts"

const channel = (over: Partial<typeof STARTER_DEFAULTS.channel> = {}) => ({ ...STARTER_DEFAULTS.channel, ...over })

test("the default channel is a subject prefix on the watched mailbox", () => {
	const ours = matchChannel(STARTER_DEFAULTS, { subject: "[pi-start] fix the flaky test", to: ["pi@example.com"], device: "dev-1" })
	assert.deepEqual(ours, { ours: true, title: "fix the flaky test" })

	// Case and padding do not matter; a different tag does.
	assert.equal(matchChannel(STARTER_DEFAULTS, { subject: "[PI-START] x", to: [], device: "dev-1" }).ours, true)
	assert.equal(matchChannel(STARTER_DEFAULTS, { subject: "  [ pi-start ]  x", to: [], device: "dev-1" }).ours, true)

	// "Re:" is how the documented reply-to-stop workflow comes back, so it is stripped, not rejected.
	assert.equal(matchChannel(STARTER_DEFAULTS, { subject: "Re: [pi-start] x", to: [], device: "dev-1" }).ours, true)
	assert.equal(matchChannel(STARTER_DEFAULTS, { subject: "RE: Fwd: [pi-start] x", to: [], device: "dev-1" }).ours, true)
	for (const subject of ["[pi] x", "pi-start: x", "[pi-start", "", "x [pi-start] y"]) {
		const result = matchChannel(STARTER_DEFAULTS, { subject, to: [], device: "dev-1" })
		assert.equal(result.ours, false, `${JSON.stringify(subject)} must not be a request`)
	}
})

test("a configured address is the channel, and does not need a prefix", () => {
	const config = { ...STARTER_DEFAULTS, channel: channel({ address: "start@example.com" }) }
	const byAddress = matchChannel(config, { subject: "fix the test", to: ["START@example.com"], device: "dev-1" })
	assert.deepEqual(byAddress, { ours: true, title: "fix the test" }, "the whole subject is the title")

	const otherAddress = matchChannel(config, { subject: "fix the test", to: ["elsewhere@example.com"], device: "dev-1" })
	assert.equal(otherAddress.ours, false)

	// And the prefix is not a second way in once an address is configured: prefixed mail sent elsewhere
	// belongs to someone else's channel, not this one.
	const prefixedElsewhere = matchChannel(config, { subject: "[pi-start] fix the test", to: ["other@example.com"], device: "dev-1" })
	assert.equal(prefixedElsewhere.ours, false)
})

test("a request tagged for another device is not ours, an untagged one is", () => {
	const input = { subject: "[pi-start] x", to: [], device: "dev-1" }
	assert.equal(matchChannel(STARTER_DEFAULTS, { ...input, deviceInSubject: "dev-2" }).ours, false)
	assert.equal(matchChannel(STARTER_DEFAULTS, { ...input, deviceInSubject: "DEV-1" }).ours, true)
	assert.equal(matchChannel(STARTER_DEFAULTS, { ...input, deviceInSubject: undefined }).ours, true)
})

test("the reason is specific enough to log", () => {
	assert.deepEqual(matchChannel(STARTER_DEFAULTS, { subject: "hello", to: [], device: "dev-1" }), {
		ours: false,
		reason: "not-this-channel",
	})
	assert.deepEqual(matchChannel({ ...STARTER_DEFAULTS, channel: channel({ subjectPrefix: "" }) }, { subject: undefined, to: [], device: "dev-1" }), {
		ours: false,
		reason: "empty",
	})
	assert.deepEqual(
		matchChannel(STARTER_DEFAULTS, { subject: "[pi-start] x", to: [], deviceInSubject: "dev-2", device: "dev-1" }),
		{ ours: false, reason: "other-device" },
	)
})
