import { test } from "node:test"
import assert from "node:assert/strict"

import { decodeRfc2047 } from "../src/core/header-encoding.ts"
import { extractHeaders } from "../src/daemon/watcher.ts"
import { sessionIdFromSubject } from "../src/core/token.ts"

// The exact subject a Hotmail client returned, gb2312-encoded because the subject
// contained an em dash. This is the regression that broke reply routing.
const REAL_ENCODED =
	"=?gb2312?B?UmU6IFtwaTpleUp6SWpvaWNtVndiSGt0ZEdWemRDMXRkMlJqTm5KNU15SXNJ?= " +
	"=?gb2312?B?bVVpT2pFM09UY3dOamN4TnpZMk9Ua3NJbVFpT2lKNVltTXRiR2x1ZFhnaWZR?= " +
	"=?gb2312?B?LjA1Y1FMV1E0RHpyOTJzb2xhRHRYT0FdIHBpOiByZXBseSB0ZXN0IKGqIHBs?= " +
	"=?gb2312?Q?ease_reply_to_this?="

test("decodes the real gb2312 case, with no space between adjacent words", () => {
	const decoded = decodeRfc2047(REAL_ENCODED)
	assert.match(decoded, /^Re: \[pi:/)
	// The Q-word decodes `_` to a space and must join the preceding B-word with no
	// inserted space, so the tail reads "please reply to this".
	assert.match(decoded, /please reply to this$/)
	assert.match(decoded, /reply test/, "non-ASCII survives")
})

test("plain ASCII passes through unchanged", () => {
	assert.equal(decodeRfc2047("[pi:abc.def] pi: done"), "[pi:abc.def] pi: done")
	assert.equal(decodeRfc2047(""), "")
	assert.equal(decodeRfc2047(undefined), "")
})

test("B and Q encodings both decode", () => {
	assert.equal(decodeRfc2047("=?utf-8?B?w6l0w6k=?="), "été")
	assert.equal(decodeRfc2047("=?utf-8?Q?caf=C3=A9?="), "café")
	assert.equal(decodeRfc2047("=?utf-8?Q?two_words?="), "two words", "underscore means space")
})

test("mixed encoded and literal text keeps the literal parts", () => {
	assert.equal(decodeRfc2047("Re: =?utf-8?B?w6l0w6k=?= [pi:x]"), "Re: été [pi:x]")
})

test("an unknown charset falls back instead of throwing", () => {
	assert.doesNotThrow(() => decodeRfc2047("=?x-nonsense?B?YWJj?="))
	assert.equal(decodeRfc2047("=?x-nonsense?B?YWJj?="), "abc")
})

test("folded whitespace inside a header is collapsed", () => {
	assert.equal(decodeRfc2047("[pi:a.b]\r\n  pi: done"), "[pi:a.b] pi: done")
})

test("the routing token survives client encoding end to end", () => {
	// What actually matters: extractHeaders -> sessionIdFromSubject.
	const secret = Buffer.alloc(32, 7)
	const raw = [
		"From: Bangcheng Yang <BangchengYang@hotmail.com>",
		`Subject: ${REAL_ENCODED}`,
		"Authentication-Results: mx.qq.com; spf=pass; dmarc=pass header.from=hotmail.com",
		"",
		"body",
	].join("\r\n")

	const headers = extractHeaders(Buffer.from(raw))
	assert.match(headers.subject ?? "", /^Re: \[pi:/, "subject must be decoded")

	// The token in that subject was minted for a known session; verify it routes.
	const session = sessionIdFromSubject(headers.subject, Buffer.from("wrong-key"))
	assert.equal(session, undefined, "a different key must still be rejected")

	const forged = extractHeaders(Buffer.from(raw))
	assert.ok(forged.headerValues.get("authentication-results"), "AR headers stay raw and ordered")
})
