// The spawner: the argv is the contract, and the readiness marker is the truth.
//
// The first test here is the important one: the prompt must never appear in the argv. pi would parse it as
// options (`--continue`), read `@path` as a file, or dispatch `/cmd` as an extension command.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
	buildKillArgv,
	buildListArgv,
	buildSpawnArgv,
	diagnosticsFrom,
	listSessions,
	type SpawnPlan,
	spawnSession,
	stopSession,
} from "../src/starter/spawn.ts"

const plan = (over: Partial<SpawnPlan> = {}): SpawnPlan => ({
	tmuxId: "fix-auth",
	piSessionId: "pi-260117-0930-ab12",
	displayName: "fix-auth",
	cwd: "/tmp/project",
	promptFile: "/tmp/prompts/req-1.txt",
	readyFile: "/tmp/prompts/req-1.ready",
	requestId: "req-1",
	bootstrapPath: "/opt/pi-mailbridge/dist/starter/bootstrap.js",
	...over,
})

test("the argv carries no prompt, uses our socket, and identifies the session by its fresh id", () => {
	const argv = buildSpawnArgv(plan({ model: "deepseek/deepseek-flash", thinking: "high", emailMode: "on" }))
	assert.deepEqual(argv, [
		"tmux",
		"-L",
		"pimail",
		"new-session",
		"-d",
		"-s",
		"fix-auth",
		"-c",
		"/tmp/project",
		"--",
		"env",
		"PI_MAILBRIDGE_START_PROMPT=/tmp/prompts/req-1.txt",
		"PI_MAILBRIDGE_START_READY=/tmp/prompts/req-1.ready",
		"PI_MAILBRIDGE_START_REQUEST=req-1",
		"PI_MAILBRIDGE_SESSION_MODE=on",
		"pi",
		"-e",
		"/opt/pi-mailbridge/dist/starter/bootstrap.js",
		"-n",
		"fix-auth",
		"--session-id",
		"pi-260117-0930-ab12",
		"--model",
		"deepseek/deepseek-flash",
		"--thinking",
		"high",
	])
	// Nothing prompt-like anywhere: the file is named, the text is not.
	const joined = argv.join(" ")
	assert.doesNotMatch(joined, /fix the flaky test|--continue|@\/etc/)
})

test("optional fields disappear rather than becoming empty arguments", () => {
	const argv = buildSpawnArgv(plan())
	assert.equal(argv.includes("--model"), false)
	assert.equal(argv.includes("--thinking"), false)
	assert.equal(argv.some((arg) => arg.startsWith("PI_MAILBRIDGE_SESSION_MODE")), false)
})

test("the human name and the pi session id are separate, so a reused name cannot resume a session", () => {
	const argv = buildSpawnArgv(plan({ displayName: "same-name", piSessionId: "pi-fresh-1" }))
	assert.equal(argv[argv.indexOf("-n") + 1], "same-name")
	assert.equal(argv[argv.indexOf("--session-id") + 1], "pi-fresh-1")
})

test("kill targets the immutable session id, never the reusable name", () => {
	assert.deepEqual(buildKillArgv("$4"), ["tmux", "-L", "pimail", "kill-session", "-t", "$4"])
	assert.deepEqual(buildListArgv(), ["tmux", "-L", "pimail", "list-sessions", "-F", "#{session_id}\t#{session_name}"])
})

test("a start is successful only when the bootstrap says ready and the session exists", async () => {
	const calls: string[][] = []
	const files = new Map<string, string>([["/tmp/prompts/req-1.ready", JSON.stringify({ ok: true, requestId: "req-1" })]])
	const result = await spawnSession(plan(), {
		exec: async (argv) => {
			calls.push(argv)
			if (argv.includes("display-message")) return { code: 0, stdout: "$7\n", stderr: "" }
			return { code: 0, stdout: "", stderr: "" }
		},
		readFile: (path) => files.get(path),
		sleep: async () => {},
	})
	assert.deepEqual(result, { ok: true, tmuxSessionId: "$7" })
	assert.equal(calls[0]![0], "tmux", "the first call is the spawn")
})

test("a marker that reports failure kills the session and says why", async () => {
	const calls: string[][] = []
	const files = new Map<string, string>([["/tmp/prompts/req-1.ready", JSON.stringify({ ok: false, error: "no model configured" })]])
	const result = await spawnSession(plan(), {
		exec: async (argv) => {
			calls.push(argv)
			if (argv.includes("display-message")) return { code: 0, stdout: "$9\n", stderr: "" }
			return { code: 0, stdout: "", stderr: "" }
		},
		readFile: (path) => files.get(path),
		sleep: async () => {},
	})
	assert.equal(result.ok, false)
	if (!result.ok) assert.equal(result.reason, "unready")
	assert.ok(calls.some((argv) => argv.includes("kill-session")), "the half-started session is killed")
})

test("a start that never reports ready is killed, with the pane text as the detail", async () => {
	const calls: string[][] = []
	const result = await spawnSession(plan(), {
		exec: async (argv) => {
			calls.push(argv)
			if (argv.includes("display-message")) return { code: 0, stdout: "$3\n", stderr: "" }
			if (argv.includes("capture-pane")) return { code: 0, stdout: "Unknown model: nope\n", stderr: "" }
			return { code: 0, stdout: "", stderr: "" }
		},
		readFile: () => undefined,
		sleep: async () => {},
		now: (() => {
			let t = 0
			return () => (t += 30_000)
		})(),
		readyTimeoutMs: 1000,
	})
	assert.equal(result.ok, false)
	if (!result.ok) {
		assert.equal(result.reason, "unready")
		assert.match(result.detail, /Unknown model/)
	}
	assert.ok(calls.some((argv) => argv.includes("kill-session")))
})

test("tmux failing to create the session is reported without trying to kill anything", async () => {
	const calls: string[][] = []
	const result = await spawnSession(plan(), {
		exec: async (argv) => {
			calls.push(argv)
			return { code: 1, stdout: "", stderr: "duplicate session: fix-auth" }
		},
		readFile: () => undefined,
		sleep: async () => {},
	})
	assert.equal(result.ok, false)
	if (!result.ok) assert.equal(result.reason, "spawn-failed")
	assert.equal(calls.some((argv) => argv.includes("kill-session")), false)
})

test("stop refuses anything that is not a tmux session id", async () => {
	const result = await stopSession("fix-auth")
	assert.equal(result.ok, false)
	if (!result.ok) assert.equal(result.reason, "bad-session-id")
})

test("stop kills by id and reports tmux's refusal instead of pretending", async () => {
	const ok = await stopSession("$2", { exec: async () => ({ code: 0, stdout: "", stderr: "" }) })
	assert.deepEqual(ok, { ok: true })
	const refused = await stopSession("$2", { exec: async () => ({ code: 1, stdout: "", stderr: "no such session" }) })
	assert.equal(refused.ok, false)
	if (!refused.ok) assert.match(refused.detail, /no such session/)
})

test("listing tolerates a dead tmux server", async () => {
	assert.deepEqual(await listSessions({ exec: async () => ({ code: 1, stdout: "", stderr: "no server" }) }), [])
	const listed = await listSessions({
		exec: async () => ({ code: 0, stdout: "$1\tfix-auth\n$2\tsame-name\n", stderr: "" }),
	})
	assert.deepEqual(listed, [
		{ id: "$1", name: "fix-auth" },
		{ id: "$2", name: "same-name" },
	])
})

test("diagnostics strip escapes and cap the length", () => {
	assert.equal(diagnosticsFrom("\u001B[31mred\u001B[0m\n"), "red")
	const long = diagnosticsFrom("x".repeat(5000))
	assert.ok(long.length <= 2001)
	assert.ok(long.endsWith("…"))
})

test("stop refuses an id that now names a different session (tmux restart reuse)", async () => {
	// `$N` is only unique while the server lives; after a restart it can belong to an unrelated session.
	const calls: string[][] = []
	const exec = async (argv: string[]) => {
		calls.push(argv)
		if (argv.includes("display-message")) return { code: 0, stdout: "someone-else", stderr: "" }
		return { code: 0, stdout: "", stderr: "" }
	}
	const result = await stopSession("$2", { expectedName: "fix-auth", exec })
	assert.equal(result.ok, false)
	if (!result.ok) assert.equal(result.reason, "not-ours")
	assert.equal(
		calls.some((argv) => argv.includes("kill-session")),
		false,
		"nothing was killed",
	)
})

test("stop still kills when the name matches", async () => {
	const exec = async (argv: string[]) => {
		if (argv.includes("display-message")) return { code: 0, stdout: "fix-auth", stderr: "" }
		return { code: 0, stdout: "", stderr: "" }
	}
	const result = await stopSession("$2", { expectedName: "fix-auth", exec })
	assert.equal(result.ok, true)
})

test("an unrecognised tmux failure is not read as 'no sessions'", async () => {
	// Returning [] for any failure made the sweep end every session we own on a 30 s timeout.
	assert.equal(await listSessions({ exec: async () => ({ code: 1, stdout: "", stderr: "lost server" }) }), undefined)
	assert.deepEqual(await listSessions({ exec: async () => ({ code: 1, stdout: "", stderr: "no server running on /tmp/x" }) }), [])
})

