// pi-mailbridge daemon — process entry.
//
// Boot order matters:
//   1. load config, surface warnings
//   2. resolve the shared secret (also the HTTP bearer token)
//   3. start the HTTP service (so /health answers while IMAP is still dialling)
//   4. catch-up scan, then the IDLE watcher
//
// Single-instance: the port IS the lock. EADDRINUSE means another daemon already
// owns the mailbox, so this process exits 0 rather than fighting it.
//
// Modes:
//   (none)          run the daemon
//   --check         validate config + secrets + token command, touch no mail
//   --setup         write a config from an address (headless equivalent of /mailbridge setup)
//   --auth          run the OAuth device-code flow
//   --prime         move the UID cursor to the newest message
//   --smoke         send one real mail, then open the folder and count
//   --print-token   print the shared secret (for scripts and tests)

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { loadConfig, hasUsableMailConfig, shortHostname, type ResolvedConfig } from "../core/config.ts"
import { configPath } from "../store/paths.ts"
import { buildSetupConfig, discoverDomain, domainOf } from "../core/discover.ts"
import { ensureSecret } from "../store/secret.ts"
import { readMode, scanningEnabled } from "../store/mode-store.ts"
import { createScanQueue } from "./scan-queue.ts"
import { sendMail } from "../core/mailer.ts"
import { createCommandTokenProvider } from "../core/oauth.ts"
import { createOpenidClient } from "../core/oauth-openid.ts"
import { buildTokenProvider } from "../core/token-source.ts"
import { fileTokenStore } from "../store/oauth-store.ts"
import { scanAndProcess } from "./process.ts"
import { createImapWatcher, type ImapWatcher } from "./watcher.ts"
import { createImapflowFactory } from "./imapflow.ts"
import { createDaemonService, type DaemonService } from "./service.ts"
import type { MailSource } from "./process.ts"
import { runSmoke } from "../core/smoke.ts"
import { runSetup } from "../core/setup.ts"
import { listPending } from "../store/pending-store.ts"
import { advanceCursor } from "../store/uid-cursor.ts"
import { recordOutbound } from "../store/threads.ts"
import { tokenFromSubject } from "../core/token.ts"

const EXIT_CONFIG = 2
const EXIT_AUTH = 3
const EXIT_NETWORK = 4

// ---------------------------------------------------------------------------
// Token supply
// ---------------------------------------------------------------------------

/**
 * Pick the token source for this installation.
 *
 * Precedence: built-in device-code OAuth2 (self-refreshing) -> a configured
 * command -> none (LOGIN auth). Returning `undefined` is not an error: it means
 * the account does not use XOAUTH2.
 */
/**
 * `--auth`: approve the device grant once and persist the refresh token.
 * Prints the URL and code, waits for approval, then exits.
 */
async function login(config: ResolvedConfig): Promise<number> {
	if (!config.oauth?.issuer || !config.oauth.clientId) {
		log("oauth.issuer and oauth.clientId are required for device login — see docs/OAUTH.md")
		return EXIT_CONFIG
	}

	const client = await createOpenidClient(config.oauth)

	// Start the grant and show the human what to do BEFORE waiting on them.
	const authorization = await client.deviceAuthorization()
	process.stdout.write(`\nApprove this login:\n  ${authorization.verificationUri}\n`)
	if (authorization.userCode) process.stdout.write(`Code: ${authorization.userCode}\n`)
	process.stdout.write("\nWaiting for approval…\n")

	try {
		const tokens = await client.pollDeviceAuthorization()
		if (!tokens.refreshToken) {
			log("the provider returned no refresh_token — add offline_access to oauth.scope")
			return EXIT_AUTH
		}
		fileTokenStore().write({
			refreshToken: tokens.refreshToken,
			accessToken: tokens.accessToken,
			expiresAt: tokens.expiresAt,
		})
	} catch (error) {
		log(`login failed: ${(error as Error).message}`)
		return EXIT_AUTH
	}

	log("authorised; refresh token stored")
	return 0
}

/**
 * `--smoke`: prove the real account works, both directions, without pi.
 *
 *   1. resolve a token (LOGIN or OAuth2)
 *   2. send one mail over SMTP
 *   3. open the IMAP folder and count messages
 *
 * Deliberately does NOT touch the cursor, the journal, or any pending record, so a
 * smoke test can never disturb real deliveries.
 */
async function smoke(config: ResolvedConfig): Promise<number> {
	const tokenProvider = await buildTokenProvider(config)
	const result = await runSmoke(config, {
		...(tokenProvider ? { getAccessToken: () => tokenProvider.getToken() } : {}),
	})
	for (const step of result.steps) {
		log(`${step.step} ${step.ok ? "ok" : "FAILED"}: ${step.detail}`)
		if (step.hint) log(`  hint: ${step.hint}`)
	}
	if (!result.ok) return EXIT_AUTH
	log("smoke ok: both directions work")
	return 0
}

/**
 * `--prime`: move the UID cursor to the newest message without reading anything.
 *
 * Without this, the first scan walks the entire existing mailbox: it fetches and
 * parses every message looking for a routing token. Nothing is stored and nothing
 * is marked seen, but on a mailbox that also carries personal mail that is both
 * slow and more exposure than a notification bridge needs. Priming says "watch
 * from now on".
 */
async function prime(config: ResolvedConfig): Promise<number> {
	const tokenProvider = await buildTokenProvider(config)
	const getAccessToken = tokenProvider ? () => tokenProvider.getToken() : undefined
	const client = await createImapflowFactory({ ...(getAccessToken ? { getAccessToken } : {}) })(
		config,
		{ idleRenewMs: config.tuning.idleRenewMs },
	)
	try {
		await client.connect()
		await client.mailboxOpen(config.mail.imap.folder || "INBOX")
		const uids = await client.search({ uid: "1:*" }, { uid: true })
		const highest = uids.length > 0 ? Math.max(...uids) : 0
		advanceCursor(process.env, highest)
		log(`primed: cursor set to uid ${highest} (${uids.length} existing message(s) will not be read)`)
		return 0
	} catch (error) {
		log(`prime failed: ${(error as Error).message}`)
		return EXIT_AUTH
	} finally {
		try {
			await client.logout()
		} catch {
			/* already gone */
		}
	}
}

/** Value of `--flag <value>`, or undefined. */
function argValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag)
	if (index < 0) return undefined
	const next = argv[index + 1]
	return next && !next.startsWith("--") ? next : undefined
}

/**
 * `--setup <pi-address> [--to <your-address>] [--force]` — the headless twin of
 * `/mailbridge setup`. Shares core/setup.ts, so behaviour cannot drift.
 */
async function setup(argv: string[]): Promise<number> {
	const address = argValue(argv, "--setup")
	if (!address) {
		log("usage: --setup <pi-address> [--to <your-address>] [--force]")
		return EXIT_CONFIG
	}
	const to = argValue(argv, "--to")
	const result = await runSetup({ address, ...(to ? { to } : {}), force: argv.includes("--force") })
	for (const step of result.steps) log(step)
	if (result.next) log(`next: ${result.next}`)
	return result.ok ? 0 : EXIT_CONFIG
}

function log(message: string): void {
	console.error(`pi-mailbridge: ${message}`)
}

/**
 * `--check`: report every problem distinctly and exit with a code a supervisor
 * can act on. Never touches mail.
 */
async function check(config: ResolvedConfig): Promise<number> {
	let code = 0
	const problems: string[] = []
	const add = (problem: string) => {
		if (!problems.includes(problem)) problems.push(problem)
	}
	// config.warnings already covers missing host/user/to and an empty allowlist.
	for (const warning of config.warnings) add(warning)

	if (!hasUsableMailConfig(config)) {
		add("mail.imap.host / mail.imap.user / mail.smtp.host / mail.to must all be set")
	}

	if (config.mail.imap.authType === "XOAUTH2" || config.mail.smtp.authType === "XOAUTH2") {
		const hasOAuth = Boolean(config.oauth?.issuer && config.oauth?.clientId)
		const command = config.mail.smtp.tokenCommand ?? config.mail.imap.tokenCommand ?? []
		if (hasOAuth) {
			const stored = fileTokenStore().read()
			if (stored?.refreshToken) {
				log("oauth: refresh token present")
			} else {
				add("oauth is configured but no refresh token yet — run `/mailbridge auth` in pi (or `pi-mailbridge --auth`)")
				code = EXIT_AUTH
			}
		} else if (command.length === 0) {
			add("XOAUTH2 selected but neither oauth.* nor tokenCommand is configured")
			code = EXIT_AUTH
		} else {
			const provider = createCommandTokenProvider({ command })
			try {
				await provider.getToken()
				log(`token command ok (${command[0]})`)
			} catch (error) {
				add((error as Error).message)
				code = EXIT_AUTH
			}
		}
	}

	if (config.security.requireDmarcPass && !config.security.trustedAuthservId) {
		log("note: security.trustedAuthservId unset — trusting the topmost Authentication-Results header")
	}

	try {
		ensureSecret()
		log("shared secret ok")
	} catch (error) {
		add(`secret: ${(error as Error).message}`)
		code = code || EXIT_CONFIG
	}

	for (const problem of problems) log(`  ! ${problem}`)
	if (problems.length === 0) log("config ok")
	return code || (problems.length > 0 ? EXIT_CONFIG : 0)
}

async function run(initialConfig: ResolvedConfig): Promise<void> {
	const token = ensureSecret().toString("base64url")

	// Mutable refs: /reload swaps both without recreating the HTTP service.
	let currentConfig = initialConfig
	let currentWatcher: ImapWatcher | undefined
	let tokenProvider: Awaited<ReturnType<typeof buildTokenProvider>>
	let service: DaemonService

	const getAccessToken = () => (tokenProvider ? tokenProvider.getToken() : Promise.reject(new Error("no token provider")))

	// A stable MailSource the service can hold across reloads.
	const sourceProxy: MailSource = {
		searchAfter: (uid) => {
			if (!currentWatcher) throw new Error("pi-mailbridge: imap watcher not started")
			return currentWatcher.searchAfter(uid)
		},
		fetch: (uid) => {
			if (!currentWatcher) throw new Error("pi-mailbridge: imap watcher not started")
			return currentWatcher.fetch(uid)
		},
		markSeen: async (uid) => {
			await currentWatcher?.markSeen?.(uid)
		},
	}

	let reportedModeOff = false
	// Last scan outcome, surfaced on /health so `/mailbridge status` can answer "why did my
	// reply not arrive?" - the reasons were already computed, just never shown.
	// When the running config was read. The extension compares this with the config file's
	// mtime: a session that attaches to an already-running daemon must not inherit a config
	// the daemon read before the user changed it.
	let configLoadedAt = configStamp()
	let lastScan: { at: number; examined: number; persisted: number; rejected: number; reasons: Record<string, number> } | undefined
	const scanOnce = createScanQueue((why) => scanNow(why))

	/** The config file's mtime as the daemon saw it, or 0 when there is no file. */
	function configStamp(): number {
		try {
			return statSync(configPath(process.env), { throwIfNoEntry: false })?.mtimeMs ?? 0
		} catch {
			return 0
		}
	}

	function formatReasons(reasons: Record<string, number>): string {
		const parts = Object.entries(reasons)
			.filter(([, n]) => n > 0)
			.sort((a, b) => b[1] - a[1])
			.map(([reason, n]) => `${reason}=${n}`)
		return parts.length ? parts.join(" ") : "no reasons"
	}

	async function scanNow(why: string): Promise<void> {
		// `/back` must actually close the channel, not just stop the mail coming back.
		// While mode is off nothing is fetched or persisted and the cursor stays put, so
		// turning /afk back on processes what arrived meanwhile.
		if (!scanningEnabled(readMode(process.env))) {
			if (!reportedModeOff) {
				reportedModeOff = true
				log(`${why}: email mode is off - not scanning`)
			}
			return
		}
		reportedModeOff = false
		const before = new Set(listPending().map((r) => r.uid))
		try {
			const result = await scanAndProcess(currentConfig, { source: sourceProxy, secret: ensureSecret() })
			lastScan = {
				at: Date.now(),
				examined: result.examined,
				persisted: result.persisted,
				rejected: result.rejected,
				reasons: result.reasons,
			}
			if (result.persisted > 0) {
				// Name the reasons even on a partial success: "rejected 1" alone leaves the user
				// unable to tell which reply was dropped and why.
				log(
					`${why}: persisted ${result.persisted} of ${result.examined} (rejected ${result.rejected}: ${formatReasons(result.reasons)})`,
				)
				for (const record of listPending()) {
					if (!before.has(record.uid)) service.broadcast({ type: "delivery", pending: record })
				}
			} else if (result.examined > 0) {
				// Name the reasons: "nothing for us" is what makes a missing reply undebuggable.
				log(`${why}: examined ${result.examined}, nothing for us (${formatReasons(result.reasons)})`)
			}
		} catch (error) {
			// A scan failure must not kill the daemon: the cursor did not advance, so
			// the next IDLE event or catch-up retries the same UIDs.
			log(`${why}: scan failed: ${(error as Error).message}`)
		}
	}

	let reloadInFlight: Promise<{ ok: boolean; error?: string; warning?: string }> | undefined

	async function doReload(): Promise<{ ok: boolean; error?: string; warning?: string }> {
		const previous = currentConfig
		try {
			await currentWatcher?.stop()
			configLoadedAt = configStamp()
			currentConfig = loadConfig()
			tokenProvider = await buildTokenProvider(currentConfig)
			const watcher = await startWatcher(currentConfig)
			// start() does not throw on a refused connect - it arms a reconnect - so ask the
			// watcher whether it is actually connected before calling the reload a success.
			if (!watcher.isHealthy()) {
				// The config was re-read; the connection is what failed, and the watcher is
				// retrying. Report it rather than calling the reload clean.
				log("reloaded config, but IMAP did not connect (check the password/host)")
				return { ok: true, warning: "config reloaded, but IMAP did not connect" }
			}
			log("reloaded config and restarted the watcher")
			return { ok: true }
		} catch (error) {
			// Do not leave the daemon holding a config whose watcher never started.
			currentConfig = previous
			try {
				await startWatcher(previous)
				log(`reload failed (${(error as Error).message}); kept the previous config`)
			} catch {
				log(`reload failed (${(error as Error).message}); previous watcher could not restart either`)
			}
			return { ok: false, error: (error as Error).message }
		}
	}

	async function startWatcher(config: ResolvedConfig): Promise<ImapWatcher> {
		const watcher = createImapWatcher(config, {
			factory: createImapflowFactory({ getAccessToken: tokenProvider ? getAccessToken : undefined }),
			callbacks: {
				onReady: () => {
					log("imap ready; running catch-up scan")
					void scanOnce("catch-up")
				},
				onMail: () => {
					void scanOnce("idle")
				},
				onError: (error, delay) => log(`imap error (${error.message}); reconnecting in ${delay}ms`),
			},
		})
		// Assign BEFORE starting: `start()` fires onReady, and the catch-up scan it
		// triggers reads through sourceProxy. With the assignment after `await`, every
		// catch-up scan failed with "imap watcher not started" and mail that arrived
		// while the daemon was down was only picked up on the next IDLE event.
		currentWatcher = watcher
		await watcher.start()
		return watcher
	}

	tokenProvider = await buildTokenProvider(initialConfig)

	service = createDaemonService({
		// The service must see the CURRENT config: /reload swaps it, and a stale recipient
		// would keep mailing the previous address after a documented re-setup.
		getConfig: () => currentConfig,
		config: initialConfig,
		token,
		source: sourceProxy,
		send: (message) => {
			const provider = tokenProvider
			// The service minted and recorded the Message-ID already (before it called us),
			// so a mail that comes straight back is recognised as ours.
			return sendMail(currentConfig, message, {
				...(provider ? { getAccessToken: () => provider.getToken() } : {}),
				// Lets a revoked grant be refreshed once instead of failing the notification.
				...(provider ? { provider } : {}),
			})
		},
		onSent: ({ messageId, subject, sessionId }) => {
			if (!messageId) return
			// The sender knows the session; parsing it back out of the subject only works
			// for legacy signed tokens, because production subjects carry a short route id.
			// That bug silently disabled both threading and the reply-chain fallback.
			const parsed = sessionId ? { sessionId, device: currentConfig.device.name } : tokenFromSubject(subject, ensureSecret())
			if (!parsed) return
			recordOutbound(process.env, {
				messageId,
				sessionId: parsed.sessionId,
				...(parsed.device ? { device: parsed.device } : {}),
				subject,
			})
		},
		// Lets `/mailbridge restart` replace the process, not just its config, so an
		// updated package actually takes effect.
		shutdown: () => {
			void shutdown("shutdown requested")
		},
		// Stop when the last pi session goes away. `daemon.exitWhenIdle: false` keeps it
		// resident instead, which is what a systemd unit wants.
		exitWhenIdle: () => currentConfig.daemon.exitWhenIdle !== false,
		scanSummary: () => lastScan,
		configLoadedAt: () => configLoadedAt,
		// Re-open the channel: process what arrived while mode was off, and retry anything a
		// full queue refused. Safe to call when nothing changed (an empty scan is cheap).
		onModeChange: (mode) => {
			// Only "on" needs work; "off" simply stops the next scan from doing anything.
			if (mode === "on" && currentWatcher) void scanOnce("mode-on")
		},
		idleTimeoutMs: (currentConfig.daemon.idleTimeoutSecs ?? 120) * 1000,
		// `/mailbridge setup` / `auth` write new config or tokens; pick them up here.
		// One reload at a time: two sessions noticing the same stale config must not each
		// stop and redial the watcher.
		reload: () => (reloadInFlight ??= doReload().finally(() => (reloadInFlight = undefined))),
	})

	service.server.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EADDRINUSE") {
			log(`another daemon already owns port ${currentConfig.daemon.port}; exiting`)
			process.exit(0)
		}
		log(`http server failed: ${error.message}`)
		process.exit(1)
	})

	const { port, host } = await service.listen()
	log(`listening on http://${host}:${port}`)

	// Register shutdown handlers BEFORE dialling IMAP: a SIGTERM during a slow
	// DNS/TLS dial must still shut down cleanly.
	let stopping = false
	const shutdown = async (signal: string) => {
		if (stopping) return
		stopping = true
		log(`${signal}: shutting down`)
		await currentWatcher?.stop()
		await service.close()
		process.exit(0)
	}
	process.on("SIGTERM", () => void shutdown("SIGTERM"))
	process.on("SIGINT", () => void shutdown("SIGINT"))

	await startWatcher(currentConfig)
}

export async function main(): Promise<void> {
	const argv = process.argv.slice(2)
	const config = loadConfig()

	if (argv.includes("--print-token")) {
		process.stdout.write(`${ensureSecret().toString("base64url")}\n`)
		return
	}
	if (argv.includes("--check")) {
		process.exitCode = await check(config)
		return
	}
	if (argv.includes("--setup")) {
		process.exitCode = await setup(argv)
		return
	}
	if (argv.includes("--auth")) {
		process.exitCode = await login(config)
		return
	}
	if (argv.includes("--prime")) {
		process.exitCode = await prime(config)
		return
	}
	if (argv.includes("--smoke")) {
		for (const warning of config.warnings) log(`warning: ${warning}`)
		process.exitCode = await smoke(config)
		return
	}

	if (!hasUsableMailConfig(config)) {
		for (const warning of config.warnings) log(`  ! ${warning}`)
		log("mail config incomplete — run with --check for details")
		process.exit(EXIT_CONFIG)
	}
	for (const warning of config.warnings) log(`warning: ${warning}`)

	await run(config)
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		log(`fatal: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	})
}
