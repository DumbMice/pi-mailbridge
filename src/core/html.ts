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
 * Render plain text as minimal HTML.
 *
 * Newlines become `<br>`, deliberately: an earlier version relied on
 * `white-space: pre-wrap`, and clients that sanitise inline styles (Outlook web
 * does) collapsed the whole body onto one line. Structure in the markup survives
 * sanitising; CSS does not.
 */
export function textToHtml(text: string): string {
	const escaped = escapeHtml(text).replace(/\r?\n/g, "<br>\n")
	return [
		'<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45">',
		escaped,
		"</div>",
	].join("")
}
