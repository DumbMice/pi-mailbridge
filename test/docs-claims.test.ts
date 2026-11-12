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

test("the documented HTTP surface exists in the handler, with the right method", () => {
	// Round 3 showed the first version was method-blind: documenting GET /ack passed because
	// `case "POST /ack"` contains the path. A reader following that doc gets a 405.
	const service = readFileSync(join(root, "src/daemon/service.ts"), "utf8")
	const rows = doc("docs/ARCHITECTURE.md")
		.split("\n")
		.filter((line) => /^\| (GET|POST|DELETE|GET\/POST) \| `\//.test(line))
	assert.ok(rows.length > 8, "expected the request table to be present")

	for (const row of rows) {
		const method = /^\| (GET|POST|DELETE|GET\/POST) \|/.exec(row)?.[1]!
		const path = /`(\/[a-z]+)`/.exec(row)?.[1]!
		if (path === "/health") {
			// The liveness probe is unauthenticated and handled before the router.
			assert.ok(service.includes('url.pathname === "/health"'), "ARCHITECTURE documents /health")
			continue
		}
		const methods = method === "GET/POST" ? ["GET", "POST"] : [method]
		for (const m of methods) {
			assert.ok(
				service.includes(`case "${m} ${path}":`),
				`ARCHITECTURE documents ${m} ${path}, which the handler does not route`,
			)
		}
	}
})

test("the module layout lists real files", () => {
	const arch = doc("docs/ARCHITECTURE.md")
	const block = /## 8\. Module layout\n\n```\n([\s\S]*?)```/.exec(arch)?.[1]
	assert.ok(block, "the layout block should exist")
	const listed = [...block.matchAll(/^\s{2,4}([a-z0-9*-]+\.ts)\s/gm)].map((m) => m[1]!)
	assert.ok(listed.length > 20, `expected a full listing, got ${listed.length}`)
	const covered = (file: string): boolean => {
		const base = file.split("/").pop()!
		return listed.some((l) => (l.includes("*") ? base.startsWith(l.split("*")[0]!) : l === base))
	}
	for (const name of listed) {
		if (name.includes("*")) continue
		assert.ok(
			existsIn("src", name),
			`ARCHITECTURE lists ${name}, which is not in src/ (renamed or never written)`,
		)
	}

	// And the other direction: a new module must be added to the map, or the map quietly
	// stops describing the code.
	const onDisk = allTs("src").filter((f) => !f.endsWith(".d.ts"))
	const missing = onDisk.filter((f) => !covered(f))
	assert.deepEqual(missing, [], `src/ modules missing from the ARCHITECTURE layout: ${missing.join(", ")}`)
})

/** Every .ts basename under `dir`, recursively. */
function allTs(dir: string, prefix = ""): string[] {
	const out: string[] = []
	for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) out.push(...allTs(join(dir, entry.name), rel))
		else if (entry.name.endsWith(".ts")) out.push(rel)
	}
	return out
}

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

test("the documented routing order is the implemented one, in every file that states it", () => {
	// Round 3 proved the previous version vacuous: it compared first-mention positions in the
	// whole file, so a reversed numbered list still passed. This reads the numbered rules.
	const expected = [/route id/i, /signed token/i, /reply chain/i]

	// Other numbered lists exist in these files (troubleshooting steps), so take the
	// contiguous block that starts with the routing rule rather than every numbered line.
	function rules(text: string): string[] {
		const blocks: { n: number; label: string }[][] = []
		let current: { n: number; label: string }[] = []
		for (const line of text.split("\n")) {
			const row = /^\|\s*(\d)\s*\|\s*\*\*(.+?)\*\*/.exec(line)
			const item = /^\s*(\d)\.\s+\*\*(.+?)\*\*/.exec(line)
			const hit = row ?? item
			if (hit) {
				const n = Number(hit[1])
				if (current.length === 0 || n === current.length + 1) current.push({ n, label: hit[2]! })
				else {
					blocks.push(current)
					current = [{ n, label: hit[2]! }]
				}
			} else if (current.length > 0 && line.trim() !== "" && !/^\s/.test(line)) {
				// A wrapped continuation line is indented and belongs to the current item;
				// only an unindented non-empty line ends the block.
				blocks.push(current)
				current = []
			}
		}
		if (current.length > 0) blocks.push(current)
		const block = blocks.find((b) => b.length >= 3 && expected[0]!.test(b[0]!.label))
		return (block ?? []).map((b) => b.label)
	}

	for (const name of ["README.md", "docs/ARCHITECTURE.md"]) {
		const list = rules(doc(name))
		assert.ok(list.length >= 3, `${name} must state the routing rules as a numbered list`)
		expected.forEach((pattern, i) => {
			assert.match(list[i]!, pattern, `${name} rule ${i + 1} should be ${pattern}`)
		})
	}

	// The changelog states it as prose, in order.
	const changelog = doc("CHANGELOG.md")
	const section = /### Reply identification[\s\S]*?(?=\n### )/.exec(changelog)?.[0]
	assert.ok(section, "CHANGELOG should have a Reply identification section")
	const positions = expected.map((p) => section.search(p))
	positions.forEach((pos, i) => assert.ok(pos > -1, `CHANGELOG omits rule ${i + 1}`))
	assert.deepEqual([...positions].sort((a, b) => a - b), positions, "CHANGELOG lists the rules out of order")
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
