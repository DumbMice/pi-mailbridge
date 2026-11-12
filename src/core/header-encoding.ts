// RFC 2047 header decoding.
//
// Headers are read raw on purpose: `Authentication-Results` must keep its original
// order and multiplicity, which most MIME parsers collapse. The cost is that any
// header a mail client decides to encode arrives as `=?charset?B?...?=` words.
//
// That is not an edge case. A subject containing one non-ASCII character — an em
// dash, a Chinese session name — is encoded *whole*, so the routing token inside it
// becomes unreadable and every reply looks like `no-token`. This module decodes it.
//
// Node ships full ICU, so `TextDecoder` handles legacy charsets like gb2312/gbk
// without adding a dependency (verified: `new TextDecoder("gb2312")` works).

/** One encoded word: =?charset?B|Q?text?= */
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g

function decodeQ(text: string): Buffer {
	// RFC 2047 §4.2: `_` means space; `=XX` is a hex byte.
	const spaced = text.replace(/_/g, " ")
	const bytes: number[] = []
	for (let i = 0; i < spaced.length; i++) {
		const char = spaced[i]!
		if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(spaced.slice(i + 1, i + 3))) {
			bytes.push(Number.parseInt(spaced.slice(i + 1, i + 3), 16))
			i += 2
			continue
		}
		bytes.push(char.charCodeAt(0))
	}
	return Buffer.from(bytes)
}

function decodeBytes(bytes: Buffer, charset: string): string {
	try {
		return new TextDecoder(charset.trim().toLowerCase()).decode(bytes)
	} catch {
		// Unknown or unsupported charset: UTF-8 is the best guess and never throws
		// on valid bytes, so a reply is not lost because of a weird label.
		return bytes.toString("utf8")
	}
}

/**
 * Decode every RFC 2047 encoded word in `value`.
 *
 * Whitespace *between* adjacent encoded words is dropped, per RFC 2047 §6.2 —
 * clients split long encoded subjects on spaces, and keeping that space would
 * corrupt the decoded text (and the token inside it).
 */
export function decodeRfc2047(value: string | undefined | null): string {
	if (!value) return ""
	if (!value.includes("=?")) return value.replace(/\r?\n\s*/g, " ").trim()

	let out = ""
	let lastIndex = 0
	let matched = false

	for (const match of value.matchAll(ENCODED_WORD)) {
		const index = match.index ?? 0
		const between = value.slice(lastIndex, index)
		// Before the first word, keep the prefix verbatim. Between two encoded words,
		// drop it only when it is pure whitespace (RFC 2047 §6.2).
		if (!matched || !/^\s*$/.test(between)) out += between

		const [, charset = "", encoding = "", text = ""] = match
		const bytes = encoding.toUpperCase() === "B" ? Buffer.from(text, "base64") : decodeQ(text)
		out += decodeBytes(bytes, charset)

		lastIndex = index + match[0].length
		matched = true
	}

	out += value.slice(lastIndex)
	return out.replace(/\r?\n\s*/g, " ").trim()
}
