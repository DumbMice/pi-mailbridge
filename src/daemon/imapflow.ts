// Real imapflow client factory.
//
// Kept separate from watcher.ts so the watcher stays testable: nothing here runs
// in a unit test. Note the two auth modes mirror core/mailer.ts — LOGIN uses an
// app password, XOAUTH2 needs an access token fetched before connect().

import {
	ImapFlow,
	type AuthOptions,
	type FetchQueryObject,
	type MessageRange,
	type SearchObject,
	type StoreOptions,
} from "imapflow"

import type { ResolvedConfig } from "../core/config.ts"
import type { ImapClientFactory, ImapClientLike } from "./watcher.ts"
import { createCommandTokenProvider } from "../core/oauth.ts"

export interface ImapflowFactoryOptions {
	/** Supplies an access token for XOAUTH2. Required when imap auth is XOAUTH2. */
	getAccessToken?: () => Promise<string>
}

/** Auth block for imapflow, honouring the configured auth type. */
export async function buildImapAuth(config: ResolvedConfig, getAccessToken?: () => Promise<string>): Promise<AuthOptions> {
	const imap = config.mail.imap
	if (imap.authType === "XOAUTH2") {
		if (!getAccessToken) {
			throw new Error("pi-mailbridge: imap.authType is XOAUTH2 but no token provider is configured")
		}
		const accessToken = await getAccessToken()
		if (!accessToken) throw new Error("pi-mailbridge: OAuth2 token provider returned an empty token for IMAP")
		return { user: imap.user, accessToken }
	}
	return { user: imap.user, pass: imap.password }
}

/**
 * Adapt the real client to the narrow interface the watcher uses.
 *
 * An explicit adapter rather than a cast: every call below is checked against
 * imapflow's real signature, so a major bump that renames or re-shapes a method
 * fails the build instead of failing at 3am.
 */
export function adapt(client: ImapFlow): ImapClientLike {
	return {
		connect: () => client.connect(),
		logout: () => client.logout(),
		mailboxOpen: (path: string) => client.mailboxOpen(path),

		// imapflow returns `false`/`undefined` for an empty result set. Normalizing
		// here is not cosmetic: without it a quiet mailbox would throw inside the scan.
		search: async (query: Record<string, unknown>, options?: { uid?: boolean }) => {
			const result = await client.search(query as SearchObject, options)
			return Array.isArray(result) ? result : []
		},

		fetchOne: (uid: number, query: Record<string, unknown>, options?: { uid?: boolean }) =>
			client.fetchOne(uid, query as FetchQueryObject, options),

		messageFlagsAdd: (uid: number, flags: string[], options?: { uid?: boolean }) =>
			client.messageFlagsAdd(uid as MessageRange, flags, options as StoreOptions | undefined),

		// ImapFlow's event map cannot be expressed generically; this is the one
		// boundary that needs a cast, and the events we listen for are covered by
		// the watcher's own tests.
		on: (event, listener) => {
			client.on(event as never, listener as never)
		},

		get usable() {
			return client.usable
		},
	}
}

export function createImapflowFactory(options: ImapflowFactoryOptions = {}): ImapClientFactory {
	return async (config, tuning) => {
		const auth = await buildImapAuth(config, options.getAccessToken)
		const client = new ImapFlow({
			host: config.mail.imap.host,
			port: config.mail.imap.port,
			secure: config.mail.imap.secure,
			// imapflow 2 exposes a typed AuthOptions; no cast needed.
			auth,
			// Renew IDLE well under the server's ~29 minute cutoff.
			maxIdleTime: tuning.idleRenewMs,
			// Never let imapflow log credentials or raw protocol.
			logger: false,
		})
		return adapt(client)
	}
}
