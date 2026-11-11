// pi-mailbridge — pi extension entry.
//
// Everything here runs INSIDE the agent process. The mailbox is not touched: the
// daemon owns IMAP, and this file talks to it over loopback.
//
// Dependencies are injectable so the registration surface (which events, which
// commands, which tools) and the settle behaviour can be asserted with a fake
// `pi`, no daemon and no mailbox.

import { Type } from "@sinclair/typebox"

import { loadConfig, type ResolvedConfig } from "./core/config.ts"
import { readSecret } from "./store/secret.ts"
import { createSettleNotifier, type SettleContext, type SettleNotifier } from "./core/settle.ts"
import { createDeliveryRunner, type DeliveryRunner } from "./core/deliveries.ts"
import { toUserContent, type UserContent } from "./core/attachments.ts"
import { daemonBaseUrl, ensureDaemon, createDaemonClient, type DaemonClient } from "./daemon/spawn.ts"

const POLL_MS = 10_000

/** The slice of the pi runtime this extension uses. */
export interface ExtensionLike {
	on(event: string, handler: (event: Record<string, unknown>, ctx: ExtensionCtxLike) => unknown): void
	registerCommand(name: string, spec: { description: string; handler: (args: string, ctx: ExtensionCtxLike) => Promise<void> }): void
	registerTool(spec: {
		name: string
		label: string
		description: string
		parameters: unknown
		execute: (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: unknown,
			onUpdate: unknown,
			ctx: ExtensionCtxLike,
		) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>
	}): void
	/** Used to answer a reply inside the session. */
	sendUserMessage(
		content: string | UserContent[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): void
}

export interface ExtensionCtxLike {
	cwd: string
	sessionManager: { getSessionId(): string; getName?(): string | undefined }
	ui: { notify(message: string, level?: "info" | "warning" | "error"): void }
}

export interface SettleTimers {
	setTimeout(handler: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

export interface MailbridgeDeps {
	env?: NodeJS.ProcessEnv
	loadConfig?: () => ResolvedConfig
	secret?: () => Buffer | undefined
	/** Build a daemon client for a base URL and bearer token. */
	makeClient?: (baseUrl: string, token: string) => DaemonClient
	/** Make sure the daemon is up. */
	ensureDaemon?: (baseUrl: string, scriptPath: string) => Promise<boolean>
	timers?: SettleTimers
	/** Poll interval for pending replies. */
	pollMs?: number
}

const defaultTimers: SettleTimers = {
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export default function mailbridge(pi: ExtensionLike, deps: MailbridgeDeps = {}): void {
	const env = deps.env ?? process.env
	const config: ResolvedConfig = (deps.loadConfig ?? (() => loadConfig(env)))()
	const secretFn = deps.secret ?? (() => readSecret(env))
	const timers = deps.timers ?? defaultTimers
	const pollMs = deps.pollMs ?? POLL_MS

	let ctx: ExtensionCtxLike | undefined
	let client: DaemonClient | undefined
	let runner: DeliveryRunner | undefined
	let pollHandle: unknown
	let notifier: SettleNotifier | undefined
	/** Mirror of the daemon's global mode. Default off: never mail unprompted. */
	let emailMode: "on" | "off" = "off"

	const baseUrl = daemonBaseUrl(config.daemon.port, config.daemon.host)

	function sessionContext(): SettleContext | undefined {
		if (!ctx) return undefined
		const sessionId = ctx.sessionManager.getSessionId()
		const name = ctx.sessionManager.getName?.()
		return {
			sessionId,
			...(name ? { sessionName: name } : {}),
			device: config.device.name,
			cwd: ctx.cwd,
		}
	}

	function stopPolling(): void {
		if (pollHandle !== undefined) {
			timers.clearTimeout(pollHandle)
			pollHandle = undefined
		}
	}

	function startPolling(): void {
		stopPolling()
		const tick = async () => {
			try {
				// Refresh the mode first: /afk may have been toggled from another
				// session, and the settle gate depends on this mirror.
				const mode = await client?.mode()
				if (mode?.ok) emailMode = mode.data.mode === "on" ? "on" : "off"
				await runner?.drain()
			} catch {
				/* drain already swallows; a poll must never throw into the runtime */
			}
			if (pollHandle !== undefined || !runner) return
			pollHandle = timers.setTimeout(() => {
				pollHandle = undefined
				void tick()
			}, pollMs)
		}
		pollHandle = timers.setTimeout(() => {
			pollHandle = undefined
			void tick()
		}, pollMs)
	}

	// ---- lifecycle ---------------------------------------------------------

	pi.on("session_start", async (_event, c) => {
		ctx = c
		const secret = secretFn()
		if (!secret) {
			c.ui.notify("mailbridge: no shared secret yet — start the daemon once to create it", "warning")
			return
		}

		const token = secret.toString("base64url")
		const makeClient = deps.makeClient ?? ((base, tok) => createDaemonClient({ baseUrl: base, token: tok }))

		const ensure = deps.ensureDaemon
		if (ensure) {
			const healthy = await ensure(baseUrl, new URL("../../src/daemon/main.ts", import.meta.url).pathname)
			if (!healthy) {
				c.ui.notify("mailbridge: daemon not reachable; replies will not arrive", "warning")
				return
			}
		}

		client = makeClient(baseUrl, token)

		// Seed the mode mirror before anything can settle.
		const initialMode = await client.mode()
		emailMode = initialMode.ok && initialMode.data.mode === "on" ? "on" : "off"

		notifier = createSettleNotifier({
			mode: () => emailMode,
			context: sessionContext,
			send: async (message) => {
				await client?.send({ subject: message.subject, text: message.text })
			},
			secret: () => secret,
			config: config.notify,
			timers,
			onError: (error) => ctx?.ui.notify(`mailbridge: could not send (${error.message})`, "warning"),
		})

		runner = createDeliveryRunner({
			client: {
				claim: (uid, instanceId) => client!.claim(uid, instanceId),
				ack: (uid, instanceId, sessionId) => client!.ack(uid, instanceId, sessionId),
				pending: () => client!.pending(),
			},
			instanceId: `${process.pid}`,
			sessionId: () => ctx?.sessionManager.getSessionId(),
			inject: async (body, record) => {
				// Attachments become image/text content blocks; the text-only case stays a
				// plain string so it is indistinguishable from a typed message.
				const content = toUserContent(body, record.attachments ?? [])
				pi.sendUserMessage(content, { deliverAs: "followUp", expandPromptTemplates: true })
			},
			onError: (error) => ctx?.ui.notify(`mailbridge: reply not delivered (${error.message})`, "warning"),
		})

		await runner.drain()
		startPolling()
	})

	// The ONLY settle signal. `agent_end` is deliberately not registered: pi may
	// still retry, compact or run queued follow-ups after it.
	pi.on("agent_settled", (event) => {
		notifier?.settled({ aborted: event["aborted"] === true })
	})

	pi.on("session_shutdown", () => {
		notifier?.cancel()
		stopPolling()
		client = undefined
		runner = undefined
		ctx = undefined
	})

	// ---- commands ----------------------------------------------------------

	async function setMode(mode: "on" | "off", c: ExtensionCtxLike): Promise<void> {
		const viaDaemon = client ? await client.setMode(mode) : undefined
		if (viaDaemon?.ok) {
			emailMode = mode
			c.ui.notify(mode === "on" ? "mailbridge: email mode ON" : "mailbridge: email mode OFF", "info")
			return
		}
		// No daemon: fall back to the local file so /afk is never a silent no-op.
		const { writeMode } = await import("./store/mode-store.ts")
		writeMode(env, mode)
		c.ui.notify(`mailbridge: email mode ${mode.toUpperCase()} (daemon unreachable, stored locally)`, "warning")
	}

	pi.registerCommand("afk", { description: "Email mode ON: decisions mail you", handler: (_a, c) => setMode("on", c) })
	pi.registerCommand("back", { description: "Email mode OFF: decisions ask in the terminal", handler: (_a, c) => setMode("off", c) })

	pi.registerCommand("mailbridge", {
		description: "Mailbridge status",
		handler: async (_a, c) => {
			const secret = secretFn()
			const health = client ? await client.health() : undefined
			const pending = client ? await client.pending() : undefined
			c.ui.notify(
				[
					`daemon: ${health?.ok ? "healthy" : "unreachable"} (${baseUrl})`,
					`device: ${config.device.name}`,
					`mode: ${health?.ok ? health.data.mode : "(unknown)"}`,
					`session: ${ctx?.sessionManager.getSessionId() ?? "(none)"}`,
					`secret: ${secret ? "present" : "missing"}`,
					`mailbox: ${config.mail.to || "(unset)"}`,
					`allowlist: ${config.security.allowFrom.join(", ") || "(empty — denies all)"}`,
					`pending replies: ${pending?.ok ? pending.data.pending.length : "?"}`,
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
			"Email the user a decision request and end the turn. Use only when email mode is on and you cannot proceed without the user's choice.",
		parameters: Type.Object({
			subject: Type.String({ description: "Short subject line" }),
			question: Type.String({ description: "The decision, with enough context to answer from a phone" }),
			options: Type.Optional(Type.Array(Type.String())),
			recommendation: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, c) {
			if (!client || !runner) {
				return { content: [{ type: "text", text: "Mailbridge daemon is not reachable; ask in the terminal instead." }], details: {} }
			}
			const mode = await client.mode()
			if (!mode.ok || mode.data.mode !== "on") {
				return { content: [{ type: "text", text: "Email mode is off — ask in the terminal." }], details: {} }
			}
			const sessionId = c.sessionManager.getSessionId()
			const reserved = await client.register(sessionId)
			if (!reserved.ok) {
				return { content: [{ type: "text", text: "Another decision is already outstanding for this session." }], details: {} }
			}
			if (reserved.data.alreadyPending) {
				return { content: [{ type: "text", text: "A decision is already outstanding for this session; not mailing twice." }], details: {} }
			}

			const secret = secretFn()
			if (!secret) return { content: [{ type: "text", text: "Mailbridge secret missing." }], details: {} }

			const { stampSubject } = await import("./core/token.ts")
			const options = (params["options"] as string[] | undefined) ?? []
			const recommendation = params["recommendation"] as string | undefined
			const body = [
				String(params["question"] ?? ""),
				options.length ? `\noptions:\n${options.map((o) => `- ${o}`).join("\n")}` : "",
				recommendation ? `\nrecommendation: ${recommendation}` : "",
				"\n",
				"--",
				"Reply above this line with your answer.",
			].join("\n")

			const sent = await client.send({
				subject: stampSubject(sessionId, String(params["subject"] ?? "pi: decision"), secret, { device: config.device.name }),
				text: body,
			})
			if (!sent.ok) {
				await client.release(sessionId)
				return { content: [{ type: "text", text: "Could not send the email; ask in the terminal instead." }], details: {} }
			}
			return { content: [{ type: "text", text: "Emailed the decision. End your turn and wait for the reply." }], details: {} }
		},
	})

	pi.registerTool({
		name: "notify_user",
		label: "Notify user",
		description: "Send the user a one-way email update. Does not end the turn and does not wait for a reply.",
		parameters: Type.Object({ subject: Type.String(), message: Type.String() }),
		async execute(_id, params, _signal, _update) {
			if (!client) return { content: [{ type: "text", text: "Mailbridge daemon is not reachable." }], details: {} }
			const mode = await client.mode()
			if (!mode.ok || mode.data.mode !== "on") {
				return { content: [{ type: "text", text: "Email mode is off." }], details: {} }
			}
			const secret = secretFn()
			if (!secret) return { content: [{ type: "text", text: "Mailbridge secret missing." }], details: {} }
			const { stampSubject } = await import("./core/token.ts")
			const sent = await client.send({
				subject: stampSubject(sessionContext()?.sessionId ?? "", String(params["subject"] ?? "pi: update"), secret, {
					device: config.device.name,
				}),
				text: String(params["message"] ?? ""),
			})
			return {
				content: [{ type: "text", text: sent.ok ? "Sent." : "Could not send." }],
				details: {},
			}
		},
	})
}
