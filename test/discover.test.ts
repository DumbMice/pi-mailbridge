import { test } from "node:test"
import assert from "node:assert/strict"

import {
	buildSetupConfig,
	discoverDomain,
	domainOf,
	parseAutoconfig,
	OAUTH_ISSUER,
	OAUTH_SCOPE,
} from "../src/core/discover.ts"

const MICROSOFT_XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="hotmail.com">
    <domain>outlook.com</domain>
    <incomingServer type="imap">
      <hostname>outlook.office365.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>OAuth2</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <incomingServer type="pop3">
      <hostname>outlook.office365.com</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <authentication>OAuth2</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp-mail.outlook.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>OAuth2</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>`

const PLAIN_XML = `<clientConfig version="1.1">
  <emailProvider id="example">
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname><port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname><port>465</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>`

test("parses a Microsoft document and prefers IMAP over POP3", () => {
	const d = parseAutoconfig(MICROSOFT_XML)
	assert.ok(d)
	assert.deepEqual(d.imap, { host: "outlook.office365.com", port: 993, secure: true })
	assert.deepEqual(d.smtp, { host: "smtp-mail.outlook.com", port: 587, secure: false }, "STARTTLS means not implicit TLS")
	assert.equal(d.authType, "XOAUTH2")
	assert.equal(d.provider, "microsoft")
})

test("a password-cleartext provider becomes LOGIN", () => {
	const d = parseAutoconfig(PLAIN_XML)
	assert.ok(d)
	assert.equal(d.authType, "LOGIN")
	assert.equal(d.provider, "other")
	assert.equal(d.imap.secure, true)
})

test("OAuth2 wins when a provider advertises both", () => {
	const both = PLAIN_XML.replace(
		"<authentication>password-cleartext</authentication>",
		"<authentication>password-cleartext</authentication><authentication>OAuth2</authentication>",
	)
	assert.equal(parseAutoconfig(both)?.authType, "XOAUTH2")
})

test("incomplete documents are rejected rather than half-used", () => {
	assert.equal(parseAutoconfig("<clientConfig></clientConfig>"), undefined)
	assert.equal(parseAutoconfig(MICROSOFT_XML.replace(/<outgoingServer[\s\S]*?<\/outgoingServer>/, "")), undefined)
	assert.equal(parseAutoconfig(MICROSOFT_XML.replace("<port>993</port>", "<port>not-a-port</port>")), undefined)
})

test("discoverDomain uses the injected fetch and reports unknown domains", async () => {
	const seen: string[] = []
	const fetchImpl = (async (url: string) => {
		seen.push(url)
		if (url.endsWith("/outlook.com")) return new Response(MICROSOFT_XML, { status: 200 })
		return new Response("nope", { status: 404 })
	}) as unknown as typeof fetch

	const found = await discoverDomain("outlook.com", { fetchImpl })
	assert.equal(found?.imap.host, "outlook.office365.com")
	assert.match(seen[0]!, /autoconfig\.thunderbird\.net\/v1\.1\/outlook\.com$/)

	assert.equal(await discoverDomain("nowhere.example", { fetchImpl }), undefined)
})

test("discoverDomain survives a network explosion", async () => {
	const fetchImpl = (async () => {
		throw new Error("ENOTFOUND")
	}) as unknown as typeof fetch
	// A supported provider still resolves from the built-in table...
	assert.equal((await discoverDomain("outlook.com", { fetchImpl }))?.provider, "microsoft")
	// ...while an unknown one is correctly reported as unknown, not guessed.
	assert.equal(await discoverDomain("nowhere.example", { fetchImpl }), undefined)
})

test("domainOf extracts the domain and rejects nonsense", () => {
	assert.equal(domainOf("pi@outlook.com"), "outlook.com")
	assert.equal(domainOf("Pi@Outlook.COM"), "outlook.com")
	assert.equal(domainOf("no-at-sign"), undefined)
	assert.equal(domainOf("trailing@"), undefined)
	assert.equal(domainOf("@leading.com"), undefined)
})

test("layout A keeps the loop guard strict", () => {
	const d = parseAutoconfig(MICROSOFT_XML)!
	const config = buildSetupConfig("pi@outlook.com", "me@outlook.com", d)
	assert.equal(config.mail.imap.user, "pi@outlook.com")
	assert.equal(config.mail.to, "me@outlook.com")
	assert.equal(config.security.allowSelfReplies, false, "different addresses: no need to relax anything")
	assert.deepEqual(config.security.allowFrom, ["me@outlook.com"])
})

test("layout B enables single-mailbox mode automatically", () => {
	const d = parseAutoconfig(MICROSOFT_XML)!
	const config = buildSetupConfig("me@outlook.com", "me@outlook.com", d)
	assert.equal(config.security.allowSelfReplies, true, "same address would otherwise reject every reply")
})

test("an OAuth provider gets a preset the user only has to complete", () => {
	const d = parseAutoconfig(MICROSOFT_XML)!
	const config = buildSetupConfig("pi@outlook.com", "me@outlook.com", d)
	assert.equal(config.oauth?.issuer, OAUTH_ISSUER.microsoft)
	assert.equal(config.oauth?.scope, OAUTH_SCOPE.microsoft)
	assert.match(String(config.oauth?.scope), /offline_access/)
	assert.match(String(config.oauth?.clientId), /client id/, "must be an obvious placeholder")
})

test("a password provider gets no oauth block at all", () => {
	const d = parseAutoconfig(PLAIN_XML)!
	const config = buildSetupConfig("pi@example.com", "me@example.com", d)
	assert.equal(config.oauth, undefined)
	assert.equal(config.mail.imap.authType, "LOGIN")
})

// --- robustness: bad input and a missing/blocked ISPDB ---------------------

test("a trailing dot in the domain is stripped", () => {
	assert.equal(domainOf("pi@hotmail.com."), "hotmail.com")
	assert.equal(domainOf("pi@hotmail.com.."), "hotmail.com")
})

test("ISPDB 404 falls back to the built-in provider table", async () => {
	const fetchImpl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
	const found = await discoverDomain("hotmail.com", { fetchImpl })
	assert.ok(found, "hotmail.com is a supported provider even if ISPDB has no entry")
	assert.equal(found.provider, "microsoft")
	assert.deepEqual(found.imap, { host: "outlook.office365.com", port: 993, secure: true })
	assert.deepEqual(found.smtp, { host: "smtp-mail.outlook.com", port: 587, secure: false })
	assert.equal(found.authType, "XOAUTH2")
})

test("an offline machine still resolves the common providers", async () => {
	const fetchImpl = (async () => {
		throw new Error("ENOTFOUND")
	}) as unknown as typeof fetch
	assert.equal((await discoverDomain("gmail.com", { fetchImpl }))?.provider, "google")
	assert.equal((await discoverDomain("outlook.com", { fetchImpl }))?.provider, "microsoft")
	// Not a known provider and offline: correctly unknown.
	assert.equal(await discoverDomain("mail.example.org", { fetchImpl }), undefined)
})

test("ISPDB still wins when it has an entry", async () => {
	const fetchImpl = (async () =>
		new Response(
			`<clientConfig><emailProvider>
			   <incomingServer type="imap"><hostname>custom.host</hostname><port>143</port>
			     <socketType>STARTTLS</socketType><authentication>OAuth2</authentication></incomingServer>
			   <outgoingServer type="smtp"><hostname>custom.smtp</hostname><port>25</port>
			     <socketType>STARTTLS</socketType><authentication>OAuth2</authentication></outgoingServer>
			 </emailProvider></clientConfig>`,
			{ status: 200 },
		)) as unknown as typeof fetch
	const found = await discoverDomain("hotmail.com", { fetchImpl })
	assert.equal(found?.imap.host, "custom.host", "the published document is authoritative, not the table")
	assert.equal(found?.imap.secure, false)
})
