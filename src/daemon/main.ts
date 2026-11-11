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
//   --print-token   print the shared secret (for scripts and tests)

import { loadConfig, hasUsableMailConfig, type ResolvedConfig } from "../core/config.ts"
import { ensureSecret } from "../store/secret.ts"
import { sendMail } from "../core/mailer.ts"
import { createCommandTokenProvider } from "../core/oauth.ts"
import { scanAndProcess } from "./process.ts"
import { createImapWatcher, type ImapWatcher } from "./watcher.ts"
import { createImapflowFactory } from "./imapflow.ts"
import { createDaemonService, type DaemonService } from "./service.ts"
import { listPending } from "../store/pending-store.ts"

const EXIT_CONFIG = 2
const EXIT_AUTH = 3

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
		const command = config.mail.smtp.tokenCommand ?? config.mail.imap.tokenCommand ?? []
		if (command.length === 0) {
			add("XOAUTH2 selected but no tokenCommand configured")
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

async function run(config: ResolvedConfig): Promise<void> {
	const token = ensureSecret().toString("base64url")

	// One token provider per process, shared by IMAP and SMTP XOAUTH2.
	const tokenCommand = config.mail.smtp.tokenCommand ?? config.mail.imap.tokenCommand ?? []
	const tokenProvider = tokenCommand.length > 0 ? createCommandTokenProvider({ command: tokenCommand }) : undefined

	const watcher: ImapWatcher = createImapWatcher(config, {
		factory: createImapflowFactory({ getAccessToken: tokenProvider ? () => tokenProvider.getToken() : undefined }),
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

	const service: DaemonService = createDaemonService({
		config,
		token,
		source: watcher,
		send: (message) =>
			sendMail(config, message, { getAccessToken: tokenProvider ? () => tokenProvider.getToken() : undefined }),
	})

	async function scanOnce(why: string): Promise<void> {
		const before = new Set(listPending().map((r) => r.uid))
		try {
			const result = await scanAndProcess(config, { source: watcher, secret: ensureSecret() })
			if (result.persisted > 0) {
				log(`${why}: persisted ${result.persisted} of ${result.examined} (rejected ${result.rejected})`)
				for (const record of listPending()) {
					if (!before.has(record.uid)) service.broadcast({ type: "delivery", pending: record })
				}
			} else if (result.examined > 0) {
				log(`${why}: examined ${result.examined}, nothing for us`)
			}
		} catch (error) {
			// A scan failure must not kill the daemon: the cursor did not advance,
			// so the next IDLE event or catch-up retries the same UIDs.
			log(`${why}: scan failed: ${(error as Error).message}`)
		}
	}

	service.server.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EADDRINUSE") {
			log(`another daemon already owns port ${config.daemon.port}; exiting`)
			process.exit(0)
		}
		log(`http server failed: ${error.message}`)
		process.exit(1)
	})

	const { port, host } = await service.listen()
	log(`listening on http://${host}:${port}`)

	await watcher.start()

	let stopping = false
	const shutdown = async (signal: string) => {
		if (stopping) return
		stopping = true
		log(`${signal}: shutting down`)
		await watcher.stop()
		await service.close()
		process.exit(0)
	}
	process.on("SIGTERM", () => void shutdown("SIGTERM"))
	process.on("SIGINT", () => void shutdown("SIGINT"))
}

async function main(): Promise<void> {
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
