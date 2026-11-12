#!/usr/bin/env -S node --experimental-strip-types
// `pi-mailbridge` — the headless entry point documented in the README.
//
// The sources ship as TypeScript, so the flag is supplied by the shebang rather than by
// the caller. `env -S` is a GNU coreutils extension; on a system without it, run
// `node --experimental-strip-types <pkg>/src/daemon/main.ts …` instead.
import { main } from "../src/daemon/main.ts"

main().catch((error) => {
	console.error(`pi-mailbridge: fatal: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
