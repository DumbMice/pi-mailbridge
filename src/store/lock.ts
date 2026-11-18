// One lock per state directory, whatever process wants it.
//
// Byte-for-byte the daemon's lock, extracted so the starter can have the same guarantee under a different
// file name instead of inventing a second locking scheme. The rules are what matter:
//
//   * `wx` makes the create atomic: two processes cannot both create the file.
//   * the pid inside lets a later process tell a live holder (it is not locked out) from a crash (it is
//     stolen), so a killed process never locks the machine out.
//   * a stale lock is stolen by RENAMING it aside, not unlinking it: an unlink plus a retake lets two
//     stealers both win.

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
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

export type LockResult = { ok: true; lock: Lock } | { ok: false; holder: number }

/** Is `pid` a live process (or one we are not allowed to signal, which also counts as live)? */
function isAlive(pid: number): boolean {
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
			// distinguishable, and `verify` is what turns a takeover into an abort instead of two owners.
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
						// Only remove our own: a stolen lock belongs to someone else now.
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

	let holder = 0
	try {
		holder = Number(readFileSync(path, "utf8").trim().split(" ")[0])
	} catch {
		/* unreadable: treat as stale */
	}
	if (holder > 0 && holder !== process.pid && isAlive(holder)) return { ok: false, holder }

	// Stale: steal by renaming, so exactly one stealer gets the file.
	const aside = `${path}.${process.pid}.stale`
	try {
		renameSync(path, aside)
	} catch {
		// Someone else moved it first; try again from the top once.
		const retry = take()
		return retry ?? { ok: false, holder }
	}
	let moved = Number.NaN
	try {
		moved = Number(readFileSync(aside, "utf8").trim().split(" ")[0])
	} catch {
		/* unreadable: it was a corpse anyway */
	}
	try {
		unlinkSync(aside)
	} catch {
		/* best effort */
	}
	// If what we moved was not the corpse we judged dead, put it back and report the holder.
	if (Number.isFinite(moved) && moved > 0 && moved !== holder && isAlive(moved)) {
		try {
			writeFileSync(path, String(moved), { flag: "wx", mode: 0o600 })
		} catch {
			/* another process won the retake; its lock is the live one */
		}
		return { ok: false, holder: moved }
	}
	const taken = take()
	return taken ?? { ok: false, holder }
}
