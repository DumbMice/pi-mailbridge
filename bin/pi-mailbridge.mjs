#!/usr/bin/env node
// `pi-mailbridge` — the headless entry point documented in the README.
//
// From an installed package this loads the compiled `dist/` build: Node refuses to strip
// TypeScript inside `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is why
// the daemon is built rather than shipped as `.ts`. A checkout without a build falls back to
// running the sources with the flag, which is how development and the tests use it.
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const compiled = new URL("../dist/daemon/main.js", import.meta.url)
const source = new URL("../src/daemon/main.ts", import.meta.url)

if (existsSync(fileURLToPath(compiled))) {
	const { main } = await import(compiled.href)
	main().catch((error) => {
		console.error(`pi-mailbridge: fatal: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	})
} else if (existsSync(fileURLToPath(source))) {
	const { spawn } = await import("node:child_process")
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", fileURLToPath(source), ...process.argv.slice(2)],
		{ stdio: "inherit" },
	)
	child.on("exit", (code) => process.exit(code ?? 1))
} else {
	console.error("pi-mailbridge: no dist/ or src/ found beside this bin; reinstall the package")
	process.exit(1)
}
