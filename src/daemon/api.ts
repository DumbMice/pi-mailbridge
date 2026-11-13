// The wire contract between the extension and the daemon.
//
// Two numbers, two clocks, deliberately separate (AGENTS.md "Compatibility"):
//
//   API_VERSION  - the HTTP surface: endpoints, payload fields, semantics. Bumped by any
//                  breaking change to it; additive changes are gated by CAPABILITIES instead.
//   package version (version.ts) - diagnostic only: which build someone is running.
//
// The daemon and the extension are spawned from one package, so a mismatch is recovered by
// replacing the process rather than negotiating - but the *number* compared must be the
// protocol, not the build, or a harmless patch bump would restart a working daemon.

/** Bumped only for a breaking change to an endpoint, a payload shape, or a meaning. */
export const API_VERSION = 1

/**
 * Additive features inside API_VERSION.
 *
 * A client must check for a capability before using anything newer than the base contract, and
 * must not fake it when absent (no fallback paths: tell the user to update, or skip the feature).
 */
export const CAPABILITIES = ["health", "version", "pending", "claim", "ack", "send"] as const

export type Capability = (typeof CAPABILITIES)[number]

/** Every endpoint, in one place, so the schema test can freeze the surface. */
export const ENDPOINTS = [
	"GET /events",
	"GET /health",
	"GET /pending",
	"GET /withheld",
	"GET /mode",
	"POST /claim",
	"POST /ack",
	"POST /register",
	"DELETE /register",
	"POST /ping",
	"POST /bye",
	"POST /shutdown",
	"POST /reload",
	"POST /mode",
	"POST /send",
] as const

/**
 * Is a daemon speaking `theirs` usable by this build?
 *
 * Missing means "from before the field existed" - that is protocol 0, which this build cannot
 * assume anything about.
 */
export function apiCompatible(mine: number, theirs: number | undefined): boolean {
	return typeof theirs === "number" && theirs === mine
}
