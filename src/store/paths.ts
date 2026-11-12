// State + config locations. Everything the package writes lives under one
// directory so a user can inspect or delete it in one step.
//
//   $XDG_STATE_HOME/pi-mailbridge/   (default ~/.local/state/pi-mailbridge)
//     secret.key        shared HMAC + daemon bearer key, mode 0600
//     uid-cursor.json   monotonic IMAP UID cursor
//     pending.json      durable pending deliveries
//     journal.json      UIDs already acked (replay protection)
//     mode.json         global on/off
//     routes.json       short routing ids (TTL-bounded)
//     threads.json      outbound Message-IDs: threading + reply chain
//     oauth.json        refresh token, 0600
//
// Config is read from, in order, each deep-merged over the previous:
//   1. built-in defaults
//   2. $XDG_CONFIG_HOME/pi-mailbridge/config.json
//   3. PI_MAILBRIDGE_* environment variables

import { homedir } from "node:os"
import { join } from "node:path"

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state")
	return join(base, "pi-mailbridge")
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_CONFIG_HOME || join(homedir(), ".config")
	return join(base, "pi-mailbridge")
}

export function statePath(env: NodeJS.ProcessEnv, ...parts: string[]): string {
	return join(stateDir(env), ...parts)
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(configDir(env), "config.json")
}
