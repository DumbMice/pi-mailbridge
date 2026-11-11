// Docs/code sync and packaging guards.
//
// These exist because a published package with stale docs is worse than no docs:
// a user runs a command or sets a key that does not exist and gets silence.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
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
	assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["imapflow", "mailparser", "nodemailer", "openid-client"])
	assert.ok(packageJson.peerDependencies["@earendil-works/pi-coding-agent"])
	assert.equal(packageJson.peerDependencies["imapflow"], undefined, "imapflow is a real dependency, not a peer")
})

// --- commands documented == commands implemented ---------------------------

test("every command in the README is registered in the extension", () => {
	const documented = [...readme.matchAll(/`\/(afk|back|mailbridge)`/g)].map((m) => m[1])
	const unique = [...new Set(documented)]
	assert.ok(unique.length >= 3, `expected 3 commands in README, found ${unique.length}`)
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
	assert.match(text, /APP_PASSWORD_NOT_LOGIN_PASSWORD/)
	assert.ok(!/-----BEGIN/.test(text))
})

// --- systemd unit ----------------------------------------------------------

test("the systemd unit runs the same entry point and self-checks first", () => {
	const unit = read("../docs/systemd/pi-mailbridge.service")
	assert.match(unit, /src\/daemon\/main\.ts/)
	assert.match(unit, /--check/)
	assert.match(unit, /127\.0\.0\.1|ReadWritePaths/, "unit should be hardened")
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
