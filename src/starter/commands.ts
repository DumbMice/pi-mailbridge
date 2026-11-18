// `pi-mailbridge starter …` — the starter's CLI, separate from the daemon's flags.
//
// The commands are thin; the decisions live in handle/run/journal. What this file owns is the process
// furniture a watcher needs: the lock, the log, prompt files, and the wiring of the IMAP watcher to the
// scan loop.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { execFile } from "node:child_process"

import type { ResolvedConfig } from "../core/config.ts"
import { loadConfig } from "../core/config.ts"
import { statePath } from "../store/paths.ts"
import { acquireLock } from "../store/lock.ts"
import { createCursorStore } from "../store/uid-cursor.ts"
import { type JournalFile, JOURNAL_DEFAULTS, readJournal, writeJournal } from "./journal.ts"
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
	return {
		config: deps.config ?? loadConfig(env),
		env,
		out: deps.stdout ?? ((line) => console.log(line)),
		err: deps.stderr ?? ((line) => console.error(line)),
		journal: deps.readJournal ?? (() => readJournal(env)),
		save: deps.saveJournal ?? ((journal) => writeJournal(env, journal, JOURNAL_DEFAULTS)),
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
export function createPromptWriter(env: NodeJS.ProcessEnv): {
	write: (requestId: string, text: string) => { promptFile: string; readyFile: string }
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
	if (config.starter.roots.length === 0) problems.push("starter.roots is empty — a session could be rooted anywhere")
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
export async function createImapSource(config: ResolvedConfig): Promise<StarterSource> {
	const provider = await buildTokenProvider(config)
	const watcher = createImapWatcher(config, {
		factory: createImapflowFactory({ getAccessToken: provider ? () => provider.getToken() : undefined }),
		callbacks: {
			// The runner owns serialisation, so both hooks can fire freely.
			onReady: () => {},
			onMail: () => {},
		},
	})
	return watcher
}

async function runLoop(ctx: Ctx, deps: CliDeps, once: boolean): Promise<number> {
	const log = createStarterLog(ctx.config, ctx.env)
	const journal: JournalFile = ctx.journal()
	const cursor = createCursorStore("starter-cursor.json")
	const prompts = createPromptWriter(ctx.env)
	const bootstrapPath = resolveBootstrapPath(import.meta.url)
	const confirmer = createConfirmer(ctx.config, { log })
	const source = await (deps.createSource ?? createImapSource)(ctx.config)
	const parserAttempts: number[] = []

	const runner = createStarterRunner({
		config: ctx.config,
		env: ctx.env,
		source,
		cursor,
		journal,
		saveJournal: (next) => {
			writeJournal(ctx.env, next, JOURNAL_DEFAULTS)
		},
		handle: {
			writePrompt: (id, text) => {
				prompts.pruneReceipts()
				return prompts.write(id, text)
			},
			spawn: (plan) => spawnSession(plan),
			stop: async (id) => {
				const result = await stopSession(id)
				return result.ok ? { ok: true } : { ok: false, detail: result.detail }
			},
			list: async () => (await listSessions()).map((entry) => ({ id: entry.id, name: entry.name })),
			send: async (message) => {
				await confirmer.send({ subject: message.subject, text: message.text, inReplyTo: message.inReplyTo })
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

	if (once) {
		const summary = await runner.once()
		log(`once: examined ${summary.examined}, started ${summary.started}, refused ${summary.refused}, ignored ${summary.ignored}`)
		return 0
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
		if (!(await which("tmux"))) problems.push("tmux is not on PATH")
		if (!(await which("pi"))) problems.push("pi is not on PATH")
		try {
			resolveBootstrapPath(import.meta.url)
		} catch (error) {
			problems.push((error as Error).message)
		}
		for (const problem of problems) ctx.err(`! ${problem}`)
		ctx.out(problems.length === 0 ? "starter: ok" : `starter: ${problems.length} problem(s)`)
		return problems.length === 0 ? 0 : 2
	}

	if (cmd === "list") {
		const live = await (deps.listSessions ?? listSessions)()
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
		const stopped = await (deps.stopSession ?? stopSession)(record.tmuxSessionId)
		if (!stopped.ok) {
			ctx.err(`could not stop ${name}: ${stopped.reason}`)
			return 1
		}
		journal.sessions[name] = { ...record, endedAt: Date.now() }
		const request = journal.requests[record.requestId]
		if (request) journal.requests[record.requestId] = { ...request, state: "ended", at: Date.now() }
		ctx.save(journal)
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
		return new Promise<number>((resolve) => {
			const child = execFile("tmux", ["-L", "pimail", "attach", "-t", name], (error) => resolve(error ? 1 : 0))
			child.stdin = process.stdin
			child.stdout = process.stdout
			child.stderr = process.stderr
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
