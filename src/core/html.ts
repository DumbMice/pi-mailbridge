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
 * Render plain text as a minimal HTML document body.
 *
 * `white-space: pre-wrap` keeps the layout without turning every newline into a
 * `<br>`, which keeps the markup small and the text copyable.
 */
export function textToHtml(text: string): string {
	return [
		'<div style="white-space:pre-wrap;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45">',
		escapeHtml(text),
		"</div>",
	].join("")
}
