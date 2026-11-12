// pi-mailbridge — pi extension entry.
//
// Everything here runs INSIDE the agent process. The mailbox is not touched: the
// daemon owns IMAP, and this file talks to it over loopback.
//
// Dependencies are injectable so the registration surface (which events, which
// commands, which tools) and the settle behaviour can be asserted with a fake
// `pi`, no daemon and no mailbox.

import { Type } from "@sinclair/typebox"

import { loadConfig, hasUsableMailConfig, type ResolvedConfig } from "./core/config.ts"
import { readSecret } from "./store/secret.ts"
import { createSettleNotifier, type SettleContext, type SettleNotifier } from "./core/settle.ts"
import { createDeliveryRunner, type DeliveryRunner } from "./core/deliveries.ts"
import { toUserContent, type UserContent } from "./core/attachments.ts"
import { daemonBaseUrl, ensureDaemon, createDaemonClient, type DaemonClient } from "./daemon/spawn.ts"
import { parseMailbridgeCommand, USAGE } from "./core/commands.ts"
import { runSetup } from "./core/setup.ts"
import { runSmoke } from "./core/smoke.ts"
import { buildTokenProvider } from "./core/token-source.ts"
import { createOpenidClient } from "./core/oauth-openid.ts"
import { createDeviceCodeProvider } from "./core/oauth-device.ts"
import { fileTokenStore } from "./store/oauth-store.ts"
import { registerRoute } from "./store/routes.ts"
import { fileURLToPath } from "node:url"

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
	sessionManager: {
		getSessionId(): string
		getName?(): string | undefined
		/** Current branch entries; assistant text and turn count come from here. */
		getBranch?(): unknown[]
	}
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
	const load = deps.loadConfig ?? (() => loadConfig(env))
	let config: ResolvedConfig = load()
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
	/** Stable id for this pi process, used for claims and for liveness pings. */
	const instanceId = `pi-${process.pid}`

	const baseUrl = daemonBaseUrl(config.daemon.port, config.daemon.host)

	/**
	 * Last assistant text and turn count from the session branch.
	 *
	 * Without this the notification body is just a placeholder — and the point of the
	 * email is to read the answer from whatever device you happen to be on. Branch
	 * entries are `{ type: "message", message: { role, content } }`; assistant
	 * content is `(TextContent | ThinkingContent | ToolCall)[]`, so only `text`
	 * parts are joined (thinking and tool calls are not the answer).
	 */
	function readSessionSnapshot(manager: ExtensionCtxLike["sessionManager"]): {
		lastAssistantText?: string
		turns?: number
	} {
		const branch = manager.getBranch?.() ?? []
		let lastAssistantText: string | undefined
		let turns = 0

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } } | undefined
			if (entry?.type !== "message" || entry.message?.role !== "assistant") continue
			turns++
			if (lastAssistantText) continue

			const content = entry.message.content
			if (typeof content === "string" && content.trim()) {
				lastAssistantText = content.trim()
				continue
			}
			if (!Array.isArray(content)) continue
			const text = content
				.filter((part): part is { type: "text"; text: string } => {
					const p = part as { type?: unknown; text?: unknown }
					return p?.type === "text" && typeof p.text === "string"
				})
				.map((part) => part.text)
				.join("\n")
				.trim()
			if (text) lastAssistantText = text
		}

		return { ...(lastAssistantText ? { lastAssistantText } : {}), ...(turns > 0 ? { turns } : {}) }
	}

	function sessionContext(): SettleContext | undefined {
		if (!ctx) return undefined
		const sessionId = ctx.sessionManager.getSessionId()
		const name = ctx.sessionManager.getName?.()
		return {
			sessionId,
			...(name ? { sessionName: name } : {}),
			device: config.device.name,
			cwd: ctx.cwd,
			...readSessionSnapshot(ctx.sessionManager),
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
				// Heartbeat first: the daemon exits when every session stops pinging, so a
				// quiet daemon is a stopping daemon.
				await client?.ping(instanceId)
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

		// The daemon has to exist before a client can talk to it. Spawning one that is
		// guaranteed to exit (no mailbox configured) would just cost five seconds on
		// every session start, so check first and say what to do instead.
		if (!hasUsableMailConfig(config)) {
			c.ui.notify(
				"mailbridge: no mailbox configured — run /mailbridge setup <pi-address> to <your-address>",
				"warning",
			)
			return
		}

		const ensure =
			deps.ensureDaemon ??
			((base: string, script: string) =>
				ensureDaemon({ baseUrl: base, scriptPath: script, env }).then((result) => result.healthy))
		const healthy = await ensure(baseUrl, fileURLToPath(new URL("./daemon/main.ts", import.meta.url)))
		if (!healthy) {
			c.ui.notify("mailbridge: daemon not reachable; replies will not arrive", "warning")
			return
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
			tagFor: (context) =>
				registerRoute({
					sessionId: context.sessionId,
					...(context.device ? { device: context.device } : {}),
					subject: `pi: ${context.sessionName ?? context.cwd}`,
					env,
				}),
			timers,
			onError: (error) => ctx?.ui.notify(`mailbridge: could not send (${error.message})`, "warning"),
		})

		runner = createDeliveryRunner({
			client: {
				claim: (uid, instanceId) => client!.claim(uid, instanceId),
				ack: (uid, instanceId, sessionId) => client!.ack(uid, instanceId, sessionId),
				pending: () => client!.pending(),
			},
			instanceId,
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
		// Release our liveness slot so an idle daemon can exit promptly rather than
		// waiting out the grace period.
		void client?.bye(instanceId)
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
		description: "Status, setup, check, auth, smoke, restart",
		handler: async (args, c) => {
			// Re-read config on every command. It can change underneath us: `--setup`
			// run from a shell, or an edit to config.json, would otherwise leave the
			// command surface reporting stale settings until pi restarts.
			config = load()
			const parsed = parseMailbridgeCommand(args)

			const statusReport = async () => {
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
			}

			switch (parsed.sub) {
				case "help":
					return void c.ui.notify(USAGE, "info")

				case "status":
					return void (await statusReport())

				case "setup": {
					if (!parsed.address) return void c.ui.notify(`setup needs an address\n\n${USAGE}`, "warning")
					const result = await runSetup({
						address: parsed.address,
						...(parsed.to ? { to: parsed.to } : {}),
						force: parsed.force,
						env,
					})
					config = load() // pick up what was just written
					const reloaded = client ? await client.reload() : undefined
					c.ui.notify(
						[
							...result.steps,
							result.next ? `next: ${result.next}` : "",
							client ? (reloaded?.ok ? "daemon reloaded" : "daemon did not reload — run /mailbridge restart") : "",
						]
							.filter(Boolean)
							.join("\n"),
						result.ok ? "info" : "error",
					)
					return
				}

				case "check": {
					const secret = secretFn()
					const problems = [...config.warnings]
					if (!secret) problems.push("shared secret missing — start the daemon once")
					const usesOAuth = config.mail.imap.authType === "XOAUTH2" || config.mail.smtp.authType === "XOAUTH2"
					if (config.oauth && !usesOAuth) {
						problems.push("oauth is configured but neither account uses XOAUTH2 — it would be ignored")
					}
					if (usesOAuth) {
						const oauthConfigured = Boolean(config.oauth?.issuer && config.oauth.clientId)
						const hasToken = Boolean(fileTokenStore(env).read()?.refreshToken)
						const hasCommand = Boolean((config.mail.smtp.tokenCommand ?? config.mail.imap.tokenCommand ?? []).length)
						if (oauthConfigured && !hasToken) problems.push("oauth configured but not authorised — /mailbridge auth")
						if (!oauthConfigured && !hasCommand) problems.push("XOAUTH2 needs oauth.* or a tokenCommand")
					}
					c.ui.notify(
						problems.length ? problems.map((p) => `! ${p}`).join("\n") : "config ok — run /mailbridge smoke to prove it",
						problems.length ? "warning" : "info",
					)
					return
				}

				case "auth": {
					if (!config.oauth?.issuer || !config.oauth.clientId) {
						return void c.ui.notify("oauth.issuer and oauth.clientId are required — run /mailbridge setup first", "error")
					}
					if (config.oauth.clientId.startsWith("<")) {
						return void c.ui.notify("oauth.clientId is still the placeholder — register an app (docs/OAUTH.md)", "error")
					}
					try {
						const oauthClient = await createOpenidClient(config.oauth)
						const authorization = await oauthClient.deviceAuthorization()
						c.ui.notify(
							[
								"Approve this login on any device, then wait here:",
								authorization.verificationUri,
								authorization.userCode ? `code: ${authorization.userCode}` : "",
							]
								.filter(Boolean)
								.join("\n"),
							"info",
						)
						// Poll in the background so the TUI stays usable.
						void oauthClient
							.pollDeviceAuthorization()
							.then(async (tokens) => {
								if (!tokens.refreshToken) {
									c.ui.notify("no refresh_token returned — add offline_access to oauth.scope", "error")
									return
								}
								fileTokenStore(env).write({
									refreshToken: tokens.refreshToken,
									accessToken: tokens.accessToken,
									expiresAt: tokens.expiresAt,
								})
								const reloaded = client ? await client.reload() : undefined
								c.ui.notify(
									`authorised; refresh token stored${reloaded?.ok ? ", daemon reloaded" : ""}`,
									"info",
								)
							})
							.catch((error: Error) => c.ui.notify(`login failed: ${error.message}`, "error"))
					} catch (error) {
						c.ui.notify(`login failed: ${(error as Error).message}`, "error")
					}
					return
				}

				case "smoke": {
					try {
						const provider = await buildTokenProvider(config, env)
						const result = await runSmoke(config, {
							...(provider ? { getAccessToken: () => provider.getToken() } : {}),
						})
						c.ui.notify(
							[
								...result.steps.map((s) => `${s.step} ${s.ok ? "ok" : "FAILED"}: ${s.detail}`),
								...result.steps.filter((s) => s.hint).map((s) => `hint: ${s.hint}`),
							].join("\n"),
							result.ok ? "info" : "error",
						)
					} catch (error) {
						c.ui.notify(`smoke failed: ${(error as Error).message}`, "error")
					}
					return
				}

				case "prime": {
					// Skip the mailbox's existing mail: set the cursor to the newest uid.
					try {
						const provider = await buildTokenProvider(config, env)
						const { createImapflowFactory } = await import("./daemon/imapflow.ts")
						const { advanceCursor } = await import("./store/uid-cursor.ts")
						const imap = await createImapflowFactory({
							...(provider ? { getAccessToken: () => provider.getToken() } : {}),
						})(config, { idleRenewMs: config.tuning.idleRenewMs })
						await imap.connect()
						await imap.mailboxOpen(config.mail.imap.folder || "INBOX")
						const uids = await imap.search({ uid: "1:*" }, { uid: true })
						const highest = uids.length ? Math.max(...uids) : 0
						advanceCursor(env, highest)
						await imap.logout().catch(() => {})
						const reloaded = client ? await client.reload() : undefined
						c.ui.notify(
							`primed: cursor at uid ${highest}; ${uids.length} existing message(s) will not be read${reloaded?.ok ? ", daemon reloaded" : ""}`,
							"info",
						)
					} catch (error) {
						c.ui.notify(`prime failed: ${(error as Error).message}`, "error")
					}
					return
				}

				case "restart": {
					// A config reload cannot replace running code, so after an update the
					// daemon would keep executing the old version. Stop the process and let
					// the supervisor start a fresh one.
					const ensure = deps.ensureDaemon ?? ((base: string, script: string) => ensureDaemon({ baseUrl: base, scriptPath: script, env }).then((r) => r.healthy))
					if (client) {
						await client.shutdown()
						// Give the process a moment to release the port before respawning.
						await new Promise((resolve) => setTimeout(resolve, 400))
					}
					const healthy = await ensure(baseUrl, fileURLToPath(new URL("./daemon/main.ts", import.meta.url)))
					c.ui.notify(
						healthy ? "daemon restarted with the current code" : "daemon did not come back — run /mailbridge restart again",
						healthy ? "info" : "error",
					)
					return
				}
			}
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

			const tag = registerRoute({
				sessionId,
				device: config.device.name,
				subject: String(params["subject"] ?? "pi: decision"),
				env,
			})
			const sent = await client.send({
				subject: `[pi:${tag}] ${String(params["subject"] ?? "pi: decision")}`,
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
			const tag = registerRoute({
				sessionId: sessionContext()?.sessionId ?? "",
				device: config.device.name,
				subject: String(params["subject"] ?? "pi: update"),
				env,
			})
			const sent = await client.send({
				subject: `[pi:${tag}] ${String(params["subject"] ?? "pi: update")}`,
				text: String(params["message"] ?? ""),
			})
			return {
				content: [{ type: "text", text: sent.ok ? "Sent." : "Could not send." }],
				details: {},
			}
		},
	})
}
