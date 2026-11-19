// One sanitizer for text that ends up in a mail.
//
// Two copies of this existed (a refusal detail and a tmux pane capture) with different caps. They are the
// same job: strip terminal escapes and control bytes, normalise line endings, and bound the length so a
// pane dump cannot become a megabyte of mail. The callers keep their own caps.

/**
 * Strip ANSI escapes and control bytes, optionally normalise CRLF, trim, and cut to `max` characters.
 *
 * CRLF normalisation is a parameter because the two original callers differed: a refusal detail was
 * normalised, a tmux pane capture was not. Folding them together silently changed the pane path (and where
 * the 2 000-character cut falls), so the difference is carried explicitly instead.
 */
export function cleanDiagnostic(text: string, max = 1_500, normalizeCrlf = true): string {
	// Order matters: control bytes are stripped first, so `\r\u0000\n` collapses to `\r\n` and may then be
	// normalised. Normalising first left that pair as CRLF, which the old refusal sanitizer did not.
	const stripped = text
		.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
	const clean = (normalizeCrlf ? stripped.replace(/\r\n/g, "\n") : stripped).trim()
	return clean.length > max ? `${clean.slice(0, max)}…` : clean
}
