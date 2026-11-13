// Setup: address in, runnable config out.
//
// Shared by `/mailbridge setup` (inside pi) and `--setup` (headless), so the two
// entry points cannot drift. It writes the config file and reports what it did;
// it never starts a process and never prompts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { shortHostname } from "./config.ts"
import { buildSetupConfig, discoverDomain, domainOf, type Discovered } from "./discover.ts"
import { configPath } from "../store/paths.ts"

export interface SetupOptions {
	address: string
	/** Where the human reads mail. Defaults to `address` (single-mailbox mode). */
	to?: string
	/** Overwrite an existing config. */
	force?: boolean
	env?: NodeJS.ProcessEnv
	fetchImpl?: typeof fetch
}

export interface SetupResult {
	ok: boolean
	/** Human-readable progress, in order. */
	steps: string[]
	/** Where the config was written, when it was. */
	path?: string
	discovered?: Discovered
	/** The exact next action, or the reason it failed. */
	next?: string
}

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
	const env = options.env ?? process.env
	const steps: string[] = []
	const address = options.address.trim()
	const to = (options.to ?? address).trim()

	const domain = domainOf(address)
	if (!domain) return { ok: false, steps: [`not an email address: ${address}`] }
	if (!domain.includes(".")) {
		return {
			ok: false,
			steps: [`"${domain}" is not a domain — it has no dot`],
			next: `addresses need a full domain — write something@${domain}.com`,
		}
	}

	// The human's address is where every notification goes and the only sender the allowlist
	// accepts. A typo here is a config that mails nowhere and rejects every reply, so check it
	// rather than writing it.
	if (!domainOf(to)) {
		return { ok: false, steps: [`not an email address: ${to}`], next: "pass `to <your-address>`" }
	}

	const target = configPath(env)
	// A device name is an identity, not a mail setting: `force` must not rename the machine,
	// because records already scanned under the old name would never be offered again.
	const previousDevice = (() => {
		try {
			const parsed = JSON.parse(readFileSync(target, "utf8")) as { device?: { name?: unknown } }
			const name = parsed?.device?.name
			return typeof name === "string" && name.trim() ? name.trim() : undefined
		} catch {
			return undefined
		}
	})()

	if (existsSync(target) && !options.force) {
		return {
			ok: false,
			steps: [`${target} already exists`],
			path: target,
			next: "run `/mailbridge setup … force` to overwrite",
		}
	}

	steps.push(`discovering ${domain}…`)
	const discovered = await discoverDomain(domain, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
	if (!discovered) {
		return {
			ok: false,
			steps: [...steps, `no published mail settings for ${domain}`],
			next: "the domain is not in the autoconfig database; write config.json by hand (config.example.json)",
		}
	}

	steps.push(`imap ${discovered.imap.host}:${discovered.imap.port} (${discovered.imap.secure ? "TLS" : "STARTTLS"})`)
	steps.push(`smtp ${discovered.smtp.host}:${discovered.smtp.port} (${discovered.smtp.secure ? "TLS" : "STARTTLS"})`)
	steps.push(`auth ${discovered.authType}${discovered.provider !== "other" ? ` (${discovered.provider})` : ""}`)

	const built = buildSetupConfig(address, to, discovered)
	const config = {
		...built,
		device: { name: previousDevice ?? shortHostname() },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 10_000, notifyOnAborted: false },
		tuning: { idleRenewMs: 25 * 60 * 1000, backoffInitialMs: 1000, backoffMaxMs: 60_000 },
	}

	mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
	// Written atomically: an automatic reload can read this file at any moment, and a torn
	// write parses as {} (readJson falls back to defaults), which would silently replace the
	// user's config with an empty mailbox.
	const tmp = `${target}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
	renameSync(tmp, target)
	steps.push(`wrote ${target}`)

	if (built.security.allowSelfReplies) {
		steps.push(`one mailbox for both roles — replies from ${to} are accepted only when they are real replies`)
		steps.push(
			"if this mailbox has other addresses that reach it (a QQ number, a foxmail alias), add each " +
				"one to security.allowFrom - the allowlist matches the exact address you reply from",
		)
		steps.push(
			"if the mailbox already has mail you do not want the agent to read, run /mailbridge prime " +
				"before your first /mailbridge on",
		)
		steps.push(
			"DMARC checks are off for this shape: a message from your address to the same address is " +
				"delivered by your own provider and may carry no Authentication-Results header, so requiring " +
				"one rejects every reply. The sender allowlist and the self-echo guards still apply.",
		)
	}

	return {
		ok: true,
		steps,
		path: target,
		discovered,
		next:
			discovered.authType === "XOAUTH2"
				? "put your app client id in the oauth block, then `/mailbridge auth`"
				: "put the account app password (QQ/163 call it 授权码) in the mail block, then `/mailbridge smoke`",
	}
}
