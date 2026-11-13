// Docs/code sync and packaging guards.
//
// These exist because a published package with stale docs is worse than no docs:
// a user runs a command or sets a key that does not exist and gets silence.

import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
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
	main: string
	peerDependencies: Record<string, string>
	repository?: { url?: string }
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

test("the published name, its scope and the README's install command agree", () => {
	// Three places name the package and only one of them is checked by npm. A rename that misses
	// the README greets every new user with `pi install` failing on a name that does not exist.
	assert.match(packageJson.name, /^@[a-z0-9-]+\/[a-z0-9-]+$/, "a scoped name: npm needs --access public")
	const [scope, bare] = packageJson.name.slice(1).split("/")
	assert.ok(scope && bare, "slug/bare parts")
	assert.ok(
		readme.includes(`pi install npm:${packageJson.name}`),
		`README must install npm:${packageJson.name}`,
	)
	// Case-insensitive: GitHub's canonical case is `DumbMice`, npm's scope must be lowercase, and
	// npm's trusted publishing compares the URL against the OIDC claim (GitHub's case).
	assert.ok(
		(packageJson.repository?.url ?? "").toLowerCase().includes(`/${scope}/${bare}`),
		`repository must point at ${scope}/${bare}`,
	)
	// The command and the state directory keep the bare name: they are the product, not the scope.
	assert.ok(readme.includes("pi-mailbridge --smoke"), "the CLI keeps the bare name")
})

test("the release workflow can actually publish: OIDC, no token, matching name", () => {
	// Each of these breaks publishing only at release time, which is the worst moment to find
	// out. npm binds the publish to this filename, so it is asserted too.
	const workflow = read("../.github/workflows/publish.yml")
	assert.match(workflow, /id-token: write/, "trusted publishing needs an OIDC token")
	assert.match(workflow, /contents: read/)
	// setup-node's registry-url writes _authToken=${NODE_AUTH_TOKEN}; with no token set, npm
	// fails to expand it instead of using OIDC.
	assert.doesNotMatch(workflow, /registry-url:/, "no token .npmrc in an OIDC workflow")
	assert.match(workflow, /npm publish --access public/)
	assert.match(workflow, /npm \^?11\.5\.1|npm@\^11\.5\.1/, "npm >= 11.5.1 does the OIDC exchange")
	assert.match(workflow, /node-version: "22"/)
	// The npm Trusted Publisher form asks for the repository and the workflow filename; the
	// package's own repository.url must match, and its case is GitHub's.
	assert.ok(
		(packageJson.repository?.url ?? "").includes("github.com/DumbMice/pi-mailbridge"),
		"repository.url must match the repository the workflow runs in",
	)
})

test("the CLI runs a checkout's sources, and an install's build", () => {
	// The same stale-build trap as src/daemon/script.ts, in the command a new user runs first:
	// `pi-mailbridge --check` used to import dist/ whenever it existed, so a checkout without a
	// fresh build silently ran old code. Run for real, in both layouts, with markers.
	const layout = (installed: boolean, withBuild = true): string => {
		const dir = mkdtempSync(join(tmpdir(), "pmb-bin-"))
		const pkg = installed ? join(dir, "node_modules", "pi-mailbridge") : join(dir, "pkg")
		mkdirSync(join(pkg, "bin"), { recursive: true })
		cpSync(join(root, "bin", "pi-mailbridge.mjs"), join(pkg, "bin", "pi-mailbridge.mjs"))
		if (withBuild) {
			mkdirSync(join(pkg, "dist", "daemon"), { recursive: true })
			writeFileSync(join(pkg, "dist", "daemon", "main.js"), 'console.log("MARKER-BUILD"); export function main() {}\n')
		}
		mkdirSync(join(pkg, "src", "daemon"), { recursive: true })
		writeFileSync(join(pkg, "src", "daemon", "main.ts"), 'console.log("MARKER-SOURCE"); export function main() {}\n')
		try {
			return execFileSync(process.execPath, [join(pkg, "bin", "pi-mailbridge.mjs"), "--check"], {
				encoding: "utf8",
			})
		} catch (error) {
			// A non-zero exit (the incomplete install) still has something to say on stderr.
			const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string }
			return `${stdout}${stderr}`
		}
	}
	assert.match(layout(true), /MARKER-BUILD/, "an install must run the build")
	// An install with no build has nothing runnable: the .ts would fail with Node's
	// "unsupported inside node_modules" error, which names neither the problem nor the fix.
	const brokenInstall = layout(true, false)
	assert.match(brokenInstall, /no compiled build/, "an incomplete install must say so")
	// The source branch spawns with inherited stdio, so the absence of the build marker is the
	// observable: it did not take the dist path.
	assert.doesNotMatch(layout(false), /MARKER-BUILD/, "a checkout must not run the build")
})

test("`main` names a file a plain-Node consumer can import", () => {
	// It used to point at ./src/extension.ts, which throws
	// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING from inside node_modules. pi itself never reads
	// `main` (it uses pi.extensions through jiti), so the field only ever misled everyone else.
	assert.equal(packageJson.main, "./dist/extension.js")
	assert.ok(
		packageJson.files.includes("dist"),
		"the build must ship, or `main` points at nothing in the tarball",
	)
	// Tests run after `pretest` builds, so the target exists here too.
	assert.ok(existsSync(new URL(packageJson.main, new URL("..", import.meta.url))), "main must resolve")
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
	// The CLI must be framed as the headless entry point, not the normal path.
	assert.match(readme, /headless/i, "README should label the CLI as headless")
	assert.match(readme, /--check/, "README should keep the ExecStartPre check documented")
})

test("the extension resolves the daemon script through the shared resolver", () => {
	// Path resolution moved into daemon/script.ts, which is tested against both layouts
	// (test/daemon-script.test.ts). What must hold here is that the extension uses it, and that
	// no URL is turned into a path with `.pathname` (breaks on spaces and non-ASCII).
	assert.match(extensionSource, /resolveDaemonScript\(import\.meta\.url\)/, "uses the resolver")
	assert.doesNotMatch(extensionSource, /\.pathname/, "URL.pathname breaks on spaces and non-ASCII paths")
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
	// The spawn path is a pure resolver so both layouts are testable (see daemon-script.test.ts).
	assert.match(extensionSource, /resolveDaemonScript\(import\.meta\.url\)/, "the extension uses the resolver")
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
