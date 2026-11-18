// The starter's boundary. The first assertion in this file is the regression for the plan's own bug: a
// cwd must be *inside* a root, and a root must never be "inside" a cwd.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { planName, resolvePrompt, sanitiseName, validateCwd, validateModel, validateThinking } from "../src/starter/validate.ts"

/** A throwaway tree: base/{root/{project,hidden-ish},outside}. */
function tree(): { base: string; root: string; project: string; outside: string } {
	const base = mkdtempSync(join(tmpdir(), "pmb-starter-"))
	const root = join(base, "root")
	const project = join(root, "project")
	const outside = join(base, "outside")
	for (const dir of [project, join(root, ".ssh"), outside]) mkdirSync(dir, { recursive: true })
	return { base, root, project, outside }
}

test("a cwd inside a root is accepted, with the path resolved", () => {
	const t = tree()
	const result = validateCwd(t.project, { roots: [t.root], reserved: [] })
	assert.equal(result.ok, true)
	if (result.ok) assert.equal(result.value, t.project)
})

test("a cwd is never accepted because it *contains* a root", () => {
	// The plan's first draft required the opposite, which would have allowed `/` and `~` here. This is the
	// regression test for that mistake.
	const t = tree()
	for (const candidate of [t.root, t.base, "/", homedir()]) {
		const result = validateCwd(candidate, { roots: [t.root], reserved: [] })
		assert.equal(result.ok, false, `${candidate} must not be accepted under ${t.root}`)
		if (!result.ok) assert.ok(["root-itself", "outside-root", "filesystem-root"].includes(result.code), result.code)
	}
})

test("a sibling with a shared prefix is not inside the root", () => {
	const t = tree()
	const sibling = `${t.root}-other`
	mkdirSync(sibling, { recursive: true })
	const result = validateCwd(sibling, { roots: [t.root], reserved: [] })
	assert.equal(result.ok, false)
	if (!result.ok) assert.equal(result.code, "outside-root")
})

test("a symlink escape is judged by where it lands", () => {
	const t = tree()
	const link = join(t.project, "escape")
	symlinkSync(t.outside, link)
	const result = validateCwd(link, { roots: [t.root], reserved: [] })
	assert.equal(result.ok, false)
	if (!result.ok) assert.equal(result.code, "outside-root")

	// ...and a symlink that stays inside is fine.
	const inner = join(t.root, "inner")
	mkdirSync(inner)
	const insideLink = join(t.base, "inside-link")
	symlinkSync(inner, insideLink)
	const accepted = validateCwd(insideLink, { roots: [t.root], reserved: [] })
	assert.equal(accepted.ok, true)
})

test("hidden segments below the root are refused, and the root itself is not a session", () => {
	const t = tree()
	const hidden = validateCwd(join(t.root, ".ssh"), { roots: [t.root], reserved: [] })
	assert.equal(hidden.ok, false)
	if (!hidden.ok) assert.equal(hidden.code, "hidden-path")

	const rootItself = validateCwd(t.root, { roots: [t.root], reserved: [] })
	assert.equal(rootItself.ok, false)
	if (!rootItself.ok) assert.equal(rootItself.code, "root-itself")
})

test("the bridge's own config and state directories are refused when they are roots", () => {
	// Deliberately not a hard-coded path test: the caller passes these, which is how the starter knows
	// where its own state lives.
	const t = tree()
	const state = join(t.root, "state")
	mkdirSync(state, { recursive: true })
	mkdirSync(join(state, "sub"), { recursive: true })
	const result = validateCwd(join(state, "sub"), { roots: [t.root], reserved: [state] })
	assert.equal(result.ok, false)
	if (!result.ok) assert.equal(result.code, "reserved-directory")
})

test("missing paths, files and relative paths are refused with distinct reasons", () => {
	const t = tree()
	const file = join(t.project, "notes.txt")
	writeFileSync(file, "x")
	const missing = validateCwd(join(t.project, "nope"), { roots: [t.root], reserved: [] })
	const notDir = validateCwd(file, { roots: [t.root], reserved: [] })
	const relativePath = validateCwd("project", { roots: [t.root], reserved: [] })
	assert.deepEqual([missing.ok, notDir.ok, relativePath.ok], [false, false, false])
	if (!missing.ok) assert.equal(missing.code, "not-found")
	if (!notDir.ok) assert.equal(notDir.code, "not-a-directory")
	if (!relativePath.ok) assert.equal(relativePath.code, "not-absolute")
})

test("~ expands, so a home root works and its hidden children do not", () => {
	const home = validateCwd("~", { roots: ["~"], reserved: [] })
	assert.equal(home.ok, false, "home is the root here, not a session cwd")
	if (!home.ok) assert.equal(home.code, "root-itself")

	const hidden = validateCwd("~/.config", { roots: ["~"], reserved: [] })
	assert.equal(hidden.ok, false)
	if (!hidden.ok) assert.equal(hidden.code, "hidden-path")
	assert.equal(homedir().startsWith("/"), true, "sanity: the platform has an absolute home")
})

test("models must be exact provider/model allowlist entries", () => {
	const allowed = ["deepseek/deepseek-flash", "closeai/gpt-6.1-sol"]
	assert.deepEqual(validateModel("deepseek/deepseek-flash", allowed), { ok: true, value: "deepseek/deepseek-flash" })
	for (const [value, code] of [
		["deepseek-flash", "model-not-qualified"],
		["deepseek/deepseek-v4-pro", "model-not-allowed"],
		["", "empty-model"],
	] as const) {
		const result = validateModel(value, allowed)
		assert.equal(result.ok, false, value)
		if (!result.ok) assert.equal(result.code, code)
	}
	// An empty allowlist refuses every explicit model rather than letting pi choose.
	assert.equal(validateModel("deepseek/deepseek-flash", []).ok, false)
})

test("thinking is one of pi's levels", () => {
	assert.deepEqual(validateThinking("HIGH"), { ok: true, value: "high" })
	assert.equal(validateThinking("turbo").ok, false)
})

test("names are sanitised, and collisions are suffixed rather than refused", () => {
	assert.equal(sanitiseName("fix the flaky test!"), "fix-the-flaky-test")
	assert.equal(sanitiseName("../../etc/passwd"), "etc-passwd", "separators and dots at the edges go")
	assert.equal(sanitiseName("---"), "")

	const now = new Date("2026-01-17T09:30:00Z")
	assert.deepEqual(planName({ title: "fix auth", taken: [], now }), { ok: true, value: "fix-auth" })
	assert.deepEqual(planName({ requested: "named", title: "fix auth", taken: [], now }), { ok: true, value: "named" })
	assert.deepEqual(planName({ requested: "named", title: "x", taken: ["named"], now }), { ok: true, value: "named-2" })
	assert.deepEqual(planName({ title: "!!!", taken: [], now }), { ok: true, value: "pi-2601170930" })
})

test("an absent prompt is the documented `hi`, and whitespace is not a prompt", () => {
	assert.equal(resolvePrompt(undefined), "hi")
	assert.equal(resolvePrompt("   "), "hi")
	assert.equal(resolvePrompt("  fix it  "), "fix it")
})

test("a 40-character name can still take a collision suffix", () => {
	// Slicing after appending deleted the suffix, so a full-length name was unusable once its first
	// session existed: every later request was refused as name-exhausted.
	const long = "a".repeat(40)
	const planned = planName({ requested: long, title: "", taken: [long], now: new Date(0) })
	assert.equal(planned.ok, true)
	if (planned.ok) {
		assert.ok(planned.value.endsWith("-2"))
		assert.ok(planned.value.length <= 40)
	}
})

