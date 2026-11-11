// pi-mailbridge — pi extension entry.
//
// Responsibilities that live IN the agent process:
//   - expose the agent-facing tools (`request_decision`, `notify_user`)
//   - mail on `agent_settled` (debounced, abort-aware)
//   - own an SSE client to the local daemon and inject claimed replies with
//     `pi.sendUserMessage(..., { deliverAs: "followUp" })`
//   - `/afk`, `/back`, `/mailbridge` commands
//
// What lives OUTSIDE, in the daemon: IMAP IDLE, UID cursor, parsing, pending
// store, SMTP. See docs/ARCHITECTURE.md §1.
//
// Scaffold status: commands and the settled-notify path are wired; the daemon
// client, tool bodies, and stores are TODO and marked inline.

import { Type } from "@sinclair/typebox"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"

import { loadConfig, type ResolvedConfig } from "./core/config.ts"
import { readSecret } from "./store/secret.ts"
import { stampSubject } from "./core/token.ts"

/** Debounce so a user who immediately types again does not get a half-finished mail. */
const SETTLED_DEBOUNCE_MS = 10_000

export default function mailbridge(pi: ExtensionAPI): void {
	let config: ResolvedConfig = loadConfig()
	let ctx: ExtensionContext | undefined
	let settledTimer: ReturnType<typeof setTimeout> | undefined
	/** Debounce mirror of the daemon's global mode, pushed over SSE. */
	let emailMode: "on" | "off" = "off"

	const sessionId = (): string | undefined => ctx?.sessionManager.getSessionId()

	// ---- lifecycle ---------------------------------------------------------

	pi.on("session_start", (_event, c) => {
		ctx = c
		config = loadConfig()
		// TODO(daemon-client): connect to http://127.0.0.1:<port>/events, replay
		// /pending, and claim deliveries whose token matches sessionId().
	})

	pi.on("agent_settled", (event) => {
		// agent_end would fire too early: retries, compaction and queued
		// follow-ups can still run after it.
		if (emailMode !== "on") return
		if (event.aborted && !config.notify.notifyOnAborted) return
		if (!config.notify.onSettled) return
		if (!ctx) return

		clearTimeout(settledTimer)
		settledTimer = setTimeout(() => {
			// TODO(daemon-client): POST /send with the last assistant text, subject
			// stamped via stampSubject(sessionId(), config.notify.subject, secret).
			// Include: session name, cwd, turn count, and the last assistant text.
		}, config.notify.debounceMs ?? SETTLED_DEBOUNCE_MS)
	})

	pi.on("session_shutdown", () => {
		clearTimeout(settledTimer)
		settledTimer = undefined
		ctx = undefined
		// TODO(daemon-client): close the SSE stream; the daemon keeps running.
	})

	// ---- commands ----------------------------------------------------------

	function setMode(mode: "on" | "off", c: ExtensionCommandContext): void {
		emailMode = mode
		// TODO(daemon-client): POST /mode so every session sees it.
		c.ui.notify(
			mode === "on"
				? "Mailbridge ON — decisions will be emailed; the terminal stays quiet."
				: "Mailbridge OFF — decisions ask in the terminal.",
			"info",
		)
	}

	pi.registerCommand("afk", {
		description: "Email mode ON: decisions mail you and end the turn",
		handler: async (_args, c) => setMode("on", c),
	})

	pi.registerCommand("back", {
		description: "Email mode OFF: decisions ask in the terminal",
		handler: async (_args, c) => setMode("off", c),
	})

	pi.registerCommand("mailbridge", {
		description: "Mailbridge status",
		handler: async (_args, c) => {
			const secret = readSecret()
			c.ui.notify(
				[
					`mode: ${emailMode}`,
					`session: ${sessionId() ?? "(none)"}`,
					`secret: ${secret ? "present" : "missing"}`,
					`mailbox: ${config.mail.imap.user || "(unset)"}`,
					`daemon: TODO not connected`,
				].join("\n"),
				"info",
			)
		},
	})

	// ---- agent-facing tools ------------------------------------------------

	pi.registerTool({
		name: "request_decision",
		label: "Request decision",
		description:
			"Email the user a decision request and end the turn. Use only when email mode is on and you genuinely cannot proceed without the user's choice.",
		parameters: Type.Object({
			subject: Type.String({ description: "Short subject line" }),
			question: Type.String({ description: "The decision, with enough context to answer without the terminal" }),
			options: Type.Optional(Type.Array(Type.String(), { description: "Concrete options" })),
			recommendation: Type.Optional(Type.String({ description: "Your recommended option and why" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, c) {
			const id = c.sessionManager.getSessionId()
			if (emailMode !== "on") {
				return { content: [{ type: "text", text: "Email mode is off — ask in the terminal instead." }], details: {} }
			}
			const secret = readSecret()
			if (!secret) {
				return { content: [{ type: "text", text: "Mailbridge secret missing; cannot stamp a routing token." }], details: {} }
			}
			const subject = stampSubject(id, params.subject, secret)
			// TODO(daemon-client): POST /send + /register (single outstanding decision).
			return {
				content: [{ type: "text", text: `Would email "${subject}" — daemon client not wired yet.` }],
				details: { sessionId: id },
			}
		},
	})

	pi.registerTool({
		name: "notify_user",
		label: "Notify user",
		description: "Send the user a one-way email update. Does not end the turn and does not wait for a reply.",
		parameters: Type.Object({
			subject: Type.String(),
			message: Type.String(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, c) {
			if (emailMode !== "on") {
				return { content: [{ type: "text", text: "Email mode is off." }], details: {} }
			}
			const secret = readSecret()
			if (!secret) {
				return { content: [{ type: "text", text: "Mailbridge secret missing." }], details: {} }
			}
			// TODO(daemon-client): fire-and-forget POST /send, no /register.
			return {
				content: [{ type: "text", text: `Would email "${stampSubject(c.sessionManager.getSessionId(), params.subject, secret)}".` }],
				details: {},
			}
		},
	})
}
