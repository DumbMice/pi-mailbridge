// Persistence for OAuth tokens.
//
// Only the refresh token is precious: access tokens are short-lived and cheap to
// re-mint. The file is 0600 inside the 0700 state dir, and it is never logged.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { statePath } from "./paths.ts"
import type { StoredTokens, TokenStore } from "../core/oauth-device.ts"

function path(env: NodeJS.ProcessEnv): string {
	return statePath(env, "oauth.json")
}

/** File-backed token store. Atomic replace, mode 0600. */
export function fileTokenStore(env: NodeJS.ProcessEnv = process.env): TokenStore {
	const file = path(env)
	return {
		read() {
			try {
				if (!existsSync(file)) return undefined
				const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredTokens
				if (typeof parsed?.refreshToken !== "string" && typeof parsed?.accessToken !== "string") return undefined
				return parsed
			} catch {
				return undefined
			}
		},

		write(tokens) {
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
			const tmp = `${file}.${process.pid}.tmp`
			writeFileSync(tmp, JSON.stringify(tokens), { mode: 0o600 })
			renameSync(tmp, file)
		},
	}
}

/** In-memory store for tests and for `--auth` dry runs. */
export function memoryTokenStore(initial?: StoredTokens): TokenStore & { value(): StoredTokens | undefined } {
	let tokens = initial
	return {
		read: () => tokens,
		write(next) {
			tokens = next
		},
		value: () => tokens,
	}
}

/** True when a refresh token is on disk, i.e. login already happened. */
export function hasStoredRefreshToken(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(fileTokenStore(env).read()?.refreshToken)
}
