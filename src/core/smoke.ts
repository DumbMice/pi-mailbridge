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
	step: "smtp" | "imap"
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
	let connection: { count(): Promise<number>; close(): Promise<void> } | undefined
	try {
		connection = await (deps.connect ?? defaultConnect)(config, deps.getAccessToken)
		const count = await connection.count()
		steps.push({ ok: true, step: "imap", detail: `${count} message(s) visible in ${folder}` })
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
