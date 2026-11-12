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

/** Whitespace-collapsed view: sentence claims must not be defeatable by re-wrapping. */
function flat(text: string): string {
	return text.replace(/\s+/g, " ")
}

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
	// following it still injected an already-accepted reply. Round 6 showed the first
	// version of this test was defeated by a later bullet repeating "pending.json" inside a
	// 1800-character window, so it now parses the recipe's own bullet list.
	const security = doc("docs/SECURITY.md")
	const start = security.search(/To revoke, stop the daemon/i)
	assert.ok(start > -1, "SECURITY should document how to revoke")

	const lines = security.slice(start).split("\n")
	const bullets: string[] = []
	let entered = false
	for (const line of lines.slice(1)) {
		const bullet = /^\s{2}- (.+)$/.exec(line)
		if (bullet) {
			entered = true
			bullets.push(bullet[1]!)
			continue
		}
		// The list ends at the first non-bullet, non-blank, unindented line.
		if (entered && line.trim() !== "" && !/^\s/.test(line)) break
	}
	assert.ok(bullets.length >= 3, `expected the recipe's bullet list, got ${bullets.length}`)

	for (const store of ["routes.json", "threads.json", "pending.json"]) {
		assert.ok(
			bullets.some((b) => b.includes(store)),
			`the revocation recipe must have its own bullet for ${store} (bullets: ${bullets.length})`,
		)
	}
	assert.ok(
		bullets.some((b) => /journal\.json/.test(b) && /dedupe/i.test(b)),
		"and must say the journal is dedupe, not routing",
	)
	assert.ok(
		bullets.some((b) => /pending\.json/.test(b) && /already-accepted/i.test(b)),
		"and must say why the queue is the one that matters",
	)
})

test("SECURITY and README do not describe SSE as the session transport", () => {
	// Sessions poll; the daemon offers /events, but nothing subscribes. ARCHITECTURE may
	// mention it (it explains why), these two may not imply it is how replies arrive.
	// SSE may be mentioned as a bound ("SSE client cap") - it may not be presented as how a
	// session receives a delivery or a mode change.
	// Applied to every doc, not just two: the round-5 major was reintroducible in
	// ARCHITECTURE's diagrams and §5 with the suite green.
	const transportClaim =
		/over SSE|SSE client of|SSE\/poll|subscribe[sd]? .*SSE|SSE: delivery|SSE: \/events|pushed to every connected session|SSE push is the path|sessions? (?:loop|connect)[^.]*\bSSE\b/i
	for (const { file, text } of allProse()) {
		assert.ok(!transportClaim.test(text), `${file} presents SSE as the session transport`)
	}
})

test("no document claims a routing identifier authenticates", () => {
	// The id routes; the allowlist and DMARC authorize. This is the single most important
	// sentence to keep true, and round 6 showed nothing pinned it.
	for (const { file, text } of allProse()) {
		assert.ok(
			!/(routing|subject) (id|token|identifier)\s+(authenticates|authorizes|is authoritative)/i.test(text),
			`${file} claims a routing identifier authenticates`,
		)
		assert.ok(
			!/the token is authoritative/i.test(text),
			`${file} calls the token authoritative`,
		)
	}
})

test("the security-relevant invariants in AGENTS are the code's", () => {
	const agents = doc("AGENTS.md")
	// Pinning the authserv-id is optional and wrong for consumer accounts; the invariant list
	// previously read as though it were mandatory.
	assert.ok(!/pinned DMARC come first/i.test(agents), "AGENTS must not mandate DMARC pinning")
	// Marking \Seen at parse time is exactly what the invariant forbids.
	assert.ok(!/mark .*\\?Seen.*(?:at parse|on parse|when parsed)/i.test(agents), "AGENTS must not invite marking \\Seen at parse time")
	assert.match(
		agents,
		/`\\Seen` and the journal append happen only in `\/ack`/,
		"AGENTS should state the ack-then-Seen rule",
	)
})

test("no document implies /claim or /ack is reachable without the bearer token", () => {
	for (const { file, text } of allProse()) {
		for (const line of text.split("\n")) {
			if (!/\/(claim|ack)\b/.test(line)) continue
			assert.ok(
				!/(unauthenticated|without (?:the )?(?:bearer|token)|no auth)/i.test(line),
				`${file}: ${line.trim()}`,
			)
		}
	}
})

test("/health is documented without claiming it exposes mail content", () => {
	for (const { file, text } of allProse()) {
		for (const line of text.split("\n")) {
			if (!/\/health/.test(line)) continue
			assert.ok(
				!/(subjects?|bodies|body|senders?|mail content)\b/i.test(line),
				`${file} claims /health exposes mail content: ${line.trim()}`,
			)
		}
	}
})

test("no document claims request_decision blocks the agent", () => {
	// It sends the question and ends the turn; the model can ignore it. Calling that a block
	// overstates an enforced gate that does not exist.
	for (const { file, text } of allProse()) {
		assert.ok(
			!/request_decision blocks the agent/i.test(text),
			`${file} says request_decision blocks the agent`,
		)
	}
})

test("the troubleshooting section names the reasons the scanner produces", () => {
	const readme = doc("README.md")
	const section = /## A reply did not arrive[\s\S]*?(?=\n## )/.exec(readme)?.[0]
	assert.ok(section, "README should have a troubleshooting section")
	// Every reason process.ts can emit should be answerable from that section.
	// Reasons are emitted from process.ts and from authorize() in authz.ts.
	const emitted = new Set<string>()
	for (const file of ["src/daemon/process.ts", "src/core/authz.ts"]) {
		const text = readFileSync(join(root, file), "utf8")
		for (const m of text.matchAll(/"(not-allowlisted|allowlist-empty|dmarc-[a-z]+|no-token|no-from|other-device|self-echo|self|empty-body|pending-full|auto-generated)"/g)) {
			emitted.add(m[1]!)
		}
	}
	assert.ok(emitted.size >= 6, `expected the reason set, got ${emitted.size}`)
	for (const reason of emitted) {
		assert.ok(section.includes(reason), `the troubleshooting table omits ${reason}`)
	}
	assert.match(section, /daemon\.log/, "and must say where the log is")
})

test("the live-mailbox status is stated the same way in README and CHANGELOG", () => {
	// One file said "not yet battle-tested against a live mailbox" while the other recorded
	// live QQ and Outlook testing. Pick one story.
	for (const { file, text } of allProse()) {
		assert.ok(
			!/not yet (?:been )?(?:battle-tested|validated) against a live mailbox/i.test(text),
			`${file} claims the package has never seen a live mailbox`,
		)
	}
})

test("the README says how to remove the package and its state", () => {
	// A user who tried it and wants it gone needs a path out; there was none.
	const readme = doc("README.md")
	const section = /## Turning it off for good[\s\S]*?(?=\n## )/.exec(readme)?.[0]
	assert.ok(section, "README should have an uninstall section")
	assert.match(section, /systemctl --user disable/, "stops the unit")
	assert.match(section, /state\/pi-mailbridge/, "and says where the state lives")
	assert.match(section, /config\/pi-mailbridge/, "including the credentials")
})

test("no doc claims the machines share one secret", () => {
	// secret.key is per machine; there is no shared key to rotate.
	for (const { file, text } of allProse()) {
		assert.ok(!/share[^.]*one secret|shared secret/i.test(text), `${file} implies a shared secret`)
	}
})

test("the README's status example matches the formatter's shape", () => {
	const readme = doc("README.md")
	const sample = /last scan: [^\n]*examined \d+, kept \d+, rejected \d+/.exec(readme)
	assert.ok(sample, "the example should show the fields status prints")
	const status = readFileSync(join(root, "src/core/status.ts"), "utf8")
	assert.match(status, /last scan: .*examined .*kept .*rejected/s, "and the formatter should print them")
	// Accepted-path counters must not be labelled as rejections (they were).
	assert.match(status, /HANDLED/, "status must separate accepted counters from refusals")
})

test("no doc claims /mailbridge check verifies credentials work", () => {
	// It checks presence and shape without a network call; a wrong password still reports
	// "config ok", so saying it validates credentials sends users away from smoke.
	for (const { file, text } of allProse()) {
		for (const line of text.split("\n")) {
			if (!/mailbridge check|--check/.test(line)) continue
			assert.ok(
				!/(validates?|verif(?:y|ies)|checks?)\b[^.]*\bcredentials\b(?!\s*(?:are\s+)?\*?present)/i.test(line),
				`${file}: ${line.trim()}`,
			)
		}
	}
})

test("the README states the Node floor", () => {
	assert.match(doc("README.md"), /Node(?:\.js)?\s*(?:≥|>=)\s*22\.6/, "the docs must state the minimum Node version")
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { engines?: { node?: string } }
	assert.equal(pkg.engines?.node, ">=22.6", "and it must match package.json")
})

test("route-miss and attachment drops are not classified as rejections", () => {
	// They were printed under "rejections:" while `rejected` said 0, contradicting itself.
	const status = readFileSync(join(root, "src/core/status.ts"), "utf8")
	const handled = /HANDLED = new Set\(\[([^\]]*)\]\)/.exec(status)?.[1] ?? ""
	assert.ok(handled.includes("route-miss"), "route-miss still routes, so it is not a rejection")
	assert.match(status, /attachment-/, "attachment drops are reported as notes")
})

test("the device-and-session claim is scoped to settle mails", () => {
	// The two agent tools build their own subject from the routing id only; "every
	// notification" was false for the decision mail, which is the one that matters.
	for (const { file, text } of allProse()) {
		assert.ok(
			!/every notification[^.]*device and (?:the )?session/i.test(text),
			`${file} claims every notification names the device and session`,
		)
	}
})

test("the reload promise matches what setup can do when no daemon is running", () => {
	const readme = doc("README.md")
	// setup/reload only touch a daemon that exists; the docs must not promise otherwise.
	const row = readme.split("\n").find((l) => /\/mailbridge setup/.test(l) && /reload the daemon/.test(l))
	assert.ok(row, "the setup row should describe what it does to the daemon")
	assert.match(row!, /start or reload the daemon/, "and must say it can start one")
})

test("no doc claims every notification names the device", () => {
	// Only settle mails carry the device line; the two agent tools build their own subject.
	// The previous guard pinned one exact phrase and both copies of the false claim survived.
	for (const { file, text } of allProse()) {
		// Collapsed first: the previous version was line-scoped, and the claim it was written
		// for was wrapped across two lines, so it passed.
		for (const sentence of flat(text).split(/(?<=[.!?])\s+/)) {
			if (!/every notification/i.test(sentence)) continue
			// The marker header genuinely is on every notification; the device line is not.
			assert.ok(
				!/device|session name/i.test(sentence),
				`${file} claims every notification names the device: ${sentence.trim()}`,
			)
		}
	}
})

test("the systemd checklist includes the state directory", () => {
	// ProtectHome=read-only + ReadWritePaths=- mean the unit cannot create it, and
	// ExecStartPre --check fails without it.
	const readme = doc("README.md")
	const block = /Three things the unit cannot guess[\s\S]{0,900}/.exec(readme)?.[0]
	assert.ok(block, "README should list what the unit needs")
	assert.match(block, /mkdir -p ~\/\.local\/state\/pi-mailbridge/, "and create the state directory")
})

test("prime is advised before the first /afk, not before the daemon", () => {
	const readme = doc("README.md")
	assert.ok(
		!/prime the cursor before starting the daemon/i.test(readme),
		"setup starts the daemon now, so that advice is un-followable",
	)
	const primeIdx = readme.indexOf("Start watching from now")
	const firstMailIdx = readme.indexOf("Your first notification")
	assert.ok(primeIdx > -1 && firstMailIdx > -1)
	assert.ok(primeIdx < firstMailIdx, "prime must be explained before the first /afk")
})

test("only the settle module puts a device name in a mail", () => {
	// A structural check rather than a phrase match: the device line belongs to settle.ts,
	// and the two agent tools build their own subject/body. If a tool ever grows an
	// equivalent, this fails and the docs get updated on purpose.
	const settle = readFileSync(join(root, "src/core/settle.ts"), "utf8")
	assert.match(settle, /@ \$\{.*device|device:/, "settle.ts should build the device line")
	for (const file of ["src/extension.ts", "src/core/mailer.ts"]) {
		const text = readFileSync(join(root, file), "utf8")
		assert.ok(!/`\[pi:\$\{[^}]*\}\] \$\{subject\} @ \$\{/.test(text), `${file} should not add a device to a subject`)
	}
})

test("the /health field list matches what the handler returns", () => {
	// The list is what a debugging reader trusts; it went stale twice (lastScan, configLoadedAt).
	const arch = flat(doc("docs/ARCHITECTURE.md"))
	const row = arch.split("| GET | `/health` |")[1]?.split("|")[0] ?? ""
	const service = readFileSync(join(root, "src/daemon/service.ts"), "utf8")
	// Field name in code → how the doc may refer to it.
	const expected: [string, RegExp][] = [
		["lastScan", /lastScan|last scan/i],
		["configLoadedAt", /configLoadedAt/],
	]
	for (const [field, pattern] of expected) {
		assert.ok(service.includes(`${field}:`), `handler should return ${field}`)
		assert.match(row, pattern, `the /health row omits ${field}`)
	}
})

test("SECURITY's /health list matches ARCHITECTURE's", () => {
	// The unauthenticated endpoint is what a security reviewer audits, and the two copies
	// drifted twice. Compare them to each other rather than to a hardcoded phrase list.
	const fields = (text: string): string[] => {
		const at = text.indexOf("liveness probe")
		assert.ok(at > -1, "the doc should describe the liveness probe")
		const window = text.slice(at, at + 400).toLowerCase()
		const known: [string, RegExp][] = [
			["mode", /mode/],
			["pending", /pending/],
			["client", /client/],
			["ping", /ping/],
			["idle", /idle/],
			["scan", /scan/],
			// The field is named configLoadedAt in code and "mtime" in prose; both are right.
			["mtime", /configloadedat|mtime/],
			["sse", /sse/],
		]
		return known.filter(([, pattern]) => pattern.test(window)).map(([name]) => name)
	}
	const architecture = fields(doc("docs/ARCHITECTURE.md"))
	const security = fields(doc("docs/SECURITY.md"))
	// SECURITY need not repeat every field, but it must not be missing a whole category.
	const important = ["mode", "pending", "ping", "idle", "scan", "mtime"]
	for (const field of important) {
		assert.ok(architecture.includes(field), `ARCHITECTURE's /health row omits ${field}`)
		assert.ok(security.includes(field), `SECURITY's /health list omits ${field}`)
	}
})

test("no doc claims the daemon stops when a token is rejected", () => {
	// Only SMTP retries once. On IMAP a rejected token re-dials on backoff, so "the daemon
	// stops" would tell a user with a revoked grant to expect silence while it actually
	// re-authenticates every minute.
	for (const { file, text } of allProse()) {
		// Collapsed first: a re-wrapped sentence would slip past a line-based match.
		assert.ok(
			!/then the daemon stops|daemon stops rather than/i.test(flat(text)),
			`${file} claims the daemon stops after a rejected token`,
		)
	}
})

test("the single-mailbox layout states its three requirements", () => {
	// This section is the whole story for one-address users, and it used to say "keep the
	// [pi:...] tag" - which the reply-evidence gate rejects.
	const readme = flat(doc("README.md"))
	const at = readme.indexOf("One mailbox (single personal account)")
	assert.ok(at > -1, "the layout-B section should exist")
	// Bounded by the next section so a later mention elsewhere cannot satisfy the checks.
	const end = readme.indexOf("Once configured, prove it without pi")
	const section = readme.slice(at, end > at ? end : at + 2200)
	assert.match(section, /X-Pi-Mailbridge/, "names the marker guard")
	assert.match(section, /In-Reply-To/, "states that a reply must carry threading headers")
	// Check the config block itself, not the prose: the prose repeats the key name, so a
	// claim-matched assertion would pass even if the block said true.
	const from = Math.max(0, section.indexOf("allowSelfReplies") - 400)
	const block = /```([\s\S]*?)```/.exec(section.slice(from))?.[1] ?? ""
	assert.match(block, /requireDmarcPass\s*=\s*false/, "the layout-B config sets DMARC off")
	assert.match(section, /only supported way in|Reply \(or Forward-then-Reply\)/, "and that Reply is the way in")
})

test("the tag advice is qualified as layout A only", () => {
	const readme = flat(doc("README.md"))
	for (const sentence of readme.split(/(?<=[.!?])\s+/)) {
		if (!/keep the `\[pi:…\]` tag/.test(sentence)) continue
		assert.match(sentence, /layout A|one address|layout B/i, `unqualified tag advice: ${sentence}`)
	}
})

test("no doc still says two things make single-mailbox mode safe", () => {
	// There are three gates; SECURITY.md always said so, the README counted two.
	for (const { file, text } of allProse()) {
		assert.ok(!/two things make that safe/i.test(flat(text)), `${file} undercounts the guards`)
	}
})

test("the QQ provider row carries the 14-day activation rule", () => {
	const row = doc("README.md")
		.split("\n")
		.find((l) => /QQ Mail/.test(l) && /\|/.test(l))
	assert.ok(row, "the provider table should have a QQ row")
	assert.match(row!, /14 days old/, "new QQ accounts cannot enable IMAP/SMTP before 14 days")
})

test("the DMARC-off explanation says what it costs", () => {
	// "DMARC was never what separated you from a stranger" was backwards: it is exactly the
	// control that would stop address forgery, and the docs must not quietly drop it.
	const readme = flat(doc("README.md"))
	const at = readme.indexOf("DMARC cannot work here")
	assert.ok(at > -1, "the layout-B section should explain the DMARC decision")
	const paragraph = readme.slice(at, at + 1200)
	assert.match(paragraph, /forging your address/i, "names the risk that is given up")
	assert.match(paragraph, /route id|routing/i, "and what still keeps a stranger out")
	assert.ok(!/DMARC was never what separated/i.test(readme), "the old claim must not return")
})

test("no doc claims the token provider dies on one failure", () => {
	for (const { file, text } of allProse()) {
		const flatText = flat(text)
		for (const sentence of flatText.split(/(?<=[.!?])\s+/)) {
			if (!/failing token command|disabled after a failing/i.test(sentence)) continue
			assert.match(sentence, /three|3|consecutive/, `${file}: ${sentence}`)
		}
	}
})

test("the renumbering behaviour is documented, including its cost", () => {
	const arch = flat(doc("docs/ARCHITECTURE.md"))
	const at = arch.indexOf("UIDs are only meaningful within one")
	assert.ok(at > -1, "ARCHITECTURE should explain UIDVALIDITY")
	const section = arch.slice(at, at + 900)
	assert.match(section, /reset/i, "says the cursor is reset")
	assert.match(section, /re-deliver|delivered once more/i, "and admits the re-delivery cost")
	assert.match(flat(doc("docs/SECURITY.md")), /uid-cursor\.json/, "SECURITY lists the cursor file")
})

test("authorization claims name DMARC's exception for one mailbox", () => {
	// With one address DMARC is off, so a flat "authorization is the allowlist and DMARC"
	// is false in the layout the README recommends for personal accounts.
	for (const { file, text } of allProse()) {
		const flatText = flat(text)
		for (const sentence of flatText.split(/(?<=[.!?])\s+/)) {
			if (!/allowlist (?:and|plus) DMARC/i.test(sentence)) continue
			if (/routing id authenticates|never authorizes|come first/i.test(sentence)) continue
			assert.match(
				sentence,
				/DMARC is off|off in the single-mailbox|single-mailbox layout/i,
				`${file}: ${sentence}`,
			)
		}
	}
})

test("the /claim and /ack contracts are documented with the UID space", () => {
	const arch = flat(doc("docs/ARCHITECTURE.md"))
	assert.ok(arch.includes("{uid, instanceId, uidValidity?}"), "/claim documents uidValidity")
	assert.match(arch, /stale-space/, "and the refusal reason")
	assert.ok(/\/ack`[^|]*\|[^|]*record's/i.test(arch), "/ack says it journals the record's space")
	assert.ok(arch.includes("/ack` | `{uid, instanceId, uidValidity?}`"), "/ack documents its body")
	assert.match(arch, /uid-cursor\.ts\s+cursor \+ UID space/, "the module map describes the cursor's space")
})

test("the UIDVALIDITY behaviour is in the changelog, not just the architecture", () => {
	const changelog = flat(doc("CHANGELOG.md"))
	assert.match(changelog, /UIDVALIDITY/i, "the release notes must mention it")
	assert.match(changelog, /renumber|renumbering/i, "and what happens when the mailbox is renumbered")
})
