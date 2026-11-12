import { test } from "node:test"
import assert from "node:assert/strict"

import { renderBody, renderInline, renderMarkdown } from "../src/core/markdown.ts"

test("emphasis and code render", () => {
	assert.equal(renderInline("**bold**"), "<strong>bold</strong>")
	assert.equal(renderInline("__bold__"), "<strong>bold</strong>")
	assert.equal(renderInline("*italic*"), "<em>italic</em>")
	assert.equal(renderInline("~~gone~~"), "<s>gone</s>", "markdown-it uses <s> for strikethrough")
	assert.equal(renderInline("`x = 1`"), "<code>x = 1</code>")
})

test("emphasis inside a code span is not interpreted", () => {
	assert.equal(renderInline("`**not bold**`"), "<code>**not bold**</code>")
})

test("a fenced block keeps its content and escapes it", () => {
	const html = renderMarkdown("```js\nif (a < b && c) {}\n```")
	assert.match(html, /<pre><code class="language-js">/)
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
	assert.match(html, /<table>/)
	assert.match(html, /<th>a<\/th>\s*<th>b<\/th>/)
	assert.match(html, /<td>1<\/td>\s*<td>2<\/td>/)
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

test("the footer after -- is literal text", () => {
	const html = renderBody("answer **here**\n\n--\ndevice: x")
	assert.match(html, /<strong>here<\/strong>/)
	assert.match(html, /<pre class="signature"/)
	assert.match(html, /--\ndevice: x/)
	assert.doesNotMatch(html, /<h2>/)
})

test("empty and whitespace-only input are harmless", () => {
	assert.equal(renderMarkdown(""), "")
	assert.equal(renderMarkdown("   \n\n  "), "")
	assert.equal(renderBody(""), "")
})
