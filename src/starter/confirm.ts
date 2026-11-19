// Result mails: what the starter tells the human, in plain text.
//
// Two rules, both from the review of the plan:
//
//   * **Only authenticated, channel-matching mail gets a reply.** These functions are called by the
//     pipeline, which has already decided that; they do not re-check it.
//   * **Never render diagnostics as Markdown.** A refusal can quote a captured terminal; `sendMail`
//     renders Markdown and discovers local paths in it as attachments. `plain: true` skips both, and the
//     renderers here strip control characters and cap the length first.

import type { ResolvedConfig } from "../core/config.ts"
import type { OutboundMessage } from "../core/mailer.ts"
import type { TokenProvider } from "../core/oauth.ts"
import { cleanDiagnostic } from "../core/diagnostics.ts"

export { cleanDiagnostic } from "../core/diagnostics.ts"

export interface StartedFacts {
	name: string
	cwd: string
	model?: string
	attachHint: string
	stopText: string
}

export function renderStarted(facts: StartedFacts): string {
	return [
		`[pi-start] started ${facts.name}`,
		`cwd: ${facts.cwd}`,
		...(facts.model ? [`model: ${facts.model}`] : []),
		`attach: ${facts.attachHint}`,
		`stop: reply with "${facts.stopText}"`,
	].join("\n")
}

export function renderRefused(code: string, detail: string, candidates?: string[]): string {
	return [
		`[pi-start] refused — ${code}: ${cleanDiagnostic(detail)}`,
		...(candidates?.length ? ["", "candidates:", ...candidates.map((c) => `  ${c}`)] : []),
	].join("\n")
}

export function renderList(rows: { name: string; id: string; cwd?: string; ageHours?: number }[]): string {
	if (rows.length === 0) return "[pi-start] no sessions"
	return [
		"[pi-start] sessions",
		...rows.map(
			(row) =>
				`  ${row.name}  ${row.id}${row.cwd ? `  ${row.cwd}` : ""}${row.ageHours === undefined ? "" : `  ${row.ageHours}h`}`,
		),
	].join("\n")
}

export function renderStopped(name: string, ok: boolean): string {
	return ok ? `[pi-start] stopped ${name}` : `[pi-start] could not stop ${name}`
}

export interface ReplySubjectOptions {
	original: string | undefined
}

/** `Re: <original>`, without stacking prefixes. */
export function replySubject(options: ReplySubjectOptions): string {
	const base = (options.original ?? "no subject").trim() || "no subject"
	return /^re:\s/i.test(base) ? base : `Re: ${base}`
}

export interface ConfirmerDeps {
	/** Injected for tests; normally `sendMail`. The provider is the XOAUTH2 one IMAP already uses. */
	send?: (config: ResolvedConfig, message: OutboundMessage, provider?: TokenProvider) => Promise<unknown>
	/** SMTP credentials source for XOAUTH2; without it the mailer refuses that auth type. */
	provider?: TokenProvider
	now?: () => number
	log?: (line: string) => void
}

export interface Confirmer {
	/** Send one result. Returns false when the budget refused it (logged, not thrown). */
	send(facts: { subject: string; text: string; inReplyTo: string }): Promise<boolean>
	/** How many were sent in the current window (for `check` and tests). */
	sentInWindow(): number
}

/**
 * Bound the result mails separately from starts.
 *
 * An authenticated sender can send `list:` in a loop; `startsPerHour` does not bound that, and an
 * unbounded reply loop is exactly the way a starter would spend an account's quota or annoy a provider.
 * The window is in memory, so a restart forgets it: acceptable, because a restart also stops the loop.
 */
export function createConfirmer(config: ResolvedConfig, deps: ConfirmerDeps = {}): Confirmer {
	const send =
		deps.send ??
		((cfg: ResolvedConfig, message: OutboundMessage, provider?: TokenProvider) =>
			import("../core/mailer.ts").then((m) => m.sendMail(cfg, message, provider ? { provider } : {})))
	const now = deps.now ?? Date.now
	const limit = Math.max(0, config.starter.confirmationsPerHour)
	const window: number[] = []

	const prune = (): void => {
		const cutoff = now() - 60 * 60 * 1000
		while (window.length > 0 && window[0]! < cutoff) window.shift()
	}

	return {
		async send(facts) {
			prune()
			if (limit > 0 && window.length >= limit) {
				deps.log?.(`confirmation budget reached (${limit}/h); dropped a result for ${facts.inReplyTo}`)
				return false
			}
			window.push(now())
			await send(
				config,
				{
					to: config.mail.to,
					subject: replySubject({ original: facts.subject }),
					// A dedicated starter address is the channel; replies must come back to it, not to whoever
					// the SMTP account is.
					...(config.starter.channel.address.trim() ? { replyTo: config.starter.channel.address.trim() } : {}),
					text: facts.text,
					// Threaded under the request, so the human sees the answer where they asked.
					inReplyTo: facts.inReplyTo,
					references: [facts.inReplyTo],
					plain: true,
				},
				deps.provider,
			)
			return true
		},
		sentInWindow: () => {
			prune()
			return window.length
		},
	}
}
