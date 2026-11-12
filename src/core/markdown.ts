// Markdown → HTML for the mail body.
//
// The agent answers in Markdown. Sending it escaped means the reader sees `**bold**`,
// `| a | b |` and ``` fences in a client that could have rendered them.
//
// Rendering is delegated to **markdown-it**, configured to be safe by default rather
// than trusted:
//
//   - `html: false` — raw HTML in the model output is escaped, not passed through, so
//     there is no sanitiser to get wrong and nothing to lose on a library upgrade.
//   - `linkify: true` — bare URLs become links, which is most of the value of an email.
//   - markdown-it's own `validateLink` refuses `javascript:`, `vbscript:` and `data:`
//     hrefs, so a link in model output cannot become script in the reader's client.
//   - `breaks: true` — single newlines are `<br>`, matching how the body is written
//     (answer, then our fixed footer) instead of reflowing it into one paragraph.
//
// Dependency cost is markdown-it plus six small transitive packages (entities,
// linkify-it, mdurl, argparse, uc.micro, punycode.js), all from the same maintainers.

import MarkdownIt from "markdown-it"

const md = new MarkdownIt({
	html: false,
	linkify: true,
	breaks: true,
	typographer: false,
})

/** Inline Markdown (no block structure). */
export function renderInline(text: string): string {
	return md.renderInline(text)
}

/** Block Markdown as HTML, trimmed so callers can concatenate it. */
export function renderMarkdown(text: string): string {
	return md.render(text).trim()
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
}

/** The RFC 3676 signature delimiter, which our own body uses before its metadata. */
const FOOTER_SPLIT = /^--$/m

/**
 * Render an outbound body: Markdown above the `--` delimiter, literal text below it.
 *
 * The footer is deliberately not Markdown. A line of `--` after a text line is a setext
 * heading underline, so rendering it would swallow our metadata into an `<h2>`.
 */
export function renderBody(text: string): string {
	const index = text.search(FOOTER_SPLIT)
	if (index === -1) return renderMarkdown(text)

	const head = text.slice(0, index)
	const tail = text.slice(index)
	return `${renderMarkdown(head)}\n<pre class="signature" style="font:inherit;opacity:.75;margin:0">${escapeHtml(tail)}</pre>`
}
