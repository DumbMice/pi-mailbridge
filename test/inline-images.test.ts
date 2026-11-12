import { test } from "node:test"
import { execFileSync } from "node:child_process"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { inlineLocalImages, sniffImage, MAX_INLINE_BYTES, MAX_INLINE_COUNT, MAX_FILE_BYTES, MAX_INLINE_TOTAL_BYTES } from "../src/core/inline-images.ts"
import { renderMessage } from "../src/core/html.ts"

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const GIF = Buffer.from("GIF89a----", "latin1")

function dir(): string {
	return mkdtempSync(join(tmpdir(), "pmb-img-"))
}

test("sniffImage trusts magic bytes, not extensions", () => {
	assert.equal(sniffImage(PNG)?.contentType, "image/png")
	assert.equal(sniffImage(JPG)?.contentType, "image/jpeg")
	assert.equal(sniffImage(GIF)?.contentType, "image/gif")
	assert.equal(sniffImage(Buffer.from("this is not an image")), undefined)
	assert.equal(sniffImage(Buffer.alloc(0)), undefined)
})

test("a small local image becomes a cid attachment", () => {
	const root = dir()
	writeFileSync(join(root, "shot.png"), PNG)

	const result = inlineLocalImages('<p><img src="./shot.png" alt="shot"></p>', { root })
	assert.equal(result.attachments.length, 1)
	assert.equal(result.attachments[0]!.contentType, "image/png")
	assert.match(result.attachments[0]!.cid!, /^pi-[0-9a-f]{16}@pi\.local$/)
	assert.match(result.html, /<img src="cid:pi-[0-9a-f]{16}@pi\.local"/)
	assert.doesNotMatch(result.html, /src="\.\/shot\.png"/)
	assert.match(result.html, /max-width:100%/)
})

test("remote and already-inlined sources are left alone", () => {
	const html = '<img src="https://x.test/a.png"><img src="cid:pi-x@pi.local">'
	const result = inlineLocalImages(html, { root: dir() })
	assert.equal(result.attachments.length, 0)
	assert.equal(result.html, html)
})

test("a non-image file is never attached, even with an image name", () => {
	const root = dir()
	writeFileSync(join(root, "secret.png"), "ssh-rsa AAAAB3NzaC1yc2E...")

	const result = inlineLocalImages('<img src="secret.png" alt="s">', { root })
	assert.equal(result.attachments.length, 0, "content sniffing must reject a renamed text file")
	assert.deepEqual(result.skipped.map((s) => s.reason), ["not-an-image"])
	assert.match(result.html, /\[s: not attached, not an image\]/)
})

test("a missing file degrades to a note instead of a broken image", () => {
	const result = inlineLocalImages('<img src="./nope.png" alt="nope">', { root: dir() })
	assert.equal(result.attachments.length, 0)
	assert.deepEqual(result.skipped.map((s) => s.reason), ["not-found"])
	assert.doesNotMatch(result.html, /<img/)
	assert.match(result.html, /not attached, file not found/)
})

test("an oversized image is refused with the size in the note", () => {
	const root = dir()
	const big = Buffer.concat([PNG, Buffer.alloc(MAX_INLINE_BYTES + 10)])
	writeFileSync(join(root, "big.png"), big)

	const result = inlineLocalImages('<img src="big.png" alt="big">', { root })
	assert.equal(result.attachments.length, 0)
	assert.deepEqual(result.skipped.map((s) => s.reason), ["too-large"])
	// The note names the actual limit, so raising MAX_INLINE_BYTES cannot leave it lying.
	assert.match(result.html, new RegExp(`over the ${Math.round(MAX_INLINE_BYTES / 1024)} KB limit`))
})

test("the same image twice is attached once", () => {
	const root = dir()
	writeFileSync(join(root, "a.png"), PNG)
	const result = inlineLocalImages('<img src="a.png"><img src="./a.png">', { root })
	assert.equal(result.attachments.length, 1, "cids are content-addressed")
	assert.equal((result.html.match(/cid:/g) ?? []).length, 2)
})

test("the count cap is enforced", () => {
	const root = dir()
	// Distinct content so each has its own cid.
	const over = MAX_INLINE_COUNT + 2
	for (let i = 0; i < over; i++) writeFileSync(join(root, `i${i}.png`), Buffer.concat([PNG, Buffer.from([i])]))

	const result = inlineLocalImages(
		Array.from({ length: over }, (_, i) => `<img src="i${i}.png" alt="i${i}">`).join(""),
		{ root },
	)
	assert.equal(result.attachments.length, MAX_INLINE_COUNT)
	assert.equal(result.skipped.filter((s) => s.reason === "too-many").length, 2)
})

test("renderMessage wires images through the Markdown body", () => {
	const root = dir()
	writeFileSync(join(root, "chart.png"), PNG)

	const rendered = renderMessage("## Result\n\n![chart](chart.png)\n\n--\ndevice: x", { root })
	assert.equal(rendered.attachments.length, 1)
	assert.match(rendered.html, /<img src="cid:/)
	assert.match(rendered.html, /<h2>Result<\/h2>/)
	assert.match(rendered.html, /border-top:1px solid #d8dee4/, "the signature block reads as a divider")
})

test("a linked local file is attached with its real name", () => {
	const root = dir()
	const bytes = Buffer.from("%PDF-1.4 quarterly report\n")
	writeFileSync(join(root, "report.pdf"), bytes)

	const result = inlineLocalImages('<p><a href="./report.pdf">the quarterly report</a></p>', { root })
	assert.equal(result.attachments.length, 1)
	const file = result.attachments[0]!
	// The real filename, not the link text: that is what the reader sees in their mail client.
	assert.equal(file.filename, "report.pdf")
	assert.equal(file.contentType, "application/pdf")
	assert.equal(file.contentDisposition, "attachment")
	assert.equal(file.cid, undefined, "an attachment is not an inline part")
	// The anchor cannot work in a mail client, so the text stays and the file is named.
	assert.match(result.html, /the quarterly report/)
	assert.match(result.html, /\[attached: report\.pdf\]/)
	assert.doesNotMatch(result.html, /href="\.\/report\.pdf"/)
})

test("a linked file outside the allowlist is not attached", () => {
	// The path comes from model output, and the one thing that must never happen is mailing a
	// private key because a prompt asked for it.
	const root = dir()
	writeFileSync(join(root, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n")
	writeFileSync(join(root, ".env"), "SECRET=1\n")

	for (const name of ["id_rsa", ".env"]) {
		const result = inlineLocalImages(`<p><a href="./${name}">config</a></p>`, { root })
		assert.equal(result.attachments.length, 0, `${name} must not be attached`)
		assert.deepEqual(result.skipped.map((s) => s.reason), ["not-allowed"])
	}
})

test("an attached file is capped before it is read", () => {
	// The refusal message is identical whether the cap runs before or after the read, so the
	// assertion has to be on the read itself: a 15 GB log must not be loaded into memory on the
	// daemon's only thread just to be refused.
	const root = dir()
	writeFileSync(join(root, "huge.pdf"), Buffer.alloc(MAX_FILE_BYTES + 1))
	let reads = 0
	const result = inlineLocalImages('<a href="huge.pdf">report</a>', {
		root,
		readFile: () => {
			reads += 1
			return Buffer.alloc(MAX_FILE_BYTES + 1)
		},
	})
	assert.equal(result.attachments.length, 0)
	assert.match(result.html, /over the limit/)
	assert.equal(reads, 0, "the per-file cap is enforced before reading")
})

test("one file linked twice rides once; remote links are untouched", () => {
	const root = dir()
	writeFileSync(join(root, "a.txt"), "same content")
	const result = inlineLocalImages(
		'<a href="a.txt">one</a><a href="./a.txt">two</a><a href="https://x.test/a.txt">remote</a>',
		{ root },
	)
	assert.equal(result.attachments.length, 1)
	assert.match(result.html, /href="https:\/\/x\.test\/a\.txt"/, "a remote link stays a link")
})

test("the total budget can be raised, and the default is under every provider ceiling", () => {
	// Base64 inflates ~4/3, so the raw default has to leave room: 18 MB -> ~24 MB on the wire,
	// under Gmail's and Outlook.com's 25 MB. A QQ account (50 MB) can raise it.
	assert.ok(MAX_INLINE_TOTAL_BYTES * (4 / 3) <= 25 * 1024 * 1024, "default stays under 25 MB encoded")

	const root = dir()
	writeFileSync(join(root, "a.bin"), Buffer.alloc(6 * 1024 * 1024, 1))
	// 6 MB of content is over a small custom budget and under the default.
	writeFileSync(join(root, "a.log"), Buffer.alloc(6 * 1024 * 1024, 1))
	const small = inlineLocalImages('<a href="a.log">log</a>', { root, maxTotalBytes: 2 * 1024 * 1024 })
	assert.equal(small.attachments.length, 0, "a 6 MB file does not fit a 2 MB budget")

	const big = inlineLocalImages('<a href="a.log">log</a>', { root })
	assert.equal(big.attachments.length, 1, "and does fit the default")
	assert.match(big.html, /\[attached: a\.log\]/)
})

test("a symlink out of the project is not attached", () => {
	// The allowlist says nothing about where a file came from. `ln -s ~/.config/pi-mailbridge/
	// config.json report.log` would otherwise mail the mailbox password in a notification.
	const root = dir()
	const outside = join(dir(), "config.json")
	writeFileSync(outside, '{"mail":{"imap":{"password":"hunter2"}}}')
	writeFileSync(join(root, "inside.log"), "fine")
	symlinkSync(outside, join(root, "report.log"))
	symlinkSync(outside, join(root, "shot.png"))

	const linked = inlineLocalImages('<a href="report.log">report</a>', { root })
	assert.equal(linked.attachments.length, 0, "the symlinked file must not be attached")
	assert.deepEqual(linked.skipped.map((s) => s.reason), ["outside-root"])
	assert.match(linked.html, /outside the project/)

	const image = inlineLocalImages('<img src="shot.png" alt="shot">', { root })
	assert.equal(image.attachments.length, 0, "and not as an inline image either")
	assert.deepEqual(image.skipped.map((s) => s.reason), ["outside-root"])

	// A real file in the project is unaffected.
	const ok = inlineLocalImages('<a href="inside.log">log</a>', { root })
	assert.equal(ok.attachments.length, 1)
})

test("a directory that looks like a file is refused fast, on both paths", () => {
	// A FIFO proves the real case but *hangs* if the check is removed, which makes the mutation
	// look like a pass. A directory has the same "not a regular file" verdict and fails fast, so
	// the check is pinned in a way a mutation test can see.
	const root = dir()
	mkdirSync(join(root, "shot.png"))
	mkdirSync(join(root, "notes.log"))

	const image = inlineLocalImages('<img src="shot.png" alt="shot">', { root })
	assert.equal(image.attachments.length, 0)
	assert.deepEqual(image.skipped.map((s) => s.reason), ["unreadable"], "image path")

	const link = inlineLocalImages('<a href="notes.log">log</a>', { root })
	assert.equal(link.attachments.length, 0)
	assert.deepEqual(link.skipped.map((s) => s.reason), ["unreadable"], "link path")
})

test("the project-directory guard fails closed", () => {
	// Three ways it used to fail open, all of them the same mistake: trusting a root it could not
	// verify, or treating an unguarded root as a project.
	const root = dir()
	writeFileSync(join(root, "notes.md"), "hello")

	// 1. Unresolvable root (deleted worktree, stale cwd): nothing is attachable.
	const stale = inlineLocalImages('<a href="/etc/hostname">h</a>', { root: "/nonexistent/worktree" })
	assert.equal(stale.attachments.length, 0)
	// Distinct from "outside the project": the *root* could not be trusted, which is a different
	// thing for the reader to act on.
	assert.deepEqual(stale.skipped.map((s) => s.reason), ["root-refused"])

	// 2. Project root = your home directory: `~/.config/pi-mailbridge/config.json` is then
	//    "inside the project", is `.json`, and mailing it mails the mailbox password. Nothing is
	//    attached from a home-rooted launch (see SECURITY §6b: start pi in a project).
	const home = dir()
	writeFileSync(join(home, "notes.md"), "fine")
	const realHome = process.env.HOME
	process.env.HOME = home
	try {
		const fromHome = inlineLocalImages('<a href="notes.md">n</a>', { root: home })
		assert.equal(fromHome.attachments.length, 0, "cwd = $HOME attaches nothing")
		assert.deepEqual(fromHome.skipped.map((s) => s.reason), ["root-refused"], "and says why")
		assert.match(fromHome.html, /start pi in a project directory/)

		// A root of "/" is the same mistake at a larger scale. Use a file that *would* pass the
		// allowlist, or the refusal would come from the extension check instead.
		const outside = join(home, "elsewhere.log")
		writeFileSync(outside, "x")
		const fromRoot = inlineLocalImages(`<a href="${outside}">h</a>`, { root: "/" })
		assert.equal(fromRoot.attachments.length, 0)
		assert.deepEqual(fromRoot.skipped.map((s) => s.reason), ["root-refused"])
	} finally {
		if (realHome === undefined) delete process.env.HOME
		else process.env.HOME = realHome
	}

	// A normal project directory still works.
	assert.equal(inlineLocalImages('<a href="notes.md">n</a>', { root }).attachments.length, 1)

	// 3. The daemon's own directories are refused even when they sit inside a normal project
	//    root. This is the case the first version of the test could not see: it used root = home,
	//    which the earlier rule already refused, so deleting the state-dir check stayed green.
	const project = dir()
	const stateDir = join(project, ".local", "state", "pi-mailbridge")
	mkdirSync(stateDir, { recursive: true })
	writeFileSync(join(stateDir, "uid-cursor.json"), "{}")
	assert.equal(inlineLocalImages('<a href=".local/state/pi-mailbridge/uid-cursor.json">c</a>', { root: project }).attachments.length, 1,
		"sanity: without the override it is just a json file in the project")
	// Both halves of the denial, and the environment is restored rather than deleted, so an
	// ambient value is not destroyed for anything running after this file.
	const configDirUnderRoot = join(project, ".config", "pi-mailbridge")
	mkdirSync(configDirUnderRoot, { recursive: true })
	writeFileSync(join(configDirUnderRoot, "config.json"), '{"mail":{"imap":{"password":"hunter2"}}}')
	const before = { state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME }
	process.env.XDG_STATE_HOME = join(project, ".local", "state")
	process.env.XDG_CONFIG_HOME = join(project, ".config")
	try {
		const secret = inlineLocalImages('<a href=".local/state/pi-mailbridge/uid-cursor.json">c</a>', { root: project })
		assert.equal(secret.attachments.length, 0, "state dir is never attached")
		assert.deepEqual(secret.skipped.map((s) => s.reason), ["root-refused"])

		const configFile = inlineLocalImages('<a href=".config/pi-mailbridge/config.json">c</a>', { root: project })
		assert.equal(configFile.attachments.length, 0, "and neither is the config with its password")
		assert.deepEqual(configFile.skipped.map((s) => s.reason), ["root-refused"])
	} finally {
		if (before.state === undefined) delete process.env.XDG_STATE_HOME
		else process.env.XDG_STATE_HOME = before.state
		if (before.config === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = before.config
	}
})

test("a duplicated file is not charged twice against the budget", () => {
	// Two links to the same 10 MB report, with an 18 MB budget: the second adds zero bytes and
	// must not be refused as over the limit.
	const root = dir()
	writeFileSync(join(root, "report.pdf"), Buffer.alloc(10 * 1024 * 1024, 7))
	const result = inlineLocalImages(
		'<a href="report.pdf">one</a><a href="./report.pdf">two</a>',
		{ root, maxTotalBytes: 18 * 1024 * 1024 },
	)
	assert.equal(result.attachments.length, 1)
	assert.deepEqual(result.skipped, [], "the duplicate is deduped, not refused")
	assert.match(result.html, /\[attached: report\.pdf\][\s\S]*\[attached: report\.pdf\]/)
})

test("a FIFO is refused instead of blocking the send, on both paths", { skip: process.platform === "win32" }, () => {
	// A FIFO reports size 0, passes the caps, and blocks readFileSync forever - on the daemon's
	// only thread. Run each probe in a child with a timeout: if the type check is removed the
	// child hangs and this fails fast, instead of hanging the whole suite (which would hide the
	// regression from a mutation test).
	const root = dir()
	execFileSync("mkfifo", [join(root, "pipe.log"), join(root, "shot.png")])
	const probe = `
		import { inlineLocalImages } from ${JSON.stringify(new URL("../src/core/inline-images.ts", import.meta.url).pathname)}
		const r = inlineLocalImages('<a href="pipe.log">p</a><img src="shot.png" alt="s">', { root: process.argv[1] })
		console.log(JSON.stringify({ n: r.attachments.length, reasons: r.skipped.map((s) => s.reason) }))
	`
	// `--input-type=module` matters on the declared floor (Node 22.6): eval input with a static
	// import is not module-detected automatically there.
	const out = execFileSync(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", probe, root],
		{
			timeout: 5_000,
			encoding: "utf8",
		},
	)
	const result = JSON.parse(out.trim()) as { n: number; reasons: string[] }
	assert.equal(result.n, 0)
	assert.deepEqual(result.reasons, ["unreadable", "unreadable"], "both paths refuse it")
})
