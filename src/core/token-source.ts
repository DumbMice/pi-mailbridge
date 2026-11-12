// Which token source this installation uses.
//
// Shared by the daemon and the in-pi commands so `/mailbridge smoke` and the
// background daemon can never authenticate differently.

import type { ResolvedConfig } from "./config.ts"
import { createCommandTokenProvider, type TokenProvider } from "./oauth.ts"
import { createDeviceCodeProvider } from "./oauth-device.ts"
import { createOpenidClient } from "./oauth-openid.ts"
import { fileTokenStore } from "../store/oauth-store.ts"

/**
 * Precedence: built-in device-code OAuth2 (self-refreshing) -> a configured
 * command -> none (the account uses LOGIN).
 * Returning undefined is not an error: it means XOAUTH2 is not in play.
 */
export async function buildTokenProvider(
	config: ResolvedConfig,
	env: NodeJS.ProcessEnv = process.env,
): Promise<TokenProvider | undefined> {
	if (config.oauth?.issuer && config.oauth.clientId) {
		const client = await createOpenidClient(config.oauth)
		return createDeviceCodeProvider({ client, store: fileTokenStore(env) })
	}

	// An empty array is not nullish: the shipped example has `mail.smtp.tokenCommand: []`, so
	// `??` picked the empty SMTP list and ignored a perfectly good IMAP command - XOAUTH2 then
	// failed at connect time while `--check` said the config was fine.
	const smtp = config.mail.smtp.tokenCommand ?? []
	const command = smtp.length > 0 ? smtp : (config.mail.imap.tokenCommand ?? [])
	if (command.length > 0) return createCommandTokenProvider({ command })

	return undefined
}
