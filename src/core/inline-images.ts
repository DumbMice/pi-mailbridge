// Inline local images as CID attachments.
//
// A Markdown image pointing at a local path renders as `<img src="./shot.png">`, which a
// mail client cannot resolve - the reader sees a broken image. The standard fix is a
// `multipart/related` attachment referenced by `cid:`, which is what this does.
//
// Safety, because the src comes from model output and the result is emailed:
//
//   - the file must actually **sniff** as an image (magic bytes), not merely have an
//     image extension, so a renamed text file or key is never attached;
//   - a size cap and a count cap, so a mail cannot become a file transfer;
//   - a path that cannot be read or does not sniff degrades to a short note instead of
//     a broken image.
//
// Images are also addressed by content hash, so the same screenshot referenced twice is
// attached once.

import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"

export interface InlineAttachment {
	filename: string
	content: Buffer
	contentType: string
	cid: string
}

export interface SkippedImage {
	src: string
	reason: "not-found" | "not-an-image" | "too-large" | "too-many" | "unreadable"
}

export interface InlineResult {
	html: string
	attachments: InlineAttachment[]
	skipped: SkippedImage[]
}

/** Per-image cap. Most screenshots are well under this. */
export const MAX_INLINE_BYTES = 128 * 1024
/** Total payload cap, so a mail cannot turn into a file transfer. */
export const MAX_INLINE_TOTAL_BYTES = 384 * 1024
export const MAX_INLINE_COUNT = 4

/**
 * Identify an image from its magic bytes rather than trusting the extension.
 *
 * SVG is deliberately absent. Not because email cannot carry it - a linked SVG file
 * (`<img src="x.svg">` or a cid attachment) is supported by roughly 97% of clients, and
 * Gmail rasterises it to PNG server-side - but because **Outlook on Windows (2007-2019)
 * renders nothing at all** for it, with no fallback. Inline `<svg>` markup is the truly
 * dead form at ~40%, since Gmail deletes the element while sanitising.
 *
 * PNG is therefore the one format that renders everywhere, which matters more for a
 * notification than vector sharpness. SVG could be added behind a flag with an explicit
 * "invisible in Outlook desktop" caveat.
 */
export function sniffImage(buffer: Buffer): { contentType: string; ext: string } | undefined {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return { contentType: "image/png", ext: "png" }
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return { contentType: "image/jpeg", ext: "jpg" }
	}
	if (buffer.length >= 6) {
		const head = buffer.subarray(0, 6).toString("latin1")
		if (head === "GIF87a" || head === "GIF89a") return { contentType: "image/gif", ext: "gif" }
	}
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") {
		return { contentType: "image/webp", ext: "webp" }
	}
	return undefined
}

const IMG_TAG = /<img\b[^>]*>/gi
const SRC_ATTR = /\bsrc\s*=\s*"([^"]*)"/i
const ALT_ATTR = /\balt\s*=\s*"([^"]*)"/i

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

function note(label: string, detail: string): string {
	return `<span style="opacity:.7">[${escapeHtml(label)}${detail ? `: ${escapeHtml(detail)}` : ""}]</span>`
}

function resolvePath(src: string, root: string): string {
	let value = src.trim()
	if (value.startsWith("file://")) value = value.slice("file://".length)
	if (value.startsWith("~/")) value = `${homedir()}${value.slice(1)}`
	return isAbsolute(value) ? value : resolve(root, value)
}

export interface InlineOptions {
	/** Base directory for relative paths - normally the agent's project directory. */
	root?: string
	maxBytes?: number
	maxCount?: number
	/** Injected for tests. */
	readFile?: (path: string) => Buffer
	sizeOf?: (path: string) => number
}

export function inlineLocalImages(html: string, options: InlineOptions = {}): InlineResult {
	const root = options.root ?? process.cwd()
	const maxBytes = options.maxBytes ?? MAX_INLINE_BYTES
	const maxCount = options.maxCount ?? MAX_INLINE_COUNT
	const read = options.readFile ?? ((path: string) => readFileSync(path))
	const size = options.sizeOf ?? ((path: string) => statSync(path).size)

	const attachments: InlineAttachment[] = []
	const skipped: SkippedImage[] = []
	const byCid = new Map<string, InlineAttachment>()
	let total = 0

	const replaced = html.replace(IMG_TAG, (tag) => {
		const src = SRC_ATTR.exec(tag)?.[1] ?? ""
		const alt = ALT_ATTR.exec(tag)?.[1] ?? ""
		// Remote, protocol-relative and already-inlined sources are left alone.
		if (!src || /^(?:https?:)?\/\//i.test(src) || src.startsWith("cid:") || src.startsWith("data:")) return tag

		if (attachments.length >= maxCount) {
			skipped.push({ src, reason: "too-many" })
			return note(alt || "image", "not attached, too many images")
		}

		const path = resolvePath(src, root)
		let bytes: Buffer
		try {
			if (size(path) > maxBytes) {
				skipped.push({ src, reason: "too-large" })
				return note(alt || "image", `${Math.round(size(path) / 1024)} KB, over the ${Math.round(maxBytes / 1024)} KB limit`)
			}
			bytes = read(path)
		} catch {
			skipped.push({ src, reason: "not-found" })
			return note(alt || "image", "not attached, file not found")
		}

		const kind = sniffImage(bytes)
		if (!kind) {
			skipped.push({ src, reason: "not-an-image" })
			return note(alt || "image", "not attached, not an image")
		}
		if (bytes.length > maxBytes || total + bytes.length > MAX_INLINE_TOTAL_BYTES) {
			skipped.push({ src, reason: "too-large" })
			return note(alt || "image", "not attached, too large")
		}

		const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16)
		const cid = `pi-${digest}@pi.local`
		const existing = byCid.get(cid)
		if (!existing) {
			const base = (alt || "image").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "image"
			const attachment: InlineAttachment = {
				filename: `${base}.${kind.ext}`,
				content: bytes,
				contentType: kind.contentType,
				cid,
			}
			byCid.set(cid, attachment)
			attachments.push(attachment)
			total += bytes.length
		}

		return `<img src="cid:${cid}" alt="${escapeHtml(alt)}" style="max-width:100%;height:auto">`
	})

	return { html: replaced, attachments, skipped }
}
