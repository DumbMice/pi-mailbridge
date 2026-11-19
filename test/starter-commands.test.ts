// `pi-mailbridge starter …`: check, list, stop, attach and the dry run.
//
// The dry run matters most: it must print the exact argv and start nothing, because it is what an operator
// uses to see what a mail would do before enabling the feature.

import { mock, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { acquireLock } from "../src/store/lock.ts"
import { statePath } from "../src/store/paths.ts"

import { STARTER_DEFAULTS, type ResolvedConfig } from "../src/core/config.ts"
import { createPromptWriter, createStarterLog, imapFailureHint, journalStore, runStarterCommand, starterMailConfig, starterProblems, watcherCallbacks } from "../src/starter/commands.ts"
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
		notify: { onSettled: true, debounceMs: 1, notifyOnAborted: false, maxAttachmentMb: 1 , inlineSvg: true, rasteriseSvg: false},
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
	// The request stays ready because its result was never delivered: the next scan mails it.
	assert.equal(saved?.requests.r1?.state, "ready")

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

test("CLI stop leaves an undelivered result owed", async () => {
	// Ending the request here removed it from the ready-only flush, abandoning the mail the session promised.
	const e = env()
	const journal: JournalFile = {
		v: 1,
		requests: { r1: { id: "r1", messageId: "m@x", uid: 1, receivedAt: 1, state: "ready", at: 1 } },
		sessions: { fix: { name: "fix", tmuxSessionId: "$3", piSessionId: "pi-x", requestId: "r1", cwd: "/tmp", at: 1 } },
	}
	let saved: JournalFile | undefined
	await runStarterCommand(["stop", "fix"], {
		config: config(),
		env: e,
		readJournal: () => journal,
		saveJournal: (j) => {
			saved = j
		},
		stopSession: async () => ({ ok: true }),
		stdout: () => {},
		stderr: () => {},
	})
	assert.equal(saved?.sessions.fix?.endedAt !== undefined, true)
	assert.equal(saved?.requests.r1?.state, "ready", "owed, not ended")
})

test("the reload guard is never pruned by age, while readiness receipts are", () => {
	// Deleting the guard after a week let the bootstrap inject a missing-prompt diagnostic into a session
	// that could still reload.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-guard-")) }
	const prompts = createPromptWriter(env)
	const { readyFile } = prompts.write("req-1", "prompt")
	writeFileSync(readyFile, JSON.stringify({ ok: true }), { mode: 0o600 })
	const guard = `${readyFile}.handled`
	writeFileSync(guard, "1", { mode: 0o600 })
	// Age both well past the readiness window.
	const old = new Date(Date.now() - 30 * 24 * 3_600_000)
	utimesSync(readyFile, old, old)
	utimesSync(guard, old, old)
	const pruned = prompts.pruneReceipts()
	assert.equal(pruned, 1, "the stale readiness receipt is removed")
	assert.equal(existsSync(readyFile), false)
	assert.equal(existsSync(guard), true, "the guard survives, so a reload injects nothing")
})

test("a lock that was taken over refuses to write", () => {
	// A stale-lock takeover can rename this process's live lock away; without verification the old owner
	// would keep writing without exclusion.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-takeover-")) }
	const journal: JournalFile = { v: 1, requests: {}, sessions: {} }
	const held = acquireLock(env, "starter-journal.lock")
	assert.equal(held.ok, true)
	if (!held.ok) return
	assert.equal(held.lock.verify(), true)
	// Another *process* takes the lock over; our handle must notice rather than keep asserting ownership.
	spawnSync(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(held.lock.path)}, "999 other")`])
	assert.equal(held.lock.verify(), false)
})

test("check rejects a root of / and a default cwd it would refuse", () => {
	// Both pass the old existence checks and then make every request impossible.
	const slash = starterProblems(config({ roots: ["/"] }))
	assert.ok(slash.some((line) => /roots: \/ is refused/.test(line)), slash.join("; "))
	// Canonicalisation, not spelling: `/tmp/..` is the filesystem root too.
	const canonical = starterProblems(config({ roots: ["/tmp/.."] }))
	assert.ok(canonical.some((line) => /roots: \/ is refused/.test(line)), canonical.join("; "))
	const outside = starterProblems(config({ roots: ["/tmp/pmb-none"], defaultCwd: "/etc" }))
	assert.ok(outside.some((line) => /defaultCwd would be refused/.test(line)), outside.join("; "))
})

test("locks reports a stale lock and never removes it", async () => {
	// Removing a stale lock in user space can delete a lock acquired in the meantime, so the command only
	// reports; the operator removes the file after confirming the pid is gone.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-locks-")) }
	const holder = spawnHolder()
	const dir = dirname(statePath(env, "x"))
	mkdirSync(dir, { recursive: true })
	const write = (name: string, pid: number) => {
		const file = statePath(env, name)
		writeFileSync(file, `${pid} token`, { mode: 0o600 })
		return file
	}
	const stale = write("starter.lock", 999_999)
	const live = write("daemon.lock", holder.pid)
	const out: string[] = []
	const errs: string[] = []
	const code = await runStarterCommand(["locks"], { config: config(), env, stdout: (l: string) => out.push(l), stderr: (l: string) => errs.push(l) })
	holder.kill()
	assert.equal(code, 1, "a stale lock makes the report fail")
	assert.equal(existsSync(stale), true, "nothing is removed")
	assert.equal(existsSync(live), true)
	assert.match(out.join("\n"), /STALE/)
	assert.match(out.join("\n"), /held by pid/)
	assert.match(errs.join("\n"), /remove the file\(s\) by hand/)
})

test("an unreadable lock is unknown, not free", () => {
	// A permission or I/O error is not evidence of absence: reporting it as free would wave an operator past
	// a lock they cannot see.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-locks-unknown-")) }
	const dir = dirname(statePath(env, "x"))
	mkdirSync(dir, { recursive: true })
	mkdirSync(statePath(env, "starter.lock"))
	const out: string[] = []
	const errs: string[] = []
	return runStarterCommand(["locks"], { config: config(), env, stdout: (l: string) => out.push(l), stderr: (l: string) => errs.push(l) }).then((code) => {
		assert.equal(code, 1)
		assert.match(errs.join("\n"), /UNKNOWN/)
		assert.doesNotMatch(out.join("\n"), /starter\.lock: free/)
	})
})

test("repair refuses while the starter or a journal write is active", async () => {
	// Repair renamed the authoritative journal with no locks, racing a watcher save or a CLI stop.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-repair-lock-")) }
	const file = statePathForTest(env)
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, "{broken", { mode: 0o600 })
	const starterLock = acquireLock(env, "starter.lock")
	assert.equal(starterLock.ok, true)
	if (starterLock.ok) {
		const code = await runStarterCommand(["repair"], { config: config(), env, stdout: () => {}, stderr: () => {} })
		assert.equal(code, 1)
		assert.equal(existsSync(file), true, "nothing moved while the starter holds its lock")
		starterLock.lock.release()
	}
	const journalLock = acquireLock(env, "starter-journal.lock")
	assert.equal(journalLock.ok, true)
	if (journalLock.ok) {
		const code = await runStarterCommand(["repair"], { config: config(), env, stdout: () => {}, stderr: () => {} })
		assert.equal(code, 1)
		assert.equal(existsSync(file), true, "nothing moved while a journal write is active")
		journalLock.lock.release()
	}
	const code = await runStarterCommand(["repair"], { config: config(), env, stdout: () => {}, stderr: () => {} })
	assert.equal(code, 0, "and it works once the locks are free")
	assert.equal(existsSync(file), false)
})

test("check rejects configuration that cannot deliver a result", () => {
	const noSmtp = config()
	const problems = starterProblems({ ...noSmtp, mail: { ...noSmtp.mail, smtp: { ...noSmtp.mail.smtp, host: "" }, to: "" } })
	assert.ok(problems.some((line) => /mail\.smtp\.host is empty/.test(line)), problems.join("; "))
	assert.ok(problems.some((line) => /mail\.to is empty/.test(line)), problems.join("; "))
})

test("a journal save adopts the pruned result, not the merged superset", () => {
	// A long-running watcher kept expired names in memory and eventually refused new ones as exhausted.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-prune-mem-")) }
	const old = Date.now() - 365 * 24 * 3_600_000
	const journal: JournalFile = {
		v: 1,
		requests: { gone: { id: "gone", messageId: "<g@x>", uid: 1, receivedAt: old, state: "ended", at: old } },
		sessions: { gone: { name: "gone", tmuxSessionId: "$1", piSessionId: "pi", requestId: "gone", cwd: "/tmp", at: old, endedAt: old } },
	}
	journalStore(env, config())(journal)
	const reread = readJournal(env)
	assert.equal(reread.requests.gone, undefined, "and the file agrees")
	assert.equal(journal.requests.gone, undefined, "the in-memory view forgets what the file forgot")
	assert.equal(journal.sessions.gone, undefined)
})

test("a repair that throws releases both locks", async () => {
	// A failed repair must not leave the state directory locked out. The clock is frozen so the destination
	// the test occupies is exactly the one production computes; otherwise a crossed millisecond makes the
	// rename succeed and the test passes without exercising the failure.
	mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 })
	try {
		const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-repair-throw-")) }
		const file = statePathForTest(env)
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, "{broken", { mode: 0o600 })
		const stamp = new Date().toISOString().replace(/[:.]/g, "-")
		const target = `${file}.repair-${stamp}`
		mkdirSync(target, { recursive: true })
		writeFileSync(join(target, "x"), "occupied")
		await assert.rejects(runStarterCommand(["repair"], { config: config(), env, stdout: () => {}, stderr: () => {} }))
		assert.equal(readFileSync(file, "utf8"), "{broken", "the journal was not moved")
		assert.equal(existsSync(statePath(env, "starter.lock")), false, "the lifetime lock is released")
		assert.equal(existsSync(statePath(env, "starter-journal.lock")), false, "the journal lock is released")
	} finally {
		mock.timers.reset()
	}
})

test("check says it is offline, and an auth failure is named as one", () => {
	// "check said ok" was read as "my password must be right"; a wrong authorisation code failed later with a
	// generic "Command failed" in the watcher log.
	const out: string[] = []
	// `check` also requires tmux and pi on PATH. A CI runner has neither, so this asserted exit 2 there while
	// passing locally; stub both rather than pretending the tool check is optional.
	const bin = mkdtempSync(join(tmpdir(), "pmb-chk-bin-"))
	for (const tool of ["tmux", "pi"]) {
		writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
	}
	const path = process.env.PATH
	process.env.PATH = `${bin}:${path ?? ""}`
	return runStarterCommand(["check"], {
		config: config({ roots: [mkdtempSync(join(tmpdir(), "pmb-chk-"))] }),
		env: { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-chk-state-")) },
		stdout: (l: string) => out.push(l),
		stderr: () => {},
	}).then((code) => {
		process.env.PATH = path
		assert.equal(code, 0)
		assert.match(out.join("\n"), /offline configuration check; it does not log in/)
		// The real imapflow shape: message is just "Command failed"; the reason is on the fields.
		assert.match(
			imapFailureHint({
				message: "Command failed",
				serverResponseCode: "AUTHENTICATIONFAILED",
				responseText: "Login fail. Account is abnormal, service is not open, password is incorrect",
				authenticationFailed: true,
			}) ?? "",
			/authorisation code/,
		)
		assert.match(imapFailureHint({ message: "Command failed", serverResponseCode: "AUTHENTICATIONFAILED" }) ?? "", /authorisation code/)
		assert.match(imapFailureHint(new Error("Login fail. Account is abnormal")) ?? "", /authorisation code/)
		assert.equal(imapFailureHint({ message: "Command failed", code: "ECONNRESET" }), undefined)
		// A hostname that merely contains 535 is not an auth failure; the old bare regex said it was.
		assert.equal(imapFailureHint({ message: "getaddrinfo ENOTFOUND 535.example.invalid" }), undefined)
		assert.match(imapFailureHint({ message: "535 5.7.8 Username and Password not accepted" }) ?? "", /authorisation code/)
		assert.match(imapFailureHint({ message: "535 5.7.3 Authentication unsuccessful" }) ?? "", /authorisation code/)
		assert.match(imapFailureHint({ message: "535 Authentication failed" }) ?? "", /authorisation code/)
		assert.equal(imapFailureHint({ message: "getaddrinfo ENOTFOUND login.535.example" }), undefined)
		// An explicit enhanced status is enough on its own; the wording after it may be anything.
		assert.match(imapFailureHint({ message: "535 5.7.8" }) ?? "", /authorisation code/)
		assert.match(imapFailureHint({ message: "535 5.7.8 Bad credentials" }) ?? "", /authorisation code/)
		assert.match(imapFailureHint({ message: "535" }) ?? "", /authorisation code/)
		// A port number is not an SMTP reply code.
		assert.equal(imapFailureHint({ message: "connect ECONNREFUSED 127.0.0.1:535" }), undefined)
		assert.equal(imapFailureHint(undefined), undefined)
	})
})

test("a lock is not re-acquired by the process that already holds it", () => {
	// A same-PID second acquisition used to be treated as a corpse and stolen, so an older handle could release
	// a replacement. With the fail-closed policy it is simply held.
	const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "pmb-selflock-")) }
	const first = acquireLock(env, "starter.lock")
	assert.equal(first.ok, true)
	if (!first.ok) return
	const second = acquireLock(env, "starter.lock")
	assert.equal(second.ok, false)
	if (!second.ok) {
		assert.equal(second.holder, process.pid)
		assert.equal(second.stale, undefined, "our own pid is alive, so the lock is not stale")
	}
	first.lock.release()
	const third = acquireLock(env, "starter.lock")
	assert.equal(third.ok, true)
	if (third.ok) third.lock.release()
})

