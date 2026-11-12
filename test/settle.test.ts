import { test } from "node:test"
import assert from "node:assert/strict"

import { buildSettleBody, buildSettleSubject, createSettleNotifier, MAX_BODY_CHARS, REPLY_HINT, type SettleContext } from "../src/core/settle.ts"
import { sessionIdFromSubject } from "../src/core/token.ts"
import type { Mode } from "../src/store/mode-store.ts"

const SECRET = Buffer.alloc(32, 5)
const SESSION = "01a1c453-f2fc-7169-8c89-69c93fa1a152"

function context(over: Partial<SettleContext> = {}): SettleContext {
	return { sessionId: SESSION, sessionName: "fix-login", cwd: "/home/ybc/Work/proj", turns: 3, lastAssistantText: "Done: the failing test passes now.", ...over }
}

function fakeTimers() {
	const queue: { handler: () => void; ms: number }[] = []
	return {
		queue,
		timers: {
			setTimeout(handler: () => void, ms: number) {
				queue.push({ handler, ms })
				return queue.length
			},
			clearTimeout() {},
		},
		/** Fire the newest scheduled handler. */
		async run() {
			const next = queue.pop()
			next?.handler()
			await new Promise((r) => setImmediate(r))
		},
	}
}

function rig(over: { mode?: Mode; aborted?: boolean; onSettled?: boolean; debounceMs?: number; notifyOnAborted?: boolean } = {}) {
	const sent: { to: string; subject: string; text: string }[] = []
	const errors: Error[] = []
	const t = fakeTimers()
	const notifier = createSettleNotifier({
		mode: () => over.mode ?? "on",
		context: () => context(),
		send: async (m) => {
			sent.push(m)
		},
		secret: () => SECRET,
		config: {
			onSettled: over.onSettled ?? true,
			debounceMs: over.debounceMs ?? 10_000,
			notifyOnAborted: over.notifyOnAborted ?? false,
		},
		timers: t.timers,
		onError: (e) => errors.push(e),
	})
	return { notifier, sent, errors, timers: t }
}

test("a normal settle schedules a debounced send", async () => {
	const r = rig()
	assert.equal(r.notifier.settled({ aborted: false }), "scheduled")
	assert.equal(r.sent.length, 0, "nothing sent until the debounce elapses")
	assert.equal(r.timers.queue[0]!.ms, 10_000)

	await r.timers.run()
	assert.equal(r.sent.length, 1)
	assert.match(r.sent[0]!.text, /failing test passes/)
	assert.match(r.sent[0]!.text, /fix-login/)
	assert.match(r.sent[0]!.text, /\/home\/ybc\/Work\/proj/)
	assert.ok(r.sent[0]!.text.includes(REPLY_HINT))
})

test("mode off sends nothing", () => {
	const r = rig({ mode: "off" })
	assert.equal(r.notifier.settled({}), "mode-off")
	assert.equal(r.timers.queue.length, 0, "no timer armed")
})

test("an aborted settle is skipped by default", () => {
	const r = rig()
	assert.equal(r.notifier.settled({ aborted: true }), "aborted")
	assert.equal(r.timers.queue.length, 0)
})

test("notifyOnAborted sends on an abort when asked", async () => {
	const r = rig({ notifyOnAborted: true })
	assert.equal(r.notifier.settled({ aborted: true }), "scheduled")
	await r.timers.run()
	assert.equal(r.sent.length, 1)
})

test("onSettled=false disables the finished mail", () => {
	const r = rig({ onSettled: false })
	assert.equal(r.notifier.settled({}), "disabled")
	assert.equal(r.timers.queue.length, 0)
})

test("rapid settles collapse into one send", async () => {
	const r = rig()
	r.notifier.settled({})
	r.notifier.settled({})
	r.notifier.settled({})
	assert.equal(r.timers.queue.length, 3, "each settle armed a timer")
	// Only the last timer survives (clearTimeout is a no-op in the fake, but the
	// notifier drops the stale context), so one send results.
	await r.timers.run()
	assert.equal(r.sent.length, 1, "exactly one email")
})

test("the subject carries a token that routes back to this session", async () => {
	const r = rig()
	r.notifier.settled({})
	await r.timers.run()
	const subject = r.sent[0]!.subject
	assert.match(subject, /^\[pi:/)
	assert.equal(sessionIdFromSubject(subject, SECRET), SESSION)
	// And a different key must not verify it.
	assert.equal(sessionIdFromSubject(subject, Buffer.alloc(32, 9)), undefined)
})

test("the subject is human-readable when a session name exists", () => {
	const subject = buildSettleSubject(context(), SECRET)
	assert.match(subject, /fix-login is waiting for you/)
})

test("the subject falls back to the project directory", () => {
	const subject = buildSettleSubject(context({ sessionName: undefined }), SECRET)
	assert.match(subject, /proj is waiting for you/)
})

test("the body is never empty, even with no assistant text", () => {
	const body = buildSettleBody(context({ lastAssistantText: undefined }))
	assert.match(body, /no text this turn/)
	assert.ok(body.includes(REPLY_HINT))
})

test("a send failure surfaces through onError and does not throw", async () => {
	const errors: Error[] = []
	const t = fakeTimers()
	const notifier = createSettleNotifier({
		mode: () => "on",
		context: () => context(),
		send: async () => {
			throw new Error("502 send_failed")
		},
		secret: () => SECRET,
		config: { onSettled: true, debounceMs: 0, notifyOnAborted: false },
		timers: t.timers,
		onError: (e) => errors.push(e),
	})
	notifier.settled({})
	await t.run()
	assert.equal(errors.length, 1)
	assert.match(errors[0]!.message, /502/)
})

test("flush sends immediately and clears the pending state", async () => {
	const r = rig()
	r.notifier.settled({})
	assert.equal(r.notifier.isPending(), true)
	await r.notifier.flush()
	assert.equal(r.sent.length, 1)
	assert.equal(r.notifier.isPending(), false)
})

test("cancel drops a pending send without sending", () => {
	const r = rig()
	r.notifier.settled({})
	r.notifier.cancel()
	assert.equal(r.notifier.isPending(), false)
	assert.equal(r.sent.length, 0)
})

test("no session context means nothing to send", () => {
	const t = fakeTimers()
	const notifier = createSettleNotifier({
		mode: () => "on",
		context: () => undefined,
		send: async () => {},
		secret: () => SECRET,
		config: { onSettled: true, debounceMs: 0, notifyOnAborted: false },
		timers: t.timers,
	})
	assert.equal(notifier.settled({}), "no-context")
	assert.equal(t.queue.length, 0)
})

test("the subject names the device as well as the session", () => {
	const subject = buildSettleSubject(context({ device: "dev-box-7" }), SECRET)
	assert.match(subject, /fix-login @ dev-box-7 is waiting for you/)
	assert.equal(sessionIdFromSubject(subject, SECRET), SESSION, "token still routes")
})

test("the body lists device, session, id and project", () => {
	const body = buildSettleBody(context({ device: "dev-box-7" }))
	for (const expected of ["device: dev-box-7", "session: fix-login", `session id: ${SESSION}`, "project: /home/ybc/Work/proj"]) {
		assert.ok(body.includes(expected), `missing "${expected}" in:\n${body}`)
	}
})

test("the subject degrades cleanly with no device", () => {
	const subject = buildSettleSubject(context({ device: undefined }), SECRET)
	assert.match(subject, /fix-login is waiting for you/)
	assert.ok(!subject.includes("@"))
})

test("a very long answer is truncated rather than mailed whole", () => {
	const long = "x".repeat(MAX_BODY_CHARS + 500)
	const body = buildSettleBody(context({ lastAssistantText: long }))
	assert.ok(body.length < long.length + 400, "body must be bounded")
	assert.match(body, /truncated \(500 more characters\)/)
})
