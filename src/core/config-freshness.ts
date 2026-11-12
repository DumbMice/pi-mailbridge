// Should a session tell the running daemon to re-read its config?
//
// A session that attaches to an already-running daemon inherits whatever config that daemon
// read - which may predate a hand-edited config.json or a headless `--setup`. Sending mail
// with a replaced address is the failure this exists to prevent, so the daemon reports when
// it last read its config and the extension compares it with the file's mtime.

export interface Freshness {
	/** When the daemon last read its config, or null if it did not report one. */
	configLoadedAt: number | null | undefined
	/** The config file's mtime, or null when there is no file (built-in defaults). */
	configMtimeMs: number | null | undefined
}

export function shouldReloadConfig({ configLoadedAt, configMtimeMs }: Freshness): boolean {
	// Nothing to compare against: leave the daemon alone rather than restarting its watcher
	// on every session start.
	if (!configLoadedAt || !configMtimeMs) return false
	// One second of slack: mtime has coarser resolution than the clock on some filesystems,
	// and a reload triggered by a fresh write must not re-trigger on the next session.
	return configMtimeMs > configLoadedAt + 1_000
}
