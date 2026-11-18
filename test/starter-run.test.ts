// The starter's loop: one scan at a time, cursor after the mail is dealt with, and no shared state.
//
// The interesting cases are the failure ones: a thrown fetch must not advance the cursor, an interrupted
// request must be reconciled against what is actually running, and overlapping IDLE/sweep scans must not
// double-act on one message.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { STARTER_DEFAULTS, type ResolvedConfig } from "../src/core/config.ts"
import type { RawMessage } from "../src/daemon/process.ts"
import { createStarterRunner, scanOnce, type ScanDeps } from "../src/starter/run.ts"
import type { JournalFile } from "../src/starter/journal.ts"
import { createCursorStore } from "../src/store/uid-cursor.ts"
import type { HandleDeps } from "../src/starter/handle.ts"

// A tiny local rig: the daemon's own scane test helpers are shaped for the delivery pipeline, and the
// starter needs a fake source plus a fake handle.
interface Rig extends ScanDeps {
	messages: Map<number, RawMessage>
	spawnCalls: number
	logs: string[]
	saves: number
}

function rig(over: { journal?: JournalFile; throwOnFetch?: number; starter?: Partial<ResolvedConfig["starter"]> } = {}): Rig {
	const base = mkdtempSync(join(tmpdir(), "pmb-run-"))
	const env = { XDG_STATE_HOME: base, XDG_CONFIG_HOME: base }
	const config: ResolvedConfig = {
		mail: {
			imap: { host: "i", port: 993, secure: true, user: "pi@e.com", password: "x", folder: "INBOX" },
			smtp: { host: "s", port: 465, secure: true, user: "pi@e.com", password: "x", authType: "LOGIN" },
			to: "me@e.com",
		},
		device: { name: "dev" },
		security: { allowFrom: ["me@e.com"], requireDmarcPass: true, tokenTtlHours: 1 },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 1, notifyOnAborted: false, maxAttachmentMb: 1 },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		warnings: [],
		starter: { ...STARTER_DEFAULTS, enabled: true, roots: [base], ...over.starter },
	}
	const project = join(base, "project")
	mkdirSync(project, { recursive: true })
	const messages = new Map<number, RawMessage>()
	messages.set(1, {
		uid: 1,
		from: "me@e.com",
		subject: "[pi-start] do a thing",
		text: `cwd: ${project}\nprompt: do it`,
		headers: { authResults: ["mx; dmarc=pass"], messageId: "<m1@x>" },
		receivedAt: Date.now(),
		internalDate: Date.now(),
	})
	const logs: string[] = []
	const rig: Rig = {
		config,
		env,
		cursor: createCursorStore("starter-cursor.json"),
		journal: over.journal ?? { v: 1, requests: {}, sessions: {} },
		saveJournal: () => {
			rig.saves += 1
		},
		source: {
			async searchAfter(after) {
				return [...messages.keys()].filter((uid) => uid > after).sort((a, b) => a - b)
			},
			async fetch(uid) {
				if (over.throwOnFetch === uid) throw new Error("transient IMAP failure")
				return messages.get(uid)
			},
			uidValidity: () => 1111,
		},
		handle: {
			writePrompt: (id: string) => ({ promptFile: `/tmp/${id}.txt`, readyFile: `/tmp/${id}.r` }),
			spawn: async () => {
				rig.spawnCalls += 1
				return { ok: true, tmuxSessionId: "$1" }
			},
			stop: async () => ({ ok: true }),
			list: async () => [],
			send: async () => {},
			log: (line: string) => logs.push(line),
			bootstrapPath: "/b.js",
		} as unknown as Omit<HandleDeps, "journal" | "save" | "config" | "env">,
		liveSessions: async () => [],
		now: () => Date.now(),
		log: (line: string) => logs.push(line),
		messages,
		spawnCalls: 0,
		logs,
		saves: 0,
	}
	return rig
}

test("a result that never went out is mailed once on the next scan, without re-spawning", async () => {
	// `ready` is written before the mail and `resultSent` after it: a crash between them leaves a session
	// that exists and a human who was never told. Retrying the mail is the point of tracking them apart.
	const r = rig({
		journal: {
			v: 1,
			requests: {
				"req-1": {
					id: "req-1",
					messageId: "<m1@x>",
					uid: 1,
					uidValidity: 1111,
					receivedAt: Date.now(),
					state: "ready",
					at: Date.now(),
					name: "do-a-thing",
					cwd: "/tmp",
					tmuxSessionId: "$4",
					piSessionId: "pi-x",
				},
			},
			sessions: {},
		},
	})
	r.liveSessions = async () => [{ id: "$4", name: "do-a-thing" }]
	r.ownerOf = async () => "req-1"
	const sent: { subject: string; text: string }[] = []
	r.handle.send = async (message) => {
		sent.push({ subject: message.subject, text: message.text })
	}

	await scanOnce(r)
	assert.equal(sent.length, 1, "the result went out")
	assert.match(sent[0]!.text, /delayed: the starter stopped/)
	assert.equal(r.journal.requests["req-1"]?.resultSent, true)

	await scanOnce(r)
	assert.equal(sent.length, 1, "and only once")
	assert.equal(r.spawnCalls, 0, "recovery never re-spawns")
})

test("a scan handles each message once and advances the cursor past it", async () => {
	const r = rig()
	const summary = await scanOnce(r)
	assert.equal(summary.examined, 1)
	assert.equal(summary.started, 1)
	assert.equal(r.spawnCalls, 1)
	assert.equal(r.cursor.read(r.env), 1)
})

test("a second scan sees nothing, because the cursor moved", async () => {
	const r = rig()
	await scanOnce(r)
	const again = await scanOnce(r)
	assert.equal(again.examined, 0)
	assert.equal(r.spawnCalls, 1)
})

test("a fetch failure does not advance the cursor past the offending UID", async () => {
	const r = rig({ throwOnFetch: 1 })
	await assert.rejects(() => scanOnce(r))
	assert.equal(r.cursor.read(r.env), 0, "the mail is retried, not skipped")
})

test("an interrupted request is reconciled against what is running, not re-run", async () => {
	// The journal says a request was reserved and exists as tmux $4: the scan adopts it rather than
	// starting a second session.
	const r = rig({
		journal: {
			v: 1,
			requests: {
				"req-1": {
					id: "req-1",
					messageId: "<m1@x>",
					uid: 1,
					uidValidity: 1111,
					receivedAt: r0(),
					state: "reserved",
					at: r0(),
					tmuxSessionId: "$4",
					name: "do-a-thing",
					piSessionId: "pi-x",
					cwd: "/tmp",
				},
			},
			sessions: {},
		},
	})
	r.liveSessions = async () => [{ id: "$4", name: "do-a-thing" }]
	r.ownerOf = async () => "req-1"
	const summary = await scanOnce(r)
	assert.equal(summary.adopted, 1)
	assert.equal(r.spawnCalls, 0, "adopting is not spawning")
	assert.equal(r.journal.requests["req-1"]?.state, "ready")
	assert.equal(r.journal.sessions["do-a-thing"]?.tmuxSessionId, "$4")
	assert.equal(r.cursor.read(r.env), 1, "and the mail is not offered again")
})

function r0(): number {
	return Date.now() - 60_000
}

test("IDLE and the sweep cannot overlap: a burst runs one scan, then at most one more", async () => {
	const r = rig()
	// A slow fetch is what lets three events arrive while the first scan is in flight. Counting concurrent
	// fetches is what proves the serialisation: the journal's dedupe would also keep the spawn count at
	// one, so that assertion alone cannot see two scans running at once.
	const originalFetch = r.source.fetch.bind(r.source)
	let inFlight = 0
	let peak = 0
	r.source.fetch = async (uid) => {
		inFlight += 1
		peak = Math.max(peak, inFlight)
		await new Promise<void>((resolve) => setTimeout(resolve, 20))
		inFlight -= 1
		return originalFetch(uid)
	}
	const runner = createStarterRunner({ ...r, scanIntervalSecs: 0 })
	await Promise.all([runner.once(), runner.once(), runner.once()])
	assert.equal(peak, 1, "scans never overlap, however many events fired")
	assert.equal(r.spawnCalls, 1, "one message, one start")
	assert.equal(r.cursor.read(r.env), 1)
})

test("a reserved record with no id but a live name is adopted, not refused", async () => {
	// The real crash window: the record is saved before spawn() returns, so it has no $N to match on.
	const r = rig({
		journal: {
			v: 1,
			requests: {
				"req-2": {
					id: "req-2",
					messageId: "<m2@x>",
					uid: 7,
					receivedAt: Date.now(),
					state: "spawning",
					at: Date.now(),
					launchedAt: Date.now(),
					name: "half-born",
					tmuxName: "half-born",
					cwd: "/tmp",
					piSessionId: "pi-y",
				},
			},
			sessions: {},
		},
	})
	r.liveSessions = async () => [{ id: "$12", name: "half-born" }]
	r.ownerOf = async () => "req-2"
	await scanOnce(r)
	assert.equal(r.journal.requests["req-2"]?.state, "ready", "the child exists; adoption is the honest answer")
	assert.equal(r.journal.sessions["half-born"]?.tmuxSessionId, "$12")

	// and when nothing matches, the outcome is unknown, not a claim that no session was created
	const r2 = rig({
		journal: {
			v: 1,
			requests: {
				"req-3": {
					id: "req-3",
					messageId: "<m3@x>",
					uid: 8,
					receivedAt: Date.now(),
					state: "spawning",
					at: Date.now(),
					launchedAt: Date.now(),
					name: "ghost",
					tmuxName: "ghost",
					cwd: "/tmp",
				},
			},
			sessions: {},
		},
	})
	r2.liveSessions = async () => []
	await scanOnce(r2)
	assert.equal(r2.journal.requests["req-3"]?.state, "uncertain")
})

test("a session that exited on its own frees the live cap", async () => {
	const r = rig({ starter: { maxSessions: 1 } })
	r.liveSessions = async () => []
	r.journal.sessions.gone = { name: "gone", tmuxSessionId: "$3", piSessionId: "pi-z", requestId: "old", cwd: "/tmp", at: 1 }
	r.journal.requests.old = { id: "old", messageId: "<o@x>", uid: 1, receivedAt: 1, state: "ready", at: 1, name: "gone", cwd: "/tmp" }
	r.messages.set(2, {
		uid: 2,
		from: "me@e.com",
		subject: "[pi-start] fresh",
		text: "cwd: /tmp",
		headers: { authResults: ["mx; dmarc=pass"], messageId: "<new@x>" },
		receivedAt: Date.now(),
		internalDate: Date.now(),
	})
	const summary = await scanOnce(r)
	assert.equal(summary.swept, 1, "the dead session was swept")
	assert.equal(summary.started, 1, "so the next start is not blocked by a slot nobody uses")
})

test("a mailing-list post and an auto-reply are robots to the starter too", async () => {
	// The starter rebuilt the header shape and dropped List-Id and X-Auto-Response-Suppress, so the shared
	// policy could not see them - a list post would start a session.
	for (const headers of [{ listId: "<list.example.com>" }, { autoResponseSuppress: "OOF" }]) {
		const r = rig()
		r.messages.delete(1)
		r.messages.set(3, {
			uid: 3,
			from: "me@e.com",
			subject: "[pi-start] from a robot",
			text: `cwd: ${r.config.starter.roots[0]}/project`,
			headers: { authResults: ["mx; dmarc=pass"], messageId: "<robot@x>", ...headers },
			receivedAt: Date.now(),
			internalDate: Date.now(),
		})
		const summary = await scanOnce(r)
		assert.equal(summary.started, 0, JSON.stringify(headers))
		assert.equal(r.spawnCalls, 0, JSON.stringify(headers))
	}
})

test("an unavailable live list ends no session and reconciles nothing", async () => {
	// `undefined` from tmux means "I could not answer". Treating it as empty ended every owned session and
	// marked a spawning record uncertain, which is terminal.
	const r = rig({
		journal: {
			v: 1,
			requests: { req: { id: "req", messageId: "<m@x>", uid: 1, receivedAt: Date.now(), state: "spawning", at: Date.now(), launchedAt: Date.now(), name: "x", tmuxName: "x", cwd: "/tmp" } },
			sessions: { x: { name: "x", tmuxSessionId: "$1", piSessionId: "pi", requestId: "req", cwd: "/tmp", at: 1 } },
		},
	})
	r.liveSessions = async () => undefined
	const summary = await scanOnce(r)
	assert.equal(summary.swept, 0, "nothing was ended")
	assert.equal(r.journal.sessions.x?.endedAt, undefined)
	assert.equal(r.journal.requests.req?.state, "spawning", "and the record was left for a scan that can see tmux")
})

test("recovery does not call a child started when its readiness marker failed or is missing", async () => {
	// A crash right after tmux creation can leave pi alive but idle; adopting it as "started" mailed a
	// success that never happened.
	const base = mkdtempSync(join(tmpdir(), "pmb-ready-"))
	const failed = join(base, "failed.json")
	writeFileSync(failed, JSON.stringify({ ok: false, error: "pi did not start a turn" }), { mode: 0o600 })
	const missing = join(base, "missing.json")
	for (const readyFile of [failed, missing]) {
		const r = rig({
			journal: {
				v: 1,
				requests: {
					req: {
						id: "req",
						messageId: "<m@x>",
						uid: 1,
						receivedAt: Date.now(),
						state: "spawning",
						at: Date.now(),
						launchedAt: Date.now(),
						name: "half",
						tmuxName: "half",
						cwd: "/tmp",
						readyFile,
					},
				},
				sessions: {},
			},
		})
		r.liveSessions = async () => [{ id: "$1", name: "half" }]
		const summary = await scanOnce(r)
		assert.equal(summary.adopted, 0, readyFile)
		assert.equal(r.journal.requests.req?.state, "uncertain", readyFile)
	}
})

test("an oversized or undated message never becomes a start request", async () => {
	// The watcher returns a metadata-only message for an oversized one: no body, no headers. Interpreting it
	// turned it into an empty start with the default cwd. Undated mail cannot be proven fresh either.
	const big = rig()
	big.messages.delete(1)
	// Otherwise a valid request: without the guard the metadata-only stub is an empty body with a default
	// cwd, which is exactly the bypass the finding describes.
	big.messages.set(5, {
		uid: 5,
		from: "me@e.com",
		subject: "[pi-start] huge",
		text: `cwd: ${big.config.starter.roots[0]}/project`,
		headers: { authResults: ["mx; dmarc=pass"], messageId: "<huge@x>" },
		receivedAt: Date.now(),
		internalDate: Date.now(),
		tooLarge: 9_000_000,
	})
	const s1 = await scanOnce(big)
	assert.equal(s1.started, 0)
	assert.equal(big.spawnCalls, 0)

	const undated = rig()
	undated.messages.delete(1)
	undated.messages.set(6, {
		uid: 6,
		from: "me@e.com",
		subject: "[pi-start] old",
		text: "cwd: /tmp",
		headers: { authResults: ["mx; dmarc=pass"], messageId: "<old@x>" },
		receivedAt: Date.now(),
		internalDate: Date.now(),
	})
	const s2 = await scanOnce(undated)
	assert.equal(s2.started, 0, "no arrival time, no freshness proof, no start")
})

test("adoption refuses a live name whose ownership marker belongs to another request", async () => {
	// A tmux restart can reuse both the id and the display name; only the request id in the session's
	// environment distinguishes our child.
	const r = rig({
		journal: {
			v: 1,
			requests: { req: { id: "req", messageId: "<m@x>", uid: 1, receivedAt: Date.now(), state: "spawning", at: Date.now(), launchedAt: Date.now(), name: "x", tmuxName: "x", cwd: "/tmp" } },
			sessions: {},
		},
	})
	r.liveSessions = async () => [{ id: "$1", name: "x" }]
	r.ownerOf = async () => "someone-else"
	const summary = await scanOnce(r)
	assert.equal(summary.adopted, 0)
	assert.equal(r.journal.requests.req?.state, "uncertain")
})

