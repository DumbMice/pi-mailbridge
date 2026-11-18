// `pi-mailbridge starter …` — the starter's CLI, separate from the daemon's flags.
//
// The commands are thin; the decisions live in handle/run/journal. What this file owns is the process
// furniture a watcher needs: the lock, the log, prompt files, and the wiring of the IMAP watcher to the
// scan loop.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { execFile, spawn } from "node:child_process"

import type { ResolvedConfig } from "../core/config.ts"
import { loadConfig } from "../core/config.ts"
import { statePath } from "../store/paths.ts"
import { acquireLock } from "../store/lock.ts"
import { createCursorStore } from "../store/uid-cursor.ts"
import { type JournalFile, JOURNAL_DEFAULTS, mergeJournals, readJournal, writeJournal } from "./journal.ts"
import { buildSpawnArgv, listSessions, spawnSession, stopSession, type SpawnPlan } from "./spawn.ts"
import { createStarterRunner, type StarterSource } from "./run.ts"
import { createConfirmer, renderList } from "./confirm.ts"
import { parseFieldsWithAgent } from "./parse-agent.ts"
import { resolveBootstrapPath } from "./bootstrap-path.ts"
import { buildTokenProvider } from "../core/token-source.ts"
import { createImapflowFactory } from "../daemon/imapflow.ts"
import { createImapWatcher } from "../daemon/watcher.ts"

export interface CliDeps {
	config?: ResolvedConfig
	env?: NodeJS.ProcessEnv
	stdout?: (line: string) => void
	stderr?: (line: string) => void
	readJournal?: () => JournalFile
	saveJournal?: (journal: JournalFile) => void
	listSessions?: typeof listSessions
	stopSession?: typeof stopSession
	/** Build the IMAP source; injected by tests. */
	createSource?: (config: ResolvedConfig) => Promise<StarterSource>
	moduleUrl?: string | URL
	now?: () => number
}

interface Ctx {
	config: ResolvedConfig
	env: NodeJS.ProcessEnv
	out: (line: string) => void
	err: (line: string) => void
	journal: () => JournalFile
	save: (journal: JournalFile) => void
}

function context(deps: CliDeps): Ctx {
	const env = deps.env ?? process.env
	const config = deps.config ?? loadConfig(env)
	return {
		config,
		env,
		out: deps.stdout ?? ((line) => console.log(line)),
		err: deps.stderr ?? ((line) => console.error(line)),
		journal: deps.readJournal ?? (() => readJournal(env)),
		save: deps.saveJournal ?? journalStore(env, config),
	}
}

/** Append-only, 0600, rotated at `maxBytes` keeping `keep` generations. */
export function createStarterLog(config: ResolvedConfig, env: NodeJS.ProcessEnv): (line: string) => void {
	const file = statePath(env, "starter.log")
	return (line) => {
		try {
			const max = config.starter.log.maxBytes
			if (max > 0) {
				try {
					if (statSync(file).size >= max) {
						for (let n = config.starter.log.keep; n > 1; n--) {
							try {
								renameSync(`${file}.${n - 1}`, `${file}.${n}`)
							} catch {
								/* no generation there */
							}
						}
						try {
							renameSync(file, `${file}.1`)
						} catch {
							/* best effort */
						}
					}
				} catch {
					/* no log yet */
				}
			}
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
			writeFileSync(file, `${new Date().toISOString()} ${line}\n`, { flag: "a", mode: 0o600 })
		} catch {
			/* a log that cannot be written must not stop the starter */
		}
	}
}

/** One prompt file per request, in a private directory. */
/**
 * The journal's single write path: read, merge, write with the configured acceptance horizon.
 *
 * Both writers use it. The runner used to call `writeJournal` directly, which undid a CLI stop on its next
 * save and pruned tombstones at the default 48 h even when the acceptance horizon was longer.
 */
export function journalStore(env: NodeJS.ProcessEnv, config: ResolvedConfig): (journal: JournalFile) => void {
	return (journal) => {
		let disk: JournalFile
		try {
			disk = readJournal(env)
		} catch (error) {
			// Untrusted on disk is not a licence to overwrite it with a partial view.
			throw new Error(`refusing to save over an untrusted journal: ${(error as Error).message}`)
		}
		const merged = mergeJournals(disk, journal)
		for (const key of Object.keys(journal.requests)) delete journal.requests[key]
		Object.assign(journal.requests, merged.requests)
		for (const key of Object.keys(journal.sessions)) delete journal.sessions[key]
		Object.assign(journal.sessions, merged.sessions)
		writeJournal(env, merged, {
			...JOURNAL_DEFAULTS,
			// The acceptance horizon is the replay guard; the journal must not forget before it.
			requestMaxAgeHours: config.starter.requestMaxAgeHours,
		})
	}
}

export function createPromptWriter(env: NodeJS.ProcessEnv): {
	write: (requestId: string, text: string) => { promptFile: string; readyFile: string }
	/** Remove a request's files: the bootstrap consumes them, so a failed start must not leave them. */
	remove: (requestId: string) => void
	pruneReceipts: () => number
} {
	const dir = statePath(env, "starter-prompts")
	return {
		write(requestId, text) {
			mkdirSync(dir, { recursive: true, mode: 0o700 })
			const promptFile = join(dir, `${requestId}.txt`)
			writeFileSync(promptFile, text, { mode: 0o600 })
			return { promptFile, readyFile: join(dir, `${requestId}.ready`) }
		},
		remove(requestId) {
			for (const suffix of [".txt", ".ready"]) {
				try {
					unlinkSync(join(dir, `${requestId}${suffix}`))
				} catch {
					/* already consumed */
				}
			}
		},
		pruneReceipts() {
			let removed = 0
			try {
				for (const name of readdirSync(dir)) {
					if (!name.endsWith(".ready")) continue
					try {
						if (Date.now() - statSync(join(dir, name)).mtimeMs > 3_600_000) {
							unlinkSync(join(dir, name))
							removed += 1
						}
					} catch {
						/* gone already */
					}
				}
			} catch {
				/* no directory yet */
			}
			return removed
		},
	}
}

/** `check`: everything `run` needs, without starting anything. */
export function starterProblems(config: ResolvedConfig): string[] {
	const problems: string[] = []
	if (!config.starter.enabled) problems.push("starter.enabled is false — nothing will start")
	// Containment fails closed with no roots: every path is `outside-root`. Saying "anywhere" told an
	// operator the opposite of the code on the line they read to decide the configuration is safe.
	if (config.starter.roots.length === 0) problems.push("starter.roots is empty — no mail could start a session")
	for (const root of config.starter.roots) {
		if (!existsSync(root)) problems.push(`starter.roots: ${root} does not exist`)
		else if (!statSync(root).isDirectory()) problems.push(`starter.roots: ${root} is not a directory`)
	}
	if (!config.starter.channel.subjectPrefix.trim() && !config.starter.channel.address.trim()) {
		problems.push("starter.channel has neither a subjectPrefix nor an address")
	}
	if (config.starter.parse.agent && !config.starter.parse.model.trim()) {
		problems.push("starter.parse.agent needs starter.parse.model")
	}
	// The request context relaxes reply evidence, so address + DMARC is the whole gate for a same-mailbox
	// starter request. If DMARC is off, say so out loud.
	if (!config.security.requireDmarcPass) {
		problems.push("security.requireDmarcPass is false — starter requests are then authorized by address only")
	}
	if (config.mail.to && !config.security.allowFrom.includes(config.mail.to)) {
		problems.push(`mail.to (${config.mail.to}) is not in security.allowFrom — its requests would be refused`)
	}
	return problems
}

function which(binary: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("which", [binary], (error) => resolve(!error))
	})
}

/** The real IMAP source: the daemon's watcher, wired through the starter's own cursor and loop. */
export interface SourceHooks {
	onMail?: () => void
	onReady?: () => void
	onError?: (error: Error, nextDelayMs: number) => void
}

/**
 * The watcher callbacks the runner depends on. Pure, so the wiring can be tested: empty hooks made IDLE
 * cosmetic - new mail then only appeared on the sweep, a minute late.
 */
export function watcherCallbacks(hooks: SourceHooks): {
	onReady: () => void
	onMail: () => void
	onError?: (error: Error, nextDelayMs: number) => void
} {
	return {
		// The runner owns serialisation (a burst queues one follow-up scan), so both may fire freely.
		onReady: () => hooks.onReady?.(),
		onMail: () => hooks.onMail?.(),
		...(hooks.onError ? { onError: hooks.onError } : {}),
	}
}

/**
 * The mail config the starter actually connects with: `starter.channel.folder` replaces the daemon's folder
 * when it is set. Without this the setting was validated and then ignored, which is worse than absent.
 */
export function starterMailConfig(config: ResolvedConfig): ResolvedConfig {
	const folder = config.starter.channel.folder.trim()
	if (!folder) return config
	return { ...config, mail: { ...config.mail, imap: { ...config.mail.imap, folder } } }
}

export async function createImapSource(config: ResolvedConfig, hooks: SourceHooks = {}): Promise<StarterSource> {
	const wired = starterMailConfig(config)
	const provider = await buildTokenProvider(wired)
	return createImapWatcher(wired, {
		factory: createImapflowFactory({ getAccessToken: provider ? () => provider.getToken() : undefined }),
		callbacks: watcherCallbacks(hooks),
	})
}

async function runLoop(ctx: Ctx, deps: CliDeps, once: boolean): Promise<number> {
	const log = createStarterLog(ctx.config, ctx.env)
	const journal: JournalFile = ctx.journal()
	const cursor = createCursorStore("starter-cursor.json")
	const prompts = createPromptWriter(ctx.env)
	const bootstrapPath = resolveBootstrapPath(import.meta.url)
	const confirmer = createConfirmer(ctx.config, { log, provider: await buildTokenProvider(ctx.config) })
	let wake = (): void => {}
	const source = deps.createSource
		? await deps.createSource(ctx.config)
		: await createImapSource(ctx.config, {
				onMail: () => wake(),
				onReady: () => wake(),
				onError: (error, nextDelayMs) => log(`imap error (${error.message}); reconnecting in ${nextDelayMs}ms`),
			})
	const parserAttempts: number[] = []

	const runner = createStarterRunner({
		config: ctx.config,
		env: ctx.env,
		source,
		cursor,
		journal,
		saveJournal: (next) => {
			journalStore(ctx.env, ctx.config)(next)
		},
		handle: {
			writePrompt: (id, text) => {
				prompts.pruneReceipts()
				return prompts.write(id, text)
			},
			removePrompt: (id) => prompts.remove(id),
			spawn: (plan) => spawnSession(plan),
			stop: async (id, name, requestId) => {
				// The name and the request id in the session's environment are the ownership proof: a reused
				// `$N` (and a reused name) after a tmux restart must not be killed.
				const result = await stopSession(id, { expectedName: name, ...(requestId ? { expectedRequestId: requestId } : {}) })
				return result.ok ? { ok: true } : { ok: false, detail: result.detail }
			},
			list: async () => (await listSessions())?.map((entry) => ({ id: entry.id, name: entry.name })),
			send: async (message) => {
				// False means the budget swallowed it; the journal must keep the result owed.
				const sent = await confirmer.send({ subject: message.subject, text: message.text, inReplyTo: message.inReplyTo })
				if (!sent) throw new Error("confirmation budget reached")
			},
			log,
			now: Date.now,
			bootstrapPath,
			// Stage B: one isolated parser run, bounded by its own budget, and only for a missing cwd.
			parseWithAgent: async (mail) => {
				const now = Date.now()
				while (parserAttempts.length > 0 && parserAttempts[0]! < now - 3_600_000) parserAttempts.shift()
				if (ctx.config.starter.parserAttemptsPerHour > 0 && parserAttempts.length >= ctx.config.starter.parserAttemptsPerHour) {
					log("parser budget reached; refusing to run stage B")
					return { error: "parser budget reached" }
				}
				parserAttempts.push(now)
				const parsed = await parseFieldsWithAgent(ctx.config, { subject: mail.subject, body: mail.body })
				return parsed.ok ? { ...(parsed.fields.cwd ? { cwd: parsed.fields.cwd } : {}) } : { error: parsed.error }
			},
		},
		liveSessions: () => listSessions(),
		now: Date.now,
		log,
	})

	// IDLE, the sweep and `once` all funnel through the runner, which serialises them.
	wake = () => void runner.once()

	if (once) {
		// A real `once` mutates the journal, so it takes the same lifetime lock as `run`: two of them at once
		// could both reserve the same name and spawn two sessions.
		const onceLock = acquireLock(ctx.env, "starter.lock")
		if (!onceLock.ok) {
			ctx.err(`another starter is already running (pid ${onceLock.holder})`)
			return 1
		}
		try {
			await source.start?.()
			const summary = await runner.once()
			await source.stop?.()
			log(`once: examined ${summary.examined}, started ${summary.started}, refused ${summary.refused}, ignored ${summary.ignored}`)
			return 0
		} finally {
			onceLock.lock.release()
		}
	}

	const lock = acquireLock(ctx.env, "starter.lock")
	if (!lock.ok) {
		ctx.err(`another starter is already running (pid ${lock.holder})`)
		return 0
	}
	await runner.start()
	ctx.out("starter: watching (SIGTERM or Ctrl-C to stop)")
	await new Promise<void>((resolve) => {
		const stop = (): void => resolve()
		process.once("SIGTERM", stop)
		process.once("SIGINT", stop)
	})
	await runner.stop()
	lock.lock.release()
	return 0
}

export async function runStarterCommand(argv: string[], deps: CliDeps = {}): Promise<number> {
	const ctx = context(deps)
	const dryRun = argv.includes("--dry-run")
	const cmd = argv.find((arg) => !arg.startsWith("--")) ?? "run"

	if (cmd === "check") {
		const problems = starterProblems(ctx.config)
		// Problems the loader already noticed belong in the answer: "check said ok" must mean the resolved
		// configuration is usable, not just that this function's own list is empty.
		for (const warning of ctx.config.warnings) problems.push(warning)
		try {
			readJournal(ctx.env)
		} catch (error) {
			problems.push(`the journal cannot be trusted: ${(error as Error).message}`)
		}
		if (!(await which("tmux"))) problems.push("tmux is not on PATH")
		if (!(await which("pi"))) problems.push("pi is not on PATH")
		try {
			resolveBootstrapPath(import.meta.url)
		} catch (error) {
			problems.push((error as Error).message)
		}
		if (existsSync(`${statePath(ctx.env, "starter-journal.json")}.failed`)) {
			problems.push("the journal is marked untrusted; inspect it, then run `starter repair`")
		}
		for (const problem of problems) ctx.err(`! ${problem}`)
		ctx.out(problems.length === 0 ? "starter: ok" : `starter: ${problems.length} problem(s)`)
		return problems.length === 0 ? 0 : 2
	}

	if (cmd === "list") {
		// An unreadable live list is reported, not rendered as "no sessions".
		const live = await (deps.listSessions ?? listSessions)()
		if (live === undefined) {
			ctx.err("could not list sessions: tmux did not answer")
			return 1
		}
		const journal = ctx.journal()
		ctx.out(
			renderList(
				live.map((entry) => ({
					name: entry.name,
					id: entry.id,
					...(journal.sessions[entry.name]?.cwd ? { cwd: journal.sessions[entry.name]!.cwd } : {}),
				})),
			),
		)
		return 0
	}

	if (cmd === "repair") {
		// The corrupt-journal refusal points here, so this has to exist: set the bad bytes aside, clear the
		// marker, and say where the evidence went. It never deletes what it cannot read.
		const file = statePath(ctx.env, "starter-journal.json")
		const marker = `${file}.failed`
		const stamp = new Date().toISOString().replace(/[:.]/g, "-")
		let moved: string | undefined
		if (existsSync(file)) {
			const target = `${file}.repair-${stamp}`
			renameSync(file, target)
			moved = target
		}
		try {
			unlinkSync(marker)
		} catch {
			/* no marker: nothing to clear */
		}
		ctx.out(moved ? `set aside ${moved}; the starter will start with an empty journal` : "no journal to set aside; the starter will start with an empty journal")
		return 0
	}
	if (cmd === "stop") {
		const name = argv.filter((arg) => !arg.startsWith("--"))[1]
		if (!name) {
			ctx.err("usage: pi-mailbridge starter stop <name>")
			return 2
		}
		const journal = ctx.journal()
		const record = journal.sessions[name]
		if (!record || record.endedAt !== undefined) {
			ctx.err(`unknown-session ${name}`)
			return 1
		}
		// The name is the ownership proof: a reused `$N` after a tmux restart must not be killed from here
		// either. Passing it is the whole difference between stopping this session and stopping a stranger.
		const stop = deps.stopSession ?? stopSession
		const stopped = await stop(record.tmuxSessionId, { expectedName: record.name, expectedRequestId: record.requestId })
		if (!stopped.ok) {
			ctx.err(`could not stop ${name}: ${stopped.reason}`)
			return 1
		}
		journal.sessions[name] = { ...record, endedAt: Date.now() }
		const request = journal.requests[record.requestId]
		if (request) journal.requests[record.requestId] = { ...request, state: "ended", at: Date.now() }
		try {
			ctx.save(journal)
		} catch (error) {
			// The kill already happened: saying so is honest, and the sweep will reconcile the journal.
			ctx.err(`stopped ${name}, but the journal was not updated: ${(error as Error).message}`)
			return 0
		}
		ctx.out(`stopped ${name}`)
		return 0
	}

	if (cmd === "attach") {
		const name = argv.filter((arg) => !arg.startsWith("--"))[1]
		if (!name) {
			ctx.err("usage: pi-mailbridge starter attach <name>")
			return 2
		}
		if (!process.stdout.isTTY) {
			ctx.err("attach needs a terminal")
			return 2
		}
		// `execFile` captures stdio; assigning the streams afterwards does not reconnect the descriptors, so
		// attach gave a live view with no input. `spawn` with inherited stdio is the API that does this.
		return new Promise<number>((resolve) => {
			const child = spawn("tmux", ["-L", "pimail", "attach", "-t", name], { stdio: "inherit" })
			child.on("error", (error) => {
				ctx.err(`attach failed: ${error.message}`)
				resolve(1)
			})
			child.on("exit", (code) => resolve(code ?? 0))
		})
	}

	if (cmd === "once" || cmd === "run") {
		if (dryRun) {
			const journal = ctx.journal()
			const pending = Object.values(journal.requests).filter((r) => r.state === "reserved" || r.state === "spawning")
			const bootstrap = resolveBootstrapPath(import.meta.url)
			for (const record of pending) {
				const plan: SpawnPlan = {
					tmuxId: record.name ?? record.id,
					piSessionId: record.piSessionId ?? record.id,
					displayName: record.name ?? record.id,
					cwd: record.cwd ?? ctx.config.starter.defaultCwd,
					...(record.model ? { model: record.model } : {}),
					promptFile: statePath(ctx.env, `starter-prompts/${record.id}.txt`),
					readyFile: statePath(ctx.env, `starter-prompts/${record.id}.ready`),
					requestId: record.id,
					bootstrapPath: bootstrap,
				}
				ctx.out(`would run: ${buildSpawnArgv(plan).join(" ")}`)
			}
			ctx.out(`starter: dry run — ${pending.length} interrupted request(s), nothing started`)
			return 0
		}
		return runLoop(ctx, deps, cmd === "once")
	}

	ctx.err(`unknown starter subcommand: ${cmd}`)
	return 2
}
