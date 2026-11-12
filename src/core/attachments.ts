// Inbound attachments.
//
// The point: reply to a pi notification from your phone with a screenshot or a log
// and have the agent actually see it.
//
// Deliberately restrictive. An attachment that reaches the model is untrusted
// input from a mail server, so:
//   - MIME allowlist, not a denylist
//   - hard caps on count and total bytes, enforced before anything is stored
//   - anything dropped is reported with a reason rather than silently ignored

/** Images the model can actually consume. */
export const ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
/** Text-like attachments we inline as text. */
export const ALLOWED_TEXT_MIMES = ["text/plain", "text/markdown", "application/json"] as const

export const MAX_ATTACHMENTS = 4
export const MAX_TOTAL_BYTES = 1_000_000

export type UserContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }

/** What the MIME parser hands us. */
export interface RawAttachment {
	filename?: string
	contentType: string
	content: Buffer
}

/** What we store in the pending record (base64, so JSON keeps it). */
export interface InboundAttachment {
	name: string
	mimeType: string
	size: number
	data: string
}

export interface DroppedAttachment {
	name: string
	reason: "mime-not-allowed" | "too-many" | "too-large" | "empty"
}

export interface SelectResult {
	accepted: InboundAttachment[]
	dropped: DroppedAttachment[]
}

function isImage(mime: string): boolean {
	return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)
}

function isText(mime: string): boolean {
	return (ALLOWED_TEXT_MIMES as readonly string[]).includes(mime)
}

/** Lowercase, strip parameters (`text/plain; charset=utf-8` → `text/plain`). */
export function normalizeMime(contentType: string | undefined): string {
	return (contentType ?? "").split(";")[0]!.trim().toLowerCase()
}

/**
 * Apply the allowlist and the caps.
 * Order matters: mime first (cheap), then count, then size.
 */
export function selectAttachments(
	raw: RawAttachment[],
	limits: { maxCount?: number; maxTotalBytes?: number } = {},
): SelectResult {
	const maxCount = limits.maxCount ?? MAX_ATTACHMENTS
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES

	const accepted: InboundAttachment[] = []
	const dropped: DroppedAttachment[] = []
	let total = 0

	for (const item of raw) {
		const mimeType = normalizeMime(item.contentType)
		const name = (item.filename ?? "").trim() || `attachment-${accepted.length + dropped.length + 1}`

		if (!isImage(mimeType) && !isText(mimeType)) {
			dropped.push({ name, reason: "mime-not-allowed" })
			continue
		}
		if (accepted.length >= maxCount) {
			dropped.push({ name, reason: "too-many" })
			continue
		}
		if (item.content.length === 0) {
			dropped.push({ name, reason: "empty" })
			continue
		}
		if (total + item.content.length > maxTotalBytes) {
			dropped.push({ name, reason: "too-large" })
			continue
		}

		total += item.content.length
		accepted.push({
			name,
			mimeType,
			size: item.content.length,
			data: item.content.toString("base64"),
		})
	}

	return { accepted, dropped }
}

/**
 * Build the payload for `pi.sendUserMessage`.
 *
 * Returns a plain string when there is nothing to attach: that keeps the common
 * case identical to a typed message, so no client special-cases it.
 */
export function toUserContent(text: string, attachments: InboundAttachment[] = []): string | UserContent[] {
	if (attachments.length === 0) return text
	// An attachment-only reply has no prose; an empty text block ahead of the image is noise
	// the model has to read past.
	const content: UserContent[] = text ? [{ type: "text", text }] : []
	for (const attachment of attachments) {
		if (isImage(attachment.mimeType)) {
			content.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType })
		} else {
			content.push({ type: "text", text: Buffer.from(attachment.data, "base64").toString("utf8") })
		}
	}
	return content
}
