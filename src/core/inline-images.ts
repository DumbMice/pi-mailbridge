// Attach local files that a notification links to.
//
// Two shapes, both resolved from the agent's working directory:
//
//   ![shot](./shot.png)     an <img> - inlined as a CID part so it renders in place
//   [report](./report.pdf)  an <a>   - attached with its real filename, and the link text
//                                      says so, because a mail client cannot follow a
//                                      relative path and a cid: anchor is unreliable
//
// The result is mailed, so the safety rules are the point: an image must sniff as an image
// (magic bytes, not an extension) whether it was written as an image or as a link, a non-image
// must have an allowlisted extension, every
// file is size- and count-capped, and anything unreadable degrades to a sentence instead of
// a broken link. Content is hashed, so one file referenced twice rides once.
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
// Images are also addressed by content hash, so the same image referenced twice is
// attached once.

import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve } from "node:path"
import { homedir } from "node:os"
import { configDir, stateDir } from "../store/paths.ts"

export interface InlineAttachment {
	filename: string
	content: Buffer
	contentType: string
	/** Present for inlined images; absent for an ordinary file attachment. */
	cid?: string
	/** nodemailer: "attachment" shows a paperclip rather than a broken inline reference. */
	contentDisposition?: "inline" | "attachment"
}

export interface SkippedImage {
	src: string
	reason:
		| "not-found"
		| "not-an-image"
		| "too-large"
		| "too-many"
		| "unreadable"
		| "not-allowed"
		| "outside-root"
		| "root-refused"
		| "hidden-path"
}

export interface InlineResult {
	html: string
	attachments: InlineAttachment[]
	skipped: SkippedImage[]
}

/**
 * Provider ceilings, which is what these numbers are derived from:
 *
 *   Gmail        25 MB send (50 MB receive)
 *   Outlook.com  25 MB per message
 *   M365 work    35 MB send / 36 MB receive (Exchange default 10 MB)
 *   QQ Mail      50 MB attachments, 55 MB with the body, 200 MB/day
 *
 * Base64 inflates by about a third, so 18 MB of files is roughly 24 MB on the wire - under the
 * smallest ceiling. `notify.maxAttachmentMb` raises the budget for a provider that allows more.
 */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024
/** Per-file cap for an attached (non-inline) file. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024
/** Default total payload cap; a caller may pass `maxTotalBytes` instead. */
export const MAX_INLINE_TOTAL_BYTES = 18 * 1024 * 1024
export const MAX_INLINE_COUNT = 10

/**
 * Extensions we will attach from a link.
 *
 * An allowlist rather than "anything readable": the path comes from model output, and the
 * one thing that must never happen is mailing a private key because a prompt said so. Add
 * to this list deliberately.
 */
const ALLOWED_FILE_EXTENSIONS: Record<string, string> = {
	pdf: "application/pdf",
	txt: "text/plain",
	log: "text/plain",
	md: "text/markdown",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	json: "application/json",
	yml: "application/yaml",
	yaml: "application/yaml",
	xml: "application/xml",
	html: "text/html",
	zip: "application/zip",
	gz: "application/gzip",
	tar: "application/x-tar",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

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
/** Markdown links become anchors; the text between them is already rendered HTML. */
const LINK_TAG = /<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi

/** realpath, or the input when it cannot be resolved (tests use paths that may not exist). */
function safeRealpath(path: string): string | undefined {
	try {
		return realpathSync(path)
	} catch {
		return undefined
	}
}

/** stat that follows symlinks; undefined when the path does not resolve. */
function safeStat(path: string): ReturnType<typeof statSync> | undefined {
	try {
		return statSync(path)
	} catch {
		return undefined
	}
}

/** Where an attachment was refused, so the note can say something true. */
type RootVerdict = "ok" | "outside-root" | "root-refused" | "hidden-path"

/**
 * Is this resolved file safe to attach?
 *
 * Three rules, all fail-closed:
 *   - it must resolve, and it must land inside the project directory (a symlink out is refused);
 *   - the root must not be `/`, where every path on the machine is "inside the project". Home is a
 *     valid root (a fresh `pi` starts there, and that is where an agent puts a deck); what is
 *     refused inside it is any path segment beginning with a dot (`.ssh`, `.config`, `.env`);
 *   - the daemon's own config and state directories are never attached, whatever the cwd.
 *
 * The comparison goes through `relative()`, not a `/`-joined prefix: on Windows the separator is
 * `\`, so a prefix test silently refused every attachment there.
 */
function insideRoot(path: string, rootReal: string | undefined): RootVerdict {
	if (!rootReal) return "root-refused"

	// A path that does not resolve yet (a missing file, a dangling link) is compared by its
	// parent's real location plus its own name, so a project reached through a symlinked path
	// (macOS /var -> /private/var, a symlinked checkout) still reports "not found" rather than
	// "outside the project"; a path that resolves elsewhere - `ln -s /proc/self/fd/0` - is
	// compared at its real location and refused.
	const target = safeRealpath(path) ?? joinResolved(dirname(path), basename(path))

	// The filesystem root is not a project: with cwd = / every path is "inside" it.
	if (rootReal === "/") return "root-refused"

	for (const dir of [configDir(), stateDir()]) {
		const real = safeRealpath(dir)
		if (real && contains(real, target)) return "root-refused"
	}

	if (!contains(rootReal, target)) return "outside-root"

	// Home *is* allowed as a root (an agent working in ~ produces ~/Downloads/report.pdf), so the
	// blunt "home refuses everything" rule is gone. What replaces it: a hidden path segment is
	// never attached. `~/.ssh`, `~/.config`, `~/.local`, `~/.aws` and every `.env` live behind a
	// dot, and a legitimate artifact almost never does - while the config/state refusal above
	// still covers the daemon's own files by name.
	const rel = relative(rootReal, target)
	const segments = rel.split(/[\\/]/).filter((part) => part && part !== ".")
	if (segments.some((part) => part.startsWith("."))) return "hidden-path"

	return "ok"
}

/** Does `parent` contain `child`? Separator-agnostic and not fooled by a shared prefix. */
function contains(parent: string, child: string): boolean {
	const rel = relative(parent, child)
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** realpath of a directory plus one unresolved name. */
function joinResolved(dir: string, name: string): string {
	return `${safeRealpath(dir) ?? dir}/${name}`
}

/** A filename a mail client will accept: no separators, no control characters, bounded. */
function safeFilename(path: string, fallback: string): string {
	const base = path.split(/[\\/]/).pop() ?? fallback
	const cleaned = base
		.normalize("NFKC")
		.replace(/[\u0000-\u001f\u007f"<>|:*?]+/g, "-")
		.replace(/^[.]+/, "")
		.trim()
	if (!cleaned) return fallback
	// Truncate the *stem*, never the whole string: cutting at 120 characters dropped the
	// extension of any long name (a Chinese title percent-encodes to well over that), and the
	// allowlist then refused the file as "this type is not attached".
	const dot = cleaned.lastIndexOf(".")
	const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : ""
	const stem = (ext ? cleaned.slice(0, dot) : cleaned).slice(0, Math.max(1, 120 - ext.length))
	return `${stem}${ext}`
}

/**
 * Percent-decode a link target.
 *
 * markdown-it encodes hrefs, so a Chinese filename arrives as `%E7%AC%AC…` - which is neither a
 * readable attachment name nor a path that exists on disk. A `%` that cannot be decoded is kept.
 */
function decodeHref(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

/** One sentence per refusal, so the mail says why rather than just omitting the file. */
function refuseText(verdict: Exclude<RootVerdict, "ok">): string {
	switch (verdict) {
		case "root-refused":
			// The daemon's own config/state, or a root that cannot bound anything (`/`). "Start pi
			// in a project" was the old advice for a rule that no longer exists, and it does not
			// help either case.
			return "not attached, a private path"
		case "hidden-path":
			return "not attached, hidden path"
		default:
			return "not attached, outside the project"
	}
}

function note(label: string, detail: string): string {
	return `<span style="opacity:.7">[${escapeHtml(label)}${detail ? `: ${escapeHtml(detail)}` : ""}]</span>`
}

function resolvePath(src: string, root: string): string {
	let value = decodeHref(src.trim())
	if (value.startsWith("file://")) value = value.slice("file://".length)
	// Models emit `sandbox:/home/…` (and similar invented schemes) for links they cannot make
	// real. The remainder is still the absolute path the reader would have clicked, so strip the
	// scheme when what follows is one; `insideRoot` still decides whether it may be attached.
	const unknownScheme = /^[a-z][a-z0-9+.-]*:(\/.*)$/i.exec(value)
	if (unknownScheme?.[1]) value = unknownScheme[1]
	if (value.startsWith("~/")) value = `${homedir()}${value.slice(1)}`
	return isAbsolute(value) ? value : resolve(root, value)
}

export interface InlineOptions {
	/** Base directory for relative paths - normally the agent's project directory. */
	root?: string
	maxBytes?: number
	maxCount?: number
	/** Total bytes of all attachments; defaults to MAX_INLINE_TOTAL_BYTES. */
	maxTotalBytes?: number
	/** Injected for tests. */
	readFile?: (path: string) => Buffer
	sizeOf?: (path: string) => number
}

export function inlineLocalImages(html: string, options: InlineOptions = {}): InlineResult {
	const root = options.root ?? process.cwd()
	const maxBytes = options.maxBytes ?? MAX_INLINE_BYTES
	const maxCount = options.maxCount ?? MAX_INLINE_COUNT
	const maxTotal = options.maxTotalBytes ?? MAX_INLINE_TOTAL_BYTES
	const read = options.readFile ?? ((path: string) => readFileSync(path))
	const size = options.sizeOf ?? ((path: string) => statSync(path).size)

	// Resolve the project directory once. Attachments are limited to it: a symlink inside the
	// project pointing at `~/.config/pi-mailbridge/config.json` would otherwise mail the
	// mailbox password, and the allowlist says nothing about where a file came from.
	const rootReal = safeRealpath(root)

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
		const verdict = insideRoot(path, rootReal)
		if (verdict !== "ok") {
			skipped.push({ src, reason: verdict })
			return note(alt || "image", refuseText(verdict))
		}
		let bytes: Buffer
		try {
			// Existence first, so the note says "not found" rather than "unreadable"; then the
			// type, because a FIFO or a device reports size 0 and blocks the read forever, which
			// would hang the send (and the poll tick that awaits it).
			const st = safeStat(path)
			if (!st) {
				skipped.push({ src, reason: "not-found" })
				return note(alt || "image", "not attached, file not found")
			}
			if (!st.isFile()) {
				skipped.push({ src, reason: "unreadable" })
				return note(alt || "image", "not attached, not a regular file")
			}
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
		if (bytes.length > maxBytes || total + bytes.length > maxTotal) {
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

	// Links to local files become ordinary attachments. Their anchors cannot work in a mail
	// client - a relative path does not exist there and `cid:` in an <a href> is unreliable -
	// so the text stays and the filename is named beside it.
	const withLinks = replaced.replace(LINK_TAG, (_tag, href: string, inner: string) => {
		if (!href || /^(?:https?:|mailto:|tel:|cid:|data:|#)/i.test(href)) return _tag
		const path = resolvePath(href, root)

		// The skipped reason is a stable code (tests and diagnostics match on it); the note is
		// what the reader sees.
		const refuse = (reason: SkippedImage["reason"], text: string): string => {
			skipped.push({ src: href, reason })
			return `${inner} ${note("not attached", text)}`
		}
		if (attachments.length >= maxCount) return refuse("too-many", "too many attachments")
		const verdict = insideRoot(path, rootReal)
		if (verdict !== "ok") return refuse(verdict, refuseText(verdict).replace("not attached, ", ""))
		const filename = safeFilename(decodeHref(href), "file")
		const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : ""
		const contentType = ALLOWED_FILE_EXTENSIONS[ext]
		if (!contentType) return refuse("not-allowed", "this file type is not attached")

		let bytes: Buffer
		try {
			const st = safeStat(path)
			if (!st) return refuse("not-found", "file not found")
			if (!st.isFile()) return refuse("unreadable", "not a regular file")
			// Per-file cap before reading; the *total* is charged after the dedupe below, so a
			// file that is already attached does not fail as "over the limit" for zero new bytes.
			if (size(path) > MAX_FILE_BYTES) {
				return refuse("too-large", `${Math.round(size(path) / 1024)} KB, over the limit`)
			}
			bytes = read(path)
			// The file can grow between stat and read.
			if (bytes.length > MAX_FILE_BYTES) {
				return refuse("too-large", `${Math.round(bytes.length / 1024)} KB, over the limit`)
			}
		} catch {
			skipped.push({ src: href, reason: "not-found" })
			return `${inner} ${note("not attached", "file not found")}`
		}

		// An extension is a claim, not a fact. The image rules above sniff; without this the link
		// path did not, so `[notes](./notes.png)` mailed any bytes at all labelled image/png -
		// the one thing the allowlist exists to prevent. Raster types are checkable; SVG is XML,
		// has no signature to check, and is attached as a file rather than inlined.
		let attachmentType = contentType
		if (contentType.startsWith("image/") && contentType !== "image/svg+xml") {
			const kind = sniffImage(bytes)
			if (!kind) return refuse("not-an-image", "not an image")
			// Name it for what it is: a real PNG called report.jpg should arrive as image/png.
			attachmentType = kind.contentType
		}

		// Same content, same part: a report linked from two places is attached once.
		const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16)
		const existing = byCid.get(`file-${digest}`)
		const name = existing?.filename ?? filename
		if (!existing) {
			if (total + bytes.length > maxTotal) {
				return refuse("too-large", `${Math.round(bytes.length / 1024)} KB, over the limit`)
			}
			const attachment: InlineAttachment = {
				filename,
				content: bytes,
				contentType: attachmentType,
				contentDisposition: "attachment",
			}
			byCid.set(`file-${digest}`, attachment)
			attachments.push(attachment)
			total += bytes.length
		}
		return `${inner} <span style="opacity:.7">[attached: ${escapeHtml(name)}]</span>`
	})

	return { html: withLinks, attachments, skipped }
}
