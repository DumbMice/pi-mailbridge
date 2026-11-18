// The decision pipeline: what happens to one message, in the security order.
//
// The cases below are the ones that decide whether this feature is safe, so they are asserted directly:
// unauthenticated mail is ignored without a reply, a bad path is refused with the reason, a reservation
// exists before the spawn, and a stop can only reach sessions the journal owns.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { STARTER_DEFAULTS, type ResolvedConfig } from "../src/core/config.ts"
import { handleMail, type HandleDeps, type StarterMail } from "../src/starter/handle.ts"
import { type JournalFile, readJournal, writeJournal } from "../src/starter/journal.ts"
import type { SpawnPlan } from "../src/starter/spawn.ts"

const env = () => ({ XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-handle-")), XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "pmb-cfg-")) })

function config(over: Partial<typeof STARTER_DEFAULTS> = {}): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "pi@example.com", password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: "pi@example.com", password: "x", authType: "LOGIN" },
			to: "me@example.com",
		},
		device: { name: "dev-1" },
		security: { allowFrom: ["me@example.com"], requireDmarcPass: true, tokenTtlHours: 720 },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 10_000, notifyOnAborted: false, maxAttachmentMb: 18 },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		warnings: [],
		starter: {
			...STARTER_DEFAULTS,
			enabled: true,
			roots: ["/tmp"],
			models: ["deepseek/deepseek-flash"],
			...over,
		},
	}
}

const mail = (over: Partial<StarterMail> = {}, cwd = "/tmp"): StarterMail => ({
	subject: "[pi-start] fix the auth test",
	from: "me@example.com",
	to: ["pi@example.com"],
	// DMARC is required by this config: every accepted case needs a passing header.
	headers: { authResults: ["mx.example.com; dmarc=pass"] },
	messageId: "<req-1@example.com>",
	uid: 1,
	uidValidity: 1111,
	receivedAt: Date.now(),
	body: `cwd: ${cwd}`,
	...over,
})

interface Rig {
	project: string
	deps: HandleDeps
	journal: JournalFile
	spawned: SpawnPlan[]
	replies: { subject: string; text: string; inReplyTo: string }[]
	stopped: string[]
	saved: number
}

function rig(
	over: {
		config?: ResolvedConfig
		journal?: JournalFile
		spawnResult?: { ok: true; tmuxSessionId: string }
		starter?: Partial<typeof STARTER_DEFAULTS>
	} = {},
): Rig {
	// The root is a temp dir and the session lives one level below it: a root is not itself a session.
	const base = mkdtempSync(join(tmpdir(), "pmb-root-"))
	const project = join(base, "project")
	mkdirSync(project, { recursive: true })
	const cfg = over.config ?? config({ roots: [base], ...over.starter })
	const e = env()
	const journal: JournalFile = over.journal ?? { v: 1, requests: {}, sessions: {} }
	const spawned: SpawnPlan[] = []
	const replies: Rig["replies"] = []
	const stopped: string[] = []
	let saved = 0
	const deps: HandleDeps = {
		config: cfg,
		journal,
		save: () => {
			saved += 1
		},
		writePrompt: (id) => ({ promptFile: `/tmp/${id}.txt`, readyFile: `/tmp/${id}.ready` }),
		spawn: async (plan) => {
			spawned.push(plan)
			return over.spawnResult ?? { ok: true, tmuxSessionId: "$1" }
		},
		stop: async (id) => {
			stopped.push(id)
			return { ok: true }
		},
		list: async () => [{ id: "$1", name: "fix-auth" }],
		send: async (message) => {
			replies.push(message)
		},
		now: () => 1_700_000_000_000,
		env: e,
		log: () => {},
		bootstrapPath: "/opt/bootstrap.js",
	}
	return {
		project,
		deps,
		journal,
		spawned,
		replies,
		stopped,
		get saved() {
			return saved
		},
	}
}

test("unauthenticated mail is ignored: no spawn, no parser, and no reply", async () => {
	// Replying to a stranger is backscatter, which is why the ignore happens before anything else.
	const r = rig()
	for (const from of ["stranger@example.com", undefined]) {
		const outcome = await handleMail(mail({ from }), r.deps)
		assert.equal(outcome.action, "ignored")
	}
	assert.equal(r.spawned.length, 0)
	assert.equal(r.replies.length, 0)
})

test("a robot, our own echo, or a missing DMARC pass is ignored silently", async () => {
	const r = rig()
	const noDmarc = await handleMail(mail({ headers: {} }), r.deps)
	assert.deepEqual(noDmarc, { action: "ignored", reason: "unauthenticated:dmarc-missing" })

	const robot = await handleMail(mail({ headers: { authResults: ["mx.example.com; dmarc=pass"], autoSubmitted: "auto-replied" } }), r.deps)
	assert.equal(robot.action, "ignored")

	const echo = await handleMail(mail({ headers: { authResults: ["mx.example.com; dmarc=pass"], xPiMailbridge: "notification" } }), r.deps)
	assert.deepEqual(echo, { action: "ignored", reason: "self-echo" })

	assert.equal(r.spawned.length, 0)
	assert.equal(r.replies.length, 0)
})

test("mail that is not on the channel, or is stale, or is a duplicate, is ignored", async () => {
	const r = rig()
	assert.equal((await handleMail(mail({ subject: "hello there" }, r.project), r.deps)).action, "ignored")
	assert.deepEqual(await handleMail(mail({ receivedAt: 1 }, r.project), r.deps), { action: "ignored", reason: "stale" })

	const first = await handleMail(mail({}, r.project), r.deps)
	assert.equal(first.action, "started")
	const again = await handleMail(mail({ uid: 2 }, r.project), r.deps)
	assert.equal(again.action, "ignored", "the same Message-ID is handled once")
	assert.equal(r.spawned.length, 1)
})

test("a complete request reserves, spawns without the prompt, and replies with the attach line", async () => {
	const r = rig()
	const outcome = await handleMail(mail({ body: `cwd: ${r.project}\nmodel: deepseek/deepseek-flash\nprompt: fix it` }, r.project), r.deps)
	assert.equal(outcome.action, "started")
	if (outcome.action === "started") assert.equal(outcome.name, "fix-the-auth-test", "the title derives the name")

	const plan = r.spawned[0]!
	assert.equal(plan.cwd, r.project)
	assert.equal(plan.model, "deepseek/deepseek-flash")
	assert.equal(plan.promptFile, `/tmp/${plan.requestId}.txt`)
	assert.equal(plan.emailMode, "on", "autoEnableMail is on by default")
	assert.equal(Object.hasOwn(plan, "prompt"), false, "the prompt is not part of the plan")
	assert.equal(JSON.stringify(plan).includes("fix it"), false, "and never appears in the argv-derived plan")

	const record = Object.values(r.journal.requests)[0]!
	assert.equal(record.state, "ready")
	assert.equal(record.resultSent, true)
	assert.equal(record.tmuxSessionId, "$1")
	assert.equal(r.journal.sessions["fix-the-auth-test"]?.requestId, record.id)
	assert.match(r.replies[0]!.text, /started fix-the-auth-test/)
	assert.match(r.replies[0]!.text, /attach: tmux -L pimail attach -t fix-the-auth-test/)
	assert.equal(r.replies[0]!.inReplyTo, "<req-1@example.com>")
	assert.ok(r.saved >= 3, "reserved, spawning, ready: the journal is written before acting")
})

test("a bad path, model or name is refused with the reason, and nothing is spawned", async () => {
	const cases = (project: string) =>
		[
			["cwd: /etc", "outside-root"],
			[`cwd: ${project}\nmodel: other/model`, "model-not-allowed"],
			[`cwd: ${project}\nthinking: turbo`, "bad-thinking"],
			[`cwd: ${project}\npromt: x`, "unknown-field"],
		] as const
	for (const r of [rig()]) {
		let n = 0
		for (const [body, code] of cases(r.project)) {
			n += 1
			// Distinct Message-IDs: each refusal is recorded now, and one mail cannot be four requests.
			const outcome = await handleMail(mail({ body, uid: 100 + n, messageId: `<case-${n}@x>` }, r.project), r.deps)
			assert.equal(outcome.action, "refused", body)
			if (outcome.action === "refused") assert.equal(outcome.code, code)
			assert.equal(r.spawned.length, 0)
			assert.match(r.replies[0]!.text, /refused/)
		}
	}
})

test("a missing cwd is refused without the agent, and filled by it when allowed", async () => {
	const noAgent = rig()
	const refused = await handleMail(mail({ body: "prompt: do something" }, noAgent.project), noAgent.deps)
	assert.equal(refused.action, "refused")
	if (refused.action === "refused") assert.equal(refused.code, "missing-cwd")

	const withAgent = rig()
	withAgent.deps.parseWithAgent = async () => ({ cwd: withAgent.project })
	const started = await handleMail(
		mail({ body: "parse: agent\nprompt: find the bug", subject: "[pi-start] find the bug", uid: 7 }, withAgent.project),
		withAgent.deps,
	)
	assert.equal(started.action, "started", "the agent fills the missing cwd, which is then validated")

	const hallucinating = rig()
	hallucinating.deps.parseWithAgent = async () => ({ cwd: "/etc" })
	const caught = await handleMail(
		mail({ body: "parse: agent\nprompt: x", uid: 8 }, hallucinating.project),
		hallucinating.deps,
	)
	assert.equal(caught.action, "refused", "the agent's answer is validated like any other")
	if (caught.action === "refused") assert.equal(caught.code, "outside-root")
})

test("a refused spawn is recorded and reported; a crash-window record says what should exist", async () => {
	const r = rig({ spawnResult: { ok: true, tmuxSessionId: "$1" } })
	const removed: string[] = []
	r.deps.removePrompt = (id) => removed.push(id)
	r.deps.spawn = async (plan) => {
		r.spawned.push(plan)
		return { ok: false, reason: "unready", detail: "Unknown model" }
	}
	const outcome = await handleMail(mail({}, r.project), r.deps)
	assert.equal(outcome.action, "refused")
	const record = Object.values(r.journal.requests)[0]!
	assert.equal(record.state, "refused")
	assert.match(record.reason ?? "", /unready/)
	assert.match(r.replies[0]!.text, /Unknown model/)
	assert.equal(removed.length, 1, "the prompt file is removed: no bootstrap will ever read it")
})

test("stop only touches sessions the journal owns, and by their immutable id", async () => {
	const r = rig()
	await handleMail(mail({}, r.project), r.deps)
	r.stopped.length = 0

	const ok = await handleMail(mail({ messageId: "<stop@x>", uid: 2, body: "stop: fix-the-auth-test" }, r.project), r.deps)
	assert.equal(ok.action, "stopped")
	assert.deepEqual(r.stopped, ["$1"], "killed by session id, not by name")
	assert.ok(r.journal.sessions["fix-the-auth-test"]?.endedAt)

	// Stopping the same session twice is "unknown", not a second kill: the record is ended.
	const twice = await handleMail(mail({ messageId: "<stop-again@x>", uid: 4, body: "stop: fix-the-auth-test" }, r.project), r.deps)
	assert.equal(twice.action, "refused")
	if (twice.action === "refused") assert.equal(twice.code, "unknown-session")
	assert.equal(r.stopped.length, 1, "and no second kill was sent")
	r.stopped.length = 0

	const unknown = await handleMail(mail({ messageId: "<stop2@x>", uid: 3, body: "stop: not-ours" }, r.project), r.deps)
	assert.equal(unknown.action, "refused")
	if (unknown.action === "refused") assert.equal(unknown.code, "unknown-session")
	assert.equal(r.stopped.length, 0, "an unknown name kills nothing")
})

test("list reports live sessions from tmux, not from the journal", async () => {
	const r = rig()
	const outcome = await handleMail(mail({ body: "list: here" }, r.project), r.deps)
	assert.equal(outcome.action, "listed")
	assert.match(r.replies[0]!.text, /fix-auth \$1/)
})

test("the start quota refuses new sessions but never a stop", async () => {
	// Budget of 1 per hour, already spent by a recent start: the next start is refused, and a stop still
	// works — a runaway must always be stoppable.
	const recent = Date.now()
	const r = rig({ config: config({ startsPerHour: 1 }) })
	r.journal.requests.used = {
		id: "used",
		messageId: "<used@x>",
		uid: 9,
		receivedAt: recent,
		state: "ready",
		at: recent,
		launchedAt: recent,
	}
	const refused = await handleMail(mail({ messageId: "<second@x>", uid: 2 }, r.project), r.deps)
	assert.equal(refused.action, "refused")
	if (refused.action === "refused") assert.equal(refused.code, "quota")
	assert.equal(r.spawned.length, 0)

	r.journal.sessions.stopme = { name: "stopme", tmuxSessionId: "$9", piSessionId: "pi-x", requestId: "req-x", cwd: "/tmp", at: 1 }
	const stop = await handleMail(mail({ messageId: "<s@x>", uid: 5, body: "stop: stopme" }, r.project), r.deps)
	assert.equal(stop.action, "stopped")
})

test("a start budget of 0 disables the limit rather than forbidding every start", async () => {
	// The opposite reading is a trap: someone lowering a number to "off" would silently stop all sessions.
	// Disabling starts is `starter.enabled: false`, which says so.
	const r = rig({ config: config({ startsPerHour: 0 }) })
	const outcome = await handleMail(mail({}, r.project), r.deps)
	assert.equal(outcome.action, "started")
})

test("launchedAt and tmuxName survive the journal round-trip", () => {
	// Both fields were written and then dropped by normaliseRequest, so every restart refunded the budget
	// and lost the name an interrupted spawn is matched by.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-rt-")) }
	const journal: JournalFile = {
		v: 1,
		requests: {
			r: { id: "r", messageId: "<r@x>", uid: 1, receivedAt: 1, state: "ready", at: 2, launchedAt: 2, tmuxName: "named" },
		},
		sessions: {},
	}
	writeJournal(env, journal)
	const read = readJournal(env)
	assert.equal(read.requests.r?.launchedAt, 2)
	assert.equal(read.requests.r?.tmuxName, "named")
})

test("a stopped session does not refund the hourly budget", async () => {
	// Counting surviving sessions made start/stop/start an unlimited loop; the attempt is the unit.
	const r = rig({ config: config({ startsPerHour: 1 }) })
	const first = await handleMail(mail({ messageId: "<a@x>", uid: 1 }, r.project), r.deps)
	assert.equal(first.action, "started")
	const stop = await handleMail(mail({ messageId: "<b@x>", uid: 2, body: "stop: all" }, r.project), r.deps)
	assert.equal(stop.action, "stopped")
	const third = await handleMail(mail({ messageId: "<c@x>", uid: 3 }, r.project), r.deps)
	assert.equal(third.action, "refused")
	if (third.action === "refused") assert.equal(third.code, "quota")
})

test("starter.enabled false refuses silently: no spawn, no parser, no reply", async () => {
	const r = rig({ config: config({ enabled: false }) })
	const outcome = await handleMail(mail({}, r.project), r.deps)
	assert.equal(outcome.action, "ignored")
	assert.equal(r.spawned.length, 0)
	assert.equal(r.replies.length, 0)
})

test("a non-command reply never starts a session, even with a default cwd", async () => {
	// The result mail says "reply with stop: …", so replies are the command channel. A person answering a
	// notification sends prose plus quoted history; treating that as a start request ran the quote as the
	// prompt. This is the P0 from round 2, and `defaultCwd` made it reachable in a directory nobody chose.
	const r = rig()
	// The setting that made the round-2 P0 reachable: a start with no cwd of its own would land here.
	r.deps.config.starter.defaultCwd = r.project
	const reply = mail({
		messageId: "<reply@x>",
		uid: 4,
		subject: "Re: [pi-start] fix-the-auth-test",
		body: 'thanks, looks good\n\nOn Mon, pi wrote:\n> cwd: /tmp/starter-e2e\n> stop: reply with "stop: fix-the-auth-test"',
	})
	const outcome = await handleMail(reply, r.deps)
	assert.equal(outcome.action, "refused")
	if (outcome.action === "refused") assert.equal(outcome.code, "reply-without-command")
	assert.equal(r.spawned.length, 0)
	// Authenticated, so it gets an answer: silence here would look like the mail was never read.
	assert.equal(r.replies.length, 1)
	assert.match(r.replies[0]!.text, /not a stop:\/list: command/)

	// A reply that lost its Re: marker is still a reply: In-Reply-To is the authoritative sign.
	const unmarked = await handleMail(
		mail({
			messageId: "<rm@x>",
			uid: 7,
			subject: "[pi-start] fix the auth test",
			headers: { authResults: ["mx.example.com; dmarc=pass"], inReplyTo: "<started@x>" },
			body: "thanks, looks good\n\nOn Mon, pi wrote:\n> cwd: /tmp/starter-e2e",
		}),
		r.deps,
	)
	assert.equal(unmarked.action, "refused")
	assert.equal(r.spawned.length, 0)

	// A command above the quote still works: that is the documented workflow.
	const stop = mail({ messageId: "<stop@x>", uid: 5, subject: "Re: [pi-start] fix-the-auth-test", body: "stop: all\n\nOn Mon, pi wrote:\n> cwd: /tmp" })
	r.journal.sessions.one = { name: "one", tmuxSessionId: "$1", piSessionId: "pi", requestId: "req", cwd: "/tmp", at: 1 }
	const stopped = await handleMail(stop, r.deps)
	assert.equal(stopped.action, "stopped")
})

test("a failed spawn still counts against the budget", async () => {
	// A wrong model created and killed a tmux session and a pi process; retrying it without bound is a
	// resource leak, so the attempt counts even though the record says refused.
	const r = rig({ starter: { startsPerHour: 1 } })
	let attempts = 0
	r.deps.spawn = async () => {
		attempts += 1
		return { ok: false, reason: "unready", detail: "Unknown model" }
	}
	const first = await handleMail(mail({ messageId: "<f1@x>", uid: 1 }, r.project), r.deps)
	assert.equal(first.action, "refused")
	const second = await handleMail(mail({ messageId: "<f2@x>", uid: 2 }, r.project), r.deps)
	assert.equal(second.action, "refused")
	if (second.action === "refused") assert.equal(second.code, "quota")
	assert.equal(attempts, 1, "the second attempt never reached spawn")
})

test("off-channel and echo replies are dropped, not answered", async () => {
	// SECURITY §4a: echo and off-channel mail is dropped without a reply. Both are reachable in the default
	// layout, because the default channel is a subject prefix on the mailbox the bridge already watches.
	const off = rig()
	const offChannel = await handleMail(
		mail({
			messageId: "<off@x>",
			uid: 21,
			subject: "Re: [pi] the build finished",
			headers: { authResults: ["mx.example.com; dmarc=pass"], inReplyTo: "<notify@x>" },
			body: "thanks!",
		}),
		off.deps,
	)
	assert.equal(offChannel.action, "ignored")
	assert.equal(off.replies.length, 0, "no backscatter to off-channel mail")

	const echoRig = rig()
	const echo = await handleMail(
		mail({
			messageId: "<echo@x>",
			uid: 22,
			subject: "Re: [pi-start] fix-the-auth-test",
			headers: { authResults: ["mx.example.com; dmarc=pass"], xPiMailbridge: "result", inReplyTo: "<req-1@example.com>" },
			body: "[pi-start] started fix-the-auth-test\ncwd: /tmp",
		}),
		echoRig.deps,
	)
	assert.equal(echo.action, "ignored")
	// Our own result mail carries In-Reply-To, so answering it would loop at the confirmation budget.
	assert.equal(echoRig.replies.length, 0, "never answer our own mail")
})

test("list: says tmux did not answer rather than claiming no sessions", async () => {
	const r = rig()
	r.deps.list = async () => undefined
	const outcome = await handleMail(mail({ messageId: "<l@x>", uid: 30, body: "list:" }, r.project), r.deps)
	assert.equal(outcome.action, "listed")
	assert.match(r.replies[0]!.text, /could not list sessions/)
})

test("a replayed command is not run twice, and a replayed refusal is not retried", async () => {
	// Commands were never journalled, so replaying an old stop after a cursor loss stopped whatever held the
	// name later; and a quota refusal could become executable once the budget freed up.
	const r = rig({ starter: { startsPerHour: 1 } })
	const stop = mail({ messageId: "<stop-1@x>", uid: 40, body: "stop: all" })
	await handleMail(stop, r.deps)
	assert.ok(
		Object.values(r.journal.requests).some((entry) => entry.kind === "stop"),
		"the command is journalled, which is what makes a replay inert",
	)
	r.journal.requests["used"] = {
		id: "used",
		messageId: "<used@x>",
		uid: 41,
		receivedAt: Date.now(),
		state: "ready",
		at: Date.now(),
		launchedAt: Date.now(),
	}
	const refused = await handleMail(mail({ messageId: "<q@x>", uid: 42 }, r.project), r.deps)
	assert.equal(refused.action, "refused")
	// Free the budget, then replay both mails: neither may act again.
	delete r.journal.requests.used
	const replayedStop = await handleMail(stop, r.deps)
	assert.equal(replayedStop.action, "ignored")
	const replayedRefusal = await handleMail(mail({ messageId: "<q@x>", uid: 42 }, r.project), r.deps)
	assert.equal(replayedRefusal.action, "ignored")
})

test("a stop that tmux refuses is journalled as settled", async () => {
	const r = rig()
	r.deps.stop = async () => ({ ok: false, detail: "not-ours" })
	r.journal.sessions.one = { name: "one", tmuxSessionId: "$1", piSessionId: "pi", requestId: "req", cwd: "/tmp", at: 1 }
	const outcome = await handleMail(mail({ messageId: "<s@x>", uid: 43, body: "stop: one" }, r.project), r.deps)
	assert.equal(outcome.action, "refused")
	const again = await handleMail(mail({ messageId: "<s@x>", uid: 43, body: "stop: one" }, r.project), r.deps)
	assert.equal(again.action, "ignored", "one mail cannot ask twice")
})

test("a refusal is durable before its mail: a crash after the send cannot leave it replayable", async () => {
	// The record was written after awaiting the reply, so a crash mid-send left no tombstone; and the
	// validation refusals wrote none at all. Creating the directory later made the replay execute.
	const r = rig()
	const missing = `${r.project}/later`
	const first = await handleMail(mail({ messageId: "<cr@x>", uid: 50, body: `cwd: ${missing}` }, r.project), r.deps)
	assert.equal(first.action, "refused")
	assert.ok(
		Object.values(r.journal.requests).some((entry) => entry.state === "refused" && entry.messageId === "<cr@x>"),
		"the refusal is in the journal",
	)
	mkdirSync(missing, { recursive: true })
	const replay = await handleMail(mail({ messageId: "<cr@x>", uid: 50, body: `cwd: ${missing}` }, r.project), r.deps)
	assert.equal(replay.action, "ignored", "the same mail cannot become executable later")
})

test("stop: all settles, so command records stay prunable", async () => {
	const r = rig()
	const outcome = await handleMail(mail({ messageId: "<sa@x>", uid: 51, body: "stop: all" }, r.project), r.deps)
	assert.equal(outcome.action, "stopped")
	const record = Object.values(r.journal.requests).find((entry) => entry.messageId === "<sa@x>")!
	assert.equal(record.state, "ended", "an admitted command must reach a terminal state")
})

test("the refusal is already persisted when the mail is being sent", async () => {
	// Asserting after completion cannot see a crash between send and record; the record must exist inside
	// the sender, for the branches that used to send first.
	for (const body of ["cwd: /nope", "prompt: x\nmodel: a/b"]) {
		const r = rig()
		let seen: string | undefined
		r.deps.send = async () => {
			seen = Object.values(r.journal.requests).find((entry) => entry.state === "refused")?.state
		}
		const outcome = await handleMail(mail({ body, uid: 60, messageId: `<dur-${body.length}@x>` }, r.project), r.deps)
		assert.equal(outcome.action, "refused", body)
		assert.equal(seen, "refused", `recorded before the send: ${body}`)
	}
})

test("an unidentifiable child is uncertain, and its evidence is kept", async () => {
	// Refusing conclusively would orphan a session that may be ours; recovery has to be able to look.
	const r = rig()
	const removed: string[] = []
	r.deps.removePrompt = (id) => removed.push(id)
	r.deps.spawn = async () => ({ ok: false, reason: "not-ours", detail: "no marker", uncertain: true })
	const outcome = await handleMail(mail({ messageId: "<u@x>", uid: 81 }, r.project), r.deps)
	assert.equal(outcome.action, "refused")
	const record = Object.values(r.journal.requests).find((entry) => entry.messageId === "<u@x>")
	assert.equal(record?.state, "uncertain")
	assert.equal(removed.length, 0, "the prompt/receipt evidence is not deleted")
	assert.equal(r.replies.length, 1, "and the operator is told it needs a look")
})

