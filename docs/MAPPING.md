# docs/MAPPING.md — `opencode-afk` → `pi-mailbridge`

Module-by-module mapping from the reference implementation
[`7emotions/afk`](https://github.com/7emotions/afk) (npm `opencode-afk`, MIT,
v0.1.5, 3,988 lines JS) onto Pi's extension API.

Read this alongside `ARCHITECTURE.md`. The goal is to port a proven design,
not to reinvent it — while deleting the parts that only exist because OpenCode
is driven out-of-process.

---

## 0. The one structural difference

`opencode-afk` injects replies through the **OpenCode SDK over HTTP**, because
its daemon lives outside the agent process. Pi extensions run **inside** the
agent process, so injection is a local function call.

That single change deletes three pieces of machinery:

| afk machinery | Why it exists | pi-mailbridge |
| --- | --- | --- |
| `resolveRootSessionID()` parent-chain walk | opencode subagent sessions have `parentID`; the plugin must find the ROOT session to stamp the token with | Not needed. Pi reports the session id directly via `ctx.sessionManager.getSessionId()`. Revisit only if pi subagents surface as child sessions. |
| Ownership self-check by `session.directory` | daemon broadcasts to all instances; each must decide if a reply is "for me" | Direct: compare the token's session id to `getSessionId()`. |
| `POST /claim {sessionID, instanceId}` with HTTP 500-on-gone handling | the SDK call may fail because the session vanished | Not needed for routing. The claim remains, but only to make **ack ordering** crash-safe (see §3). |

Everything else ports essentially as-is.

---

## 1. Module map

| `opencode-afk` file | Lines | pi-mailbridge target | Change |
| --- | --- | --- | --- |
| `index.js` | 391 | `src/extension.ts` | Rewritten: opencode tool/command registration → `pi.registerTool` / `pi.registerCommand` |
| `daemon.js` | 473 | `src/daemon/main.ts` + `src/daemon/service.ts` | Ported: HTTP surface + SSE in `service.ts`, CLI/lifecycle and single-instance lock in `main.ts` (port **4177**, not 4100) |
| `core/watcher.js` | 261 | `src/daemon/watcher.ts` | Ported verbatim — `imapflow` IDLE, renew < 29 min, exponential backoff |
| `core/process.js` | 314 | `src/daemon/process.ts` | Ported — UID-cursor incremental scan → fetch → parse → persist |
| `core/reply-parse.js` | 265 | `src/core/reply-parse.ts` | Ported — quote stripping, address/AR-header pinning (token verify lives in `core/token.ts`) |
| `core/inject.js` | 181 | `src/extension.ts` (in-process) | **Replaced** by `pi.sendUserMessage(body, { deliverAs: "followUp" })` |
| `core/pause-notify.js` | 143 | `src/extension.ts` → `pi.on("agent_settled")` | Replaced by the pi event (§4) |
| `core/subscribe.js` | 271 | `src/extension.ts` | Replaced — polls `/pending` and replays it (idempotent); `/events` SSE stays available for push clients |
| `core/new-session.js` | 103 | **out of scope** | Deferred. Pi can do it (`ctx.newSession`) but it replaces the active session; see ARCHITECTURE §6 |
| `request-decision.js` | 187 | `src/extension.ts` | Ported as a `pi.registerTool` |
| `notify.js` | 125 | `src/extension.ts` | Ported as a `pi.registerTool` |
| `mailer.js` | 86 | `src/core/mailer.ts` | Ported — `[omo:…]` → `[pi:…]`, nodemailer transport |
| `config.js` | 184 | `src/core/config.ts` | Ported — layered config + env overrides |
| `messages.js` | 102 | *(inlined)* | Folded into the modules that emit the text (`commands.ts`, `settle.ts`, `smoke.ts`) — no separate table |
| `install.js` | 168 | **dropped** | opencode-specific installer; pi installs via `pi install npm:pi-mailbridge` |
| `store/paths.js` | 88 | `src/store/paths.ts` | Ported — XDG state dir |
| `store/secret.js` | 116 | `src/store/secret.ts` | Ported — HMAC key file, first-writer-wins |
| `store/pending-store.js` | 215 | `src/store/pending-store.ts` | Ported — durable pending replies |
| `store/uid-cursor.js` | 123 | `src/store/uid-cursor.ts` | Ported — monotonic UID cursor |
| `store/mode-store.js` | 86 | `src/store/mode-store.ts` | Ported — global on/off `/afk` · `/back` |
| `store/registry.js` | 106 | `src/store/registry.ts` | Ported — one-outstanding-decision guard |
| `command/afk.md`, `command/back.md` | short | `pi.registerCommand` | Inline, no separate command files |
| `AGENTS.md` | — | `AGENTS.md` | Rewritten for contributors + agents |

---

## 2. API substitutions

### Registering a tool

```js
// opencode-afk
export const request_decision = tool({
  description: "…",
  args: { subject: z.string(), question: z.string() },
  async execute(args, ctx) { /* … */ },
})
```

```ts
// pi-mailbridge
pi.registerTool({
  name: "request_decision",
  label: "Request decision",
  description: "Email the user a decision request and end the turn.",
  parameters: Type.Object({
    subject: Type.String(),
    question: Type.String(),
    options: Type.Optional(Type.Array(Type.String())),
    recommendation: Type.Optional(Type.String()),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    /* … */
    return { content: [{ type: "text", text: "Email sent." }], details: {} };
  },
})
```

### Inbound injection

```js
// opencode-afk (core/inject.js)
await client.session.prompt({
  path: { id: sessionID }, query: { directory },
  body: { parts: [{ type: "text", text: body }] },
})
```

```ts
// pi-mailbridge — in-process, cannot "not find" the session
pi.sendUserMessage(body, { deliverAs: "followUp", expandPromptTemplates: true })
```

`deliverAs: "followUp"` queues the reply if a run is in flight — matching afk's
behaviour when a decision is answered late.

### Lifecycle signal

```js
// opencode-afk: polling/idle heuristics in core/pause-notify.js
```

```ts
// pi-mailbridge: a real event, and the correct one
pi.on("agent_settled", (event) => {
  if (event.aborted && !config.notify.notifyOnAborted) return   // Escape ≠ finished
  scheduleSettledMail()                                          // debounced
})
```

`agent_end` is **wrong** here: pi may still retry, compact, or run queued
follow-ups after it.

### Commands

```js
// opencode-afk: command/afk.md + command/back.md
```

```ts
pi.registerCommand("afk",  { description: "Email mode ON",  handler: (_, ctx) => setMode("on",  ctx) })
pi.registerCommand("back", { description: "Email mode OFF", handler: (_, ctx) => setMode("off", ctx) })
pi.registerCommand("mailbridge", { description: "Status, setup, check, auth, smoke, restart", handler: (_, ctx) => status(ctx) })
```

---

## 3. What we keep exactly (these are the hard-won parts)

1. **UID-cursor polling, not `\Seen`.** afk searches `UID > cursor`, never
   `UNSEEN` and never by SUBJECT. `\Seen` is shared mutable state — any other
   mail client can set it and silently eat a reply.
2. **Ack ordering.** Parse → persist to durable pending → notify → inject →
   **then** `\Seen` + journal append. A crash anywhere before the ack leaves
   the mail unseen and the pending durable, so nothing is lost. Never mark
   seen at parse time.
3. **Single watcher per machine.** One daemon, one IMAP IDLE connection, fixed
   port, `EADDRINUSE` = "already running, exit quietly". This is what makes
   multi-session polling sane: N pi sessions, 1 mailbox connection.
4. **A routing id in the subject — but no longer a signature.** Shipped as a 6-hex
   local route id (`[pi:f913c9]`, six hex, eight on the rare collision), looked up in
   `store/routes.ts`. This is the one
   deliberate reversal from the baseline: a signed token made every subject preview
   unreadable (a 39-character token, in a subject over 80 characters). HMAC tokens still
   verify for mail already in flight, and
   authorization never depended on the token either way.
5. **Global mode store.** `/afk` and `/back` are explicit, persisted, and
   independent of focus heuristics.
6. **Backoff + IDLE renew.** Renew well under the ~29-minute server timeout;
   exponential reconnect 1 s → 60 s.
7. **Bounded resources.** Registry cap, SSE client cap, request body cap,
   constant-time token comparison.

---

## 4. Deliberate differences

| Area | afk | pi-mailbridge | Why |
| --- | --- | --- | --- |
| New session from mail (`/new`) | supported | deferred | `ctx.newSession()` *replaces* the active session; needs its own design pass |
| Service | opencode/qq mail tuned | provider-neutral | `config.mail.*`; no hard-coded host |
| Transport | SMTP password | SMTP password **or** OAuth2/XOAUTH2 | Outlook requires OAuth2 since 2024-09-16 |
| Reply parsing | hand-rolled | hand-rolled, quote-stripping covered by tests | no `inreply` dependency: the stripping rules are ours and tested |
| Auth check | allowlist | allowlist + DMARC header (pinned when `trustedAuthservId` is set; **off for a single mailbox** — SECURITY.md §5) | see SECURITY.md §2 |
| Port | 4100 | 4177 | avoid colliding with a running afk |

---

## 5. Publish checklist

- [x] `package.json` `files` limited to `src`, `bin`, `docs`, `config.example.json`, `CHANGELOG.md`
- [x] no secrets in the package; `config.json` is gitignored and never shipped
- [x] `pi` manifest points at `./src/extension.ts`
- [x] peer deps on `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and `@sinclair/typebox`, not hard deps
- [x] tests run with `node --test` and never touch real IMAP/SMTP
- [x] docs state the daemon is a **local, authenticated** service that can inject prompts
- [x] README states the threat model before the install steps ("Security first", and the install section points at SECURITY.md)
