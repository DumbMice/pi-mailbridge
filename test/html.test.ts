import { test } from "node:test"
import assert from "node:assert/strict"

import { escapeHtml, textToHtml } from "../src/core/html.ts"
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
		notify: { onSettled: true, debounceMs: 0, notifyOnAborted: false, subject: "pi" },
		tuning: { idleRenewMs: 1, autoIdleDelayMs: 1, backoffInitialMs: 1, backoffMaxMs: 2 },
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
	assert.ok(!html.includes("white-space"), "no reliance on pre-wrap")
})

test("the signature block is literal, not Markdown", () => {
	// `--` after a text line is a setext heading underline; rendering the footer as
	// Markdown would swallow it into an <h2>. The delimiter line itself is not printed,
	// because the block's top border is the divider in HTML.
	const html = textToHtml("answer\n\n--\ndevice: ybc-linux\nturns: 3")
	assert.match(html, /<pre class="signature"[^>]*border-top/)
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
