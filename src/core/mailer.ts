// SMTP send path.
//
// Deliberately tiny: build transport options, hand the message to the transport,
// let failures propagate. Callers decide how to degrade (release a reservation,
// surface an error to the tool) — this module never pretends a send succeeded.
//
// Two auth modes, because Outlook has no third option:
//   LOGIN    — provider app password. Works for Gmail, Fastmail, QQ, 163, …
//   XOAUTH2  — access token. Mandatory for outlook.com/hotmail (Microsoft
//              retired SMTP basic auth on 2024-09-16).
//
// Subject stamping is NOT done here. It belongs to core/token so there is exactly
// one place that mints routing tokens.

import nodemailer from "nodemailer"

import type { ResolvedConfig } from "./config.ts"
import { textToHtml } from "./html.ts"

export interface OutboundMessage {
	to: string
	subject: string
	text: string
	/** Defaults to the SMTP user. */
	from?: string
}

export interface TransportLike {
	sendMail(options: Record<string, unknown>): Promise<unknown>
}

export type TransportFactory = (options: Record<string, unknown>) => TransportLike

/**
 * Compile-time guard: nodemailer's transport must satisfy what we call. Same reason
 * as the IMAP guard — the factory casts, so drift would otherwise be invisible.
 */
type AssertNodemailerShape = ReturnType<typeof nodemailer.createTransport> extends TransportLike ? true : never
const _nodemailerShapeOk: AssertNodemailerShape = true
void _nodemailerShapeOk

/** Default: nodemailer. Tests inject a fake so no socket is ever opened. */
export const defaultTransportFactory: TransportFactory = (options) =>
	nodemailer.createTransport(options as Parameters<typeof nodemailer.createTransport>[0]) as TransportLike

export interface SendDeps {
	transportFactory?: TransportFactory
	/**
	 * Supplies a fresh access token for XOAUTH2. Required when the account uses
	 * XOAUTH2; see src/core/oauth.ts for the caching implementation.
	 */
	getAccessToken?: () => Promise<string>
}

/**
 * Transport options for this account.
 * Exported so `--check` can validate the shape without sending anything.
 */
export async function buildTransportOptions(config: ResolvedConfig, deps: SendDeps = {}): Promise<Record<string, unknown>> {
	const smtp = config.mail.smtp
	const base = { host: smtp.host, port: smtp.port, secure: smtp.secure }

	if (smtp.authType === "XOAUTH2") {
		if (!deps.getAccessToken) {
			throw new Error(
				"pi-mailbridge: smtp.authType is XOAUTH2 but no token provider is configured — set mail.smtp.tokenCommand (see docs/SECURITY.md)",
			)
		}
		const accessToken = await deps.getAccessToken()
		if (!accessToken) throw new Error("pi-mailbridge: OAuth2 token provider returned an empty token")
		return { ...base, auth: { type: "OAuth2", user: smtp.user, accessToken } }
	}

	return { ...base, auth: { user: smtp.user, pass: smtp.password } }
}

/**
 * Send one plain-text message.
 * Throws on any transport failure — there is no partial-success path.
 *
 * Returns the Message-ID the server assigned when available, so the daemon can
 * record it and route replies that lost their subject token.
 */
export async function sendMail(
	config: ResolvedConfig,
	message: OutboundMessage,
	deps: SendDeps = {},
): Promise<{ messageId?: string }> {
	if (!config.mail.smtp.host) throw new Error("pi-mailbridge: mail.smtp.host is not configured")
	if (!message.to) throw new Error("pi-mailbridge: no recipient (mail.to)")

	const factory = deps.transportFactory ?? defaultTransportFactory
	const transportOptions = await buildTransportOptions(config, deps)
	const transporter = factory(transportOptions)

	const info = (await transporter.sendMail({
		from: message.from ?? config.mail.smtp.user,
		to: message.to,
		subject: message.subject,
		// multipart/alternative: clients fold quoted history only for HTML mail, so
		// plain-text-only notifications produced reply threads of raw repeated text.
		text: message.text,
		html: textToHtml(message.text),
	})) as { messageId?: string } | undefined

	return info?.messageId ? { messageId: info.messageId } : {}
}
