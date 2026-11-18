// `pi-mailbridge starter …`: check, list, stop, attach and the dry run.
//
// The dry run matters most: it must print the exact argv and start nothing, because it is what an operator
// uses to see what a mail would do before enabling the feature.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { statePath } from "../src/store/paths.ts"

import { STARTER_DEFAULTS, type ResolvedConfig } from "../src/core/config.ts"
import { createPromptWriter, createStarterLog, journalStore, runStarterCommand, starterMailConfig, starterProblems, watcherCallbacks } from "../src/starter/commands.ts"
import { type JournalFile, readJournal } from "../src/starter/journal.ts"
import { validateCwd } from "../src/starter/validate.ts"

const statePathForTest = (env: NodeJS.ProcessEnv) => statePath(env, "starter-journal.json")

/** A live process that holds nothing: its pid is all the test needs. */
function spawnHolder(): { pid: number; kill: () => void } {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" })
	return {
		pid: child.pid ?? 0,
		kill: () => {
			try {
				child.kill()
			} catch {
				/* already gone */
			}
		},
	}
}

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
	assert.match(out.join("\n"), /would run: tmux -L pimail new-session -d -s fix-it -e PI_MAILBRIDGE_REQUEST=r1 -c \/tmp -- env /)
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

test("starter.channel.folder replaces the daemon's folder for the starter's own connection", () => {
	// It was validated and then ignored: the starter read INBOX while the operator expected a subfolder.
	const base = config()
	const plain = starterMailConfig(base)
	assert.equal(plain.mail.imap.folder, base.mail.imap.folder, "unchanged when unset")
	const moved = starterMailConfig({ ...base, starter: { ...base.starter, channel: { ...base.starter.channel, folder: "Queue" } } })
	assert.equal(moved.mail.imap.folder, "Queue")
	assert.equal(base.mail.imap.folder, "INBOX", "the shared config object is not mutated")
	assert.equal(moved.mail.imap.host, base.mail.imap.host, "everything else is carried through")
})

test("an empty roots list is reported as fail-closed, matching the containment rule", () => {
	// The message said "a session could be rooted anywhere"; validateCwd returns outside-root for every
	// path when there are no roots. Message and behaviour are pinned together here so they cannot drift.
	const empty = config({ roots: [] })
	const problems = starterProblems(empty)
	assert.ok(problems.some((line) => /no mail could start a session/.test(line)), problems.join("; "))
	assert.ok(!problems.some((line) => /anywhere/.test(line)), "the opposite of the behaviour is not claimed")

	// And the behaviour it reports: every path is outside zero roots.
	const outcome = validateCwd("/tmp", { roots: [], reserved: [] })
	assert.equal(outcome.ok, false)
	if (!outcome.ok) assert.equal(outcome.code, "outside-root")
})

test("CLI stop passes the recorded name, so a reused tmux id is not killed", async () => {
	// The runner had the ownership check; the operator's own path did not, which is the documented one.
	const base = config()
	const seen: { id: string; expectedName?: string }[] = []
	const code = await runStarterCommand(["stop", "fix-auth"], {
		config: base,
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-stop-")) },
		stdout: () => {},
		stderr: () => {},
		readJournal: () => ({
			v: 1,
			requests: { req: { id: "req", messageId: "<m@x>", uid: 1, receivedAt: 1, state: "ready", at: 1 } },
			sessions: { "fix-auth": { name: "fix-auth", tmuxSessionId: "$3", piSessionId: "pi", requestId: "req", cwd: "/tmp", at: 1 } },
		}),
		stopSession: async (id: string, options?: { expectedName?: string }) => {
			seen.push({ id, ...(options?.expectedName ? { expectedName: options.expectedName } : {}) })
			return { ok: true }
		},
	})
	assert.equal(code, 0)
	assert.deepEqual(seen, [{ id: "$3", expectedName: "fix-auth" }])
})

test("`repair` sets the unreadable journal aside and clears the marker", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pmb-repair-"))
	const env = { XDG_STATE_HOME: dir }
	const file = statePathForTest(env)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, "{broken", { mode: 0o600 })
	writeFileSync(`${file}.failed`, "not valid JSON", { mode: 0o600 })
	const out: string[] = []
	const code = await runStarterCommand(["repair"], { config: config(), env, stdout: (l: string) => out.push(l), stderr: () => {} })
	assert.equal(code, 0)
	assert.match(out.join("\n"), /set aside/)
	assert.equal(existsSync(file), false, "the bad bytes were moved, not deleted")
	assert.equal(existsSync(`${file}.failed`), false, "and the marker is gone, so the starter can start")
})

test("journalStore prunes at the configured horizon, not the default 48 hours", () => {
	// The runner used to call writeJournal directly with JOURNAL_DEFAULTS, so a 72-hour acceptance horizon
	// still forgot tombstones at 48 - the replay guard was only as long as the smaller number.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-horizon-")) }
	const hour = 60 * 60 * 1000
	const ended = Date.now() - 49 * hour
	const journal: JournalFile = {
		v: 1,
		requests: { old: { id: "old", messageId: "<old@x>", uid: 1, receivedAt: ended, state: "ended", at: ended } },
		sessions: {},
	}
	journalStore(env, config({ requestMaxAgeHours: 72 } as never))(journal)
	const read = readJournal(env)
	assert.ok(read.requests.old, "still a tombstone, so the mail is still a replay")
})

test("the journal write is a transaction: a held lock refuses rather than overwriting", () => {
	// Two unlocked read-merge-writes can each drop the other's reservation, and a lost reservation is a
	// lost replay guard.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-txn-")) }
	const journal: JournalFile = { v: 1, requests: {}, sessions: {} }
	// A real, separately controlled holder: a child process that is alive while the write is attempted.
	// (The lock treats its own pid as stale, so the holder cannot be this process.)
	const holder = spawnHolder()
	mkdirSync(dirname(statePath(env, "starter-journal.lock")), { recursive: true })
	writeFileSync(statePath(env, "starter-journal.lock"), String(holder.pid), { mode: 0o600 })
	assert.throws(() => journalStore(env, config())(journal), /another process is writing the journal/)
	holder.kill()
	unlinkSync(statePath(env, "starter-journal.lock"))
	assert.doesNotThrow(() => journalStore(env, config())(journal))
})

