// Shared secret material: one 32-byte key used both as the HMAC key for routing
// tokens and as the daemon's bearer token.
//
// Created first-writer-wins with mode 0600 so the plugin can mint a token before
// the daemon has ever started (the first mail must not fail because the daemon
// is down).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync, chmodSync } from "node:fs"

import { stateDir, statePath } from "./paths.ts"
import { newSecret } from "../core/token.ts"

function ensureDir(env: NodeJS.ProcessEnv): string {
	const dir = stateDir(env)
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	return dir
}

/** Read the key, or undefined when it does not exist yet. Never creates. */
export function readSecret(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
	const path = statePath(env, "secret.key")
	try {
		if (!existsSync(path)) return undefined
		const raw = readFileSync(path, "utf8").trim()
		if (!raw) return undefined
		const buf = Buffer.from(raw, "base64url")
		return buf.length === 32 ? buf : undefined
	} catch {
		return undefined
	}
}

/**
 * Read the key, creating it if absent. Atomic: `wx` create means exactly one
 * process wins and the others read the winner's key.
 */
/** Small synchronous pause; no timer is available on this path. */
function sleepMs(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function ensureSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
	const existing = readSecret(env)
	if (existing) return existing

	ensureDir(env)
	const path = statePath(env, "secret.key")
	try {
		const fd = openSync(path, "wx", 0o600)
		try {
			writeSync(fd, newSecret().toString("base64url"))
		} finally {
			closeSync(fd)
		}
		chmodSync(path, 0o600)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		// Lost the race: the winner's key is the truth.
	}
	// Another process may have won the create race a microsecond ago and not finished
	// writing: `openSync(...,"wx")` makes the file visible before writeSync lands. Retry
	// briefly before declaring the key corrupt.
	for (let attempt = 0; attempt < 50; attempt++) {
		const winner = readSecret(env)
		if (winner) return winner
		sleepMs(2)
	}
	throw new Error(`pi-mailbridge: ${path} exists but is not a valid 32-byte key`)
}
