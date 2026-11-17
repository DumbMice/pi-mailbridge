// The persisted email-mode switch: the machine-wide default, and the only part of email mode that
// survives a restart.
//
// It is deliberately not the whole story. A session can override it in either direction
// (`/mailbridge off|on` without `--all`), so one noisy agent can be silenced without disarming the
// others; those overrides live in the daemon's memory (`daemon/service.ts`) and die with the
// session. `--all` writes this file and clears every override, and a write here is what a
// reconnecting session compares against (`readModeStamp`) before re-asserting an override of its own.
//
// Default OFF, so installing never starts mailing you unprompted.

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

/**
 * When the persisted switch last changed. Sessions use it to tell whether a decision they made is
 * still current: a global write moves the stamp, so a session that reconnects afterwards knows its
 * own override was superseded - by another session's `--all`, or by its own.
 */
export function readModeStamp(env: NodeJS.ProcessEnv = process.env): number {
	try {
		const parsed = JSON.parse(readFileSync(path(env), "utf8")) as Partial<ModeFile>
		return typeof parsed?.updatedAt === "number" ? parsed.updatedAt : 0
	} catch {
		return 0
	}
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
	// Strictly increasing, not just "now": sessions compare this value for equality to decide whether
	// their own override was superseded, and two writes in one millisecond would compare equal - so a
	// stale override would be re-applied after a `--all` that was meant to clear it.
	const stamp = Math.max(now, readModeStamp(env) + 1)
	const tmp = `${p}.${process.pid}.tmp`
	writeFileSync(tmp, JSON.stringify({ mode, updatedAt: stamp } satisfies ModeFile), { mode: 0o600 })
	renameSync(tmp, p)
	return mode
}

/**
 * The single rule for whether the daemon may touch the mailbox. `/mailbridge off` is documented as
 * closing the control channel, so this is the gate that makes that true.
 */
export function scanningEnabled(mode: Mode): boolean {
	return mode === "on"
}
