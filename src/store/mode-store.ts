// Global email mode: "am I away from the keyboard?"
//
// One human, one mailbox, one switch. It is deliberately global rather than
// per-session: you are either at the desk or you are not, and pretending
// otherwise makes the agent guess.
//
// Persisted so a daemon restart cannot silently re-enable emailing, and default
// OFF so installing the package never starts mailing you unprompted.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { statePath } from "./paths.ts"

export type Mode = "on" | "off"

export const DEFAULT_MODE: Mode = "off"

interface ModeFile {
	mode: Mode
	updatedAt: number
}

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, "mode.json")
}

export function isMode(value: unknown): value is Mode {
	return value === "on" || value === "off"
}

/** Current mode; a missing or corrupt file means off. */
export function readMode(env: NodeJS.ProcessEnv = process.env): Mode {
	const p = path(env)
	try {
		if (!existsSync(p)) return DEFAULT_MODE
		const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<ModeFile>
		return isMode(parsed?.mode) ? parsed.mode : DEFAULT_MODE
	} catch {
		return DEFAULT_MODE
	}
}

/** Persist the mode. Returns the value actually stored. */
export function writeMode(env: NodeJS.ProcessEnv, mode: Mode, now: number = Date.now()): Mode {
	const p = path(env)
	mkdirSync(dirname(p), { recursive: true, mode: 0o700 })
	const tmp = `${p}.${process.pid}.tmp`
	writeFileSync(tmp, JSON.stringify({ mode, updatedAt: now } satisfies ModeFile), { mode: 0o600 })
	renameSync(tmp, p)
	return mode
}

/**
 * The single rule for whether the daemon may touch the mailbox. `/back` is documented as
 * closing the control channel, so this is the gate that makes that true.
 */
export function scanningEnabled(mode: Mode): boolean {
	return mode === "on"
}
