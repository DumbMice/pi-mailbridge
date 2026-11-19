#!/usr/bin/env node
// Real tmux: does ownership survive a server restart that reuses both the id and the name?
//
// The unit tests use fake executors, so they can prove the argv and the decision, but not that tmux actually
// behaves the way the decision assumes. This runs against a disposable socket inside the live image:
//
//   1. create a session named `probe` carrying PI_MAILBRIDGE_REQUEST=req-1, note its `$N`
//   2. stop it with the matching marker — must succeed
//   3. create another, kill the server, start a fresh one, recreate the *same name* with a *different*
//      marker; the new session is very likely to receive the same `$N`
//   4. ask stop to kill the old id with the old marker — it must refuse, and the new session must survive
//   5. stop it with its own marker — must succeed
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"

const require = createRequire("/usr/local/lib/node_modules/@dumbmice/pi-mailbridge/package.json")
const { stopSession, listSessions } = require("/usr/local/lib/node_modules/@dumbmice/pi-mailbridge/dist/starter/spawn.js")

const SOCKET = "pmb-restart"
const NAME = "probe"

function tmux(args, options = {}) {
	// Capture stderr: a missing server is an expected state here, not something to print.
	return execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })
}

function create(marker) {
	tmux(["new-session", "-d", "-s", NAME, "-e", `PI_MAILBRIDGE_REQUEST=${marker}`, "--", "sleep", "300"])
	return tmux(["display-message", "-p", "-t", NAME, "#{session_id}"]).trim()
}

function killServer() {
	try {
		tmux(["kill-server"])
	} catch {
		/* already gone */
	}
}

const fail = (message) => {
	console.error(`FAIL: ${message}`)
	process.exitCode = 1
}

killServer()

// 1–2: the matching marker stops it.
const first = create("req-1")
const stopped = await stopSession(first, { expectedName: NAME, expectedRequestId: "req-1", socket: SOCKET })
if (!stopped.ok) fail(`the matching stop was refused: ${JSON.stringify(stopped)}`)
const afterStop = await listSessions({ socket: SOCKET })
if (afterStop === undefined || afterStop.length !== 0) fail(`the session survived a matching stop: ${JSON.stringify(afterStop)}`)

// 3: a new server, same name, different marker.
const oldId = create("req-1")
killServer()
const reusedId = create("req-2")
console.log(`old id ${oldId}, reused id ${reusedId}${oldId === reusedId ? " (same id, as expected)" : " (tmux chose a different id; the name check still applies)"}`)

// 4: the stale record must not kill the impostor.
const refused = await stopSession(oldId, { expectedName: NAME, expectedRequestId: "req-1", socket: SOCKET })
if (refused.ok) fail("stop killed a session whose marker belongs to another request")
else if (refused.reason !== "not-ours") fail(`expected not-ours, got ${refused.reason}: ${refused.detail}`)
const survivors = await listSessions({ socket: SOCKET })
if (survivors === undefined || survivors.length !== 1) fail(`the impostor did not survive: ${JSON.stringify(survivors)}`)
// Exact identity, not just a count: the survivor must be the *new* session, not the old one re-created.
else if (survivors[0].id !== reusedId || survivors[0].name !== NAME) {
	fail(`the survivor is not the impostor: ${JSON.stringify(survivors)} (expected ${reusedId}/${NAME})`)
}

// 5: its own marker works.
const own = await stopSession(reusedId, { expectedName: NAME, expectedRequestId: "req-2", socket: SOCKET })
if (!own.ok) fail(`stop with the matching marker failed: ${JSON.stringify(own)}`)
const empty = await listSessions({ socket: SOCKET })
if (empty === undefined || empty.length !== 0) fail(`the session survived its own stop: ${JSON.stringify(empty)}`)

killServer()
if (process.exitCode) process.exit(process.exitCode)
console.log("PASS: a restart that reuses the id and name cannot be killed by the old record")
