import { test } from "node:test"
import assert from "node:assert/strict"

import { renderBody, renderInline, renderMarkdown } from "../src/core/markdown.ts"
import { renderMessage } from "../src/core/html.ts"

test("emphasis and code render", () => {
	assert.equal(renderInline("**bold**"), "<strong>bold</strong>")
	assert.equal(renderInline("__bold__"), "<strong>bold</strong>")
	assert.equal(renderInline("*italic*"), "<em>italic</em>")
	assert.equal(renderInline("~~gone~~"), "<s>gone</s>", "markdown-it uses <s> for strikethrough")
	assert.match(renderInline("`x = 1`"), /^<code[^>]*>x = 1<\/code>$/)
})

test("emphasis inside a code span is not interpreted", () => {
	assert.match(renderInline("`**not bold**`"), /^<code[^>]*>\*\*not bold\*\*<\/code>$/)
})

test("a fenced block keeps its content and escapes it", () => {
	const html = renderMarkdown("```js\nif (a < b && c) {}\n```")
	assert.match(html, /<pre[^>]*><code class="language-js">/)
	assert.match(html, /if \(a &lt; b &amp;&amp; c\) \{\}/)
	assert.doesNotMatch(html, /<code class="language-js">if \(a < b/)
})

test("headings, rules, lists and quotes", () => {
	assert.match(renderMarkdown("## Title"), /<h2>Title<\/h2>/)
	assert.match(renderMarkdown("---"), /<hr>/)
	// markdown-it puts each list item on its own line, so match across whitespace.
	assert.match(renderMarkdown("- one\n- two"), /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/)
	assert.match(renderMarkdown("1. first\n2. second"), /<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/)
	assert.match(renderMarkdown("> quoted"), /<blockquote>[\s\S]*quoted[\s\S]*<\/blockquote>/)
})

test("a table renders with a header row", () => {
	const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")
	assert.match(html, /<table[^>]*>/)
	assert.match(html, /<th[^>]*>a<\/th>\s*<th[^>]*>b<\/th>/)
	assert.match(html, /<td[^>]*>1<\/td>\s*<td[^>]*>2<\/td>/)
})

test("only safe link schemes become anchors", () => {
	assert.equal(renderInline("[docs](https://example.com)"), '<a href="https://example.com">docs</a>')
	assert.equal(renderInline("[mail](mailto:a@b.co)"), '<a href="mailto:a@b.co">mail</a>')
	// markdown-it's validateLink refuses these, so they stay literal text.
	assert.doesNotMatch(renderInline("[x](javascript:alert(1))"), /<a /)
	assert.doesNotMatch(renderInline("[x](data:text/html,hi)"), /<a /)
	assert.doesNotMatch(renderInline("[x](vbscript:msgbox)"), /<a /)
})

test("bare URLs become links, which is most of the value of an email", () => {
	assert.match(renderInline("see https://example.com ok"), /<a href="https:\/\/example.com">/)
})

test("model output cannot inject markup", () => {
	const html = renderMarkdown('<img src=x onerror=alert(1)> and <script>x</script>')
	assert.doesNotMatch(html, /<img/)
	assert.doesNotMatch(html, /<script/)
	assert.match(html, /&lt;img/)
})

test("single newlines inside a paragraph are preserved", () => {
	assert.equal(renderMarkdown("a\nb"), "<p>a<br>\nb</p>")
})

test("the footer is literal text with a border, and no repeated --", () => {
	const html = renderBody("answer **here**\n\n--\ndevice: x\nsession id: y")
	assert.match(html, /<strong>here<\/strong>/)
	assert.match(html, /<pre class="signature"[^>]*border-top:1px solid/)
	// The border is the divider in HTML; printing `--` as well reads as a duplicate.
	assert.doesNotMatch(html, />\s*--\s*</, "the delimiter line must not be rendered")
	assert.match(html, /device: x\nsession id: y/, "the metadata itself is untouched")
	assert.doesNotMatch(html, /<h2>/, "and it is not parsed as a setext heading")
})

test("empty and whitespace-only input are harmless", () => {
	assert.equal(renderMarkdown(""), "")
	assert.equal(renderMarkdown("   \n\n  "), "")
	assert.equal(renderBody(""), "")
})

test("table cells carry borders inline, since clients default to none", () => {
	// markdown-it emits bare <table>; without inline borders a table arrives as loose
	// text. A <style> block is stripped by several clients, so the styles are inline.
	const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")
	assert.match(html, /<table[^>]*border-collapse:collapse/)
	assert.match(html, /<th[^>]*border:1px solid/)
	assert.match(html, /<td[^>]*border:1px solid/)
	assert.match(html, /cellspacing="0"/, "table attributes survive sanitising better than CSS")
})

test("code blocks and inline code are visually distinct", () => {
	const block = renderMarkdown("```\nplain\n```")
	assert.match(block, /<pre[^>]*background:/)
	assert.match(block, /ui-monospace|monospace/)
	const inline = renderInline("`x`")
	assert.match(inline, /<code[^>]*background:/)
})

test("table alignment from Markdown is preserved alongside our style", () => {
	const html = renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |")
	assert.match(html, /text-align:left/, "our header alignment default remains")
	assert.match(html, /text-align:right/, "a right-aligned column keeps its alignment")
})

test("a long line in a code block wraps instead of widening the mail", () => {
	// A rule drawn with box-drawing characters (a pasted terminal capture), a long shell command, a
	// wide row: with `overflow:auto` alone, Gmail and Outlook ignore the scroll and stretch the
	// whole message, which is what a divider-looking line inside a fence did in a real reply.
	const rule = "─".repeat(180)
	const { html } = renderMessage("```\n" + rule + "\n```")
	const pre = /<pre style="([^"]+)"/.exec(html)?.[1] ?? ""
	assert.match(pre, /white-space:pre-wrap/, "wrapping, not scrolling")
	assert.match(pre, /word-break:break-word/)
	assert.match(pre, /overflow-wrap:anywhere/)
	assert.ok(html.includes(rule), "and the line is still there, unbroken")
	// `word-wrap` is the same property under a legacy name, so the last one wins. The alias must come
	// first, or a modern engine computes `break-word` and `anywhere` (the stronger value) is lost.
	assert.ok(
		pre.indexOf("word-wrap") < pre.indexOf("overflow-wrap"),
		`the alias must precede the standard property: ${pre}`,
	)
})

test("the wrapper wraps, so a long token outside a fence cannot widen the mail", () => {
	// The fence, the cells and inline code had rules; a paragraph, heading or link did not, and a
	// base64 blob or a hash pasted without a fence still stretched the mail. The wrapper div is
	// where that is fixed, and it inherits into p/h*/li/blockquote/a.
	const { html } = renderMessage("x".repeat(300))
	const div = /<div style="([^"]+)"/.exec(html)?.[1] ?? ""
	assert.match(div, /overflow-wrap:anywhere/)
	assert.match(div, /word-wrap:break-word/, "the legacy alias Outlook's engine honours")
})

test("a right-aligned column header keeps its alignment", () => {
	// Our `text-align:left` was appended after markdown-it's own alignment and won, so a `--:`
	// column had a left-aligned header over right-aligned cells. The presence-only assertion this
	// replaces passed either way.
	const html = renderBody("| left | right |\n|:--|--:|\n| 1 | 2 |")
	const headers = [...html.matchAll(/<th style="([^"]+)"/g)].map((m) => m[1] ?? "")
	assert.equal(headers.length, 2)
	assert.ok(
		headers[1]!.lastIndexOf("text-align:right") > headers[1]!.lastIndexOf("text-align:left"),
		`the later declaration wins: ${headers[1]}`,
	)
})

test("a long token in a table cell wraps, so the table cannot widen the mail", () => {
	const wide = "─".repeat(180)
	const { html } = renderMessage(`| a | b |\n| --- | --- |\n| ${wide} | x |`)
	const cell = /<td style="([^"]+)"/.exec(html)?.[1] ?? ""
	assert.match(cell, /word-break:break-word/)
	assert.match(cell, /overflow-wrap:anywhere/)
	const head = /<th style="([^"]+)"/.exec(html)?.[1] ?? ""
	assert.match(head, /overflow-wrap:anywhere/, "headers wrap too")
})

test("long inline code is breakable too", () => {
	const long = "/very/long/path/" + "segment/".repeat(30)
	const { html } = renderMessage("see `" + long + "`")
	const code = /<code style="([^"]+)"/.exec(html)?.[1] ?? ""
	assert.match(code, /overflow-wrap:anywhere/)
})

