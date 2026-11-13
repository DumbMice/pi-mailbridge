// Which daemon entry should a session spawn?
//
// The pi manifest points at `src/extension.ts`, and pi loads it through jiti - so in a published
// install the loaded module is TypeScript *inside node_modules*, where Node refuses type
// stripping. The daemon beside it must therefore be the compiled `dist/` entry whenever one
// exists, whichever shape this module has.
//
// Pure and exported so both layouts can be tested without installing a package.

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Resolve the daemon script for the module at `moduleUrl`.
 *
 * - `dist/extension.js`     -> `dist/daemon/main.js`
 * - `src/extension.ts`      -> `dist/daemon/main.js` when built (a published install)
 * - `src/extension.ts` only -> `src/daemon/main.ts` (a checkout, run with the flag)
 */
export function resolveDaemonScript(moduleUrl: string | URL, exists: (path: string) => boolean = existsSync): string {
	const here = fileURLToPath(moduleUrl)
	const dir = dirname(here)
	const root = dirname(dir)
	const compiled = here.endsWith(".js")
	const candidates = compiled
		? [
				// dist/extension.js -> dist/daemon/main.js
				join(dir, "daemon", "main.js"),
				join(root, "dist", "daemon", "main.js"),
				join(dir, "daemon", "main.ts"),
			]
		: [
				// src/extension.ts -> the build, when the package was published
				join(root, "dist", "daemon", "main.js"),
				join(dir, "daemon", "main.js"),
				// a checkout without a build
				join(dir, "daemon", "main.ts"),
			]
	for (const candidate of candidates) {
		if (exists(candidate)) return candidate
	}
	// Nothing exists: name the source path, so the failure mentions what the caller expected.
	return join(dir, "daemon", "main.ts")
}
