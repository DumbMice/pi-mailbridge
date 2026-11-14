// Inbound attachments.
//
// The point: reply to a pi notification from your phone with an image or a log
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

/**
 * Documents a reply may carry, by extension, for the agent to open itself.
 *
 * These are written to a private directory under the state dir and the message names the path -
 * a PDF or a PPTX cannot be a message part, and inlining megabytes of bytes through `pending.json`
 * would undo the store's byte ceiling. The extension list is the guard rail; the sender is already
 * allowlisted and DMARC-checked, so this is about accidents (a key renamed `.pdf`), not about
 * stopping the human.
 */
export const ALLOWED_FILE_EXTENSIONS: Record<string, string> = {
	pdf: "application/pdf",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	ppt: "application/vnd.ms-powerpoint",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	doc: "application/msword",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.ms-excel",
	csv: "text/csv",
	odt: "application/vnd.oasis.opendocument.text",
	odp: "application/vnd.oasis.opendocument.presentation",
	zip: "application/zip",
	gz: "application/gzip",
	tar: "application/x-tar",
	md: "text/markdown",
	txt: "text/plain",
	log: "text/plain",
	json: "application/json",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	// iPhone photos, which no vision API accepts but a shell can convert.
	heic: "image/heic",
	heif: "image/heif",
	svg: "image/svg+xml",
}

/** Per file, for a document written to disk. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024
/** Files per reply. */
export const MAX_FILES = 10
/** All files in one reply. */
export const MAX_FILES_TOTAL_BYTES = 25 * 1024 * 1024
/**
 * Longest filename we keep.
 *
 * The name is persisted with the record and there is no upstream bound on the MIME `filename`
 * parameter - a message at the 8 MB message ceiling can carry a multi-megabyte one. Unbounded, it
 * was the last field that could push a record past `PENDING_MAX_BYTES` and be refused on every
 * scan with nothing to expire. Outbound already caps names (`safeFilename`, inline-images.ts).
 */
export const MAX_NAME_CHARS = 200

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

/** A document too big to inline: written to disk, delivered as a path. */
export interface SelectedFile {
	name: string
	mimeType: string
	size: number
	content: Buffer
}

export interface SelectResult {
	accepted: InboundAttachment[]
	files: SelectedFile[]
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
export interface SelectLimits {
	maxCount?: number
	maxTotalBytes?: number
	maxFileBytes?: number
	maxFiles?: number
	maxFilesTotalBytes?: number
}

/** Extension of a filename, lowercased, without the dot. */
function extensionOf(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? name
	const dot = base.lastIndexOf(".")
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

/**
 * Sort what came in a reply into "inline", "file on disk" and "dropped".
 *
 * Images and short text become message parts - the model can *see* an image, and text is text.
 * Everything else with an allowed extension is written to disk and the message names the path,
 * because a PDF or a 20 MB PPTX cannot be a message part. An image over the inline cap goes the
 * same way (the agent's `read` tool can still open it).
 */
export function selectAttachments(raw: RawAttachment[], limits: SelectLimits = {}): SelectResult {
	const maxCount = limits.maxCount ?? MAX_ATTACHMENTS
	const maxTotalBytes = limits.maxTotalBytes ?? MAX_TOTAL_BYTES
	const maxFileBytes = limits.maxFileBytes ?? MAX_FILE_BYTES
	const maxFiles = limits.maxFiles ?? MAX_FILES
	const maxFilesTotalBytes = limits.maxFilesTotalBytes ?? MAX_FILES_TOTAL_BYTES

	const accepted: InboundAttachment[] = []
	const files: SelectedFile[] = []
	const dropped: DroppedAttachment[] = []
	let total = 0
	let fileTotal = 0

	for (const item of raw) {
		const mimeType = normalizeMime(item.contentType)
		const name =
			(item.filename ?? "").trim().slice(0, MAX_NAME_CHARS) ||
			`attachment-${accepted.length + files.length + dropped.length + 1}`

		if (item.content.length === 0) {
			dropped.push({ name, reason: "empty" })
			continue
		}

		// Inline first: it is the richest form (the model sees the image, not a path).
		if (isImage(mimeType) || isText(mimeType)) {
			if (accepted.length >= maxCount) {
				dropped.push({ name, reason: "too-many" })
				continue
			}
			if (total + item.content.length > maxTotalBytes) {
				// Too big to inline, but a legitimate document: hand it over as a file rather than
				// losing it. (A 5 MB phone photo is exactly this case.)
				if (!pushFile(item, name, mimeType, files, dropped, { maxFileBytes, maxFiles, maxFilesTotalBytes, fileTotal })) {
					continue
				}
				fileTotal += item.content.length
				continue
			}
			total += item.content.length
			accepted.push({ name, mimeType, size: item.content.length, data: item.content.toString("base64") })
			continue
		}

		const extension = extensionOf(name)
		const documentType = ALLOWED_FILE_EXTENSIONS[extension]
		if (!documentType) {
			dropped.push({ name, reason: "mime-not-allowed" })
			continue
		}
		if (!pushFile(item, name, documentType, files, dropped, { maxFileBytes, maxFiles, maxFilesTotalBytes, fileTotal })) {
			continue
		}
		fileTotal += item.content.length
	}

	return { accepted, files, dropped }
}

/** Push a file if it fits, or record why not. Returns whether it was taken. */
function pushFile(
	item: RawAttachment,
	name: string,
	mimeType: string,
	files: SelectedFile[],
	dropped: DroppedAttachment[],
	limits: { maxFileBytes: number; maxFiles: number; maxFilesTotalBytes: number; fileTotal: number },
): boolean {
	if (files.length >= limits.maxFiles) {
		dropped.push({ name, reason: "too-many" })
		return false
	}
	if (item.content.length > limits.maxFileBytes || limits.fileTotal + item.content.length > limits.maxFilesTotalBytes) {
		dropped.push({ name, reason: "too-large" })
		return false
	}
	files.push({ name, mimeType, size: item.content.length, content: item.content })
	return true
}

/**
 * Build the payload for `pi.sendUserMessage`.
 *
 * Returns a plain string when there is nothing to attach: that keeps the common
 * case identical to a typed message, so no client special-cases it.
 */
export function toUserContent(
	text: string,
	attachments: InboundAttachment[] = [],
	files: { name: string; mimeType: string; size: number; path: string }[] = [],
): string | UserContent[] {
	if (attachments.length === 0 && files.length === 0) return text
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
	if (files.length > 0) {
		// A path, not the bytes: the agent opens it with its own tools, which is the only way a
		// PDF or a presentation can be delivered at all.
		const lines = files.map((f) => `- ${f.path} (${f.name}, ${f.mimeType}, ${Math.round(f.size / 1024)} KB)`)
		content.push({
			type: "text",
			text: `[pi-mailbridge] the human attached ${files.length} file(s):\n${lines.join("\n")}`,
		})
	}
	return content
}
