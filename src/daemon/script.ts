// Which daemon entry should a session spawn?
//
// The pi manifest points at `src/extension.ts`, and pi loads it through jiti - so in a published
// install the loaded module is TypeScript *inside node_modules*, where Node refuses type
// stripping. The daemon beside it must therefore be the compiled `dist/` entry whenever one
// exists, whichever shape this module has.
//
// Pure and exported so both layouts can be tested without installing a package.

import { existsSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Resolve the daemon script for the module at `moduleUrl`.
 *
 * - `dist/extension.js`     -> `dist/daemon/main.js`
 * - `src/extension.ts`      -> `dist/daemon/main.js` when built (a published install)
 * - `src/extension.ts` only -> `src/daemon/main.ts` (a checkout, run with the flag)
 *
 * In a checkout the SOURCE wins even when `dist/` exists. `dist/` is gitignored and rebuilt only
 * by `pretest`/`prepublishOnly`, so editing `src/daemon/*` without rebuilding would otherwise run
 * the previous build - with an unchanged `API_VERSION`, so nothing detects the mismatch and the
 * only symptom is a fix that appears not to work. A published install has no source to prefer.
 */
export function resolveDaemonScript(moduleUrl: string | URL, exists: (path: string) => boolean = existsSync): string {
	const here = fileURLToPath(moduleUrl)
	const dir = dirname(here)
	const root = dirname(dir)
	const compiled = here.endsWith(".js")
	// A dependency install is the only place `dist/` is the authority; everything else is a
	// checkout someone is editing.
	const installed = here.split(sep).includes("node_modules")
	const built = join(root, "dist", "daemon", "main.js")
	const source = join(dir, "daemon", "main.ts")
	const candidates = compiled
		? [
				// dist/extension.js -> dist/daemon/main.js
				join(dir, "daemon", "main.js"),
				built,
				source,
			]
		: installed
			? [
					// src/extension.ts inside node_modules: the compiled daemon, or nothing
					built,
					join(dir, "daemon", "main.js"),
					source,
				]
			: [
					// a checkout: what the editor has, not what the last build left behind
					source,
					built,
					join(dir, "daemon", "main.js"),
				]
	for (const candidate of candidates) {
		if (exists(candidate)) return candidate
	}
	// Nothing exists: name the source path, so the failure mentions what the caller expected.
	return join(dir, "daemon", "main.ts")
}
