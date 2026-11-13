#!/usr/bin/env node
// `pi-mailbridge` — the headless entry point documented in the README.
//
// From an installed package this loads the compiled `dist/` build: Node refuses to strip
// TypeScript inside `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is why
// the daemon is built rather than shipped as `.ts`.
//
// A checkout is the mirror image: it must run its SOURCES even when a build is sitting there.
// `dist/` is gitignored and rebuilt only by `pretest`/`prepublishOnly`, so preferring it would
// silently run the previous build — with an unchanged `API_VERSION`, nothing would notice. The
// `node_modules` path segment is the discriminator because it is the actual constraint, and it is
// the same rule src/daemon/script.ts applies to the daemon a session spawns.
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { sep } from "node:path"

const here = fileURLToPath(import.meta.url)
const installed = here.split(sep).includes("node_modules")
const compiled = new URL("../dist/daemon/main.js", import.meta.url)
const source = new URL("../src/daemon/main.ts", import.meta.url)
const runCompiled = existsSync(fileURLToPath(compiled)) && (installed || !existsSync(fileURLToPath(source)))

if (runCompiled) {
	const { main } = await import(compiled.href)
	main().catch((error) => {
		console.error(`pi-mailbridge: fatal: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	})
} else if (!installed && existsSync(fileURLToPath(source))) {
	const { spawn } = await import("node:child_process")
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", fileURLToPath(source), ...process.argv.slice(2)],
		{ stdio: "inherit" },
	)
	child.on("exit", (code) => process.exit(code ?? 1))
} else if (installed) {
	// Spawning the .ts from here would fail with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING,
	// which tells a user nothing about the real problem: the install is incomplete.
	console.error("pi-mailbridge: this install has no compiled build (dist/); reinstall the package")
	process.exit(1)
} else {
	console.error("pi-mailbridge: no dist/ or src/ found beside this bin; reinstall the package")
	process.exit(1)
}
