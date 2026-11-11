// Real imapflow client factory.
//
// Kept separate from watcher.ts so the watcher stays testable: nothing here runs
// in a unit test. Note the two auth modes mirror core/mailer.ts — LOGIN uses an
// app password, XOAUTH2 needs an access token fetched before connect().

import { ImapFlow } from "imapflow"

import type { ResolvedConfig } from "../core/config.ts"
import type { ImapClientFactory, ImapClientLike } from "./watcher.ts"
import { createCommandTokenProvider } from "../core/oauth.ts"

export interface ImapflowFactoryOptions {
	/** Supplies an access token for XOAUTH2. Required when imap auth is XOAUTH2. */
	getAccessToken?: () => Promise<string>
}

/** Auth block for imapflow, honouring the configured auth type. */
export async function buildImapAuth(
	config: ResolvedConfig,
	getAccessToken?: () => Promise<string>,
): Promise<Record<string, unknown>> {
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

export function createImapflowFactory(options: ImapflowFactoryOptions = {}): ImapClientFactory {
	return async (config, tuning) => {
		const auth = await buildImapAuth(config, options.getAccessToken)
		const client = new ImapFlow({
			host: config.mail.imap.host,
			port: config.mail.imap.port,
			secure: config.mail.imap.secure,
			auth: auth as ConstructorParameters<typeof ImapFlow>[0]["auth"],
			// Renew IDLE well under the server's ~29 minute cutoff.
			maxIdleTime: tuning.idleRenewMs,
			// Never let imapflow log credentials or raw protocol.
			logger: false,
		})
		return client as unknown as ImapClientLike
	}
}

/**
 * Convenience: a factory that pulls XOAUTH2 tokens from a `tokenCommand`.
 * Used by the daemon when `mail.imap.authType` is XOAUTH2.
 */
export function createImapflowFactoryWithCommand(config: ResolvedConfig): ImapClientFactory {
	const provider = createCommandTokenProvider({
		command: config.mail.imap.tokenCommand ?? [],
	})
	return createImapflowFactory({ getAccessToken: () => provider.getToken() })
}
