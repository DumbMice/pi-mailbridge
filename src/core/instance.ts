// This run's identity, as the daemon sees it.
//
// Not the pid alone. The daemon keys a session's email-mode override on this id, keeps it for 24 h and
// refreshes it on every ping - and a pid is recycled. A session killed with SIGKILL never sends
// `/bye`, so its override survives; a later process that happens to receive the same pid would then
// inherit a decision it never made (quiet without asking, or mailing without asking, which is worse).
// A random suffix makes the id unique per process lifetime for four bytes and one call.

import { randomBytes } from "node:crypto"

/**
 * `pi-<pid>-<8 hex>`. The pid is kept because it is what a human reads in a log; the suffix is what
 * makes it an identity. `random` is injectable so the uniqueness can be tested without mocking crypto.
 */
export function sessionInstanceId(
	pid: number = process.pid,
	random: () => string = () => randomBytes(4).toString("hex"),
): string {
	return `pi-${pid}-${random()}`
}
