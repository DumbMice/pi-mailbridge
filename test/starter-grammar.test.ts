// The deterministic grammar. Three states, and the difference between them is the point: an explicit
// but wrong value must never be repaired by an agent, and a missing one must never be silently defaulted
// where the operator clearly meant to set it.

import { test } from "node:test"
import assert from "node:assert/strict"

import { parseRequest } from "../src/starter/grammar.ts"

const parse = (body: string) => parseRequest(body, { promptMaxChars: 200 })

test("a complete request carries every field it was given", () => {
	const result = parse("cwd: ~/Work/app\nmodel: deepseek/deepseek-flash\nthinking: high\nname: fix-auth\nprompt: fix the flaky test")
	assert.equal(result.state, "complete")
	if (result.state !== "complete") return
	assert.deepEqual(result.request.fields, {
		cwd: "~/Work/app",
		model: "deepseek/deepseek-flash",
		thinking: "high",
		name: "fix-auth",
		prompt: "fix the flaky test",
		parse: "auto",
	})
})

test("prompt: | takes the remaining lines verbatim, de-indented", () => {
	const result = parse("cwd: /tmp\nprompt: |\n  line one\n    indented\n  line two")
	assert.equal(result.state, "complete")
	if (result.state !== "complete") return
	assert.equal(result.request.fields.prompt, "line one\n  indented\nline two")
})

test("the body without keys is the prompt, colon and all", () => {
	// "note: the build is broken" is a sentence, not a key block: it only becomes a block when at least
	// one line carries a key we know.
	const prose = parse("note: the build is broken")
	assert.equal(prose.state, "incomplete", "no cwd, so stage B may look - but the text is kept")
	if (prose.state === "incomplete") {
		assert.equal(prose.request.fields.prompt, "note: the build is broken")
		assert.deepEqual(prose.missing, ["cwd"])
	}
})

test("an unknown key is invalid when it sits in a real block, prose when it stands alone", () => {
	// next to a known key it is a typo in a block, and must not be silently ignored
	const typoInBlock = parse("cwd: /tmp\npromt: fix it")
	assert.equal(typoInBlock.state, "invalid")
	if (typoInBlock.state === "invalid") assert.equal(typoInBlock.errors[0]?.code, "unknown-field")

	// alone it is just text
	const typoAlone = parse("promt: fix it")
	assert.equal(typoAlone.state, "incomplete")
	if (typoAlone.state === "incomplete") assert.equal(typoAlone.request.fields.prompt, "promt: fix it")
})

test("duplicate and empty values are invalid", () => {
	for (const body of ["cwd: /tmp\ncwd: /var", "cwd: \nprompt: x", "cwd: /tmp\nmodel: "]) {
		assert.equal(parse(body).state, "invalid", body)
	}
})

test("thinking is validated against pi's levels", () => {
	const bad = parse("cwd: /tmp\nthinking: turbo")
	assert.equal(bad.state, "invalid")
	if (bad.state === "invalid") assert.equal(bad.errors[0]?.code, "bad-thinking")
	assert.equal(parse("cwd: /tmp\nthinking: XHIGH").state, "complete", "case-insensitive")
})

test("stop and list are commands, and cannot carry start fields", () => {
	const stop = parse("stop: fix-auth")
	assert.equal(stop.state, "complete")
	if (stop.state === "complete") {
		assert.equal(stop.request.kind, "stop")
		assert.equal(stop.request.stopTarget, "fix-auth")
	}
	const list = parse("list: here")
	assert.equal(list.state, "complete")
	if (list.state === "complete") assert.equal(list.request.kind, "list")

	assert.equal(parse("stop: x\ncwd: /tmp").state, "invalid")
	assert.equal(parse("stop: x\nlist: y").state, "invalid")
	assert.equal(parse("stop:").state, "invalid", "stop needs a target")
})

test("the prompt is optional, and a long one is refused rather than truncated", () => {
	const noPrompt = parse("cwd: /tmp")
	assert.equal(noPrompt.state, "complete", "the caller defaults the prompt to `hi`")
	if (noPrompt.state === "complete") assert.equal(noPrompt.request.fields.prompt, undefined)

	const long = parseRequest(`cwd: /tmp\nprompt: ${"x".repeat(201)}`, { promptMaxChars: 200 })
	assert.equal(long.state, "invalid")
	if (long.state === "invalid") assert.equal(long.errors[0]?.code, "prompt-too-long")
})

test("parse: agent is a field, not an unknown key", () => {
	const agent = parse("parse: agent")
	assert.equal(agent.state, "incomplete")
	if (agent.state === "incomplete") assert.equal(agent.request.fields.parse, "agent")

	const bad = parse("parse: maybe")
	assert.equal(bad.state, "invalid")
})
