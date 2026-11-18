// Where the compiled bootstrap extension lives, from this module's URL.
//
// The starter passes an absolute path to `pi -e`, so it must exist in both layouts: a checkout runs the
// sources (the bootstrap is `.ts`, which pi loads through jiti) and an install runs the compiled build
// (Node refuses type stripping inside `node_modules`, the same rule the daemon's script resolution obeys).

import { existsSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `dist/starter/bootstrap.js` for an install; `src/starter/bootstrap.ts` for a checkout without a build.
 * Throws with a reinstall message when neither exists, because that is a broken install, not a bad flag.
 */
export function resolveBootstrapPath(moduleUrl: string | URL | undefined = import.meta.url): string {
	// The default is *this* module's URL, not the caller's: the bootstrap sits beside this file in both
	// layouts, and a caller in `daemon/main.ts` would otherwise look in the wrong directory.
	if (process.env.PI_MAILBRIDGE_BOOTSTRAP?.trim()) return process.env.PI_MAILBRIDGE_BOOTSTRAP.trim()
	const here = fileURLToPath(moduleUrl)
	const dir = dirname(here)
	const root = dirname(dir)
	const installed = here.split(sep).includes("node_modules")
	const compiled = join(dir, "bootstrap.js")
	const source = join(dir, "bootstrap.ts")
	const candidates = installed ? [compiled, source] : [source, compiled]
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate
	}
	throw new Error(
		`no starter bootstrap found beside ${here} — reinstall the package (dist/starter/bootstrap.js is missing)`,
	)
}
