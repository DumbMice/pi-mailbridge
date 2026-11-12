import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// The first review found the docs confidently describing behaviour the code did not have
// (an `!approve` command, per-session tool restriction, SSE clients, a signed subject
// token, a config key that was never read). Prose cannot be typechecked, but the specific
// claims that were wrong can be pinned: each assertion below encodes a fact about the code
// that the sentences around it must keep agreeing with.

const root = fileURLToPath(new URL("..", import.meta.url))

function doc(name: string): string {
	return readFileSync(join(root, name), "utf8")
}

const prose = [
	"README.md",
	"AGENTS.md",
	...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
]

function allProse(): { file: string; text: string }[] {
	return prose.map((file) => ({ file, text: doc(file) }))
}

test("no document offers a command or control the code does not have", () => {
	for (const { file, text } of allProse()) {
		assert.ok(!/!approve/.test(text), `${file} mentions !approve, which is not implemented`)
		assert.ok(
			!/per-session tool restriction/i.test(text.replace(/does not enforce tool scoping/gi, "")),
			`${file} implies this package restricts tools; pi's own --tools does that`,
		)
	}
})

test("the documented HTTP surface exists in the handler", () => {
	const service = readFileSync(join(root, "src/daemon/service.ts"), "utf8")
	const ar ="docs/ARCHITECTURE.md"
	const rows = doc(ar)
		.split("\n")
		.filter((line) => /^\| (GET|POST|DELETE|GET\/POST) \| `\//.test(line))
	assert.ok(rows.length > 8, "expected the request table to be present")
	for (const row of rows) {
		const path = /`(\/[a-z]+)`/.exec(row)?.[1]
		if (!path) continue
		if (path === "/health") continue
		assert.ok(
			service.includes(`"${path}"`) || service.includes(` ${path}"`) || service.includes(`"${path.slice(1)}`),
			`${ar} documents ${path}, which the handler does not route`,
		)
	}
})

test("the module layout lists real files", () => {
	const arch = doc("docs/ARCHITECTURE.md")
	const block = /## 8\. Module layout\n\n```\n([\s\S]*?)```/.exec(arch)?.[1]
	assert.ok(block, "the layout block should exist")
	const listed = [...block.matchAll(/^\s{4}([a-z0-9-]+\.ts)\s/gm)].map((m) => m[1]!)
	assert.ok(listed.length > 20, `expected a full listing, got ${listed.length}`)
	for (const name of listed) {
		// oauth*.ts is written as a glob in the layout; everything else must exist.
		if (name.includes("*")) continue
		assert.ok(
			existsIn("src", name),
			`ARCHITECTURE lists ${name}, which is not in src/ (renamed or never written)`,
		)
	}
})

function existsIn(dir: string, name: string): boolean {
	for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
		if (entry.isFile() && entry.name === name) return true
		if (entry.isDirectory() && existsIn(join(dir, entry.name), name)) return true
	}
	return false
}

test("the changelog has no duplicated headings and no stale signed-subject claim", () => {
	const changelog = doc("CHANGELOG.md")
	const headings = changelog.split("\n").filter((line) => line.startsWith("### "))
	for (const heading of headings) {
		assert.equal(
			headings.filter((h) => h === heading).length,
			1,
			`duplicated changelog heading: ${heading}`,
		)
	}
	// Subjects carry a short route id now; a signed blob is only legacy.
	assert.ok(
		!/routed by the signed token/.test(changelog),
		"CHANGELOG still says replies are routed by a signed token",
	)
})

test("the README's test count is not a hardcoded number that can drift", () => {
	// It said 269 while the suite ran 346: doc updates that silently fail to match are
	// worse than no number at all.
	const readme = doc("README.md")
	assert.ok(
		!/\b\d{2,3} hermetic tests\b/.test(readme),
		"README states a literal test count; describe the suite instead",
	)
})

test("the documented routing order is the implemented one", () => {
	// Round 2 found README and ARCHITECTURE still listing the signed token as rule 1,
	// and describing it as authoritative, while process.ts tries the short route id first.
	const readme = doc("README.md")
	const arch = doc("docs/ARCHITECTURE.md")
	for (const [name, text] of [
		["README.md", readme],
		["docs/ARCHITECTURE.md", arch],
	] as const) {
		const route = text.search(/Short route id|short route id/i)
		const legacy = text.search(/Legacy signed token|legacy signed token/i)
		assert.ok(route > -1, `${name} must document the short route id`)
		assert.ok(legacy > -1, `${name} must document the legacy token as the fallback`)
		assert.ok(route < legacy, `${name} lists the signed token before the short route id`)
	}
	// The id is a lookup key, not a signature: no doc may call it authoritative.
	assert.ok(!/authoritative because it is signed/i.test(arch), "ARCHITECTURE still calls the token authoritative")
	assert.ok(!/\*\*Signed token in the subject\*\*/.test(readme), "README still presents the token as rule 1")
})

test("every environment override is documented", () => {
	const config = readFileSync(join(root, "src/core/config.ts"), "utf8")
	const names = [...config.matchAll(/env\.(PI_MAILBRIDGE_[A-Z_]+)/g)].map((m) => m[1]!)
	assert.ok(names.length >= 8, `expected the override list, got ${names.length}`)
	const readme = doc("README.md")
	for (const name of new Set(names)) {
		assert.ok(readme.includes(name), `${name} is read by config.ts but not documented`)
	}
})

test("the systemd unit cannot restart-loop and keeps its state dir", () => {
	const unit = readFileSync(join(root, "docs/systemd/pi-mailbridge.service"), "utf8")
	// Restart=always would restart the clean "pi already owns the port" exit forever.
	assert.ok(/^Restart=on-failure$/m.test(unit), "the unit must not use Restart=always")
	assert.ok(/PI_MAILBRIDGE_EXIT_WHEN_IDLE=false/.test(unit), "a supervised daemon must not exit when idle")
	// A ReadWritePaths that may not exist yet fails namespace setup unless '-'-prefixed.
	assert.ok(/^ReadWritePaths=-/m.test(unit), "ReadWritePaths must tolerate a missing directory")
})
