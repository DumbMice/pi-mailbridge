#!/usr/bin/env node
// Wait for the just-sent request to arrive, then point the starter's cursor immediately before it.
//
// Ordering matters for a fast test: the starter should be measured doing its own work, not waiting on QQ's
// delivery latency. This connects, polls for the subject, and writes the cursor with `lastUid = uid - 1` so
// the very next scan reads exactly that one mail.
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()
const req = createRequire(`${globalRoot}/@dumbmice/pi-mailbridge/package.json`)
const { ImapFlow } = req("imapflow")
const subject = process.argv[2]

const client = new ImapFlow({
	host: "imap.qq.com",
	port: 993,
	secure: true,
	auth: { user: process.env.QQ_EMAIL, pass: process.env.QQ_AUTH },
	logger: false,
})
await client.connect()
await client.mailboxOpen("INBOX")
// QQ's SEARCH SUBJECT is unreliable (it returned nothing for a message that is demonstrably in INBOX), so
// search by date and match the exact envelope subject instead.
let found
for (let i = 0; i < 40 && !found; i += 1) {
	const uids = await client.search({ since: new Date(Date.now() - 10 * 60_000) }, { uid: true })
	for (const uid of [...uids].reverse()) {
		const msg = await client.fetchOne(uid, { envelope: true }, { uid: true })
		if (msg?.envelope?.subject === subject) {
			found = uid
			break
		}
	}
	if (!found) await new Promise((r) => setTimeout(r, 500))
}
if (!found) {
	console.error(`await-prime: ${subject} never arrived`)
	await client.logout()
	process.exit(1)
}
const file = join(process.env.XDG_STATE_HOME, "pi-mailbridge", "starter-cursor.json")
mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
const tmp = `${file}.${process.pid}.tmp`
writeFileSync(
	tmp,
	JSON.stringify({ v: 1, lastUid: found - 1, uidValidity: Number(client.mailbox.uidValidity), primed: true }),
	{ mode: 0o600 },
)
renameSync(tmp, file)
await client.logout()
console.log(`arrived at uid ${found}; cursor placed at ${found - 1}`)
