// Pin `security.trustedAuthservId` from a header the provider wrote.
//
// The value is the receiving server's own `authserv-id` (the token before the first `;` in
// `Authentication-Results`). Nobody can hand it to a user: it is observable only in a delivered
// message, and guessing it pins the wrong thing. The one place it can be learned safely is a copy of
// a message *we* sent to ourselves - its headers are the provider's work, not a sender's choice - so
// `--smoke` reads it there and this writes it once.
//
// It is set only when the field is unset and DMARC is required: an explicit value is never
// overwritten, and pinning while `requireDmarcPass` is off would change nothing but surprise.

import { readFileSync, renameSync, writeFileSync } from "node:fs"

import { configPath } from "./paths.ts"

export interface PinResult {
	/** True when the file was rewritten. */
	pinned: boolean
	/** Why not, when `pinned` is false. */
	reason?: "already-set" | "not-required" | "no-config" | "no-value"
}

export function pinAuthservId(
	env: NodeJS.ProcessEnv,
	candidate: string | undefined,
): PinResult {
	if (!candidate?.trim()) return { pinned: false, reason: "no-value" }
	const path = configPath(env)
	let parsed: Record<string, unknown>
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
	} catch {
		return { pinned: false, reason: "no-config" }
	}
	const security = (parsed.security ?? {}) as Record<string, unknown>
	if (security.requireDmarcPass !== true) return { pinned: false, reason: "not-required" }
	const current = typeof security.trustedAuthservId === "string" ? security.trustedAuthservId.trim() : ""
	if (current) return { pinned: false, reason: "already-set" }

	parsed.security = { ...security, trustedAuthservId: candidate.trim().toLowerCase() }
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
	renameSync(tmp, path)
	return { pinned: true }
}
