// Settle notification: the email you get when the agent stops.
//
// Three rules earn this module its existence:
//   1. It fires on `agent_settled` only. `agent_end` precedes retries,
//      compaction and queued follow-ups, so mailing there would send you a
//      "finished" message for work that is still running.
//   2. It is debounced. Settle → you type again → settle would otherwise mail
//      you a half-finished answer.
//   3. An aborted settle (Escape) is not "finished" and is skipped by default.

import type { Mode } from "../store/mode-store.ts"
import { stampSubject } from "./token.ts"

export interface SettleContext {
	sessionId: string
	sessionName?: string
	cwd: string
	/** Completed turns in this session, when known. */
	turns?: number
	/** The assistant's last text, when known. */
	lastAssistantText?: string
}

export const REPLY_HINT = "Reply above this line to continue the session."

/** Subject: human-readable, with the routing token that makes the reply land here. */
export function buildSettleSubject(context: SettleContext, secret: Buffer): string {
	const label = context.sessionName?.trim() || context.cwd.split("/").filter(Boolean).pop() || "session"
	return stampSubject(context.sessionId, `pi: ${label} is waiting for you`, secret)
}

/** Plain-text body. Deliberately boring: it must survive arbitrary mail clients. */
export function buildSettleBody(context: SettleContext): string {
	const lines: string[] = []
	lines.push(context.lastAssistantText?.trim() || "(the agent produced no text this turn)")
	lines.push("")
	lines.push("--")
	lines.push(`session: ${context.sessionName?.trim() || context.sessionId}`)
	lines.push(`session id: ${context.sessionId}`)
	lines.push(`project: ${context.cwd}`)
	if (typeof context.turns === "number") lines.push(`turns: ${context.turns}`)
	lines.push("")
	lines.push(REPLY_HINT)
	return lines.join("\n")
}

export interface SettleNotifyConfig {
	onSettled: boolean
	debounceMs: number
	notifyOnAborted: boolean
}

export interface SettleNotifierDeps {
	mode: () => Mode
	/** Current session context, or undefined when there is no session. */
	context: () => SettleContext | undefined
	send: (message: { to: string; subject: string; text: string }) => Promise<void>
	secret: () => Buffer
	config: SettleNotifyConfig
	timers: {
		setTimeout(handler: () => void, ms: number): unknown
		clearTimeout(handle: unknown): void
	}
	onError?: (error: Error) => void
}

export type SettleOutcome = "scheduled" | "mode-off" | "aborted" | "disabled" | "no-context"

export interface SettleNotifier {
	/** Call from `agent_settled`. Returns why it did or did not schedule. */
	settled(event?: { aborted?: boolean }): SettleOutcome
	/** Send any pending notification immediately (tests, shutdown). */
	flush(): Promise<void>
	/** True while a debounced send is waiting. */
	isPending(): boolean
	/** Drop a pending send without sending (session shutdown). */
	cancel(): void
}

export function createSettleNotifier(deps: SettleNotifierDeps): SettleNotifier {
	let handle: unknown
	let pendingContext: SettleContext | undefined

	async function deliver(context: SettleContext): Promise<void> {
		const secret = deps.secret()
		try {
			await deps.send({
				to: "", // the daemon fills in mail.to
				subject: buildSettleSubject(context, secret),
				text: buildSettleBody(context),
			})
		} catch (error) {
			deps.onError?.(error instanceof Error ? error : new Error(String(error)))
		}
	}

	function cancel(): void {
		if (handle !== undefined) {
			deps.timers.clearTimeout(handle)
			handle = undefined
		}
		pendingContext = undefined
	}

	return {
		settled(event) {
			if (deps.mode() !== "on") return "mode-off"
			if (event?.aborted && !deps.config.notifyOnAborted) return "aborted"
			if (!deps.config.onSettled) return "disabled"

			const context = deps.context()
			if (!context) return "no-context"

			// Debounce: a later settle replaces the earlier one entirely.
			cancel()
			pendingContext = context
			const delay = Math.max(0, deps.config.debounceMs)
			handle = deps.timers.setTimeout(() => {
				handle = undefined
				const pending = pendingContext
				pendingContext = undefined
				if (pending) void deliver(pending)
			}, delay)
			return "scheduled"
		},

		async flush() {
			const context = pendingContext
			cancel()
			if (context) await deliver(context)
		},

		isPending() {
			return pendingContext !== undefined
		},

		cancel,
	}
}
