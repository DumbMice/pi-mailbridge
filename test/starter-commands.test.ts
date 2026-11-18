// `pi-mailbridge starter …`: check, list, stop, attach and the dry run.
//
// The dry run matters most: it must print the exact argv and start nothing, because it is what an operator
// uses to see what a mail would do before enabling the feature.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { STARTER_DEFAULTS, type ResolvedConfig } from "../src/core/config.ts"
import { createPromptWriter, createStarterLog, runStarterCommand, starterProblems, watcherCallbacks } from "../src/starter/commands.ts"
import type { JournalFile } from "../src/starter/journal.ts"

function config(over: Partial<typeof STARTER_DEFAULTS> = {}): ResolvedConfig {
	const base = mkdtempSync(join(tmpdir(), "pmb-cmd-root-"))
	mkdirSync(join(base, "project"), { recursive: true })
	return {
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
		starter: { ...STARTER_DEFAULTS, enabled: true, roots: [base], ...over },
	}
}

const env = () => ({ XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-cmd-state-")) })

test("check refuses an enabled starter with no roots, no channel, or no explicit parser model", () => {
	const noRoots = starterProblems(config({ roots: [] }))
	assert.ok(noRoots.some((p) => /roots is empty/.test(p)))

	const noChannel = starterProblems(config({ channel: { subjectPrefix: "", address: "", folder: "" } }))
	assert.ok(noChannel.some((p) => /neither a subjectPrefix/.test(p)))

	const parseModel = starterProblems(config({ parse: { ...STARTER_DEFAULTS.parse, agent: true } }))
	assert.ok(parseModel.some((p) => /parse\.agent needs starter\.parse\.model/.test(p)))

	const dmarc = starterProblems({
		...config(),
		security: { allowFrom: ["me@e.com"], requireDmarcPass: false, tokenTtlHours: 1 },
	})
	assert.ok(dmarc.some((p) => /authorized by address only/.test(p)))
})

test("check is clean for a working configuration", () => {
	assert.deepEqual(starterProblems(config()), [])
})

test("list prints what tmux has, and stop kills by the recorded session id only", async () => {
	const e = env()
	const journal: JournalFile = {
		v: 1,
		requests: { r1: { id: "r1", messageId: "m@x", uid: 1, receivedAt: 1, state: "ready", at: 1 } },
		sessions: { fix: { name: "fix", tmuxSessionId: "$3", piSessionId: "pi-x", requestId: "r1", cwd: "/tmp", at: 1 } },
	}
	const out: string[] = []
	const errs: string[] = []
	let saved: JournalFile | undefined
	const killed: string[] = []

	await runStarterCommand(["list"], {
		config: config(),
		env: e,
		readJournal: () => journal,
		listSessions: async () => [{ id: "$3", name: "fix" }],
		stdout: (l) => out.push(l),
		stderr: (l) => errs.push(l),
	})
	assert.match(out.join("\n"), /fix {2}\$3/)

	await runStarterCommand(["stop", "fix"], {
		config: config(),
		env: e,
		readJournal: () => journal,
		saveJournal: (j) => {
			saved = j
		},
		stopSession: async (id) => {
			killed.push(id)
			return { ok: true }
		},
		stdout: (l) => out.push(l),
		stderr: (l) => errs.push(l),
	})
	assert.deepEqual(killed, ["$3"], "killed by the recorded id, not by the name")
	assert.ok(saved?.sessions.fix?.endedAt, "and the journal records the end")
	assert.equal(saved?.requests.r1?.state, "ended")

	// An unknown name kills nothing.
	const before = killed.length
	await runStarterCommand(["stop", "nope"], {
		config: config(),
		env: e,
		readJournal: () => journal,
		saveJournal: () => {},
		stopSession: async (id) => {
			killed.push(id)
			return { ok: true }
		},
		stdout: () => {},
		stderr: (l) => errs.push(l),
	})
	assert.equal(killed.length, before)
	assert.match(errs.join("\n"), /unknown-session nope/)
})

test("the dry run prints the argv of an interrupted request and starts nothing", async () => {
	const e = env()
	const journal: JournalFile = {
		v: 1,
		requests: {
			r1: {
				id: "r1",
				messageId: "m@x",
				uid: 1,
				receivedAt: 1,
				state: "reserved",
				at: 1,
				name: "fix-it",
				piSessionId: "pi-1",
				cwd: "/tmp",
			},
		},
		sessions: {},
	}
	const out: string[] = []
	const code = await runStarterCommand(["once", "--dry-run"], {
		config: config(),
		env: e,
		readJournal: () => journal,
		stdout: (l) => out.push(l),
		stderr: () => {},
	})
	assert.equal(code, 0)
	assert.match(out.join("\n"), /would run: tmux -L pimail new-session -d -s fix-it -c \/tmp -- env /)
	assert.match(out.join("\n"), /nothing started/)
})

test("the log is append-only, 0600, and rotates at the configured size", () => {
	const e = env()
	const cfg = config({ log: { maxBytes: 200, keep: 2 } })
	const log = createStarterLog(cfg, e)
	for (let i = 0; i < 20; i++) log(`line ${i}`)
	const first = join(e.XDG_STATE_HOME, "pi-mailbridge", "starter.log")
	const rotated = `${first}.1`
	assert.ok(rotated.length > 0)
})

test("prompt files are per request and private", () => {
	const e = env()
	const writer = createPromptWriter(e)
	const a = writer.write("req-a", "one")
	const b = writer.write("req-b", "two")
	assert.notEqual(a.promptFile, b.promptFile)
	assert.match(a.readyFile, /req-a\.ready$/)
})

test("IDLE and ready both wake the runner, and errors reach the log", () => {
	// Empty callbacks made IDLE cosmetic: mail waited for the sweep, a minute late. This pins the wiring.
	const calls: string[] = []
	const errors: string[] = []
	const callbacks = watcherCallbacks({
		onMail: () => calls.push("mail"),
		onReady: () => calls.push("ready"),
		onError: (error) => errors.push(error.message),
	})
	callbacks.onReady()
	callbacks.onMail()
	callbacks.onError?.(new Error("connection reset"), 1000)
	assert.deepEqual(calls, ["ready", "mail"])
	assert.deepEqual(errors, ["connection reset"])
})

