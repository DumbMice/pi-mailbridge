// What a starter does with one message.
//
// The order is the security design (docs/ARCHITECTURE.md §7a): resource caps, then authentication, then
// channel, then replay/freshness, then parsing, then validation, then a durable reservation, then the side
// effect, then the result mail. Two rules that are easy to get wrong:
//
//   * **Only authenticated, channel-matching mail gets a reply.** Refusing a stranger by mail is
//     backscatter; the daemon's robot policy already refuses to answer robots, and this follows it.
//   * **The reservation is written before the spawn.** A crash then leaves a record that says what should
//     exist, which is the only way recovery can distinguish "nothing started" from "we did not hear back".

import type { ResolvedConfig } from "../core/config.ts"
import { authorize } from "../core/authz.ts"
import { normalizeAddress } from "../core/reply-parse.ts"
import { matchChannel } from "./channel.ts"
import { isReplySubject, parseRequest, stripQuotedText, type StartFields } from "./grammar.ts"
import { type JournalFile, type RequestRecord, type SessionRecord, alreadySeen, isStale } from "./journal.ts"
import { planName, resolvePrompt, validateCwd, validateModel, validateThinking } from "./validate.ts"
import { type SpawnPlan, type SpawnResult } from "./spawn.ts"
import { configPath, statePath } from "../store/paths.ts"

export interface StarterMail {
	subject?: string
	from?: string
	to: string[]
	headers: {
		inReplyTo?: string
		references?: string[]
		authResults?: string[]
		autoSubmitted?: string
		precedence?: string
		xPiMailbridge?: string
		listId?: string
		autoResponseSuppress?: string
	}
	messageId: string
	uid: number
	uidValidity?: number
	/** IMAP INTERNALDATE, ms. Freshness is the mail's age, not when it was fetched. */
	receivedAt: number
	body: string
}

export interface OutcomeMail {
	subject: string
	text: string
	/** The request mail, so the answer threads under it. */
	inReplyTo: string
}

export interface HandleDeps {
	config: ResolvedConfig
	journal: JournalFile
	/** Persist the journal (the caller owns the file; this function never writes it directly). */
	save: (journal: JournalFile) => void
	/** Reserve a prompt file for a request; returns the paths the bootstrap will use. */
	writePrompt: (requestId: string, text: string) => { promptFile: string; readyFile: string }
	/** Remove a prompt file whose session never started (the bootstrap removes it when it runs). */
	removePrompt?: (requestId: string) => void
	spawn: (plan: SpawnPlan) => Promise<SpawnResult>
	stop: (tmuxSessionId: string, expectedName?: string) => Promise<{ ok: boolean; detail?: string }>
	list: () => Promise<{ id: string; name: string }[] | undefined>
	send: (mail: OutcomeMail) => Promise<void>
	now: () => number
	env: NodeJS.ProcessEnv
	log: (line: string) => void
	/** Absolute path to the compiled bootstrap extension. */
	bootstrapPath: string
	socket?: string
	/** Injected so a test can drive stage B; absent means stage B is unavailable. */
	parseWithAgent?: (mail: StarterMail, missing: "cwd") => Promise<{ cwd?: string; error?: string }>
}

export type Outcome =
	| { action: "ignored"; reason: string }
	| { action: "refused"; code: string; detail: string; replied: boolean }
	| { action: "started"; name: string; tmuxSessionId: string; replied: boolean }
	| { action: "stopped"; name: string; replied: boolean }
	| { action: "listed"; count: number; replied: boolean }

const ignore = (reason: string): Outcome => ({ action: "ignored", reason })

function newRequestId(mail: StarterMail, now: number): string {
	// Stable per mail, and readable in a log: the Message-ID hash plus a timestamp is enough to correlate
	// the request, the journal entry, the prompt file and the confirmation.
	let hash = 0
	for (const ch of mail.messageId) hash = (hash * 31 + ch.charCodeAt(0)) | 0
	return `req-${Math.abs(hash).toString(16)}-${now.toString(36)}`
}

function replySubject(subject: string | undefined): string {
	const base = (subject ?? "no subject").trim()
	return base.toLowerCase().startsWith("re:") ? base : `Re: ${base}`
}

/** Sessions we may stop: journal-owned and not already ended. */
function ownedNames(journal: JournalFile): string[] {
	return Object.values(journal.sessions)
		.filter((s) => s.endedAt === undefined)
		.map((s) => s.name)
}

function startQuotaReached(config: ResolvedConfig, journal: JournalFile, now: number): boolean {
	const live = Object.values(journal.sessions).filter((s) => s.endedAt === undefined)
	if (live.length >= config.starter.maxSessions) return true
	const hourAgo = now - 60 * 60 * 1000
	// Counted by *attempt*: a stop changes the state to ended, and refunding the budget would let a loop of
	// start/stop/start run unbounded. Refusals never spawned, so they do not count.
	// A failed spawn keeps its `launchedAt`: it created and killed a tmux session and a pi process, so a
	// wrong model must not be retryable without bound. `launchedAt` itself separates attempt from refusal.
	const recent = Object.values(journal.requests).filter((r) => r.launchedAt !== undefined && r.launchedAt > hourAgo)
	// 0 disables the limit, like every other window in this file: a user who wants no starts at all has
	// `starter.enabled: false`, and a silent "0 means never" would be a trap in the other direction.
	return config.starter.startsPerHour > 0 && recent.length >= config.starter.startsPerHour
}

/** Set a request's state and touch its timestamp. */
function transition(journal: JournalFile, id: string, patch: Partial<RequestRecord>, now: number): RequestRecord {
	const current = journal.requests[id]
	if (!current) throw new Error(`journal has no request ${id}`)
	const next = { ...current, ...patch, at: now }
	journal.requests[id] = next
	return next
}

export async function handleMail(mail: StarterMail, deps: HandleDeps): Promise<Outcome> {
	const { config, journal } = deps
	const now = deps.now()
	const starter = config.starter

	// `enabled: false` is a switch, not advice: `check` reports it, but a daemon-less process must refuse
	// work itself. Silence, not a refusal mail: a starter that is off should look off to a stranger.
	if (!starter.enabled) return { action: "ignored", reason: "disabled" }

	// Resource caps. Commands (`stop`, `list`) are exempt: a stop must work at the quota.
	// Reply headers are the authoritative sign: a fresh request has none *by design* (that is why the
	// request context relaxes reply evidence), so `In-Reply-To`/`References` means this answers a mail even
	// when the client's marker is one we do not know, or was edited off.
	const replyMail =
		isReplySubject(mail.subject) ||
		Boolean(mail.headers.inReplyTo?.trim()) ||
		(mail.headers.references?.length ?? 0) > 0
	const body = replyMail ? stripQuotedText(mail.body) : mail.body
	const grammared = parseRequest(body, { promptMaxChars: starter.promptMaxChars })
	const isCommand = grammared.state === "complete" && (grammared.request.kind === "stop" || grammared.request.kind === "list")

	/** Returns whether the mail actually went out: the journal must not record a failed result as sent. */
	const reply = async (text: string): Promise<boolean> => {
		try {
			await deps.send({ subject: replySubject(mail.subject), text, inReplyTo: mail.messageId })
			return true
		} catch (error) {
			deps.log(`confirmation failed: ${(error as Error).message}`)
			return false
		}
	}

	// 2. Authentication, in the request context. A self-addressed request has no reply headers by design.
	const auth = authorize(
		{
			from: mail.from,
			headers: {
				inReplyTo: mail.headers.inReplyTo,
				references: mail.headers.references,
				authResults: mail.headers.authResults,
				autoSubmitted: mail.headers.autoSubmitted,
				precedence: mail.headers.precedence,
				// The shared policy uses both of these to spot robots; dropping them here made a list post
				// look like a person.
				...(mail.headers.listId === undefined ? {} : { listId: mail.headers.listId }),
				...(mail.headers.autoResponseSuppress === undefined
					? {}
					: { autoResponseSuppress: mail.headers.autoResponseSuppress }),
			},
			context: "request",
		},
		config,
	)
	if (!auth.ok) return ignore(`unauthenticated:${auth.reason}`)

	// 3. Our own mail must never start anything (the marker, then the recorded Message-ID).
	if (mail.headers.xPiMailbridge) return ignore("self-echo")

	// 4. The channel, and this machine.
	const channel = matchChannel(starter, { subject: mail.subject, to: mail.to, device: config.device.name })
	if (!channel.ours) return ignore(channel.reason)

	// 5. Replay and freshness.
	const seen = alreadySeen(journal, { messageId: mail.messageId, uid: mail.uid, uidValidity: mail.uidValidity })
	if (seen) return ignore(`already-handled:${seen.state}`)
	if (isStale({ receivedAt: mail.receivedAt }, now, starter.requestMaxAgeHours)) return ignore("stale")

	// A reply is how `stop:` comes back (the result mail says so), but a non-command reply is a person
	// answering a notification: starting a session from it would run the quoted history as the prompt.
	// Placed *after* the echo/channel/replay gates: SECURITY §4a promises that echo, off-channel, replayed
	// and stale mail is dropped without a reply, and answering our own result mail would start a loop.
	if (replyMail && !isCommand) {
		// If the block did name a command, say what was wrong with it rather than "not a command".
		const named = /^\s*(stop|list)\s*:/im.test(body)
		const detail =
			named && grammared.state !== "complete"
				? grammared.state === "invalid"
					? grammared.errors.map((e) => `${e.code}: ${e.detail}`).join("; ")
					: "the command block is incomplete"
				: "this reply is not a stop:/list: command"
		const sent = await reply(
			`[pi-start] refused — ${detail}; nothing was started. Send \`stop: <name>\` or \`list:\`, or a new mail to start a session`,
		)
		return { action: "refused", code: named ? "bad-command" : "reply-without-command", detail, replied: sent }
	}

	if (grammared.state === "invalid") {
		const detail = grammared.errors.map((e) => `${e.code}: ${e.detail}`).join("; ")
		await reply(`[pi-start] refused — ${detail}`)
		return { action: "refused", code: grammared.errors[0]?.code ?? "invalid", detail, replied: true }
	}

	// 6. Commands: stop and list are not starts, so the caps do not apply to them.
	if (grammared.state === "complete" && grammared.request.kind === "list") {
		const live = await deps.list()
		if (live === undefined) {
			// `undefined` is "tmux did not answer", not "nothing is running".
			await reply("[pi-start] could not list sessions: tmux did not answer")
			return { action: "listed", count: 0, replied: true }
		}
		const rows = live.map((entry) => {
			const record = journal.sessions[entry.name]
			return `${entry.name} ${entry.id}${record?.cwd ? ` ${record.cwd}` : ""}`
		})
		await reply(rows.length ? `[pi-start] sessions\n${rows.join("\n")}` : "[pi-start] no sessions")
		return { action: "listed", count: live.length, replied: true }
	}
	if (grammared.state === "complete" && grammared.request.kind === "stop") {
		const target = grammared.request.stopTarget ?? ""
		const stopOne = async (name: string): Promise<"stopped" | "unknown" | "failed"> => {
			const record = journal.sessions[name]
			if (!record || record.endedAt !== undefined) return "unknown"
			const stopped = await deps.stop(record.tmuxSessionId, record.name)
			if (!stopped.ok) return "failed"
			journal.sessions[name] = { ...record, endedAt: now }
			if (journal.requests[record.requestId]) {
				transition(journal, record.requestId, { state: "ended" }, now)
			}
			return "stopped"
		}
		if (target === "all") {
			const results = await Promise.all(ownedNames(journal).map(async (name) => [name, await stopOne(name)] as const))
			deps.save(journal)
			const said = results.map(([name, result]) => `${name} ${result}`).join(", ") || "nothing to stop"
			await reply(`[pi-start] ${said}`)
			return { action: "stopped", name: "all", replied: true }
		}
		const result = await stopOne(target)
		deps.save(journal)
		await reply(
			result === "stopped"
				? `[pi-start] stopped ${target}`
				: result === "unknown"
					? `[pi-start] unknown-session ${target}`
					: `[pi-start] could not stop ${target}`,
		)
		return result === "stopped"
			? { action: "stopped", name: target, replied: true }
			: { action: "refused", code: result === "unknown" ? "unknown-session" : "kill-failed", detail: target, replied: true }
	}

	if (!isCommand && startQuotaReached(config, journal, now)) {
		await reply("[pi-start] refused — start budget or live-session cap reached; stop a session or wait")
		return { action: "refused", code: "quota", detail: "start budget or session cap", replied: true }
	}

	// 7. Parsing, then the optional agent for a missing cwd. Explicit values are never repaired.
	let fields: StartFields =
		grammared.state === "complete" || grammared.state === "incomplete" ? grammared.request.fields : { parse: "auto" }
	const wantsAgent = fields.parse === "agent" || (grammared.state === "incomplete" && starter.parse.agent)
	if (grammared.state === "incomplete" && wantsAgent && deps.parseWithAgent) {
		const parsed = await deps.parseWithAgent(mail, "cwd")
		if (parsed.cwd) fields = { ...fields, cwd: parsed.cwd }
		else if (parsed.error) deps.log(`agent parse found nothing: ${parsed.error}`)
	}
	if (!fields.cwd && starter.defaultCwd) fields = { ...fields, cwd: starter.defaultCwd }
	if (!fields.cwd) {
		const detail = starter.parse.agent || wantsAgent ? "cwd is missing and could not be determined" : "cwd is required"
		await reply(`[pi-start] refused — ${detail} (set "cwd:" or starter.defaultCwd)`)
		return { action: "refused", code: "missing-cwd", detail, replied: true }
	}

	// 8. Validation: the boundary.
	const cwd = validateCwd(fields.cwd ?? starter.defaultCwd, {
		roots: starter.roots,
		reserved: [parentOf(configPath(deps.env)), parentOf(statePath(deps.env, "x"))],
	})
	if (!cwd.ok) {
		await reply(`[pi-start] refused — ${cwd.code}: ${cwd.detail}`)
		return { action: "refused", code: cwd.code, detail: cwd.detail, replied: true }
	}
	if (fields.model) {
		const model = validateModel(fields.model, starter.models)
		if (!model.ok) {
			await reply(`[pi-start] refused — ${model.code}: ${model.detail}`)
			return { action: "refused", code: model.code, detail: model.detail, replied: true }
		}
	} else if (starter.defaultModel) {
		const model = validateModel(starter.defaultModel, [...starter.models, starter.defaultModel])
		if (!model.ok) {
			await reply(`[pi-start] refused — ${model.code}: ${model.detail} (starter.defaultModel)`)
			return { action: "refused", code: model.code, detail: model.detail, replied: true }
		}
	}
	if (fields.thinking) {
		const thinking = validateThinking(fields.thinking)
		if (!thinking.ok) {
			await reply(`[pi-start] refused — ${thinking.code}: ${thinking.detail}`)
			return { action: "refused", code: thinking.code, detail: thinking.detail, replied: true }
		}
	}

	const name = planName({ requested: fields.name, title: channel.title, taken: Object.keys(journal.sessions), now: new Date(now) })
	if (!name.ok) {
		await reply(`[pi-start] refused — ${name.code}: ${name.detail}`)
		return { action: "refused", code: name.code, detail: name.detail, replied: true }
	}

	// 9. Reserve before executing: the record says what should exist, before it exists.
	const id = newRequestId(mail, now)
	const piSessionId = `pi-${new Date(now).toISOString().slice(2, 16).replace(/[-:T]/g, "")}-${Math.abs(now % 0xffff).toString(16).padStart(4, "0")}`
	const model = fields.model ?? (starter.defaultModel || undefined)
	const prompt = resolvePrompt(fields.prompt)
	const { promptFile, readyFile } = deps.writePrompt(id, prompt)
	journal.requests[id] = {
		id,
		messageId: mail.messageId,
		uid: mail.uid,
		...(mail.uidValidity === undefined ? {} : { uidValidity: mail.uidValidity }),
		receivedAt: mail.receivedAt,
		state: "reserved",
		at: now,
		piSessionId,
		name: name.value,
		cwd: cwd.value,
		// Ownership before existence: recovery matches a live child by this name, never by a `$N` that the
		// tmux server may reuse after a restart.
		tmuxName: name.value,
		...(model ? { model } : {}),
	}
	deps.save(journal)

	// 10. Execute.
	transition(journal, id, { state: "spawning", launchedAt: now }, now)
	deps.save(journal)
	const result = await deps.spawn({
		tmuxId: name.value,
		piSessionId,
		displayName: name.value,
		cwd: cwd.value,
		...(model ? { model } : {}),
		...(fields.thinking ? { thinking: fields.thinking } : {}),
		promptFile,
		readyFile,
		requestId: id,
		...(starter.autoEnableMail ? { emailMode: "on" as const } : {}),
		bootstrapPath: deps.bootstrapPath,
		...(deps.socket ? { socket: deps.socket } : {}),
	})
	if (!result.ok) {
		// The bootstrap never read it, so it is a secret-bearing temp file nobody will consume.
		deps.removePrompt?.(id)
		transition(journal, id, { state: "refused", reason: `${result.reason}: ${result.detail}` }, deps.now())
		deps.save(journal)
		await reply(`[pi-start] refused — ${result.reason}: ${result.detail}`)
		return { action: "refused", code: result.reason, detail: result.detail, replied: true }
	}

	// 11. Success, recorded before the mail: a crash leaves `ready, resultSent: false`, which is retried.
	transition(journal, id, { state: "ready", tmuxSessionId: result.tmuxSessionId }, deps.now())
	const session: SessionRecord = {
		name: name.value,
		tmuxSessionId: result.tmuxSessionId,
		piSessionId,
		requestId: id,
		cwd: cwd.value,
		...(fields.model ? { model: fields.model } : {}),
		at: now,
	}
	journal.sessions[name.value] = session
	deps.save(journal)

	const sentStart = await reply(
		[
			`[pi-start] started ${name.value}`,
			`cwd: ${cwd.value}`,
			...(fields.model ? [`model: ${fields.model}`] : []),
			`attach: tmux -L ${deps.socket ?? "pimail"} attach -t ${name.value}`,
			`stop: reply with "stop: ${name.value}"`,
		].join("\n"),
	)
	// Only a delivered result is marked sent: the flush retries `ready, resultSent:false` once.
	if (sentStart) {
		transition(journal, id, { resultSent: true }, deps.now())
		deps.save(journal)
	}
	return { action: "started", name: name.value, tmuxSessionId: result.tmuxSessionId, replied: sentStart }
}

/** The directory a file lives in, without importing a dirname helper for two call sites. */
function parentOf(file: string): string {
	return file.replace(/\/[^/]+$/, "")
}
