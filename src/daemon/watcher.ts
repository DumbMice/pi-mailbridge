// IMAP IDLE watcher. Port of opencode-afk `core/watcher.js`.
//
// One connection for the whole machine, owned by the daemon. Ported constants:
//   - renew IDLE well under the server's ~29-minute timeout
//   - let imapflow auto-start IDLE after a quiet period
//   - exponential reconnect, bounded
//
// TODO: implement. Contract below is fixed so process.ts can be written first.

import type { ResolvedConfig } from "../core/config.ts"

export const DEFAULT_IDLE_RENEW_MS = 25 * 60 * 1000
export const DEFAULT_AUTO_IDLE_DELAY_MS = 1000
export const DEFAULT_BACKOFF_INITIAL_MS = 1000
export const DEFAULT_BACKOFF_MAX_MS = 60_000

export interface WatcherCallbacks {
	/** Fired when the server reports new messages. Must not throw. */
	onMail: () => void
	/** Fired once the connection is usable, so a catch-up scan can run. */
	onReady: () => void
}

export interface WatcherHandle {
	stop(): Promise<void>
	isHealthy(): boolean
}

/**
 * Start the single IDLE connection.
 *
 * Ported invariants:
 *   - never log credentials; imapflow `logger: false`
 *   - `AFK_DEBUG=1`-style gated debug logging, errors always to stderr
 *   - errors are summarised from `responseStatus`/`responseText` only
 */
export async function startWatcher(_config: ResolvedConfig, _callbacks: WatcherCallbacks): Promise<WatcherHandle> {
	throw new Error("pi-mailbridge: watcher not implemented yet")
}
