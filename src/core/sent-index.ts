// Record the Message-ID the provider actually delivered.
//
// We mint a Message-ID and stamp it, but some providers (QQ among them) replace it on
// submission: a live test showed our `<uuid@qq.com>` stored in the Sent folder as
// `<tencent_…@qq.com>`, and the human's reply carried the tencent id in In-Reply-To.
//
// The reply-chain fallback matches In-Reply-To against ids we recorded, so on such a provider
// it silently never matches - the subject tag is the only remaining route. When
// `mail.imap.sentFolder` is configured, the just-sent copy is read back and its Message-ID
// recorded too, which makes the fallback work everywhere.

import type { ResolvedConfig } from "./config.ts"
import { recordOutbound } from "../store/threads.ts"

export interface SentLookupClient {
	connect(): Promise<void>
	mailboxOpen(path: string): Promise<unknown>
	search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[]>
	fetchOne(uid: number, query: Record<string, unknown>, options?: { uid?: boolean }): Promise<unknown>
	logout(): Promise<void>
}

/** Look back far enough for a slow append to the Sent folder. */
const CAPTURE_WINDOW_MS = 15 * 60_000
/** How many recent sent messages to inspect before giving up. */
const CAPTURE_SCAN = 5

export interface CaptureOptions {
	config: ResolvedConfig
	/** The subject we sent, used to find the copy. */
	subject: string
	sessionId: string
	env?: NodeJS.ProcessEnv
	/** Injected for tests. */
	connect?: () => Promise<SentLookupClient>
	record?: typeof recordOutbound
}

/** Pull the first `Message-ID:` out of a header block. */
export function messageIdFromHeaders(headers: string): string | undefined {
	const unfolded = headers.replace(/\r?\n[ \t]+/g, " ")
	for (const line of unfolded.split(/\r?\n/)) {
		const match = /^message-id:\s*<([^>]+)>/i.exec(line.trim())
		if (match) return match[1]!.trim()
	}
	return undefined
}

/**
 * Read the just-sent message back from the Sent folder and record its Message-ID for the
 * session. Best-effort: a failure here must never fail the send.
 */
export async function captureDeliveredMessageId(options: CaptureOptions): Promise<string | undefined> {
	const folder = options.config.mail.imap.sentFolder
	if (!folder) return undefined
	const env = options.env ?? process.env
	const connect = options.connect ?? (await defaultConnect(options.config))
	let client: SentLookupClient | undefined
	try {
		client = await connect()
		await client.mailboxOpen(folder)
		// Not `search({subject})`: QQ's Sent folder answers that with nothing (measured), while a
		// date-bounded search works. So look at recent sent mail and pick ours out by the marker
		// header and the subject we sent.
		const since = new Date(Date.now() - CAPTURE_WINDOW_MS)
		const uids = await client.search({ since }, { uid: true })
		if (!uids.length) return undefined
		const newestFirst = uids.slice().sort((a, b) => b - a).slice(0, CAPTURE_SCAN)
		for (const uid of newestFirst) {
			const fetched = (await client.fetchOne(uid, { source: true }, { uid: true })) as
				| { source?: Buffer }
				| false
				| undefined
			if (!fetched || !fetched.source) continue
			const text = fetched.source.toString("utf8")
			const head = text.split(/\r?\n\r?\n/)[0] ?? ""
			// The marker is decisive: only we write it, and it survives QQ's RFC 2047 encoding of
			// the subject (which is why a subject match failed here in the live test).
			const unfolded = head.replace(/\r?\n[ \t]+/g, " ")
			if (!/^x-pi-mailbridge:\s*notification/im.test(unfolded)) continue
			const messageId = messageIdFromHeaders(head)
			if (!messageId) continue
			;(options.record ?? recordOutbound)(env, {
				messageId,
				sessionId: options.sessionId,
				...(options.config.device.name ? { device: options.config.device.name } : {}),
				subject: options.subject,
			})
			return messageId
		}
		return undefined
	} catch {
		return undefined
	} finally {
		await client?.logout().catch(() => undefined)
	}
}

async function defaultConnect(config: ResolvedConfig): Promise<() => Promise<SentLookupClient>> {
	const { createImapflowFactory } = await import("../daemon/imapflow.ts")
	return async () => {
		const client = await createImapflowFactory({})(config, { idleRenewMs: config.tuning.idleRenewMs })
		await client.connect()
		return client as unknown as SentLookupClient
	}
}
