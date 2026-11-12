// Should a session tell the running daemon to re-read its config?
//
// A session that attaches to an already-running daemon inherits whatever config that daemon
// read - which may predate a hand-edited config.json or a headless `--setup`. Sending mail
// with a replaced address is the failure this exists to prevent.
//
// The daemon reports the *mtime of the file it is running on*, and the extension compares it
// with the file's current mtime. mtime-to-mtime deliberately: a clock reading would make a
// preserved/backdated mtime reload forever, and would hide a write that landed between the
// read and the timestamp.

export interface Freshness {
	/**
	 * The mtime of the config file the daemon is running on (NOT the time it read it), or 0
	 * when it loaded with no file, or null/undefined if it did not report one.
	 */
	configLoadedAt: number | null | undefined
	/** The config file's mtime, or null when there is no file (built-in defaults). */
	configMtimeMs: number | null | undefined
}

export function shouldReloadConfig({ configLoadedAt, configMtimeMs }: Freshness): boolean {
	// No file: nothing changed, leave the daemon alone.
	if (!configMtimeMs) return false
	// The daemon reports 0 when it loaded while there was no config file. That is not
	// "nothing to compare" - it is a daemon running on defaults, and a file that has since
	// appeared must be picked up. Treating 0 as absent made this state permanent.
	if (!configLoadedAt) return true
	// Strictly newer. No slack: a re-trigger is impossible when both sides are the same
	// file's mtime, and a tolerance would permanently miss a save that lands within it
	// (an editor that writes twice), which is the failure this check exists to prevent.
	return configMtimeMs > configLoadedAt
}
