#!/usr/bin/env node
// Send one starter request through real SMTP, the way a mail client would.
//
// Deliberately NOT the package's own mailer: that stamps `X-Pi-Mailbridge`, which the starter (correctly)
// treats as its own mail. This has to look like a human's message.
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()
// Resolve from the package that depends on it: npm may hoist or nest, and the bin script lives outside both.
const requireFromPackage = createRequire(`${globalRoot}/@dumbmice/pi-mailbridge/package.json`)
const nodemailer = requireFromPackage("nodemailer")

const {
	QQ_EMAIL,
	QQ_AUTH,
	SMTP_HOST = "smtp.qq.com",
	SMTP_PORT = "465",
	SUBJECT,
	BODY,
} = process.env

if (!QQ_EMAIL || !QQ_AUTH) {
	console.error("live-send: QQ_EMAIL and QQ_AUTH are required")
	process.exit(2)
}

const transport = nodemailer.createTransport({
	host: SMTP_HOST,
	port: Number(SMTP_PORT),
	secure: Number(SMTP_PORT) === 465,
	auth: { user: QQ_EMAIL, pass: QQ_AUTH },
	// QQ wants LOGIN; nodemailer otherwise tries PLAIN first and reports a confusing 535.
	authMethod: "LOGIN",
})

const info = await transport.sendMail({
	from: QQ_EMAIL,
	to: QQ_EMAIL,
	subject: SUBJECT,
	text: BODY,
})
console.log(`sent ${info.messageId}`)
