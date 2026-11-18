// The starter's loop: one scan at a time, over its own cursor, with no shared state.
//
// The loop is thin on purpose - every decision lives in `handle.ts` and every guarantee about replay in
// `journal.ts`. What is here is the sequencing that those two rely on:
//
//   * one scan at a time (IDLE and the sweep must not overlap),
//   * the cursor advances only after a message has been dealt with - ignored, refused, started or adopted,
//   * a crash leaves the cursor where it was, so the mail is seen again and reconciled against the journal,
//   * the sweep exists because IDLE alone can miss a provider that does not push (the daemon learned this
//     the hard way, and the starter runs on the same servers).

import type { ResolvedConfig } from "../core/config.ts"
import type { HeaderLike } from "../core/reply-parse.ts"
import type { RawMessage } from "../daemon/process.ts"
import type { JournalFile } from "./journal.ts"
import { alreadySeen, reconcile } from "./journal.ts"
import type { HandleDeps, Outcome, StarterMail } from "./handle.ts"
import { handleMail } from "./handle.ts"
import type { CursorStore } from "../store/uid-cursor.ts"

/** The part of the daemon's IMAP watcher the starter uses. */
export interface StarterSource {
	searchAfter(afterUid: number): Promise<number[]>
	fetch(uid: number): Promise<RawMessage | undefined>
	uidValidity?(): number | undefined
	start?(): Promise<void>
	stop?(): Promise<void>
	isHealthy?(): boolean
}

export interface ScanDeps {
	config: ResolvedConfig
	source: StarterSource
	cursor: CursorStore
	env: NodeJS.ProcessEnv
	journal: JournalFile
	saveJournal: (journal: JournalFile) => void
	handle: Omit<HandleDeps, "journal" | "save" | "config" | "env">
	/** Live tmux sessions, for reconciliation of interrupted requests. */
	liveSessions: () => Promise<{ id: string; name: string }[]>
	now: () => number
	log: (line: string) => void
}

export interface ScanSummary {
	examined: number
	started: number
	refused: number
	ignored: number
	adopted: number
	uncertain: number
}

function toStarterMail(message: RawMessage, uidValidity: number | undefined): StarterMail {
	const headers: HeaderLike = message.headers
	return {
		subject: message.subject,
		from: message.from,
		to: headers.to ?? [],
		headers: {
			inReplyTo: headers.inReplyTo,
			references: headers.references,
			authResults: headers.authResults,
			autoSubmitted: headers.autoSubmitted,
			precedence: headers.precedence,
			xPiMailbridge: headers.piMailbridge,
		},
		messageId: headers.messageId ?? `<uid-${message.uid}>`,
		uid: message.uid,
		...(uidValidity === undefined ? {} : { uidValidity }),
		receivedAt: message.receivedAt,
		body: message.text,
	}
}

/** Reconcile a request whose outcome was interrupted, using what is actually running now. */
async function reconcileInterrupted(record: ReturnType<typeof alreadySeen>, deps: ScanDeps, summary: ScanSummary): Promise<void> {
	if (!record || record.state === "refused" || record.state === "ended") return
	const live = await deps.liveSessions()
	const verdict = reconcile(record, live.map((entry) => ({ tmuxSessionId: entry.id, name: entry.name })))
	if (verdict.action === "adopt") {
		deps.journal.requests[record.id] = { ...record, state: "ready", at: deps.now() }
		if (record.tmuxSessionId && record.name) {
			deps.journal.sessions[record.name] = {
				name: record.name,
				tmuxSessionId: record.tmuxSessionId,
				piSessionId: record.piSessionId ?? "",
				requestId: record.id,
				cwd: record.cwd ?? "",
				...(record.model ? { model: record.model } : {}),
				at: record.at,
			}
		}
		summary.adopted += 1
		deps.log(`adopted ${record.name ?? record.id} from an interrupted start`)
	} else if (verdict.action === "refuse") {
		deps.journal.requests[record.id] = { ...record, state: "refused", reason: verdict.reason, at: deps.now() }
		summary.refused += 1
		deps.log(`refused ${record.id}: ${verdict.reason}`)
	} else {
		// Stays uncertain: it is never respawned automatically, and the log says why.
		deps.journal.requests[record.id] = { ...record, state: "uncertain", reason: verdict.reason, at: record.at }
		summary.uncertain += 1
		deps.log(`uncertain ${record.id}: ${verdict.reason}`)
	}
	deps.saveJournal(deps.journal)
}

/**
 * One scan. Serialised by the caller: IDLE, the sweep and a manual `once` all go through this.
 *
 * A thrown fetch stops the batch with the cursor where it was - the same rule as the daemon's scan - so
 * a transient IMAP error never skips mail.
 */
export async function scanOnce(deps: ScanDeps): Promise<ScanSummary> {
	const summary: ScanSummary = { examined: 0, started: 0, refused: 0, ignored: 0, adopted: 0, uncertain: 0 }
	const cursor = deps.cursor.read(deps.env)
	const uidValidity = deps.source.uidValidity?.()
	deps.cursor.sync(deps.env, uidValidity)
	const uids = (await deps.source.searchAfter(deps.cursor.read(deps.env))).slice().sort((a, b) => a - b)
	summary.examined = uids.length

	for (const uid of uids) {
		const message = await deps.source.fetch(uid)
		if (!message) {
			// Deleted between search and fetch: nothing to act on, and the cursor may move.
			deps.cursor.advance(deps.env, uid)
			continue
		}
		const mail = toStarterMail(message, uidValidity)
		const seen = alreadySeen(deps.journal, { messageId: mail.messageId, uid, uidValidity })
		if (seen) {
			await reconcileInterrupted(seen, deps, summary)
			deps.cursor.advance(deps.env, uid)
			summary.ignored += 1
			continue
		}

		const outcome: Outcome = await handleMail(mail, {
			...deps.handle,
			config: deps.config,
			env: deps.env,
			journal: deps.journal,
			save: deps.saveJournal,
			now: deps.now,
		})
		if (outcome.action === "started") summary.started += 1
		else if (outcome.action === "refused") summary.refused += 1
		else summary.ignored += 1
		// Recorded (or deliberately not) before the cursor moves: a crash here re-reads the mail and the
		// journal recognises it.
		deps.cursor.advance(deps.env, uid)
	}
	void cursor
	return summary
}

export interface RunnerTimers {
	setTimeout(handler: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

const realTimers: RunnerTimers = {
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface RunnerDeps extends ScanDeps {
	timers?: RunnerTimers
	scanIntervalSecs?: number
}

/**
 * The loop: catch-up on ready, a sweep on a timer, IDLE as the fast path, and never an idle exit.
 *
 * `start()` is what a `run` subcommand calls; `once()` is what a debug run calls. Neither takes the lock
 * here - the CLI owns that, so a dry run can be lock-free.
 */
export function createStarterRunner(deps: RunnerDeps) {
	const timers = deps.timers ?? realTimers
	const intervalMs = Math.max(0, (deps.scanIntervalSecs ?? deps.config.starter.scanIntervalSecs) * 1000)
	let sweep: unknown
	let running = false
	let queued = false

	let lastSummary: ScanSummary | undefined
	const guarded = async (): Promise<void> => {
		if (running) {
			// A burst of IDLE events must not start overlapping scans; run one more after this one.
			queued = true
			return
		}
		running = true
		try {
			const summary = await scanOnce(deps)
			lastSummary = summary
			if (summary.examined > 0) {
				deps.log(
					`scan: examined ${summary.examined}, started ${summary.started}, refused ${summary.refused}, ignored ${summary.ignored}`,
				)
			}
		} catch (error) {
			// The cursor was not advanced past the failure, so the next scan retries the same UIDs.
			deps.log(`scan failed: ${(error as Error).message}`)
		} finally {
			running = false
			if (queued) {
				queued = false
				await guarded()
			}
		}
	}

	const schedule = (): void => {
		if (intervalMs <= 0) return
		sweep = timers.setTimeout(() => {
			void guarded()
			schedule()
		}, intervalMs)
	}

	return {
		/** One scan, for `once` and for tests. Returns the summary of the scan it ran (or the last one). */
		once: async (): Promise<ScanSummary> => {
			await guarded()
			return lastSummary ?? { examined: 0, started: 0, refused: 0, ignored: 0, adopted: 0, uncertain: 0 }
		},
		async start(): Promise<void> {
			deps.log("starter: watching")
			await deps.source.start?.()
			void guarded()
			schedule()
		},
		async stop(): Promise<void> {
			if (sweep !== undefined) timers.clearTimeout(sweep)
			sweep = undefined
			await deps.source.stop?.()
		},
	}
}
