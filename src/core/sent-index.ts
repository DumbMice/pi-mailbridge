// Record the Message-ID the provider actually delivered.
//
// We mint a Message-ID and stamp it, but some providers (QQ among them) replace it on
// submission: a live test showed our `<uuid@qq.com>` stored in the Sent folder as
// `<tencent_…@qq.com>`, and the human's reply carried the tencent id in In-Reply-To.
//
// The reply-chain fallback matches In-Reply-To against ids we recorded, so on such a provider
// it never matches - the subject tag is the only remaining route.
//
// The just-sent copy is found by the `X-Pi-Mailbridge-Id` header, which carries the id we
// minted. Two things learned the hard way (a live review caught both):
//   - the copy is appended *after* the send completes, so this must run after it, and must
//     retry: QQ took 20-30 s in one measurement;
//   - matching on the marker header alone records a *different* notification's id when two
//     sessions send close together, which routes a reply into the wrong session.

import type { ResolvedConfig } from "./config.ts"
import { recordOutbound } from "../store/threads.ts"

export interface SentLookupClient {
	connect(): Promise<void>
	mailboxOpen(path: string): Promise<unknown>
	search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[]>
	fetchOne(uid: number, query: Record<string, unknown>, options?: { uid?: boolean }): Promise<unknown>
	logout(): Promise<void>
}

/** Look back far enough to see a send that is still being appended. */
const CAPTURE_WINDOW_MS = 30 * 60_000
/** How many recent sent messages to inspect per attempt. */
const CAPTURE_SCAN = 20
/** Backoff between attempts: providers append asynchronously. */
const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 30_000, 30_000] as const

export interface CaptureOptions {
	config: ResolvedConfig
	/** The id we minted and stamped into `X-Pi-Mailbridge-Id`. */
	mintedId: string
	sessionId: string
	subject: string
	env?: NodeJS.ProcessEnv
	/** XOAUTH2 accounts need a token for this connection too, exactly like the watcher. */
	getAccessToken?: () => Promise<string>
	/** Injected for tests. */
	connect?: () => Promise<SentLookupClient>
	record?: typeof recordOutbound
	retryDelaysMs?: readonly number[]
	sleep?: (ms: number) => Promise<void>
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

/** `X-Pi-Mailbridge-Id: <uuid@domain>` — normalised, without angle brackets. */
export function stampedIdFromHeaders(headers: string): string | undefined {
	const unfolded = headers.replace(/\r?\n[ \t]+/g, " ")
	for (const line of unfolded.split(/\r?\n/)) {
		const match = /^x-pi-mailbridge-id:\s*<?([^>\s]+)>?/i.exec(line.trim())
		if (match) return match[1]!.trim()
	}
	return undefined
}

/**
 * Read the just-sent message back from the Sent folder and record its Message-ID for the
 * session. Best-effort: a failure never fails the send, and one capture runs at a time.
 */
export async function captureDeliveredMessageId(options: CaptureOptions): Promise<string | undefined> {
	const folder = options.config.mail.imap.sentFolder
	if (!folder) return undefined
	return serialise(options.mintedId, () => attempt(options, folder))
}

/**
 * One capture in flight at a time, and identical requests share it.
 *
 * A burst of notifications must not open one connection each, and a capture can hold the
 * queue for a minute; coalescing means a repeated request for the same minted id costs
 * nothing extra.
 */
let queue: Promise<unknown> = Promise.resolve()
const inFlightByMintedId = new Map<string, Promise<string | undefined>>()

function serialise<T>(key: string, run: () => Promise<T>): Promise<T> {
	const existing = inFlightByMintedId.get(key)
	if (existing) return existing as Promise<T>
	const next = queue.then(run, run)
	queue = next.catch(() => undefined)
	inFlightByMintedId.set(key, next as Promise<string | undefined>)
	next.catch(() => undefined).finally(() => inFlightByMintedId.delete(key))
	return next
}

async function attempt(options: CaptureOptions, folder: string): Promise<string | undefined> {
	const env = options.env ?? process.env
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
	const connect = options.connect ?? (await defaultConnect(options.config, options.getAccessToken))
	const wanted = options.mintedId.replace(/[<>]/g, "")

	let client: SentLookupClient | undefined
	try {
		client = await connect()
		await client.mailboxOpen(folder)
		for (const delay of delays) {
			if (delay > 0) await sleep(delay)
			const since = new Date(Date.now() - CAPTURE_WINDOW_MS)
			const uids = await client.search({ since }, { uid: true })
			if (!uids.length) continue
			const newestFirst = uids.slice().sort((a, b) => b - a).slice(0, CAPTURE_SCAN)
			for (const uid of newestFirst) {
				const fetched = (await client.fetchOne(uid, { source: true }, { uid: true })) as
					| { source?: Buffer }
					| false
					| undefined
				if (!fetched || !fetched.source) continue
				const head = (fetched.source.toString("utf8").split(/\r?\n\r?\n/)[0] ?? "").replace(/\r?\n[ \t]+/g, " ")
				// Only the copy of the message we just sent: the header carries our minted id.
				if (stampedIdFromHeaders(head) !== wanted) continue
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
		}
		return undefined
	} catch {
		return undefined
	} finally {
		await client?.logout().catch(() => undefined)
	}
}

async function defaultConnect(
	config: ResolvedConfig,
	getAccessToken?: () => Promise<string>,
): Promise<() => Promise<SentLookupClient>> {
	const { createImapflowFactory } = await import("../daemon/imapflow.ts")
	return async () => {
		const client = await createImapflowFactory({ ...(getAccessToken ? { getAccessToken } : {}) })(config, {
			idleRenewMs: config.tuning.idleRenewMs,
		})
		try {
			await client.connect()
		} catch (error) {
			// Do not leak the socket of a client whose connect failed.
			await client.logout().catch(() => undefined)
			throw error
		}
		return client as unknown as SentLookupClient
	}
}
