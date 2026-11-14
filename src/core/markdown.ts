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

// --- email-safe styling ------------------------------------------------------
//
// markdown-it emits bare tags. Mail clients default to *no* table borders, so a table
// arrived as loose text; and a `<style>` block is stripped by several clients. Inline
// styles on each cell are what survive that, so the rendering rules are overridden
// rather than the output being post-processed.

const CELL_BORDER = "border:1px solid #c8ccd1"
/** A path in a cell is one unbreakable token; without this the table widens past the pane. */
const CELL_WRAP = "word-break:break-word;overflow-wrap:anywhere"

/**
 * Merge our style with any attributes markdown-it already set (alignment, mostly).
 * `attrs` is typed loosely because @types/markdown-it uses its own TokenAttribute
 * shape; it is always a list of name/value pairs at runtime.
 */
function styledTag(name: string, rawAttrs: unknown, extra: string): string {
	const pairs = Array.isArray(rawAttrs) ? (rawAttrs as [string, string][]) : []
	const attrs = new Map<string, string>(pairs)
	const existing = attrs.get("style")
	attrs.set("style", existing ? `${existing};${extra}` : extra)
	// cellspacing/cellpadding are attributes, not CSS, and survive sanitising better.
	const rendered = [...attrs].map(([key, value]) => ` ${key}="${md.utils.escapeHtml(value)}"`).join("")
	return `<${name}${rendered}>`
}

md.renderer.rules.table_open = () =>
	'<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:10px 0;font-size:13px">'
md.renderer.rules.th_open = (tokens, idx) =>
	styledTag(
		"th",
		tokens[idx]?.attrs,
		`${CELL_BORDER};padding:6px 10px;background:#f2f4f7;text-align:left;${CELL_WRAP}`,
	)
md.renderer.rules.td_open = (tokens, idx) =>
	styledTag("td", tokens[idx]?.attrs, `${CELL_BORDER};padding:6px 10px;${CELL_WRAP}`)

const MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
/**
 * Wrapping, not scrolling.
 *
 * `overflow:auto` is the obvious choice and the wrong one for mail: Gmail and Outlook strip or
 * ignore it on <pre>, so a 180-character line - a rule drawn with box-drawing characters, a long
 * shell command, a wide table row - does not scroll inside the block, it widens the whole message
 * until the reader has to scroll sideways through every line of it. pre-wrap keeps the block inside
 * the reading pane; break-word keeps one unbreakable token (a long path) from doing the same.
 */
const CODE_BLOCK_STYLE = `white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;overflow:auto`
md.renderer.rules.fence = (tokens, idx) => {
	const token = tokens[idx]!
	const language = token.info.trim().split(/\s+/)[0] ?? ""
	const cls = language ? ` class="language-${md.utils.escapeHtml(language)}"` : ""
	return (
		`<pre style="background:#f6f8fa;${CELL_BORDER};border-radius:4px;padding:10px;${CODE_BLOCK_STYLE};${MONO};font-size:13px">` +
		`<code${cls}>${md.utils.escapeHtml(token.content)}</code></pre>`
	)
}
md.renderer.rules.code_inline = (tokens, idx) =>
	// Inline code carries paths and commands too; one long one would blow the line out the same way.
	`<code style="background:#f2f4f7;border-radius:3px;padding:1px 4px;overflow-wrap:anywhere;${MONO};font-size:13px">${md.utils.escapeHtml(tokens[idx]!.content)}</code>`


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
	const tailLines = text.slice(index).split("\n")
	// The `--` line itself is dropped in HTML: the top border is the divider there. It
	// stays in the text part, where RFC 3676 needs it and quote stripping relies on it.
	const tail = (tailLines[0]?.trim() === "--" ? tailLines.slice(1) : tailLines).join("\n")
	// A visible divider, but literal text: rendering `--` as Markdown would make it a
	// setext heading underline and swallow the body above it.
	const signatureStyle = "font:inherit;opacity:.75;margin:18px 0 0;padding-top:10px;border-top:1px solid #d8dee4"
	return `${renderMarkdown(head)}\n<pre class="signature" style="${signatureStyle}">${escapeHtml(tail)}</pre>`
}
