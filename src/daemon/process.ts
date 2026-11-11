// Scan → fetch → parse → persist. Port of opencode-afk `core/process.js`.
//
// The ordering here IS the correctness property (see docs/ARCHITECTURE.md §2):
//
//   1. search UID  <uid> *          — UID cursor, never \Seen, never SUBJECT
//   2. fetch envelope + source
//   3. parse body, strip quotes, extract and verify the routing token
//   4. persist to the durable pending store     <- nothing is lost after this
//   5. advance the cursor
//   6. broadcast for claiming                   <- sessions act on it
//
// Marking \Seen and journaling happen only in the daemon's /ack handler, after a
// session has injected the reply. Doing it here would lose replies on a crash.
//
// TODO: implement.

import type { ResolvedConfig } from "../core/config.ts"

export interface ScanResult {
	/** New UIDs examined this scan. */
	examined: number
	/** Deliveries persisted (token verified, sender authorized). */
	persisted: number
	/** Rejected for any reason; no state written. */
	rejected: number
}

export async function scanAndProcess(_config: ResolvedConfig): Promise<ScanResult> {
	throw new Error("pi-mailbridge: scan pipeline not implemented yet")
}
