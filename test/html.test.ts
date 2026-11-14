import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { escapeHtml, renderMessage, textToHtml } from "../src/core/html.ts"
import { sendMail, type TransportLike } from "../src/core/mailer.ts"
import type { ResolvedConfig } from "../src/core/config.ts"

function config(): ResolvedConfig {
	return {
		mail: {
			imap: { host: "imap.example.com", port: 993, secure: true, user: "pi@example.com", password: "x", folder: "INBOX" },
			smtp: { host: "smtp.example.com", port: 465, secure: true, user: "pi@example.com", password: "x", authType: "LOGIN" },
			to: "you@example.com",
		},
		device: { name: "test-device" },
		security: { allowFrom: ["you@example.com"], requireDmarcPass: false, tokenTtlHours: 24 },
		daemon: { host: "127.0.0.1", port: 4177 },
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false, maxAttachmentMb: 18 },
		tuning: { idleRenewMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
		warnings: [],
	}
}

test("escapeHtml covers every dangerous character", () => {
	assert.equal(escapeHtml(`<script>alert("x")</script> & 'quoted'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;")
	assert.equal(escapeHtml("plain text, no markup"), "plain text, no markup")
})

test("model output cannot inject markup into the mail body", () => {
	// The body is model output, so this has to hold for hostile-looking text.
	const body = `here is <img src=x onerror=alert(1)> and <a href="javascript:x">a link</a>`
	const html = textToHtml(body)
	assert.doesNotMatch(html, /<img/)
	assert.doesNotMatch(html, /<a /)
	assert.match(html, /&lt;img/)
	assert.match(html, /&lt;a href=&quot;javascript:x&quot;&gt;/)
})

test("line structure lives in the markup, not in CSS", () => {
	const html = textToHtml("line one\nline two\n\n--\ndevice: x")
	// A client that strips `style` must still render separate lines.
	assert.match(html, /<p>line one<br>\nline two<\/p>/)
	// The *paragraph path* must not depend on styling. The signature block does use
	// `white-space: pre-wrap` - to wrap long footer tokens rather than widen the mail - and the
	// old document-wide assertion here could not tell the two apart.
	const wrapper = /<div style="([^"]*)"[\s\S]*?<p>line one/.exec(html)?.[1]
	assert.ok(wrapper !== undefined, "the wrapper div should be found")
	assert.doesNotMatch(wrapper, /white-space/)
})

test("the signature block is literal, not Markdown", () => {
	// `--` after a text line is a setext heading underline; rendering the footer as
	// Markdown would swallow it into an <h2>. The delimiter line itself is not printed,
	// because the block's top border is the divider in HTML.
	const html = textToHtml("answer\n\n--\ndevice: ybc-linux\nturns: 3")
	assert.match(html, /<pre class="signature"[^>]*border-top/)
	// Long footer tokens (`project: <cwd>`, `session id:`) must wrap like a fence does.
	const signature = /<pre class="signature" style="([^"]+)"/.exec(html)?.[1] ?? ""
	assert.match(signature, /white-space:pre-wrap/)
	assert.match(signature, /overflow-wrap:anywhere/)
	assert.ok(
		signature.indexOf("word-wrap") < signature.indexOf("overflow-wrap"),
		`the alias must precede the standard property: ${signature}`,
	)
	assert.match(html, /device: ybc-linux\nturns: 3/)
	assert.doesNotMatch(html, />\s*--\s*</)
	assert.doesNotMatch(html, /<h2>/)
})

test("the message goes out as text plus html", async () => {
	const sent: Record<string, unknown>[] = []
	const factory = (): TransportLike => ({
		async sendMail(mail) {
			sent.push(mail as Record<string, unknown>)
			return { messageId: "<x@y>" }
		},
	})

	await sendMail(config(), { to: "you@example.com", subject: "pi: x", text: "done & <ok>" }, { transportFactory: factory })

	assert.equal(sent[0]!.text, "done & <ok>", "the text part is unchanged")
	assert.match(String(sent[0]!.html), /done &amp; &lt;ok&gt;/, "the html part is escaped")
	assert.match(String(sent[0]!.html), /<div style=/, "so clients treat it as html and fold quotes")
})

test("a notification that links a report mails the report too", () => {
	// End to end through renderMessage: markdown link -> anchor -> attachment with a real name.
	const root = mkdtempSync(join(tmpdir(), "html-link-"))
	writeFileSync(join(root, "build.log"), "line 1\nline 2\n")
	const rendered = renderMessage("Build finished. See [the log](./build.log).", { root })
	const file = rendered.attachments.find((a) => a.filename === "build.log")
	assert.ok(file, `expected build.log, got ${JSON.stringify(rendered.attachments.map((a) => a.filename))}`)
	assert.equal(file!.contentType, "text/plain")
	assert.equal(file!.contentDisposition, "attachment")
	assert.match(rendered.html, /\[attached: build\.log\]/)
})

test("a linked file's bytes are what gets attached", () => {
	// Content was never asserted: an empty or wrong payload would have passed.
	const root = mkdtempSync(join(tmpdir(), "html-bytes-"))
	const bytes = Buffer.from("line one\nline two\n")
	writeFileSync(join(root, "build.log"), bytes)
	const rendered = renderMessage("see [log](./build.log)", { root })
	const file = rendered.attachments.find((a) => a.filename === "build.log")!
	assert.deepEqual(file.content, bytes)
})
