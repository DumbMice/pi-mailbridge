import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runSetup } from "../src/core/setup.ts"
import { buildSetupConfig } from "../src/core/discover.ts"
import { configPath } from "../src/store/paths.ts"

const env = () => ({ XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "pmb-setup-")) })

const offline = (async () => {
	throw new Error("ENOTFOUND")
}) as unknown as typeof fetch

test("a hostname with no dot is explained, not just refused", async () => {
	const e = env()
	const result = await runSetup({ address: "pi@hotmail", env: e, fetchImpl: offline })

	assert.equal(result.ok, false)
	assert.match(result.steps.join("\n"), /is not a domain/i)
	assert.match(String(result.next), /hotmail\.com/, "must tell them what to write")
	// And it must not have written anything.
	assert.throws(() => readFileSync(join(e.XDG_CONFIG_HOME!, "pi-mailbridge", "config.json")))
})

test("a full hotmail.com address works even offline (built-in provider table)", async () => {
	const e = env()
	const result = await runSetup({ address: "pi-x@hotmail.com", to: "me@hotmail.com", env: e, fetchImpl: offline })

	assert.equal(result.ok, true, result.steps.join("\n"))
	assert.match(result.steps.join("\n"), /outlook\.office365\.com:993/)

	const written = JSON.parse(readFileSync(join(e.XDG_CONFIG_HOME!, "pi-mailbridge", "config.json"), "utf8"))
	assert.equal(written.mail.imap.host, "outlook.office365.com")
	assert.equal(written.mail.imap.authType, "XOAUTH2")
	assert.equal(written.mail.to, "me@hotmail.com")
	assert.equal(written.security.allowSelfReplies, false, "layout A: different addresses")
	assert.equal(written.oauth.issuer, "https://login.microsoftonline.com/consumers/v2.0")
	assert.match(String(result.next), /client id/i)
})

test("an existing config needs force", async () => {
	const e = env()
	const first = await runSetup({ address: "pi@hotmail.com", to: "me@hotmail.com", env: e, fetchImpl: offline })
	assert.equal(first.ok, true)

	const second = await runSetup({ address: "pi@hotmail.com", to: "me@hotmail.com", env: e, fetchImpl: offline })
	assert.equal(second.ok, false)
	assert.match(String(second.next), /force/)

	const forced = await runSetup({ address: "pi@hotmail.com", to: "me@hotmail.com", env: e, fetchImpl: offline, force: true })
	assert.equal(forced.ok, true)
})

test("an unknown domain still fails clearly", async () => {
	const e = env()
	const result = await runSetup({ address: "pi@mail.example.org", env: e, fetchImpl: offline })
	assert.equal(result.ok, false)
	assert.match(result.steps.join("\n"), /no published mail settings/)
})

test("gmail setup chooses an app password, not OAuth", async () => {
	const e = env()
	const result = await runSetup({ address: "pi-x@gmail.com", to: "me@hotmail.com", env: e, fetchImpl: offline })
	assert.equal(result.ok, true, result.steps.join("\n"))
	assert.match(result.steps.join("\n"), /imap\.gmail\.com:993/)

	const written = JSON.parse(readFileSync(join(e.XDG_CONFIG_HOME!, "pi-mailbridge", "config.json"), "utf8"))
	assert.equal(written.mail.imap.authType, "LOGIN", "app password, not a 7-day OAuth token")
	assert.equal(written.oauth, undefined, "no OAuth block: nothing to register")
	assert.match(String(result.next), /app password/i)
})

test("outlook setup still requires OAuth", async () => {
	const e = env()
	const result = await runSetup({ address: "pi-x@hotmail.com", to: "me@hotmail.com", env: e, fetchImpl: offline })
	assert.equal(result.ok, true)
	const written = JSON.parse(readFileSync(join(e.XDG_CONFIG_HOME!, "pi-mailbridge", "config.json"), "utf8"))
	assert.equal(written.mail.imap.authType, "XOAUTH2", "no app-password path exists for Microsoft any more")
	assert.ok(written.oauth)
})

test("check-style warnings flag an empty app password", async () => {
	const { loadConfig } = await import("../src/core/config.ts")
	const { mkdirSync, writeFileSync } = await import("node:fs")
	const e = env()
	mkdirSync(join(e.XDG_CONFIG_HOME!, "pi-mailbridge"), { recursive: true })
	writeFileSync(
		join(e.XDG_CONFIG_HOME!, "pi-mailbridge", "config.json"),
		JSON.stringify({
			mail: {
				imap: { host: "imap.qq.com", port: 993, secure: true, user: "pi@qq.com", password: "", folder: "INBOX", authType: "LOGIN" },
				smtp: { host: "smtp.qq.com", port: 465, secure: true, user: "pi@qq.com", password: "", authType: "LOGIN" },
				to: "me@hotmail.com",
			},
			security: { allowFrom: ["me@hotmail.com"], requireDmarcPass: false },
		}),
	)

	const warnings = loadConfig(e).warnings.join("\n")
	assert.match(warnings, /mail\.imap\.password is empty/)
	assert.match(warnings, /mail\.smtp\.password is empty/)
	assert.match(warnings, /授权码/, "the message should name the code, since that is what QQ shows")
})

test("no empty-password warning once a password is set", async () => {
	const { loadConfig } = await import("../src/core/config.ts")
	const { mkdirSync, writeFileSync } = await import("node:fs")
	const e = env()
	mkdirSync(join(e.XDG_CONFIG_HOME!, "pi-mailbridge"), { recursive: true })
	writeFileSync(
		join(e.XDG_CONFIG_HOME!, "pi-mailbridge", "config.json"),
		JSON.stringify({
			mail: {
				imap: { host: "imap.qq.com", port: 993, secure: true, user: "pi@qq.com", password: "x", folder: "INBOX", authType: "LOGIN" },
				smtp: { host: "smtp.qq.com", port: 465, secure: true, user: "pi@qq.com", password: "x", authType: "LOGIN" },
				to: "me@hotmail.com",
			},
			security: { allowFrom: ["me@hotmail.com"], requireDmarcPass: false },
		}),
	)
	assert.doesNotMatch(loadConfig(e).warnings.join("\n"), /password is empty/)
})

test("setup turns DMARC off for one address and on for two", async () => {
	// The two settings are written together, so they must agree: requiring DMARC on a
	// self-addressed mailbox rejects every reply on providers that stamp no header.
	const { buildSetupConfig } = await import("../src/core/discover.ts")
	const base = {
		imap: { host: "imap.qq.com", port: 993, secure: true },
		smtp: { host: "smtp.qq.com", port: 465, secure: true },
		authType: "LOGIN" as const,
		provider: "other" as const,
		folder: "INBOX",
	}
	const single = buildSetupConfig("you@qq.com", "you@qq.com", base as never)
	assert.equal(single.security.allowSelfReplies, true)
	assert.equal(single.security.requireDmarcPass, false, "one address cannot require DMARC")

	const two = buildSetupConfig("pi@qq.com", "you@qq.com", base as never)
	assert.equal(two.security.allowSelfReplies, false)
	assert.equal(two.security.requireDmarcPass, true, "two addresses keep DMARC")
})

test("setup names the Sent folder on a provider that rewrites Message-ID", () => {
	// Measured live: QQ rewrites the Message-ID we stamp, which kills the reply-chain fallback.
	// Nothing configured the read-back, so the documented fallback silently did not work for the
	// one provider we know needs it.
	const discovered = (host: string) => ({
		provider: "other" as const,
		imap: { host: `imap.${host}`, port: 993, secure: true },
		smtp: { host: `smtp.${host}`, port: 465, secure: true },
		user: `someone@${host}`,
		folder: "INBOX",
		authType: "LOGIN" as const,
	})

	const qq = buildSetupConfig("someone@qq.com", "you@example.com", discovered("qq.com"))
	assert.equal(qq.mail.imap.sentFolder, "Sent Messages")

	const generic = buildSetupConfig("someone@fastmail.com", "you@example.com", discovered("fastmail.com"))
	assert.equal(generic.mail.imap.sentFolder, undefined, "only where it is known to be needed")
})

test("the auto-detected Sent folder cannot be triggered by a lookalike host", () => {
	// A loosening to /qq\.com/ would pass the suite and would quietly write a Sent folder for
	// hosts nobody measured.
	const discovered = (host: string) => ({
		provider: "other" as const,
		imap: { host, port: 993, secure: true },
		smtp: { host: host.replace("imap", "smtp"), port: 465, secure: true },
		user: "someone@example.com",
		folder: "INBOX",
		authType: "LOGIN" as const,
	})
	for (const host of ["imap.notqq.com", "imap.qq.com.evil.example", "imap.qq.com.evil"]) {
		const config = buildSetupConfig("someone@example.com", "you@example.com", discovered(host))
		assert.equal(config.mail.imap.sentFolder, undefined, `${host} must not be treated as QQ`)
	}
	for (const host of ["imap.qq.com", "imap.foxmail.com"]) {
		const config = buildSetupConfig("someone@example.com", "you@example.com", discovered(host))
		assert.equal(config.mail.imap.sentFolder, "Sent Messages", `${host} is QQ/Foxmail`)
	}
})

test("setup refuses a bad human address instead of writing it", async () => {
	// `to` is where every notification goes and the only sender the allowlist accepts. A typo
	// used to be written verbatim: mails to a nonexistent address, every reply rejected.
	const dir = mkdtempSync(join(tmpdir(), "setup-to-"))
	const env = { XDG_CONFIG_HOME: dir }
	const result = await runSetup({ address: "pi@example.com", to: "typo-at-example.com", env })
	assert.equal(result.ok, false)
	assert.match(result.steps.join("\n"), /not an email address: typo-at-example.com/)
	assert.equal(existsSync(configPath(env)), false, "and nothing was written")
})

test("setup force keeps the machine's device name", async () => {
	// Records are stamped with the device that scanned them; renaming the machine on `force`
	// made already-queued replies undeliverable, with only a status line to say so.
	const dir = mkdtempSync(join(tmpdir(), "setup-device-"))
	const env = { XDG_CONFIG_HOME: dir }
	mkdirSync(join(dir, "pi-mailbridge"), { recursive: true })
	writeFileSync(
		configPath(env),
		JSON.stringify({ device: { name: "my-laptop" }, mail: { to: "you@example.com" } }),
	)

	// Discovery is stubbed through the injected fetch: a minimal autoconfig document.
	const xml = `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="example.com">
		<incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType>
		<authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></incomingServer>
		<outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>465</port><socketType>SSL</socketType>
		<authentication>password-cleartext</authentication><username>%EMAILADDRESS%</username></outgoingServer>
	</emailProvider></clientConfig>`
	const result = await runSetup({
		address: "pi@example.com",
		to: "you@example.com",
		force: true,
		env,
		fetchImpl: (async () => new Response(xml, { status: 200 })) as unknown as typeof fetch,
	})
	assert.equal(result.ok, true, result.steps.join("\n"))
	const written = JSON.parse(readFileSync(configPath(env), "utf8")) as { device?: { name?: string } }
	assert.equal(written.device?.name, "my-laptop", "the identity survives force")
})
