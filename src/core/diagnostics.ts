// One sanitizer for text that ends up in a mail.
//
// Two copies of this existed (a refusal detail and a tmux pane capture) with different caps. They are the
// same job: strip terminal escapes and control bytes, normalise line endings, and bound the length so a
// pane dump cannot become a megabyte of mail. The callers keep their own caps.

/** Strip ANSI escapes and control bytes, normalise CRLF, trim, and cut to `max` characters. */
export function cleanDiagnostic(text: string, max = 1_500): string {
	const clean = text
		.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
		.replace(/\r\n/g, "\n")
		.trim()
	return clean.length > max ? `${clean.slice(0, max)}…` : clean
}
