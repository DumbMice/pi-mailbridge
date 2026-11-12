// Live connectivity probe, shared by `/mailbridge smoke` and the headless
// `--smoke` entry point so the two can never drift.
//
// Deliberately does NOT touch the cursor, the journal or any pending record: a
// smoke test must never disturb real deliveries.

import type { ResolvedConfig } from "./config.ts"
import { sendMail } from "./mailer.ts"
import { createImapflowFactory } from "../daemon/imapflow.ts"

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
		/** The newest message's raw headers, for the echo probe. */
		newestHeaders?(): Promise<Buffer | undefined>
		close(): Promise<void>
	}>
}

const defaultConnect: NonNullable<SmokeDeps["connect"]> = async (config, getAccessToken) => {
	const factory = createImapflowFactory({ getAccessToken })
	const client = await factory(config, { idleRenewMs: config.tuning.idleRenewMs })
	await client.connect()
	await client.mailboxOpen(config.mail.imap.folder || "INBOX")
	return {
		count: async () => (await client.search({ uid: "1:*" }, { uid: true })).length,
		newestHeaders: async () => {
			const uids = await client.search({ uid: "1:*" }, { uid: true })
			const newest = uids.length ? Math.max(...uids) : undefined
			if (newest === undefined) return undefined
			const fetched = (await client.fetchOne(newest, { source: true }, { uid: true })) as
				| { source?: Buffer }
				| false
				| undefined
			return fetched && fetched.source ? fetched.source : undefined
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
	let connection: { count(): Promise<number>; newestHeaders?(): Promise<Buffer | undefined>; close(): Promise<void> } | undefined
	try {
		connection = await (deps.connect ?? defaultConnect)(config, deps.getAccessToken)
		const count = await connection.count()
		steps.push({ ok: true, step: "imap", detail: `${count} message(s) visible in ${folder}` })

		// --- echo probe (the one live question single-mailbox mode depends on) ---
		//
		// Our own notification must come back carrying `X-Pi-Mailbridge` and the Message-ID we
		// stamped: they are the two independent guards that stop the agent re-ingesting its own
		// mail. If the provider strips both, the loop becomes possible. Probe it here rather than
		// discovering it from a talking agent.
		const headers = await connection.newestHeaders?.()
		if (headers) {
			const text = headers.toString("utf8")
			const marker = /^x-pi-mailbridge:\s*notification/im.test(text)
			const stamped = (sentId: string | undefined): boolean => Boolean(sentId && text.includes(sentId))
			steps.push({
				ok: marker || stamped(lastMessageId),
				step: "echo",
				detail: marker
					? "our marker header survives delivery"
					: stamped(lastMessageId)
						? "marker header was stripped, but our Message-ID survives (guard still holds)"
						: "neither our marker header nor our Message-ID survived - single-mailbox mode may re-ingest its own mail",
			})
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
