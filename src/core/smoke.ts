// Live connectivity probe, shared by `/mailbridge smoke` and the headless
// `--smoke` entry point so the two can never drift.
//
// Deliberately does NOT touch the cursor, the journal or any pending record: a
// smoke test must never disturb real deliveries.

import type { ResolvedConfig } from "./config.ts"
import { sendMail } from "./mailer.ts"
import { createImapflowFactory } from "../daemon/imapflow.ts"
import { stampedIdFromHeaders } from "./sent-index.ts"

export interface SmokeStep {
	ok: boolean
	/** What was attempted, e.g. "smtp". */
	step: "smtp" | "imap" | "echo"
	/** Human-readable outcome. */
	detail: string
	/** Hint shown when the failure looks like the personal-Outlook problem. */
	hint?: string
}

export interface SmokeResult {
	ok: boolean
	steps: SmokeStep[]
}

export interface SmokeDeps {
	getAccessToken?: () => Promise<string>
	/** Injected for tests. */
	send?: typeof sendMail
	connect?: (config: ResolvedConfig, getAccessToken?: () => Promise<string>) => Promise<{
		count(): Promise<number>
		/** Raw source of the messages seen since `sinceMs`, for the echo probe. */
		recentSources?(sinceMs: number): Promise<Buffer[]>
		close(): Promise<void>
	}>
	/** Retry delays for the echo probe: the provider delivers the copy asynchronously. */
	echoRetryDelaysMs?: readonly number[]
	sleep?: (ms: number) => Promise<void>
}

const defaultConnect: NonNullable<SmokeDeps["connect"]> = async (config, getAccessToken) => {
	const factory = createImapflowFactory({ getAccessToken })
	const client = await factory(config, { idleRenewMs: config.tuning.idleRenewMs })
	await client.connect()
	await client.mailboxOpen(config.mail.imap.folder || "INBOX")
	return {
		count: async () => (await client.search({ uid: "1:*" }, { uid: true })).length,
		recentSources: async (sinceMs: number) => {
			const uids = await client.search({ since: new Date(sinceMs) }, { uid: true })
			const newest = uids.slice().sort((a, b) => b - a).slice(0, 20)
			const sources: Buffer[] = []
			for (const uid of newest) {
				const fetched = (await client.fetchOne(uid, { source: true }, { uid: true })) as
					| { source?: Buffer }
					| false
					| undefined
				if (fetched && fetched.source) sources.push(fetched.source)
			}
			return sources
		},
		close: async () => {
			try {
				await client.logout()
			} catch {
				/* already gone */
			}
		},
	}
}

/** The personal-Outlook failure modes, which mean "use Graph", not "retry". */
export function looksLikeOutlookRefusal(message: string): boolean {
	return /authenticated but not connected|smtpclientauthentication is disabled|535 authentication unsuccessful/i.test(message)
}

export async function runSmoke(config: ResolvedConfig, deps: SmokeDeps = {}): Promise<SmokeResult> {
	const steps: SmokeStep[] = []
	const send = deps.send ?? sendMail
	/** The Message-ID we stamped, so the echo probe can look for it. */
	let lastMessageId: string | undefined

	// --- SMTP ---
	try {
		const stamp = new Date().toISOString()
		const sent = await send(
			config,
			{
				to: config.mail.to,
				subject: `pi-mailbridge smoke test ${stamp}`,
				text: `This is a smoke test from ${config.device.name}.\n\nIf you can read this, SMTP works.\n`,
			},
			{ getAccessToken: deps.getAccessToken },
		)
		lastMessageId = sent.messageId
		steps.push({
			ok: true,
			step: "smtp",
			detail: `sent to ${config.mail.to}${sent.messageId ? ` (${sent.messageId})` : ""}`,
		})
	} catch (error) {
		const detail = (error as Error).message
		steps.push({
			ok: false,
			step: "smtp",
			detail,
			...(looksLikeOutlookRefusal(detail) ? { hint: "the account refuses SMTP AUTH; the Graph transport is the fix — see docs/OAUTH.md" } : {}),
		})
		return { ok: false, steps }
	}

	// --- IMAP ---
	const folder = config.mail.imap.folder || "INBOX"
	let connection:
		| { count(): Promise<number>; recentSources?(sinceMs: number): Promise<Buffer[]>; close(): Promise<void> }
		| undefined
	try {
		connection = await (deps.connect ?? defaultConnect)(config, deps.getAccessToken)
		const count = await connection.count()
		steps.push({ ok: true, step: "imap", detail: `${count} message(s) visible in ${folder}` })

		// --- echo probe ---
		//
		// Only meaningful in the single-mailbox layout: there the notification is delivered into
		// the folder we watch, so we can see what the provider did to our headers. In layout A it
		// goes to the human's mailbox and anything found here is unrelated.
		//
		// The copy arrives asynchronously (QQ: 20-30 s) and is identified by the
		// `X-Pi-Mailbridge-Id` we stamped — reading "the newest message" once produced a false
		// alarm on a live account.
		const sameMailbox =
			Boolean(config.mail.to) &&
			config.mail.to.trim().toLowerCase() === (config.mail.imap.user ?? "").trim().toLowerCase()
		if (sameMailbox && lastMessageId && connection.recentSources) {
			const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
			const delays = deps.echoRetryDelaysMs ?? [2_000, 5_000, 15_000, 30_000]
			const wanted = lastMessageId.replace(/[<>]/g, "")
			const since = Date.now() - 15 * 60_000
			let seen: "none" | "marker" | "id" = "none"
			for (const delay of delays) {
				await sleep(delay)
				for (const source of await connection.recentSources(since)) {
					const head = (source.toString("utf8").split(/\r?\n\r?\n/)[0] ?? "").replace(/\r?\n[ \t]+/g, " ")
					if (stampedIdFromHeaders(head) !== wanted) continue
					seen = /^x-pi-mailbridge:\s*notification/im.test(head) ? "marker" : "id"
					break
				}
				if (seen !== "none") break
			}
			steps.push(
				seen === "none"
					? {
							ok: false,
							step: "echo",
							detail:
								"our notification did not come back to this folder with either header — single-mailbox mode relies on the marker or the Message-ID to recognise its own mail",
						}
					: {
							ok: true,
							step: "echo",
							detail:
								seen === "marker"
									? "our marker header survives delivery"
									: "marker header was stripped, but our Message-ID survived — the guard still holds",
						},
			)
		}

	} catch (error) {
		const detail = (error as Error).message
		steps.push({
			ok: false,
			step: "imap",
			detail,
			...(looksLikeOutlookRefusal(detail) ? { hint: "the account refuses IMAP for this token; the Graph transport is the fix — see docs/OAUTH.md" } : {}),
		})
	} finally {
		await connection?.close()
	}

	return { ok: steps.every((s) => s.ok), steps }
}
