// Channel matching: which mail may carry a starter request, and for which machine.
//
// The default channel is the mailbox the bridge already watches, distinguished by a subject prefix -
// so a request is ordinary mail from the human, and it is authorized by the same allowlist + DMARC gates
// as any other reply. A configured address (a dedicated alias) is the stronger option; the prefix is the
// default because it needs no second mailbox.
//
// Device targeting matters because two machines sharing a mailbox would otherwise both act on one mail.
// The daemon already appends its device tag to notification subjects; requests follow the same rule: a
// request addressed to another device is not ours, and an untagged one is everyone's.

import type { StarterConfig } from "../core/config.ts"
import { normalizeAddress } from "../core/reply-parse.ts"

export type ChannelMatch =
	| { ours: true; title: string }
	| { ours: false; reason: "not-this-channel" | "other-device" | "empty" }

export interface ChannelInput {
	subject: string | undefined
	/** Every `To:` address, lowercased; the channel may be configured as an address. */
	to: string[]
	/** This process's device name. (Tags inside the subject are not a supported protocol.) */
	device: string
}

/**
 * Strip the reply/forward markers a mail client adds.
 *
 * The result mails say `stop:` in reply, and the reply arrives as `Re: [pi-start] redo`. Rejecting that made
 * the documented workflow a refusal, so the markers are removed before the channel tag is read.
 */
function stripReplyMarkers(subject: string): string {
	let value = subject.trim()
	for (;;) {
		const next = value.replace(/^(?:re|aw|sv|antw|fwd|fw|tr)\s*(?:\[\d+\])?\s*:\s*/i, "")
		if (next === value) return value
		value = next
	}
}

/** `[pi-start] fix the flaky test` → `fix the flaky test`, when the prefix matches. */
function titleAfterPrefix(subject: string, prefix: string): string | undefined {
	const trimmed = stripReplyMarkers(subject)
	if (!trimmed.startsWith("[")) return undefined
	const close = trimmed.indexOf("]")
	if (close === -1) return undefined
	const tag = trimmed.slice(1, close).trim().toLowerCase()
	if (tag !== prefix.trim().toLowerCase()) return undefined
	return trimmed.slice(close + 1).trim()
}

/**
 * Does this mail belong to the starter channel on this machine?
 *
 * Address matching (when configured) wins over the prefix: an operator who bothered to configure a
 * dedicated address does not want prefixed mail to that same mailbox acted on by accident.
 */
export function matchChannel(config: StarterConfig, input: ChannelInput): ChannelMatch {
	const address = config.channel.address.trim().toLowerCase()
	const prefix = config.channel.subjectPrefix.trim()

	let byAddress = false
	// `To: Starter <start@example.com>` is the ordinary form; comparing the raw value with an addr-spec
	// rejected it, so a dedicated alias only worked if the client sent a bare address.
	const wanted = address ? normalizeAddress(address) : undefined
	// `normalizeAddress` returns undefined for a malformed address; comparing those would admit anything
	// sent to anything, so both sides must be valid.
	if (wanted) byAddress = input.to.some((value) => normalizeAddress(value) === wanted)
	const byPrefix = prefix ? titleAfterPrefix(input.subject ?? "", prefix) : undefined

	// Address and prefix are alternatives, never a union: with an address configured, prefixed mail sent
	// *elsewhere* is someone else's channel.
	const matched = address ? byAddress : byPrefix !== undefined
	if (!matched) {
		return { ours: false, reason: input.subject === undefined && address === "" ? "empty" : "not-this-channel" }
	}

	// A dedicated address has no prefix to strip, so the whole subject is the title.
	const title = (address ? stripReplyMarkers(input.subject ?? "") : (byPrefix ?? "")).trim()
	return { ours: true, title }
}
