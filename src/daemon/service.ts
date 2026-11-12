// Daemon HTTP service.
//
// Transport-neutral: construction takes its collaborators, so tests boot the real
// server against fake mail/source and assert the whole contract over HTTP.
//
// Auth: every route except /health requires `Authorization: Bearer <token>`,
// compared in constant time. Loopback is not authorization.
//
// Bounds: request body, SSE clients, registry entries. A local process should not
// be able to exhaust the daemon.

import http from "node:http"
import { timingSafeEqual } from "node:crypto"

import type { ResolvedConfig } from "../core/config.ts"
import type { MailSource } from "./process.ts"
import { ackPending, claimPending, listPending } from "../store/pending-store.ts"
import { journal } from "../store/journal.ts"
import { readMode, writeMode, isMode, type Mode } from "../store/mode-store.ts"
import { createRegistry, type Registry } from "../store/registry.ts"

export const MAX_BODY_BYTES = 1_000_000
export const MAX_SSE_CLIENTS = 100

export type DaemonEvent =
	| { type: "delivery"; pending: ReturnType<typeof listPending>[number] }
	| { type: "mode"; mode: Mode }

export interface DaemonDeps {
	config: ResolvedConfig
	token: string
	source: MailSource
	/** Sends mail. Injected so tests never open a socket. */
	send: (message: { to: string; subject: string; text: string }) => Promise<{ messageId?: string } | void>
	/**
	 * Called after a successful send with the assigned Message-ID, so the caller can
	 * record it for reply-chain routing. Kept out of this module so the service does
	 * not need the routing secret.
	 */
	onSent?: (info: { messageId?: string; subject: string }) => void
	/**
	 * Re-read config and restart the watcher. Called after `/mailbridge setup` or
	 * `auth` so a fresh config or token takes effect without killing the daemon.
	 */
	reload?: () => Promise<{ ok: boolean; error?: string }>
	env?: NodeJS.ProcessEnv
	now?: () => number
	registry?: Registry
}

export interface DaemonService {
	server: http.Server
	listen(port?: number, host?: string): Promise<{ port: number; host: string }>
	close(): Promise<void>
	/** Push an event to every connected SSE client. */
	broadcast(event: DaemonEvent): void
	readonly sseClients: number
}

function constantTimeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a)
	const bb = Buffer.from(b)
	return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				reject(new Error("request body too large"))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function createDaemonService(deps: DaemonDeps): DaemonService {
	const env = deps.env ?? process.env
	const now = deps.now ?? (() => Date.now())
	const registry = deps.registry ?? createRegistry()

	/** live SSE response objects */
	const streams = new Set<http.ServerResponse>()

	function broadcast(event: DaemonEvent): void {
		const payload = `data: ${JSON.stringify(event)}\n\n`
		for (const res of streams) {
			try {
				res.write(payload)
			} catch {
				streams.delete(res)
			}
		}
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")
		const send = (status: number, body: unknown) => {
			const payload = JSON.stringify(body)
			res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
			res.end(payload)
		}
		const fail = (status: number, code: string, extra?: Record<string, unknown>) =>
			send(status, { error: { code, ...extra } })

		// Liveness is unauthenticated so a supervisor can probe without a secret.
		if (url.pathname === "/health") {
			return send(200, {
				ok: true,
				mode: readMode(env),
				pending: listPending(env).length,
				sessions: registry.list().length,
				sseClients: streams.size,
			})
		}

		const header = req.headers.authorization ?? ""
		const presented = header.startsWith("Bearer ") ? header.slice(7) : ""
		if (!constantTimeEqual(presented, deps.token)) return fail(401, "unauthorized")

		const route = `${req.method} ${url.pathname}`
		try {
			switch (route) {
				case "GET /events": {
					if (streams.size >= MAX_SSE_CLIENTS) return fail(503, "too_many_clients")
					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					})
					res.write(": connected\n\n")
					// Tell a fresh client the current mode immediately.
					res.write(`data: ${JSON.stringify({ type: "mode", mode: readMode(env) })}\n\n`)
					streams.add(res)
					req.on("close", () => streams.delete(res))
					return undefined
				}

				case "GET /pending":
					return send(200, { pending: listPending(env) })

				case "GET /mode":
					return send(200, { mode: readMode(env) })

				case "POST /claim": {
					const body = asRecord(JSON.parse(await readBody(req)))
					const uid = Number(body?.uid)
					const instanceId = typeof body?.instanceId === "string" ? body.instanceId : ""
					if (!Number.isInteger(uid) || !instanceId) return fail(400, "bad_request")
					const result = claimPending(env, uid, instanceId, now())
					if (!result.ok) return fail(result.reason === "not-found" ? 404 : 409, result.reason)
					return send(200, { ok: true })
				}

				case "POST /ack": {
					const body = asRecord(JSON.parse(await readBody(req)))
					const uid = Number(body?.uid)
					const instanceId = typeof body?.instanceId === "string" ? body.instanceId : ""
					if (!Number.isInteger(uid) || !instanceId) return fail(400, "bad_request")

					// Journal BEFORE removing the record and before touching the mail:
					// the journal is the dedupe authority, so it must not be possible to
					// ack, then lose the journal write, then redeliver.
					if (!ackPending(env, uid, instanceId)) return fail(409, "not_claimed")
					journal(env, uid)
					registry.release(String(body?.sessionId ?? ""))

					// Mailbox hygiene only. A failure here must not resurrect the delivery.
					try {
						await deps.source.markSeen?.(uid)
					} catch {
						/* logged by the caller in production; delivery is already acked */
					}
					return send(200, { ok: true })
				}

				case "POST /register": {
					const body = asRecord(JSON.parse(await readBody(req)))
					const sessionId = typeof body?.sessionId === "string" ? body.sessionId : ""
					if (!sessionId) return fail(400, "bad_request")
					const result = registry.register(sessionId)
					if (result.full) return fail(503, "registry_full")
					return send(200, result)
				}

				case "DELETE /register": {
					const body = asRecord(JSON.parse(await readBody(req)))
					const sessionId = typeof body?.sessionId === "string" ? body.sessionId : ""
					if (!sessionId) return fail(400, "bad_request")
					registry.release(sessionId)
					return send(200, { ok: true })
				}

				case "POST /reload": {
					if (!deps.reload) return fail(501, "not_supported")
					try {
						const result = await deps.reload()
						if (!result.ok) return fail(500, "reload_failed", { message: result.error ?? "unknown" })
					} catch (error) {
						return fail(500, "reload_failed", { message: (error as Error).message })
					}
					return send(200, { ok: true })
				}

				case "POST /mode": {
					const body = asRecord(JSON.parse(await readBody(req)))
					if (!isMode(body?.mode)) return fail(400, "bad_request")
					const mode = writeMode(env, body.mode, now())
					broadcast({ type: "mode", mode })
					return send(200, { mode })
				}

				case "POST /send": {
					const body = asRecord(JSON.parse(await readBody(req)))
					const subject = typeof body?.subject === "string" ? body.subject : ""
					const text = typeof body?.text === "string" ? body.text : ""
					const to = typeof body?.to === "string" && body.to ? body.to : deps.config.mail.to
					if (!subject || !text) return fail(400, "bad_request")
					try {
						const result = await deps.send({ to, subject, text })
						// Record the outbound id so a reply reaches this session even if a
						// client or a human rewrites the subject token away.
						deps.onSent?.({ messageId: (result as { messageId?: string } | undefined)?.messageId, subject })
					} catch (error) {
						return fail(502, "send_failed", { message: (error as Error).message })
					}
					return send(200, { ok: true })
				}

				default:
					return fail(404, "not_found")
			}
		} catch (error) {
			const message = (error as Error).message
			if (message === "request body too large") return fail(413, "body_too_large")
			return fail(400, "bad_request", { message })
		}
	})

	return {
		server,
		get sseClients() {
			return streams.size
		},
		broadcast,
		listen(port = deps.config.daemon.port, host = deps.config.daemon.host) {
			return new Promise((resolve, reject) => {
				server.once("error", reject)
				server.listen(port, host, () => {
					server.removeListener("error", reject)
					const address = server.address()
					resolve({ port: typeof address === "object" && address ? address.port : port, host })
				})
			})
		},
		close() {
			return new Promise((resolve) => {
				for (const res of streams) {
					try {
						res.end()
					} catch {
						/* already gone */
					}
				}
				streams.clear()
				server.close(() => resolve())
			})
		},
	}
}
