// One lock per state directory, whatever process wants it.
//
// Byte-for-byte the daemon's lock, extracted so the starter can have the same guarantee under a different
// file name instead of inventing a second locking scheme. The rules are what matter:
//
//   * `wx` makes the create atomic: two processes cannot both create the file.
//   * the pid inside lets a later process tell a live holder (it is not locked out) from a crash (it is
//     stolen), so a killed process never locks the machine out.
//   * a stale lock is NOT stolen. Moving a lock that another process may have just replaced is how two
//     owners end up convinced they hold it; the holder is reported instead, and only an explicit
//     `pi-mailbridge starter locks` names it, and an operator removes it after confirming the pid is gone.

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { statePath } from "./paths.ts"

export interface Lock {
	release: () => void
	readonly path: string
	/**
	 * Still ours? A lock file can be renamed away by a takeover (a stale lock judged dead by another
	 * process), and the earlier holder would otherwise keep working without exclusion. Callers that perform
	 * a side effect verify first and abort if the answer is no.
	 */
	verify: () => boolean
}

export type LockResult =
	| { ok: true; lock: Lock }
	| { ok: false; holder: number; stale?: boolean }

/** Is `pid` a live process (or one we are not allowed to signal, which also counts as live)? */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

export function acquireLock(env: NodeJS.ProcessEnv, fileName: string): LockResult {
	const path = statePath(env, fileName)
	const take = (): { ok: true; lock: Lock } | undefined => {
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
			// A token, not just the pid: two locks created by the same process (or a reused pid) must still be
			// distinguishable, and `verify` is what turns a lost lock into an abort instead of two owners.
			const token = `${process.pid} ${randomBytes(8).toString("hex")}`
			writeFileSync(path, token, { flag: "wx", mode: 0o600 })
			const mine = (): string | undefined => {
				try {
					return readFileSync(path, "utf8").trim()
				} catch {
					return undefined
				}
			}
			return {
				ok: true,
				lock: {
					path,
					verify: () => mine() === token,
					release: () => {
						// Only remove our own: a replaced lock belongs to someone else now.
						try {
							if (mine() === token) unlinkSync(path)
						} catch {
							/* already gone */
						}
					},
				},
			}
		} catch {
			return undefined
		}
	}

	const first = take()
	if (first) return first

	// No takeover, and no automatic removal either: in user space there is no primitive that removes *this*
	// file only if it is unchanged, so any "clear the stale lock" helper can delete a lock that was acquired
	// in the meantime. A stale lock is therefore reported with its pid and path, and an operator who has
	// confirmed the pid is gone removes the file themselves. Failing closed is the only honest option here.
	let holder = 0
	let stale = false
	try {
		const content = readFileSync(path, "utf8").trim()
		holder = Number(content.split(" ")[0])
		stale = !(holder > 0 && isAlive(holder))
	} catch {
		stale = true
	}
	return { ok: false, holder, ...(stale ? { stale: true } : {}) }
}
