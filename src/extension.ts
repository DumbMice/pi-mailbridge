// pi-mailbridge — pi extension entry.
//
// Everything here runs INSIDE the agent process. The mailbox is not touched: the
// daemon owns IMAP, and this file talks to it over loopback.
//
// Dependencies are injectable so the registration surface (which events, which
// commands, which tools) and the settle behaviour can be asserted with a fake
// `pi`, no daemon and no mailbox.

import { statSync } from "node:fs"
import { Type } from "@sinclair/typebox"

import { loadConfig, hasUsableMailConfig, type ResolvedConfig } from "./core/config.ts"
import { shouldReloadConfig } from "./core/config-freshness.ts"
import { configPath } from "./store/paths.ts"
import { ensureSecret, readSecret } from "./store/secret.ts"
import { formatScan, type ScanSummary } from "./core/status.ts"
import { createSettleNotifier, type SettleContext, type SettleNotifier } from "./core/settle.ts"
import { createDeliveryRunner, type DeliveryRunner } from "./core/deliveries.ts"
import { toUserContent, type UserContent } from "./core/attachments.ts"
import { parseMailCommand } from "./core/mail-command.ts"
import { API_VERSION, apiCompatible } from "./daemon/api.ts"
import { probeHealth } from "./daemon/spawn.ts"
import { resolveDaemonScript } from "./daemon/script.ts"
import { daemonBaseUrl, ensureDaemon, createDaemonClient, type DaemonClient } from "./daemon/spawn.ts"
import { parseMailbridgeCommand, USAGE } from "./core/commands.ts"
import { runSetup } from "./core/setup.ts"
import { runSmoke } from "./core/smoke.ts"
import { buildTokenProvider } from "./core/token-source.ts"
import { createOpenidClient } from "./core/oauth-openid.ts"
import { createDeviceCodeProvider } from "./core/oauth-device.ts"
import { fileTokenStore } from "./store/oauth-store.ts"
import { ensureRouteForSession, registerRoute } from "./store/routes.ts"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const POLL_MS = 10_000
/** How often the poll may try to start a dead daemon. */
const RESPAWN_BACKOFF_MS = 60_000
/** How often to ask a healthy daemon which build it is. */
const VERSION_CHECK_MS = 60_000

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
		/** The real API. `getName` was a mistake here and always returned undefined. */
		getSessionName?(): string | undefined
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
	/** Injected by tests: is something answering on this base URL? */
	probeHealth?: (options: { baseUrl: string }) => Promise<boolean>
	/** How often to re-check the daemon's protocol. Defaults to a minute. */
	versionCheckMs?: number
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
	/** The address the current client was built with; may lag `config` after a port edit. */
	let clientBase: string | undefined
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
	/** Throttle for respawning a daemon that exited for idleness. */
	let lastRespawnAttempt = 0
	/** Throttles the post-update daemon replacement; a failed respawn must not loop. */
	let lastVersionCheck = 0
	/** Set when a respawn still spoke another protocol: only a new pi session can fix that. */
	let protocolStuck = false
	/** Set when the daemon is owned by a supervisor: restarting it is the supervisor's job. */
	let supervisedMismatch = false

	// Computed per use, not once: `config` is replaced whenever a /mailbridge command
	// reloads it, and a frozen URL means editing daemon.port leaves every probe (including
	// /mailbridge restart, the documented remedy) dialling the old port forever.
	const currentBaseUrl = (): string => daemonBaseUrl(config.daemon.port, config.daemon.host)

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
		// `getSessionName()` is the documented method; `getName` never existed.
		const name = ctx.sessionManager.getSessionName?.() ?? ctx.sessionManager.getName?.()
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
				// Heartbeat: the daemon exits when every session stops pinging, so a quiet
				// daemon is a stopping daemon.
				const ping = await client?.ping(instanceId)
				if (ping && !ping.ok) {
					// The daemon exited for idleness (or crashed). Nothing else would bring it
					// back for this session, so the poll becomes the supervisor.
					const now = Date.now()
					if (now - lastRespawnAttempt > RESPAWN_BACKOFF_MS) {
						lastRespawnAttempt = now
						const healthy = await ensureDaemonSafe()
						if (healthy) {
							notifier?.cancel()
							await startRuntime()
						}
					}
					// Fall through to the reschedule below: returning here is what stopped the
					// poll loop permanently after a single failed ping.
				} else {
					// After `pi update` the daemon can still be running the previous build: it
					// mints nothing and resolves nothing, so every reply after the upgrade would
					// be rejected with the cursor already past it. Replace it once the build
					// differs, throttled so a failing respawn cannot loop.
					if (await replaceOutdatedDaemon()) return
					const mode = await client?.mode()
					if (mode?.ok) emailMode = mode.data.mode === "on" ? "on" : "off"
					// `/mailbridge off` closes the channel: no claim, no injection while it is off.
					// Anything already queued stays pending and is delivered on the next
					// `on`, which is why the docs say so explicitly.
					if (emailMode === "on") await runner?.drain()
				}
			} catch {
				/* drain already swallows; a poll must never throw into the runtime */
			} finally {
				// Re-arm whenever this session is alive - not only when a runner exists: a
				// daemon replacement clears the runner for a moment, and tying the loop to it
				// stopped polling exactly when the daemon was missing.
				if (ctx && pollHandle === undefined) {
					pollHandle = timers.setTimeout(() => {
						pollHandle = undefined
						void tick()
					}, pollMs)
				}
			}
		}
		pollHandle = timers.setTimeout(() => {
			pollHandle = undefined
			void tick()
		}, pollMs)
	}

	// ---- lifecycle ---------------------------------------------------------

	/**
	 * Is the running daemon this build? Returns true when it replaced one.
	 *
	 * The extension and the daemon are separate processes with separate lifetimes: `pi update`
	 * reloads this module while the daemon keeps executing what it started with. A version it
	 * cannot resolve routing ids against is worse than no daemon, because replies are consumed.
	 */
	async function replaceOutdatedDaemon(): Promise<boolean> {
		// Once a respawn has proved the mismatch is not ours to fix, stop trying.
		if (protocolStuck || supervisedMismatch) return false
		if (Date.now() - lastVersionCheck < (deps.versionCheckMs ?? VERSION_CHECK_MS)) return false
		lastVersionCheck = Date.now()
		const health = await client?.health()
		if (!health?.ok || apiCompatible(API_VERSION, health.data.apiVersion)) return false

		// A supervised daemon (exitWhenIdle: false, i.e. systemd) must not be shut down from
		// here: it exits 0, `Restart=on-failure` does not bring it back, and the daemon we spawn
		// instead inherits this process's env - where exitWhenIdle is true, so the mailbox stops
		// being watched as soon as pi closes. Ask the supervisor to do it.
		if (health.data.idleExitEnabled === false) {
			supervisedMismatch = true
			ctx?.ui.notify(
				`mailbridge: the daemon is supervised and speaks protocol ${health.data.apiVersion ?? "0"} ` +
					`(this session: ${API_VERSION}) — restart it where it is managed, e.g. ` +
					`systemctl --user restart pi-mailbridge`,
				"warning",
			)
			return true
		}

		ctx?.ui.notify(
			`mailbridge: replacing the running daemon (protocol ${health.data.apiVersion ?? "0"} → ${API_VERSION})`,
			"info",
		)
		await client?.shutdown()
		client = undefined
		runner = undefined
		notifier?.cancel()
		notifier = undefined

		// `/shutdown` answers before it closes the listener, so an immediate probe finds the
		// dying daemon and "reuses" it - the replacement then reports success while the old
		// protocol is still being served. Wait for the port to stop answering.
		const base = clientBase ?? currentBaseUrl()
		const deadline = Date.now() + 5_000
		while (Date.now() < deadline && (await probe({ baseUrl: base }))) {
			await new Promise((resolve) => setTimeout(resolve, 100))
		}

		// A failed respawn must not end the poll loop: with `runner` gone, a re-arm tied to it
		// would stop the only thing that notices the daemon is missing.
		if (!(await ensureDaemonSafe()) || !(await startRuntime())) {
			ctx?.ui.notify(
				"mailbridge: the daemon did not come back after the update — retrying, and /mailbridge restart forces it",
				"warning",
			)
			return true
		}

		// If the respawn brought back another protocol again, this session is older than the
		// package on disk. Replacing forever would kill the bridge once a minute, silently.
		const after = await (client as DaemonClient | undefined)?.health()
		if (after?.ok && !apiCompatible(API_VERSION, after.data.apiVersion)) {
			protocolStuck = true
			ctx?.ui.notify(
				`mailbridge: this pi session speaks protocol ${API_VERSION} and the installed daemon speaks ` +
					`${after.data.apiVersion ?? "0"} — restart pi to load the matching extension`,
				"error",
			)
			return true
		}
		startPolling()
		return true
	}

	const probe = deps.probeHealth ?? probeHealth

	// The pi manifest points at this TypeScript file inside the installed package, so the daemon
	// beside it must be the compiled build wherever one exists (Node refuses type stripping in
	// node_modules). See daemon/script.ts.
	const daemonScript = (): string => resolveDaemonScript(import.meta.url)

	/**
	 * Build the client, notifier and delivery runner. Called on session_start and again
	 * if the poll tick finds the daemon gone, so a session recovers without a reload.
	 */
	async function startRuntime(): Promise<boolean> {
		const current = ctx
		if (!current) return false
		const secret = secretFn()
		if (!secret) return false

		const token = secret.toString("base64url")
		const makeClient = deps.makeClient ?? ((base, tok) => createDaemonClient({ baseUrl: base, token: tok }))
		clientBase = currentBaseUrl()
		client = makeClient(clientBase, token)

		const initialMode = await client.mode()
		// A session_shutdown can land during that await. Without this the runtime is rebuilt
		// around a dead ctx: the poll keeps pinging and the daemon's idle exit can never fire.
		if (!ctx) {
			client = undefined
			return false
		}
		emailMode = initialMode.ok && initialMode.data.mode === "on" ? "on" : "off"

		notifier = createSettleNotifier({
			mode: () => emailMode,
			context: sessionContext,
			send: async (message) => {
				const sent = await client?.send({
					subject: message.subject,
					text: message.text,
					...(ctx ? { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() } : {}),
				})
				// A non-ok result used to be discarded here, so a refused or timed-out send
				// vanished: no toast, no log, no retry. Throwing routes it to onError.
				// `sent === undefined` means there is no client at all; reporting that as a
				// success would make "nothing was sent" indistinguishable from "sent".
				if (!sent) throw new Error("send failed (daemon unavailable)")
				if (!sent.ok) throw new Error(`send failed (${sent.code ?? sent.status})`)
			},
			secret: () => secret,
			config: { ...config.notify, tokenTtlHours: config.security.tokenTtlHours },
			tagFor: (context) =>
				ensureRouteForSession({
					sessionId: context.sessionId,
					...(context.device ? { device: context.device } : {}),
					subject: `pi: ${context.sessionName ?? context.cwd}`,
					ttlHours: config.security.tokenTtlHours,
					env,
				}),
			timers,
			onError: (error) => ctx?.ui.notify(`mailbridge: could not send (${error.message})`, "warning"),
		})

		runner = createDeliveryRunner({
			client: {
				// Pass every argument through. This adapter has silently dropped one before
				// (uidValidity), which disabled the stale-space guard on the only production
				// client while the store's own test stayed green.
				claim: (uid, id, uidValidity) => client!.claim(uid, id, uidValidity),
				ack: (uid, id, sessionId, uidValidity) => client!.ack(uid, id, sessionId, uidValidity),
				pending: () => client!.pending(),
			},
			instanceId,
			sessionId: () => ctx?.sessionManager.getSessionId(),
			stillDelivering: () => emailMode === "on",
			inject: async (body, record) => {
				// A command by mail runs the same handler the prompt would, and then there is
				// nothing to inject: the human asked for an action, not for the agent to read a
				// sentence. Anything we do not run here stays a message, so a quoted "/mailbridge off" or a
				// refused "/mailbridge setup" is never executed by accident.
				const command = parseMailCommand(body)
				if (command) {
					const handler = commandHandlers.get(command.name)
					if (handler && !ctx) {
						// The session is tearing down. Throwing keeps the record pending so the
						// command runs in a live session; falling through would inject the
						// command text into a dead session and then ack it, consuming the mail.
						throw new Error("no active session for a command reply")
					}
					if (handler && ctx) {
						// A command that throws must NOT propagate: deliveries treats an inject
						// failure as "retry later" and never acks, so the same command would run
						// again every poll tick - and `/mailbridge smoke` would send a real mail
						// each time. The command was handled either way; say it failed and let
						// the delivery be acked.
						try {
							await handler(command.args, ctx)
						} catch (error) {
							ctx.ui.notify(
								`mailbridge: /${command.name} from mail failed: ${(error as Error).message}`,
								"error",
							)
						}
						return
					}
				}

				const content = toUserContent(body, record.attachments ?? [])
				// A reply is text from a human, never a command. With template expansion on, pi
				// dispatches a message starting with "/" as an extension command and never gives
				// it to the model - so a reply of "/mailbridge off" would run a command, return without a
				// turn, and the runner would ack and \Seen it. The human would believe the agent
				// had read it.
				pi.sendUserMessage(content, { deliverAs: "followUp", expandPromptTemplates: false })
			},
			onError: (error) => ctx?.ui.notify(`mailbridge: reply not delivered (${error.message})`, "warning"),
		})

		// Catch-up on connect, but only when the channel is actually open: `off` must not
		// be bypassed by a session starting up.
		if (emailMode === "on") await runner.drain()
		// Same reason as above, after the drain's awaits.
		if (!ctx) {
			client = undefined
			return false
		}
		return true
	}

	/**
	 * Tell a pre-existing daemon to re-read its config when the file is newer than the
	 * config it loaded. Best-effort: a failure here must not block the session.
	 */
	async function reloadIfStale(): Promise<void> {
		if (!client) return
		try {
			const health = await client.health()
			if (!health.ok) return
			const loadedAt = health.data.configLoadedAt
			const mtime = statSync(configPath(env), { throwIfNoEntry: false })?.mtimeMs ?? null
			if (!shouldReloadConfig({ configLoadedAt: loadedAt, configMtimeMs: mtime })) return
			const reloaded = await client.reload()
			// Never silent: this is the path that decides which address the agent's mail goes
			// to, so a refused reload (daemon kept the old config) must be visible.
			if (!reloaded.ok) {
				ctx?.ui.notify(
					"mailbridge: the daemon could not reload its config — run /mailbridge restart",
					"warning",
				)
			} else if (reloaded.data.warning) {
				ctx?.ui.notify(`mailbridge: ${reloaded.data.warning}`, "warning")
			}
		} catch {
			/* best effort: a stale config is not a reason to fail the session */
		}
	}

	async function ensureDaemonSafe(): Promise<boolean> {
		return (await ensureDaemonDetailed()).healthy
	}

	/**
	 * Spawn-or-reuse, keeping the reason. `incompatible` means something answered but spoke
	 * another protocol - the replacement path, not the dead-daemon path.
	 */
	async function ensureDaemonDetailed(): Promise<{ healthy: boolean; incompatible?: boolean }> {
		if (deps.ensureDaemon) return { healthy: await deps.ensureDaemon(currentBaseUrl(), daemonScript()) }
		return ensureDaemon({ baseUrl: currentBaseUrl(), scriptPath: daemonScript(), env })
	}

	pi.on("session_start", async (_event, c) => {
		ctx = c

		// Spawning a daemon that is guaranteed to exit (no mailbox configured) would just
		// cost five seconds on every session start, so check the mailbox first.
		if (!hasUsableMailConfig(config)) {
			c.ui.notify(
				"mailbridge: no mailbox configured — run /mailbridge setup <pi-address> to <your-address>",
				"warning",
			)
			return
		}

		// The daemon owns secret.key, but waiting for a daemon that only this code can start
		// is a deadlock: on a machine that has never run it, the key does not exist yet and
		// every session would bail out here. Mint it instead (first-writer-wins, 0600).
		if (!secretFn()) {
			try {
				ensureSecret(env)
			} catch (error) {
				c.ui.notify(`mailbridge: could not create the shared secret (${(error as Error).message})`, "error")
				return
			}
		}

		protocolStuck = false
		supervisedMismatch = false
		const ensured = await ensureDaemonDetailed()
		if (!ensured.healthy) {
			c.ui.notify(
				ensured.incompatible
					? "mailbridge: the running daemon speaks another protocol — restarting it"
					: "mailbridge: daemon not reachable; replies will not arrive",
				"warning",
			)
			// An incompatible daemon is the version-replacement path, not a dead one.
			if (!ensured.incompatible || !(await replaceOutdatedDaemon())) return
		}

		if (!(await startRuntime())) return
		startPolling()

		// A daemon that was already running may have read the config before the user edited
		// it (hand-edited config.json, headless --setup). Re-read it rather than mailing the
		// address they just replaced - but do NOT block the session on an IMAP redial, which
		// can take imapflow's full connect timeout when the new config is wrong.
		void reloadIfStale()
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
		// No client means this session never built a runtime (it started before a config
		// existed). Writing mode.json alone would report ON with no notifier and no runner - the
		// documented "copy config.example.json yourself" path lands here.
		if (!client && (await startRuntime())) startPolling()
		const viaDaemon = client ? await client.setMode(mode) : undefined
		if (viaDaemon?.ok) {
			emailMode = mode
			c.ui.notify(mode === "on" ? "mailbridge: email mode ON" : "mailbridge: email mode OFF", "info")
			return
		}
		// No daemon: fall back to the local file so the mode change is never a silent no-op.
		const { writeMode } = await import("./store/mode-store.ts")
		writeMode(env, mode)
		// The settle notifier reads this mirror, not the file. Without it the command reports
		// ON while every notification is dropped as "mode off".
		emailMode = mode
		c.ui.notify(`mailbridge: email mode ${mode.toUpperCase()} (daemon unreachable, stored locally)`, "warning")
	}

	// The same handlers back both the in-pi command and a command arriving as a mail reply, so
	// the mode subcommands cannot drift between mail and prompt.
	const commandHandlers = new Map<string, (args: string, c: ExtensionCtxLike) => Promise<void>>()
	const registerCommand = (
		name: string,
		description: string,
		handler: (args: string, c: ExtensionCtxLike) => Promise<void>,
	): void => {
		commandHandlers.set(name, handler)
		pi.registerCommand(name, { description, handler })
	}

	registerCommand("mailbridge",
		"Status, on/off, setup, check, auth, smoke, restart",
		async (args, c) => {
			// Re-read config on every command. It can change underneath us: `--setup`
			// run from a shell, or an edit to config.json, would otherwise leave the
			// command surface reporting stale settings until pi restarts.
			config = load()
			const parsed = parseMailbridgeCommand(args)

			/**
			 * Build client/notifier/runner and start polling if this session has no runtime.
			 *
			 * `session_start` returns early when there is no usable config - which is exactly
			 * the state on a fresh install. Every command that can make the config usable
			 * (`setup`, `restart`) must therefore be able to wire the runtime afterwards, or
			 * the documented first run ends in a session that reports "on" and never mails.
			 */
			type UiLevel = "error" | "info" | "warning"
			const ensureRuntime = async (ui: { notify: (m: string, level?: UiLevel) => void }): Promise<boolean> => {
				if (client) return true
				if (!secretFn()) {
					try {
						ensureSecret(env)
					} catch (error) {
						ui.notify(`mailbridge: could not create the shared secret (${(error as Error).message})`, "error")
						return false
					}
				}
				if (!(await ensureDaemonSafe())) {
					ui.notify("mailbridge: daemon not reachable; replies will not arrive", "warning")
					return false
				}
				if (!(await startRuntime())) return false
				startPolling()
				return true
			}

			const statusReport = async () => {
				const secret = secretFn()
				const health = client ? await client.health() : undefined
				const pending = client ? await client.pending() : undefined
				// The daemon is a separate process with its own lifetime; after `pi update` it can
				// be an older build, so name it here rather than making the user read /health.
				const daemonVersion = health?.ok ? (health.data.version ?? "unknown") : "unknown"
				// The protocol is what matters; the package version is diagnostic.
				const build = health?.ok
					? apiCompatible(API_VERSION, health.data.apiVersion)
						? ` — daemon version ${daemonVersion}, protocol ${health.data.apiVersion}`
						: ` — daemon protocol ${health.data.apiVersion ?? "0"}, this session is ${API_VERSION} (replacing it)`
					: ""
				c.ui.notify(
					[
						`daemon: ${health?.ok ? "healthy" : "unreachable"} (${clientBase ?? currentBaseUrl()})${build}`,
						`device: ${config.device.name}`,
						`mode: ${health?.ok ? health.data.mode : "(unknown)"}`,
						`imap: ${health?.ok ? (health.data as { imap?: string }).imap ?? "unknown" : "(unknown)"}`,
						`session: ${ctx?.sessionManager.getSessionId() ?? "(none)"}`,
						`secret: ${secret ? "present" : "missing"}`,
						`mailbox: ${config.mail.to || "(unset)"}`,
						`allowlist: ${config.security.allowFrom.join(", ") || "(empty — denies all)"}`,
						`pending replies: ${pending?.ok ? pending.data.pending.length : "?"}`,
						...formatScan(health?.ok ? (health.data.lastScan ?? null) : null),
					].join("\n"),
					"info",
				)
			}

			switch (parsed.sub) {
				case "on":
					return void (await setMode("on", c))

				case "off":
					return void (await setMode("off", c))

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
					// A session that started before the config existed has no runtime yet.
					if (result.ok && !client) {
						const started = await ensureRuntime(c.ui)
						c.ui.notify(
							started
								? "daemon started — /mailbridge smoke, then /mailbridge on"
								: "config written, but the daemon did not start — /mailbridge restart",
							started ? "info" : "warning",
						)
					}
					return
				}

				case "check": {
					// Mint rather than advise: "start the daemon once" is unfollowable in the only
					// state where this is missing.
					let secret = secretFn()
					let mintedSecret = false
					if (!secret) {
						try {
							secret = ensureSecret(env)
							mintedSecret = Boolean(secret)
						} catch {
							/* reported below */
						}
					}
					const problems = [...config.warnings]
					if (config.security.allowSelfReplies && config.security.requireDmarcPass) {
						problems.push(
							"allowSelfReplies is on but requireDmarcPass is too: providers that do not stamp " +
								"Authentication-Results on self-addressed mail will reject every reply (dmarc-missing)",
						)
					}
					if (!secret) problems.push("shared secret missing and could not be created")
					// A running daemon caches the bearer token from startup, so a freshly minted key
					// is rejected until it restarts. Say so; "config ok" would be a lie.
					else if (mintedSecret) problems.push("created a new shared secret — restart the daemon so it uses it")
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
						// Reload first: smoke is the documented "does it work?" step after editing
						// the password, and the daemon holds the config it started with. Without
						// this, smoke passes (it reads the file) while /send keeps using the old
						// empty password and the first notification fails.
						const reloaded = client ? await client.reload() : undefined
						if (client && reloaded?.ok !== true) {
							c.ui.notify("daemon did not reload; run /mailbridge restart", "warning")
						} else if (reloaded?.ok && reloaded.data.warning) {
							c.ui.notify(`mailbridge: ${reloaded.data.warning}`, "warning")
						}
						config = load()
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
					// First run only: the cursor is what makes mail visible, so moving it after
					// the bridge has been watching would skip replies that arrived unscanned.
					let imap: { logout: () => Promise<void> } | undefined
					try {
						const provider = await buildTokenProvider(config, env)
						const { createImapflowFactory } = await import("./daemon/imapflow.ts")
						const { advanceCursor, isPrimed, markPrimed, readCursor } = await import("./store/uid-cursor.ts")
						const { alreadyPrimedMessage, runPrime } = await import("./core/prime.ts")
						const imapClient = await createImapflowFactory({
							...(provider ? { getAccessToken: () => provider.getToken() } : {}),
						})(config, { idleRenewMs: config.tuning.idleRenewMs })
						imap = imapClient
						const plan = await runPrime(config, {
							openMailbox: async (cfg) => {
								await imapClient.connect()
								await imapClient.mailboxOpen(cfg.mail.imap.folder || "INBOX")
								return {
									search: () => imapClient.search({ uid: "1:*" }, { uid: true }),
									close: async () => imapClient.logout(),
								}
							},
							readCursor: () => readCursor(env),
							isPrimed: () => isPrimed(env),
							markPrimed: () => markPrimed(env),
							advanceCursor: (uid) => {
								advanceCursor(env, uid)
							},
						})
						if (!plan.ok) {
							c.ui.notify(alreadyPrimedMessage(plan.currentUid), "warning")
							return
						}
						const reloaded = client ? await client.reload() : undefined
						c.ui.notify(
							`primed: cursor at uid ${plan.highest}; ${plan.count} existing message(s) will not be read${reloaded?.ok ? ", daemon reloaded" : ""}`,
							"info",
						)
					} catch (error) {
						c.ui.notify(`prime failed: ${(error as Error).message}`, "error")
					} finally {
						// A connect that succeeded before mailboxOpen threw would otherwise leak the
						// connection. logout is idempotent; the CLI does the same.
						await imap?.logout().catch(() => undefined)
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
					const healthy = await ensure(currentBaseUrl(), daemonScript())
					if (healthy && !client) {
						// This session never had a runtime (started before the config existed).
						await ensureRuntime(c.ui)
					}
					c.ui.notify(
						healthy ? "daemon restarted with the current code" : "daemon did not come back — run /mailbridge restart again",
						healthy ? "info" : "error",
					)
					return
				}
			}
		},
	)

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

			// The slot is reserved above. Everything from here must either send the mail or free
			// the reservation: a leaked slot answers "already outstanding" for the rest of the
			// session, because re-registering refreshes its TTL.
			let sent = false
			try {
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

				const tag = ensureRouteForSession({
					sessionId,
					device: config.device.name,
					subject: String(params["subject"] ?? "pi: decision"),
					ttlHours: config.security.tokenTtlHours,
					env,
				})
				const outcome = await client.send({
					subject: `[pi:${tag}] ${String(params["subject"] ?? "pi: decision")}`,
					text: body,
					cwd: c.cwd,
					sessionId,
				})
				if (!outcome.ok) {
					return { content: [{ type: "text", text: "Could not send the email; ask in the terminal instead." }], details: {} }
				}
				sent = true
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not email the decision (${(error as Error).message}); ask in the terminal.` }],
					details: {},
				}
			} finally {
				// Free only a reservation that never produced a mail.
				if (!sent) await client.release(sessionId).catch(() => undefined)
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
			// No session means no session to route back to: minting a route for "" would be
			// dead state that the scanner treats as no-route anyway.
			const context = sessionContext()
			if (!context?.sessionId) {
				return { content: [{ type: "text", text: "No active session to attach this notification to." }], details: {} }
			}
			const tag = ensureRouteForSession({
				sessionId: context.sessionId,
				device: config.device.name,
				subject: String(params["subject"] ?? "pi: update"),
				ttlHours: config.security.tokenTtlHours,
				env,
			})
			const sent = await client.send({
				subject: `[pi:${tag}] ${String(params["subject"] ?? "pi: update")}`,
				text: String(params["message"] ?? ""),
				...((sessionContext()?.cwd ?? undefined) ? { cwd: sessionContext()!.cwd } : {}),
				...(sessionContext()?.sessionId ? { sessionId: sessionContext()!.sessionId } : {}),
			})
			return {
				content: [{ type: "text", text: sent.ok ? "Sent." : "Could not send." }],
				details: {},
			}
		},
	})
}
