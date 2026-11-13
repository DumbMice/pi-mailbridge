// Docs/code sync and packaging guards.
//
// These exist because a published package with stale docs is worse than no docs:
// a user runs a command or sets a key that does not exist and gets silence.

import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8")

const packageJson = JSON.parse(read("../package.json")) as {
	name: string
	version: string
	files: string[]
	pi: { extensions: string[] }
	peerDependencies: Record<string, string>
}

const readme = read("../README.md")
const extensionSource = read("../src/extension.ts")
const configSource = read("../src/core/config.ts")
const example = JSON.parse(read("../config.example.json")) as Record<string, unknown>

function leafKeys(value: unknown, prefix = ""): string[] {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix]
	return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
		leafKeys(child, prefix ? `${prefix}.${key}` : key),
	)
}

// --- package shape ---------------------------------------------------------

test("package.json declares the pi extension entry point", () => {
	assert.deepEqual(packageJson.pi.extensions, ["./src/extension.ts"])
	assert.ok(existsSync(new URL("../src/extension.ts", import.meta.url)))
})

test("the published file list excludes tests, state and secrets", () => {
	const files = packageJson.files
	assert.ok(files.includes("src"))
	assert.ok(files.includes("docs"))
	assert.ok(files.includes("config.example.json"))
	for (const forbidden of ["test", "node_modules", "config.json", "secret.key"]) {
		assert.ok(!files.includes(forbidden), `${forbidden} must not be published`)
	}
	// And the real files must not be tracked in the first place.
	assert.ok(existsSync(new URL("../.gitignore", import.meta.url)))
	const gitignore = read("../.gitignore")
	for (const secret of ["config.json", "secret.key"]) {
		assert.ok(gitignore.includes(secret), `${secret} must be gitignored`)
	}
})

test("runtime deps stay minimal and pi is only a peer dependency", () => {
	const pkg = JSON.parse(read("../package.json")) as { dependencies: Record<string, string> }
	assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["imapflow", "mailparser", "markdown-it", "nodemailer", "openid-client"])
	assert.ok(packageJson.peerDependencies["@earendil-works/pi-coding-agent"])
	assert.equal(packageJson.peerDependencies["imapflow"], undefined, "imapflow is a real dependency, not a peer")
})

// --- commands documented == commands implemented ---------------------------

test("every command in the README is registered in the extension", () => {
	// Only `/mailbridge` exists as a top-level command: on/off are subcommands of it.
	const documented = [...readme.matchAll(/`\/([a-z]+)`/g)]
		.map((m) => m[1]!)
		.filter((name) => name === "mailbridge")
	const unique = [...new Set(documented)]
	assert.ok(unique.length >= 1, `expected /mailbridge in README, found ${unique.length}`)
	for (const name of unique) {
		assert.ok(
			extensionSource.includes(`registerCommand("${name}"`),
			`README documents /${name} but extension.ts does not register it`,
		)
	}
})

test("every tool in the README is registered in the extension", () => {
	for (const name of ["request_decision", "notify_user"]) {
		assert.ok(readme.includes(name), `README must document ${name}`)
		assert.ok(extensionSource.includes(`name: "${name}"`), `extension.ts must register ${name}`)
	}
})

// --- config documented == config read --------------------------------------

test("every key in config.example.json is read by config.ts", () => {
	const keys = leafKeys(example)
	assert.ok(keys.length > 20, `expected a full example, got ${keys.length} leaves`)
	const missing = keys.filter((path) => {
		const leaf = path.split(".").pop()!
		return !configSource.includes(leaf)
	})
	assert.deepEqual(missing, [], `config.example.json documents keys config.ts never reads: ${missing.join(", ")}`)
})

test("security defaults are safe by construction", () => {
	const security = example["security"] as Record<string, unknown>
	const daemon = example["daemon"] as Record<string, unknown>
	const mail = example["mail"] as Record<string, Record<string, unknown>>

	assert.deepEqual(security["allowFrom"], ["you@example.com"])
	assert.equal(security["requireDmarcPass"], true)
	assert.equal(daemon["host"], "127.0.0.1")
	assert.ok(["LOGIN", "XOAUTH2"].includes(String(mail["imap"]!["authType"])))
	assert.ok(["LOGIN", "XOAUTH2"].includes(String(mail["smtp"]!["authType"])))
})

test("the example never contains a live-looking secret", () => {
	const text = read("../config.example.json")
	// A placeholder, not an instruction: a self-hosted user needs their account password,
	// and "APP_PASSWORD_NOT_LOGIN_PASSWORD" would be sent verbatim if copied.
	assert.match(text, /<PASSWORD>/)
	assert.ok(!/-----BEGIN/.test(text))
	// No password field may hold a plausible literal (the placeholder starts with "<").
	for (const m of text.matchAll(/"password":\s*"([^"]*)"/g)) {
		assert.ok(m[1] === "" || m[1]!.startsWith("<"), `config.example.json has a literal password: ${m[1]}`)
	}
})

// --- systemd unit ----------------------------------------------------------

test("the systemd unit runs the same entry point and self-checks first", () => {
	const unit = read("../docs/systemd/pi-mailbridge.service")
	// The compiled entry, run by plain node: an installed package cannot strip types inside
	// node_modules, so a unit pointing at src/daemon/main.ts would never start.
	assert.match(unit, /dist\/daemon\/main\.js/)
	assert.doesNotMatch(unit, /--experimental-strip-types/, "the unit runs the build, not the sources")
	assert.match(unit, /--check/)
	assert.match(unit, /ReadWritePaths/, "unit should be hardened")
})

test("the systemd unit does not hardcode paths that may not exist", () => {
	const unit = read("../docs/systemd/pi-mailbridge.service")
	// /usr/bin/node is absent on a machine where pi shipped its own Node, and the
	// npm package path is wrong for a local checkout. Both must be configurable.
	assert.doesNotMatch(unit, /^ExecStart=\/usr\/bin\/node/m, "node path must not be hardcoded")
	assert.match(unit, /Environment=PATH=/, "PATH must carry the pi-managed node first")
	assert.match(unit, /Environment=PI_MAILBRIDGE_DIR=/)
	// systemd cannot expand a variable in the executable position, so the binary must
	// be a literal path and the variables may only appear as arguments.
	assert.match(unit, /^ExecStart=\/usr\/bin\/env node .*\$\{PI_MAILBRIDGE_DIR\}/m)
	assert.match(unit, /local checkout|Work\/pi-mailbridge/, "a local-path variant should be shown")
})

// --- README integrity ------------------------------------------------------

test("README links to the three design docs", () => {
	for (const doc of ["docs/ARCHITECTURE.md", "docs/MAPPING.md", "docs/SECURITY.md"]) {
		assert.ok(readme.includes(doc), `README should link ${doc}`)
		assert.ok(existsSync(new URL(`../${doc}`, import.meta.url)), `${doc} must exist`)
	}
})

test("README states the shipped version", () => {
	assert.ok(readme.includes(`\`${packageJson.version}\``), `README should mention ${packageJson.version}`)
})

// --- any-device framing + device identity ---------------------------------

test("docs say any device with email, not phone-only", () => {
	const docs = [readme, read("../docs/ARCHITECTURE.md"), read("../docs/SECURITY.md")].join("\n").toLowerCase()
	// Positive assertions: the universal framing is present.
	for (const phrase of ["any device", "tablet", "another pc", "webmail"]) {
		assert.ok(docs.includes(phrase), `docs should mention "${phrase}"`)
	}
	assert.ok(readme.includes("No app, no account, no relay, no push service"))
})

test("device.name is documented and shipped in the example config", () => {
	assert.ok(readme.includes("device.name"), "README config table must document device.name")
	const device = example["device"] as Record<string, unknown>
	assert.ok(device && typeof device["name"] === "string", "config.example.json must include device.name")
	assert.ok(configSource.includes("device"), "config.ts must read device settings")
})

test("the README shows a notification naming both device and session", () => {
	assert.match(readme, /device: /, "the sample notification should show the device line")
	assert.match(readme, /session: /, "the sample notification should show the session line")
	assert.match(readme, /@ .*is waiting for you/, "the sample subject should name the device")
})

test("the reply identification rule is documented in README and ARCHITECTURE", () => {
	for (const doc of [readme, read("../docs/ARCHITECTURE.md")]) {
		assert.match(doc, /In-Reply-To/, "must name In-Reply-To")
		assert.match(doc, /References/, "must name References")
		assert.match(doc, /no-token/, "must say what happens when nothing matches")
	}
	assert.ok(readme.includes("security.allowHeaderThreading"), "README must document the switch")
	const security = example["security"] as Record<string, unknown>
	assert.equal(security["allowHeaderThreading"], true, "example config must ship the default")
})

test("OAuth is documented in one coherent place", () => {
	assert.ok(existsSync(new URL("../docs/OAUTH.md", import.meta.url)), "docs/OAUTH.md must exist")
	assert.ok(readme.includes("docs/OAUTH.md"), "README must link the OAuth guide")

	// The example config is the app-password path end to end. Shipping an oauth block
	// beside `authType: LOGIN` produced an inert block and a warning for anyone who
	// copy-pasted it, so the block lives in the OAuth guide with a matching authType.
	assert.equal(example["oauth"], undefined, "config.example.json must not mix OAuth into the LOGIN example")
	const guide = read("../docs/OAUTH.md")
	for (const key of ["issuer", "clientId", "scope"]) {
		assert.ok(guide.includes(`"${key}"`), `docs/OAUTH.md must show oauth.${key}`)
	}
	assert.match(guide, /offline_access/, "offline_access is required for a refresh token")
	assert.match(guide, /"authType": "XOAUTH2"/, "the OAuth example must use XOAUTH2, not mix with LOGIN")
})

test("the provider matrix names the risky case honestly", () => {
	assert.match(readme, /Personal.*outlook\.com|personal-Outlook/i, "README must call out personal Outlook")
	assert.match(readme, /Graph/, "README must name the Graph escape hatch")
	assert.match(readme, /not\s+\*\*implemented|not implemented/i, "README must admit Graph is not built yet")
})

test("the in-pi flow is documented first, CLI only as headless", () => {
	for (const sub of ["setup", "auth", "smoke"]) {
		assert.match(readme, new RegExp(`/mailbridge ${sub}`), `README must document /mailbridge ${sub}`)
	}
	// The CLI must be framed as the daemon/systemd entry point, not the normal path.
	assert.match(readme, /headless/i, "README should label the CLI as headless/systemd only")
	assert.match(readme, /--check/, "README should keep the ExecStartPre check documented")
})

test("the extension resolves the daemon script with fileURLToPath", () => {
	const src = read("../src/extension.ts")
	assert.match(src, /fileURLToPath\(new URL\(/, "must convert the URL to a filesystem path properly")
	assert.doesNotMatch(src, /\.pathname/, "URL.pathname breaks on spaces and non-ASCII paths")
})

test("every parsed subcommand has a handler in the extension", () => {
	const src = read("../src/extension.ts")
	for (const sub of ["status", "setup", "check", "auth", "smoke", "restart", "help"]) {
		assert.ok(src.includes(`case "${sub}":`), `/mailbridge ${sub} is parsed but has no handler`)
	}
})

test("--prime is documented", () => {
	assert.match(readme, /--prime|primed/i, "README should mention priming the cursor")
})

test("the daemon assigns currentWatcher before starting it", () => {
	const src = read("../src/daemon/main.ts")
	const assign = src.indexOf("currentWatcher = watcher")
	const start = src.indexOf("await watcher.start()")
	assert.ok(assign > 0 && start > 0, "both statements must exist")
	assert.ok(
		assign < start,
		"start() fires onReady, whose catch-up scan reads through sourceProxy; assigning afterwards breaks it",
	)
})

test("the documented CLI actually exists and ships", () => {
	// README documents `pi-mailbridge --smoke/--check/--auth/--prime`, and SECURITY.md points
	// at package.json's author for disclosure. All three were missing.
	const pkg = JSON.parse(read("../package.json")) as {
		bin?: Record<string, string>
		author?: string
		repository?: { url?: string }
		files: string[]
	}
	assert.ok(pkg.bin?.["pi-mailbridge"], "package.json must declare the pi-mailbridge bin")
	// SECURITY.md's disclosure channel must actually work: an author with an address. This
	// package publishes no `repository`, so SECURITY leads with the address instead of pointing
	// at a URL that does not exist.
	const author = pkg.author as { email?: string } | string | undefined
	const email = typeof author === "string" ? author : author?.email
	assert.match(String(email), /@/, "SECURITY.md's disclosure channel needs a reachable address")
	assert.ok(pkg.files.includes("bin"), "the bin shim must ship in the tarball")

	// The shim is plain `node`: an installed package runs the compiled `dist/`, because Node
	// refuses to strip types inside node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
	const shim = read("../bin/pi-mailbridge.mjs")
	assert.match(shim, /^#!\/usr\/bin\/env node\n/, "the shim must run plain node")
	assert.match(shim, /dist\/daemon\/main\.js/, "and prefer the compiled daemon")
	assert.ok(pkg.files.includes("dist"), "which must ship in the tarball")
	assert.match(shim, /src\/daemon\/main\.ts/, "with a source fallback for a checkout")
	assert.match(shim, /main\(\)/, "and actually invokes the CLI")
})

test("the daemon entry guard does not compare a URL to a path", () => {
	// The extension's copy of this bug was fixed with fileURLToPath; main.ts kept
	// `import.meta.url === \`file://${process.argv[1]}\``, which is false for any install
	// path with a space or non-ASCII character - the unit then runs nothing and exits 0.
	const main = readFileSync(fileURLToPath(new URL("../src/daemon/main.ts", import.meta.url)), "utf8")
	assert.doesNotMatch(main, /`file:\/\/\$\{process\.argv\[1\]\}`/, "compare paths, not a URL and a path")
	assert.match(main, /realpathSync\(fileURLToPath\(import\.meta\.url\)\)/, "and resolve both sides")
})

test("the daemon starts from an installed package, not just a checkout", () => {
	// Node refuses type stripping inside node_modules
	// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a package that ships only .ts can be
	// installed, loaded by pi (jiti) and still be unable to start its daemon. Every live test
	// before this ran from a checkout, where the failure cannot happen.
	const box = mkdtempSync(join(tmpdir(), "pmb-install-"))
	const installed = join(box, "node_modules", "pi-mailbridge")
	mkdirSync(join(box, "node_modules"), { recursive: true })
	// The runtime dependencies, without copying them: a real install has them beside the package.
	for (const dep of readdirSync(join(root, "node_modules"))) {
		if (dep === "pi-mailbridge" || dep.startsWith(".")) continue
		try {
			symlinkSync(join(root, "node_modules", dep), join(box, "node_modules", dep))
		} catch {
			/* a scoped entry needs its parent first; skip what cannot be linked */
		}
	}
	mkdirSync(installed, { recursive: true })
	for (const part of ["dist", "bin", "package.json"]) {
		cpSync(join(root, part), join(installed, part), { recursive: true })
	}

	const out = execFileSync(process.execPath, [join(installed, "bin", "pi-mailbridge.mjs"), "--print-token"], {
		encoding: "utf8",
		env: { ...process.env, XDG_STATE_HOME: join(box, "state"), XDG_CONFIG_HOME: join(box, "config") },
		timeout: 20_000,
	})
	assert.match(out.trim(), /^[A-Za-z0-9_-]{20,}$/, "the daemon entry ran and printed the secret")

	// And the thing it would have done: resolve a script inside node_modules with no TS flag.
	const spawned = readFileSync(join(installed, "dist", "daemon", "main.js"), "utf8")
	assert.doesNotMatch(spawned, /^import .*\.ts"/m, "the build must not import .ts")
})
