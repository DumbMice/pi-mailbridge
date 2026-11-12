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

	// /health is unauthenticated, so a blanket "every request carries a bearer token" two
	// lines above its row is self-contradictory.
	assert.ok(
		!/Every request carries/.test(doc("docs/ARCHITECTURE.md")),
		"ARCHITECTURE must qualify its bearer-token claim, because /health is unauthenticated",
	)

	// Every row in the request table must use a method the handler understands; otherwise a
	// fabricated `| PUT | /admin |` row is silently skipped by the filter above.
	for (const row of doc("docs/ARCHITECTURE.md").split("\n")) {
		if (!/^\| [A-Z]+\s*\| `\//.test(row)) continue
		const method = /^\| ([A-Z]+)\s*\|/.exec(row)?.[1]!
		assert.ok(
			["GET", "POST", "DELETE", "GET/POST"].includes(method),
			`ARCHITECTURE documents an unsupported method ${method} in its request table`,
		)
	}

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

test("the module layout lists exactly the modules that exist", () => {
	// Checked in both directions and by full path: comparing basenames let a new
	// src/store/config.ts hide behind a documented src/core/config.ts.
	const arch = doc("docs/ARCHITECTURE.md")
	const block = /## 8\. Module layout\n\n```\n([\s\S]*?)```/.exec(arch)?.[1]
	assert.ok(block, "the layout block should exist")

	const listed: string[] = []
	let dir = ""
	for (const line of block.split("\n")) {
		const header = /^\s{2}([a-z]+)\/\s*$/.exec(line)
		if (header) {
			dir = header[1]!
			continue
		}
		const entry = /^\s{2,4}([a-z0-9*-]+\.ts)\s/gm.exec(line)
		if (!entry) continue
		listed.push(dir ? `${dir}/${entry[1]}` : entry[1]!)
	}
	assert.ok(listed.length > 20, `expected a full listing, got ${listed.length}`)

	const onDisk = allTs("src").filter((f) => !f.endsWith(".d.ts"))
	const glob = (entry: string): RegExp =>
		new RegExp(`^${entry.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)

	for (const entry of listed) {
		const pattern = glob(entry)
		assert.ok(
			onDisk.some((f) => pattern.test(f)),
			`ARCHITECTURE lists ${entry}, which is not in src/ (renamed or never written)`,
		)
	}
	const missing = onDisk.filter((f) => !listed.some((entry) => glob(entry).test(f)))
	assert.deepEqual(missing, [], `src/ modules missing from the ARCHITECTURE layout: ${missing.join(", ")}`)
})

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
		// Catches "376 tests", "376 hermetic unit tests", "376 passing tests", "the 376 tests".
		!/\b\d{2,4}\s+(?:[a-z]+\s+){0,3}tests?\b/i.test(readme),
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

	// The changelog states it as prose. Check within the paragraph that names all three:
	// searching the whole section was defeatable by prefixing a sentence that mentions them
	// in another order.
	const changelog = doc("CHANGELOG.md")
	const section = /### Reply identification[\s\S]*?(?=\n### )/.exec(changelog)?.[0]
	assert.ok(section, "CHANGELOG should have a Reply identification section")
	const paragraphs = section.split(/\n\s*\n/).filter((p) => expected.every((e) => e.test(p)))
	assert.ok(paragraphs.length > 0, "CHANGELOG should state the three rules in one paragraph")
	for (const paragraph of paragraphs) {
		const positions = expected.map((p) => paragraph.search(p))
		assert.deepEqual([...positions].sort((a, b) => a - b), positions, "CHANGELOG lists the rules out of order")
	}
})

test("every environment override is documented", () => {
	// Scans all of src/, not just config.ts: a PI_MAILBRIDGE_ read in main.ts was invisible.
	const names = new Set<string>()
	for (const file of allTs("src")) {
		const text = readFileSync(join(root, "src", file), "utf8")
		for (const m of text.matchAll(/env\.(PI_MAILBRIDGE_[A-Z_]+)/g)) names.add(m[1]!)
	}
	assert.ok(names.size >= 8, `expected the override list, got ${names.size}`)
	const readme = doc("README.md")
	for (const name of names) {
		if (name === "PI_MAILBRIDGE_DIR") continue // unit-local, documented in the unit
		assert.ok(readme.includes(name), `${name} is read by src/ but not documented`)
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

test("the documented /mailbridge subcommands are exactly the implemented ones", () => {
	// The first version of this file only grepped for `!approve`; an invented
	// `/mailbridge doctor` would have shipped.
	const commands = readFileSync(join(root, "src/core/commands.ts"), "utf8")
	const block = /const SUBCOMMANDS[^=]*=\s*\[([\s\S]*?)\]/.exec(commands)?.[1]
	assert.ok(block, "SUBCOMMANDS should be a literal array")
	const implemented = new Set([...block.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!))
	assert.ok(implemented.size >= 6, `expected the subcommand list, got ${implemented.size}`)

	const documented = new Set(
		[...doc("README.md").matchAll(/`\/mailbridge ([a-z]+)/g)].map((m) => m[1]!),
	)
	for (const name of documented) {
		if (name === "mailbridge") continue
		assert.ok(implemented.has(name), `README documents /mailbridge ${name}, which has no handler`)
	}
	// `status` is what bare `/mailbridge` does, and `help` is offered by the usage text.
	const bareStatus = /\/mailbridge\s{2,}#/.test(doc("README.md"))
	for (const name of implemented) {
		if (name === "status" && bareStatus) continue
		if (name === "help") continue
		assert.ok(documented.has(name), `/mailbridge ${name} exists but is undocumented`)
	}
})

test("no document claims the extension uses SSE", () => {
	// The extension polls /pending every 10s and never opens /events; the daemon does
	// offer SSE, which is a different statement and is allowed.
	const extension = readFileSync(join(root, "src/extension.ts"), "utf8")
	assert.ok(!extension.includes("/events"), "the extension must not claim to use /events")
	assert.ok(!/"SSE client"|SSE client|over loopback SSE/i.test(doc("AGENTS.md")), "AGENTS.md claims an SSE client")
	assert.ok(!/sessions are thin clients that connect over loopback SSE/i.test(doc("docs/ARCHITECTURE.md")))
})

test("the revocation recipe names every store that can still deliver", () => {
	// Round 4 blocked on this: the recipe named the routing stores but not the queue, so
	// following it still injected an already-accepted reply.
	const security = doc("docs/SECURITY.md")
	const start = security.search(/To revoke, stop the daemon/i)
	assert.ok(start > -1, "SECURITY should document how to revoke")
	const recipe = security.slice(start, start + 1800)
	for (const store of ["routes.json", "threads.json", "pending.json"]) {
		assert.ok(recipe.includes(store), `the revocation recipe must name ${store}`)
	}
	assert.match(recipe, /journal\.json/, "and must say what the journal is (dedupe, not routing)")
})

test("SECURITY and README do not describe SSE as the session transport", () => {
	// Sessions poll; the daemon offers /events, but nothing subscribes. ARCHITECTURE may
	// mention it (it explains why), these two may not imply it is how replies arrive.
	// SSE may be mentioned as a bound ("SSE client cap") - it may not be presented as how a
	// session receives a delivery or a mode change.
	const transportClaim = /over SSE|SSE client of|subscribe[sd]? .*SSE|SSE: delivery|pushed to every connected session/i
	for (const name of ["docs/SECURITY.md", "README.md"]) {
		assert.ok(!transportClaim.test(doc(name)), `${name} presents SSE as the session transport`)
	}
})
