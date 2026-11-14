// Inbound documents on disk.
//
// A PDF or a PPTX cannot be a message part, and carrying megabytes of base64 through
// `pending.json` would undo the store's byte ceiling. The daemon writes the file once, the pending
// record carries only its path, and the message tells the agent where to look - its own `read`
// tool does the rest.
//
// Safety, because the bytes are untrusted and the path is generated here:
//   - the directory is per message, under the state dir, mode 0700; files are 0600
//   - the name is sanitised (no separators, no control characters, no leading dots) and deduped,
//     so a hostile filename cannot escape the directory or overwrite a sibling
//   - the directory is pruned by age and total size, so a full mailbox cannot fill the disk

import { closeSync, constants, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

import type { SelectedFile } from "../core/attachments.ts"
import { stateDir } from "./paths.ts"

/** Old enough that nothing will ever read it again. */
export const ATTACHMENT_MAX_AGE_MS = 7 * 24 * 3600_000
/** Total bytes of inbound documents kept; older ones go first. */
export const ATTACHMENT_DIR_MAX_BYTES = 200 * 1024 * 1024

export interface SavedFile {
	name: string
	mimeType: string
	size: number
	/** Absolute path. The message shows this verbatim. */
	path: string
}

export function attachmentRoot(env: NodeJS.ProcessEnv): string {
	return join(stateDir(env), "attachments")
}

/** One directory per message: `uidValidity-uid`, so a renumber cannot collide. */
function messageDir(env: NodeJS.ProcessEnv, uid: number, uidValidity: number | undefined): string {
	return join(attachmentRoot(env), `${uidValidity ?? 0}-${uid}`)
}

/**
 * A filename a filesystem will accept, without any of the ways out of this directory.
 * Keeps the extension, because the agent picks a reader by it.
 */
export function safeName(name: string, fallback: string): string {
	const base = basename(name.replace(/\\/g, "/"))
	const cleaned = base
		.normalize("NFKC")
		.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-")
		.replace(/^[.\s]+/, "")
		.trim()
	// By BYTES, not characters: NAME_MAX is 255 bytes, so 120 CJK characters is 360 bytes and the
	// write throws ENAMETOOLONG - on a path that is supposed to be the fallback, not a failure.
	// The extension is kept (how the agent picks a reader), but it is capped too: a 300-byte
	// "extension" would otherwise be the whole name, and the leading-dot strip above would be
	// undone by a truncated-away stem.
	const dot = cleaned.lastIndexOf(".")
	const extension = dot > 0 ? truncateBytes(cleaned.slice(dot), 16) : ""
	const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
	const room = Math.max(1, 120 - Buffer.byteLength(extension, "utf8"))
	const capped = `${truncateBytes(stem, room)}${extension}`.replace(/^[.\s]+/, "")
	return capped || fallback
}

function truncateBytes(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
	let out = ""
	for (const char of value) {
		if (Buffer.byteLength(out + char, "utf8") > maxBytes) break
		out += char
	}
	return out
}

/**
 * Write the reply's documents and return their paths.
 *
 * Idempotent per message: an existing directory is reused, so a re-scan of the same UID (a crash
 * before the cursor moved) does not accumulate copies.
 */
export function saveInboundFiles(
	env: NodeJS.ProcessEnv,
	where: { uid: number; uidValidity?: number },
	files: SelectedFile[],
): SavedFile[] {
	if (files.length === 0) return []
	const dir = messageDir(env, where.uid, where.uidValidity)
	mkdirSync(dir, { recursive: true, mode: 0o700 })

	const taken = new Set<string>()
	const saved: SavedFile[] = []
	for (const [index, file] of files.entries()) {
		const name = safeName(file.name, `file-${index + 1}`)
		// Two attachments called report.pdf must both survive: suffix rather than overwrite.
		let unique = name
		for (let n = 2; taken.has(unique); n++) {
			const dot = name.lastIndexOf(".")
			unique = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`
		}
		taken.add(unique)
		const path = join(dir, unique)
		// O_NOFOLLOW: a symlink planted in the directory (same user, so not an escalation, but the
		// same discipline the outbound path applies) must not redirect the write elsewhere.
		const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
		try {
			// writeFileSync on the descriptor, not writeSync: a short write (ENOSPC mid-file,
			// RLIMIT_FSIZE) returns a count instead of throwing, and a truncated document recorded
			// as complete is the silent loss this module exists to prevent. writeFileSync loops.
			writeFileSync(fd, file.content)
		} finally {
			closeSync(fd)
		}
		saved.push({ name: unique, mimeType: file.mimeType, size: file.content.length, path })
	}
	return saved
}

/**
 * Drop old documents, then the oldest ones until the total fits.
 *
 * Called after a write rather than on a timer: the only moment the directory grows is a write, and
 * a daemon that is not running cannot fill it.
 */
export function pruneInboundFiles(
	env: NodeJS.ProcessEnv,
	options: { maxAgeMs?: number; maxBytes?: number; now?: number } = {},
): number {
	const maxAge = options.maxAgeMs ?? ATTACHMENT_MAX_AGE_MS
	const maxBytes = options.maxBytes ?? ATTACHMENT_DIR_MAX_BYTES
	const now = options.now ?? Date.now()
	const root = attachmentRoot(env)

	let dirs: string[]
	try {
		dirs = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, entry.name))
	} catch {
		return 0
	}

	const stats = dirs.map((dir) => {
		let bytes = 0
		let newest = 0
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isFile()) continue
				const stat = statSync(join(dir, entry.name))
				bytes += stat.size
				newest = Math.max(newest, stat.mtimeMs)
			}
		} catch {
			/* vanished between listing and stat */
		}
		return { dir, bytes, newest }
	})

	let removed = 0
	let total = 0
	const keep: typeof stats = []
	for (const entry of stats) {
		// `newest === 0` is a directory whose write failed before any file landed: it holds no mail
		// and would otherwise trickle inodes for ever.
		if (entry.newest === 0 || now - entry.newest > maxAge) {
			try {
				rmSync(entry.dir, { recursive: true, force: true })
				removed++
			} catch {
				/* someone else removed it */
			}
			continue
		}
		total += entry.bytes
		keep.push(entry)
	}

	// Still over the size ceiling: oldest first.
	keep.sort((a, b) => a.newest - b.newest)
	for (const entry of keep) {
		if (total <= maxBytes) break
		try {
			rmSync(entry.dir, { recursive: true, force: true })
			total -= entry.bytes
			removed++
		} catch {
			/* already gone */
		}
	}
	return removed
}
