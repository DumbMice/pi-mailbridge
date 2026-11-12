// HTML alternative for outbound mail.
//
// Mail clients collapse quoted history only when the original is HTML: they quote it
// as a <blockquote> they can fold away. A text/plain-only mail gets quoted as raw
// lines, so a reply thread reads as walls of repeated text.
//
// So every message now goes out as multipart/alternative: `text` (the fallback, and
// what the scanner would see if pi ever read its own mail) plus `html`.
//
// Escaping is not optional. The body is model output — it can contain `<`, `&`, or
// something that looks like markup — and an unescaped interpolation would inject
// into the recipient's mail client.

import { renderBody } from "./markdown.ts"
import { inlineLocalImages, type InlineAttachment, type SkippedImage } from "./inline-images.ts"

const ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
}

/** Escape text for safe interpolation into HTML. */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char)
}

/**
 * Render a mail body as HTML.
 *
 * The agent answers in Markdown, so it is rendered (core/markdown.ts) instead of being
 * shown as literal `**bold**` and fence markers. Structure lives in the markup, not in
 * CSS: clients that sanitise inline styles (Outlook web does) would collapse anything
 * that relied on `white-space: pre-wrap`.
 */
export function textToHtml(text: string): string {
	return [
		'<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45">',
		renderBody(text),
		"</div>",
	].join("")
}

export interface RenderedMessage {
	html: string
	attachments: InlineAttachment[]
	skipped: SkippedImage[]
}

/**
 * Full HTML body plus any images that had to be inlined.
 * `root` is the agent's working directory, used to resolve relative image paths.
 */
export function renderMessage(text: string, options: { root?: string } = {}): RenderedMessage {
	const rendered = inlineLocalImages(textToHtml(text), options)
	return { html: rendered.html, attachments: rendered.attachments, skipped: rendered.skipped }
}
