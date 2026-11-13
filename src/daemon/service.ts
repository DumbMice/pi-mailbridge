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
import type { ScanSummary } from "../core/status.ts"

type ScanSummaryLike = ScanSummary
import { CAPABILITIES } from "./api.ts"
import { createSendBudget } from "./send-budget.ts"
import type { MailSource } from "./process.ts"
import { ackPending, claimPending, listPending, listPendingForDevice } from "../store/pending-store.ts"
import { journal } from "../store/journal.ts"
import { recordOutbound, removeOutbound, sessionThread } from "../store/threads.ts"
import { generateMessageId } from "../core/mailer.ts"
import { readMode, writeMode, isMode, type Mode } from "../store/mode-store.ts"
import { createRegistry, type Registry } from "../store/registry.ts"

export const MAX_BODY_BYTES = 1_000_000
/** A body that is not JSON: the caller's fault, and the only 400 the handler emits. */
class BadBodyError extends Error {}

async function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
	const text = await readBody(req)
	try {
		return JSON.parse(text)
	} catch {
		throw new BadBodyError("body is not valid JSON")
	}
}

export const MAX_SSE_CLIENTS = 100
/** Heartbeat entries kept; sessions that vanished are pruned on /health anyway. */
export const MAX_PINGS = 256

export type DaemonEvent =
	| { type: "delivery"; pending: ReturnType<typeof listPending>[number] }
	| { type: "mode"; mode: Mode }

export interface DaemonDeps {
	config: ResolvedConfig
	token: string
	source: MailSource
	/** Sends mail. Injected so tests never open a socket. */
	send: (message: {
		to: string
		subject: string
		text: string
		cwd?: string
		sessionId?: string
		/** RFC 5322 threading, derived here from the outbound id registry. */
		inReplyTo?: string
		references?: string[]
		/** Minted and recorded before this is called; the transport must stamp it. */
		messageId: string
	}) => Promise<{ messageId?: string } | void>
	/**
	 * Called after a successful send with the assigned Message-ID, so the caller can
	 * record it for reply-chain routing. Kept out of this module so the service does
	 * not need the routing secret.
	 */
	onSent?: (info: { messageId?: string; subject: string; sessionId?: string }) => void
	/**
	 * Re-read config and restart the watcher. Called after `/mailbridge setup` or
	 * `auth` so a fresh config or token takes effect without killing the daemon.
	 */
	reload?: () => Promise<{ ok: boolean; error?: string; warning?: string }>
	/**
	 * Ask the daemon to exit so a supervisor can start a fresh process.
	 * `/reload` re-reads config but cannot replace running code, so an updated
	 * package would otherwise keep executing the previous version until reboot.
	 */
	shutdown?: (reason?: string) => void
	/**
	 * Called after a mode change. Turning mode on must trigger a scan: the only other
	 * triggers are an IMAP `exists` (a NEW arrival) and reconnect, so without this a reply
	 * that arrived while the channel was closed would wait for unrelated mail.
	 */
	onModeChange?: (mode: Mode) => void
	/**
	 * Live config accessor. /reload swaps the config, so anything that reads it per
	 * request (recipient, Message-ID domain, device name, listen address) must ask here
	 * rather than capture the object this service was built with.
	 */
	getConfig?: () => ResolvedConfig
	/** Outcome of the most recent scan, for diagnostics. */
	scanSummary?: () => ScanSummaryLike | undefined
	/** mtime of the config file the daemon is running on (0 when there was no file). */
	configLoadedAt?: () => number
	/** Is the IMAP watcher connected? A revoked credential shows here, not in the process. */
	imapHealthy?: () => boolean
	/** This build's version. Diagnostic only - compatibility is `apiVersion`. */
	version?: string
	/** The wire contract this daemon implements. */
	apiVersion?: number
	/** How long after the last ping to exit. Default 120s. */
	idleTimeoutMs?: number
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

	// Sliding one-minute budget for outbound mail. Ten notifications a minute is far above any
	// human-answered flow; the point is that a loop cannot spend the account's quota.
	const sendBudget = createSendBudget({ limit: 10, windowMs: 60_000 })

	// Liveness of pi sessions. A session pings on its poll tick; when every session has gone quiet
	// the daemon stops - always, and by design: an updated package cannot leave an orphan running
	// old code, and nothing reads a mailbox no session will consume. A daemon nobody ever pings
	// (started by hand, and pi never attached) stops on the same clock.
	const pings = new Map<string, number>()
	// Idleness is measured from the daemon's own start when nobody has pinged yet, so a fresh
	// daemon gets the full grace period rather than looking infinitely stale.
	const startedAt = Date.now()
	const idleTimeout = deps.idleTimeoutMs ?? 120_000

	const idleCheck = setInterval(() => {
		const newest = Math.max(startedAt, ...pings.values())
		if (Date.now() - newest <= idleTimeout) return
		deps.shutdown?.(`idle: no ping for ${Math.round(idleTimeout / 1000)}s`)
	}, Math.min(15_000, Math.max(1_000, Math.floor(idleTimeout / 4))))
	// Never hold the process open just for this timer.
	if (typeof idleCheck.unref === "function") idleCheck.unref()

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

	// The handler is a separate function so a throw anywhere in it - including the URL parse,
	// which runs before authentication - becomes a 500 rather than an unhandled rejection that
	// kills the daemon. Node accepts absolute-form request targets, so `new URL` can throw on a
	// single unauthenticated request.
	const dispatch = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> => {
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
			// Prune here as well as on /bye: a crashed session never sends one, and an
			// unbounded map plus a spread into Math.max is its own failure mode.
			const nowMs = now()
			const stale = nowMs - (deps.idleTimeoutMs ?? 120_000) * 4
			for (const [id, at] of pings) if (at < stale) pings.delete(id)
			// Track the maximum by iteration: spreading an unbounded map into Math.max throws
			// RangeError (and kills the daemon) long before the map is "large".
			let newestPing = 0
			for (const at of pings.values()) if (at > newestPing) newestPing = at
			return send(200, {
				ok: true,
				mode: readMode(env),
				pending: listPending(env).length,
				// `sessions` is the decision registry (sessions that were told about a
				// notification), not connected clients — a raw payload showed `sessions: 0`
				// next to `clients: 2`. Both keys, so neither reading is wrong.
				sessions: registry.list().length,
				registry: registry.list().length,
				sseClients: streams.size,
				// Liveness: how many sessions are pinging, and how long ago the last one did.
				clients: pings.size,
				lastPingAgoMs: newestPing ? Math.max(0, now() - newestPing) : null,
				lastScan: deps.scanSummary?.() ?? null,
				// Diagnostic (which build), and the contract (which protocol). The session
				// replaces a daemon whose apiVersion differs; the version is for the panel.
				version: deps.version,
				apiVersion: deps.apiVersion,
				capabilities: CAPABILITIES,
				configLoadedAt: deps.configLoadedAt?.() ?? null,
				imap: deps.imapHealthy ? (deps.imapHealthy() ? "connected" : "disconnected") : "unknown",
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
					// Filtered: a whole-file payload of another machine's mail is both wrong to
					// deliver and wastefully large.
					const url = new URL(req.url ?? "/", "http://127.0.0.1")
					const device = url.searchParams.get("device")
					const config = deps.getConfig?.()
					const mine = device ?? config?.device.name
					return send(200, {
						pending: mine ? listPendingForDevice(env, mine) : listPending(env),
					})

				case "GET /mode":
					return send(200, { mode: readMode(env) })

				case "POST /claim": {
					const body = asRecord(await readJson(req))
					const uid = Number(body?.uid)
					const instanceId = typeof body?.instanceId === "string" ? body.instanceId : ""
					if (!Number.isInteger(uid) || !instanceId) return fail(400, "bad_request")
					const uidValidity =
						typeof body?.uidValidity === "number" && Number.isFinite(body.uidValidity) ? body.uidValidity : undefined
					const result = claimPending(
						env,
						uid,
						instanceId,
						now(),
						uidValidity,
						deps.source.uidValidity?.(),
						deps.getConfig?.()?.device.name,
					)
					if (!result.ok) return fail(result.reason === "not-found" ? 404 : 409, result.reason)
					return send(200, { ok: true })
				}

				case "POST /ack": {
					const body = asRecord(await readJson(req))
					const uid = Number(body?.uid)
					const instanceId = typeof body?.instanceId === "string" ? body.instanceId : ""
					if (!Number.isInteger(uid) || !instanceId) return fail(400, "bad_request")

					// Remove the record, THEN journal, then touch the mail. The order looks
					// backwards but is the safe one: the journal is read at scan time, so
					// journalling while the record still exists would leave a window where a
					// polling session claims and injects the same reply twice. Losing the
					// journal write after a successful ack only re-opens dedupe for a UID that
					// is no longer in `pending`, which the scanner never reads again.
					const uidValidity =
						typeof body?.uidValidity === "number" && Number.isFinite(body.uidValidity) ? body.uidValidity : undefined
					const acked = ackPending(env, uid, instanceId, uidValidity, deps.source.uidValidity?.())
					if (!acked.ok) return fail(acked.reason === "not-found" ? 404 : 409, acked.reason)
					// The record's space, never the watcher's: after a renumbering the two differ,
					// and journaling under the live space would suppress a brand-new message at
					// that UID. A record predating UIDVALIDITY carries none, and journal() then
					// keeps the space the file already records.
					journal(env, uid, acked.uidValidity)
					// The record's session, never the request body's: a client that acks
					// another session's mail must not also free its decision slot.
					registry.release(acked.sessionId)

					// Mailbox hygiene only. A failure here must not resurrect the delivery.
					try {
						await deps.source.markSeen?.(uid)
					} catch {
						/* logged by the caller in production; delivery is already acked */
					}
					return send(200, { ok: true })
				}

				case "POST /register": {
					const body = asRecord(await readJson(req))
					const sessionId = typeof body?.sessionId === "string" ? body.sessionId : ""
					if (!sessionId) return fail(400, "bad_request")
					const result = registry.register(sessionId)
					if (result.full) return fail(503, "registry_full")
					return send(200, result)
				}

				case "DELETE /register": {
					const body = asRecord(await readJson(req))
					const sessionId = typeof body?.sessionId === "string" ? body.sessionId : ""
					if (!sessionId) return fail(400, "bad_request")
					registry.release(sessionId)
					return send(200, { ok: true })
				}

				case "POST /ping": {
					const body = asRecord(await readJson(req))
					const instanceId = typeof body?.instanceId === "string" ? body.instanceId : ""
					if (!instanceId) return fail(400, "bad_request")
					pings.set(instanceId, now())
					// Bounded: a client that keeps changing its id must not grow this map without
					// limit. Oldest entries are dropped first.
					while (pings.size > MAX_PINGS) {
						const oldest = pings.keys().next().value
						if (oldest === undefined) break
						pings.delete(oldest)
					}
					return send(200, { ok: true, clients: pings.size })
				}

				case "POST /bye": {
					const body = asRecord(await readJson(req))
					const instanceId = typeof body?.instanceId === "string" ? body.instanceId : ""
					if (!instanceId) return fail(400, "bad_request")
					pings.delete(instanceId)
					return send(200, { ok: true, clients: pings.size })
				}

				case "POST /shutdown": {
					if (!deps.shutdown) return fail(501, "not_supported")
					// Answer first, then exit: a client that got no response would report
					// a failure for a restart that actually worked.
					send(200, { ok: true })
					setTimeout(() => deps.shutdown?.(), 50)
					return undefined
				}

				case "POST /reload": {
					if (!deps.reload) return fail(501, "not_supported")
					try {
						const result = await deps.reload()
						if (!result.ok) return fail(500, "reload_failed", { message: result.error ?? "unknown" })
						return send(200, { ok: true, ...(result.warning ? { warning: result.warning } : {}) })
					} catch (error) {
						return fail(500, "reload_failed", { message: (error as Error).message })
					}
				}

				case "POST /mode": {
					const body = asRecord(await readJson(req))
					if (!isMode(body?.mode)) return fail(400, "bad_request")
					const mode = writeMode(env, body.mode, now())
					broadcast({ type: "mode", mode })
					deps.onModeChange?.(mode)
					return send(200, { mode })
				}

				case "POST /send": {
					// A budget, not a rate limiter: an injected agent can ask for unbounded mail, and
					// a provider that starts refusing (or a daily quota that runs out) silences the
					// notifications that matter. Count and refuse rather than queue.
					if (!sendBudget.take(Date.now())) {
						return fail(429, "send_budget")
					}
					const body = asRecord(await readJson(req))
					const subject = typeof body?.subject === "string" ? body.subject : ""
					const text = typeof body?.text === "string" ? body.text : ""
					const config = deps.getConfig?.() ?? deps.config
					const to = typeof body?.to === "string" && body.to ? body.to : config.mail.to
					// cwd lets the mailer resolve relative image paths from the agent's project.
					const cwd = typeof body?.cwd === "string" ? body.cwd : undefined
					// sessionId lets the sender thread this mail into the session's conversation.
					const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined
					if (!subject || !text) return fail(400, "bad_request")

					// Thread every notification for a session into one conversation: reply to
					// the previous message, reference the session root. Read BEFORE sending,
					// because recording happens after.
					// Mint and record BEFORE calling deps.send. The scan can see the mail come
					// back into INBOX as soon as SMTP accepts it, so an id recorded after the
					// send leaves the self-echo guard empty for exactly that window.
					// Read the thread BEFORE recording: recording moves lastMessageId to the new
					// id, and a message must answer its predecessor, not itself.
					const thread = sessionId ? sessionThread(env, sessionId) : {}
					const messageId = generateMessageId(config.mail.smtp.user ?? "")
					if (sessionId) {
						recordOutbound(env, {
							messageId,
							sessionId,
							device: config.device.name,
							subject,
						})
					}
					const threading = {
						...(thread.lastMessageId ? { inReplyTo: `<${thread.lastMessageId}>` } : {}),
						...(thread.rootMessageId ? { references: [`<${thread.rootMessageId}>`] } : {}),
					}
					try {
						const result = await deps.send({
							to,
							subject,
							text,
							...(cwd ? { cwd } : {}),
							...(sessionId ? { sessionId } : {}),
							messageId,
							...threading,
						})
						// Record the outbound id so a reply reaches this session even if a
						// client or a human rewrites the subject token away.
					} catch (error) {
						// The id was recorded before the send, because the mail can come back
						// before the transport resolves. It will not come back now, so drop it:
						// otherwise the next notification threads against a parent that never
						// existed.
						removeOutbound(env, messageId)
						return fail(502, "send_failed", { message: (error as Error).message })
					}
					// Bookkeeping only, and outside the failure path: a recording error here must
					// not report a delivered mail as undelivered.
					try {
						deps.onSent?.({ messageId, subject, ...(sessionId ? { sessionId } : {}) })
					} catch {
						/* the thread store is an optimisation; the mail is already gone */
					}
					return send(200, { ok: true })
				}

				default:
					return fail(404, "not_found")
			}
		} catch (error) {
			const message = (error as Error).message
			if (message === "request body too large") return fail(413, "body_too_large")
			// Classified by cause, not by prose: a store write failure mentions `threads.json`,
			// and a substring match on "json" reported it as the client's fault.
			if (error instanceof BadBodyError) return fail(400, "bad_request", { message })
			return fail(500, "internal", { message })
		}
	}

	const server = http.createServer((req, res) => {
		void dispatch(req, res).catch(() => {
			// A malformed request must not take the process down with it.
			try {
				if (!res.headersSent) {
					res.writeHead(500, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: { code: "internal" } }))
				} else {
					res.destroy()
				}
			} catch {
				/* the socket is already gone */
			}
		})
	})
	// Unparseable HTTP never reaches the handler at all.
	server.on("clientError", (_error, socket) => {
		socket.destroy()
	})

	return {
		server,
		get sseClients() {
			return streams.size
		},
		broadcast,
		// Never fall back to the unspecified address: `undefined` binds 0.0.0.0, and the port is
		// what keeps one daemon per machine. loadConfig repairs this, so this is a belt.
		listen(port = deps.config.daemon.port, host = deps.config.daemon.host || "127.0.0.1") {
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
			clearInterval(idleCheck)
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
