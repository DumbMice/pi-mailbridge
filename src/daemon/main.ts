// pi-mailbridge daemon — one instance per machine.
//
// Single-instance lock is the port itself: EADDRINUSE means a daemon already
// owns the mailbox, so this process exits quietly. Two daemons would mean two
// IMAP IDLE connections and two claim sets — the exact race the design avoids.
//
// Scaffold status: lock, auth gate, routing table and lifecycle are real; the
// handlers below return 501 until the watcher/process/store modules land. Run:
//   node --experimental-strip-types src/daemon/main.ts --print-token

import http from "node:http"
import { timingSafeEqual } from "node:crypto"

import { loadConfig, hasUsableMailConfig } from "../core/config.ts"
import { ensureSecret } from "../store/secret.ts"

const MAX_BODY_BYTES = 1_000_000
const MAX_SSE_CLIENTS = 100

function constantTimeEquals(a: string, b: string): boolean {
	const ab = Buffer.from(a)
	const bb = Buffer.from(b)
	return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks: Buffer[] = []
		req.on("data", (c: Buffer) => {
			size += c.length
			if (size > MAX_BODY_BYTES) {
				reject(new Error("request body too large"))
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})
}

export function createDaemon(token: string, config = loadConfig()) {
	let sseClients = 0

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const json = (status: number, body: unknown) => {
			const payload = JSON.stringify(body)
			res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
			res.end(payload)
		}

		if (url.pathname === "/health") return json(200, { ok: true, mode: "scaffold" })

		// Every non-health route is authenticated. Loopback is not authorization.
		const auth = req.headers.authorization ?? ""
		const presented = auth.startsWith("Bearer ") ? auth.slice(7) : ""
		if (!constantTimeEquals(presented, token)) {
			// No detail, no timing signal.
			return json(401, { error: { code: "unauthorized" } })
		}

		try {
			switch (`${req.method} ${url.pathname}`) {
				case "GET /events":
					if (sseClients >= MAX_SSE_CLIENTS) return json(503, { error: { code: "too_many_clients" } })
					res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
					sseClients++
					req.on("close", () => { sseClients-- })
					res.write(": connected\n\n")
					// TODO: subscribe to delivery/mode events.
					return
				case "GET /pending":
					// TODO: return durable pending deliveries for catch-up.
					return json(200, { pending: [] })
				case "POST /claim":
				case "POST /ack":
				case "POST /register":
				case "DELETE /register":
				case "POST /send":
					await readBody(req)
					return json(501, { error: { code: "not_implemented", path: url.pathname } })
				case "GET /mode":
					return json(200, { mode: "off" })
				case "POST /mode":
					await readBody(req)
					return json(501, { error: { code: "not_implemented", path: url.pathname } })
				default:
					return json(404, { error: { code: "not_found" } })
			}
		} catch (error) {
			return json(400, { error: { code: "bad_request", message: (error as Error).message } })
		}
	})

	return server
}

function main(): void {
	const config = loadConfig()
	const argv = process.argv.slice(2)

	if (argv.includes("--print-token")) {
		// Convenience for scripts and tests; the token never goes to logs.
		process.stdout.write(`${ensureSecret().toString("base64url")}\n`)
		return
	}

	if (!hasUsableMailConfig(config)) {
		console.error("pi-mailbridge: mail config incomplete — see config.example.json")
		for (const w of config.warnings) console.error(`  ! ${w}`)
		process.exitCode = 2
		return
	}
	for (const w of config.warnings) console.error(`pi-mailbridge: warning: ${w}`)

	const token = ensureSecret().toString("base64url")
	const server = createDaemon(token, config)

	server.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EADDRINUSE") {
			// Expected when a daemon already owns the mailbox: not an error.
			process.exit(0)
		}
		console.error(`pi-mailbridge: daemon failed: ${error.message}`)
		process.exit(1)
	})

	server.listen(config.daemon.port, config.daemon.host, () => {
		console.error(`pi-mailbridge: daemon listening on http://${config.daemon.host}:${config.daemon.port}`)
		// TODO: startWatcher(), catch-up scan, pending recovery.
	})

	const shutdown = () => server.close(() => process.exit(0))
	process.on("SIGTERM", shutdown)
	process.on("SIGINT", shutdown)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
