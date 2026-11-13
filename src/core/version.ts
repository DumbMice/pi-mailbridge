// Which build is this? Diagnostic only - compatibility is `daemon/api.ts` (API_VERSION).
//
// The extension is loaded by pi and the daemon is a child process; after `pi update` the child
// can still be executing the previous build. `/health` carries this string so a session can
// notice and replace it, instead of talking to a daemon that mints routing ids it cannot resolve.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const cache = new Map<string, string>()

/**
 * The version from the package.json that owns this module.
 *
 * `dist/daemon/main.js` and `src/daemon/main.ts` are both two levels below the package root, so
 * one lookup works for a checkout and for an installed build. Unknown is reported as `"unknown"`
 * rather than guessing: a caller that cannot compare should do nothing.
 */
export function packageVersion(moduleUrl: string | URL): string {
	const key = String(moduleUrl)
	const cached = cache.get(key)
	if (cached !== undefined) return cached

	// Walk up rather than assuming a depth: `src/extension.ts` is one level below the package
	// root, `src/daemon/main.ts` and its compiled twin are two, and a test file is one.
	let version = "unknown"
	let dir = dirname(fileURLToPath(moduleUrl))
	for (let depth = 0; depth < 5; depth += 1) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown }
			if (typeof parsed.version === "string" && parsed.version.length > 0) {
				version = parsed.version
				break
			}
		} catch {
			/* keep walking */
		}
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	cache.set(key, version)
	return version
}
