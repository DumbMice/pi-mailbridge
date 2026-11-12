# Changelog

## 0.1.0 — unreleased

Feature-complete for the single-user, one-mailbox case. Exercised by hand against a live
Outlook.com and QQ mailbox; no automated live-mailbox test exists.

### Core

- `core/token.ts` — HMAC-signed routing tokens (`[pi:<payload>.<mac>]`) with TTL,
  constant-time verification, prefix-tolerant subject extraction, and an
  optional **device claim** so replies route to the machine that owns the session.
- `core/authz.ts` — fail-closed chain: loop guard (pi account) → machine-generated
  → allowlist (empty denies all) → DMARC (`Authentication-Results`, optionally pinned
  to `security.trustedAuthservId` when set).
- `core/reply-parse.ts` — quote stripping that cuts at the first recognisable
  boundary, addr-spec normalization, auto-generated detection,
  `findTrustedAuthResults` (topmost matching `authserv-id` only).
- `core/attachments.ts` — MIME allowlist, 4 files / 1 MB caps, reasons for every
  drop; images become `ImageContent`, text is inlined.
- `core/mailer.ts` — SMTP send, `LOGIN` and `XOAUTH2`, injectable transport.
- `core/oauth.ts` — token from an argv command (argc-safe, `shell:false`), cached
  until TTL, one refresh on 401, disabled after three consecutive failing commands.
- `core/settle.ts` — `agent_settled`-only notifier, debounced, abort-aware,
  id-stamped subject naming the **device and session** (`pi: fix-login @ dev-box-7
  is waiting for you`), body with device/session id/project/turns/last text.
- `core/deliveries.ts` — claim → inject → ack runner; never acks a failed
  injection; absorbs replays after a failed ack.

### Single mailbox: safe to run, and no longer silently lossy

One address for both pi and the human is a first-class layout, so the guards around it are
now explicit and tested:

- every notification carries `X-Pi-Mailbridge: notification`, and inbound scanning refuses
  that marker before authorization - so our own mail cannot come back as an instruction even
  if the outbound id was never recorded;
- the outbound `Message-ID` is minted and recorded **before** the send, closing the window in
  which a notification could return before the guard knew about it;
- a message from your own address is accepted only with reply evidence (`In-Reply-To` or
  `References`), so a freshly composed mail is rejected instead of being injected;
- `/mailbridge setup` writes `requireDmarcPass: false` for this shape: providers that stamp
  no `Authentication-Results` on self-addressed mail (QQ) would otherwise reject every reply,
  and the rejection advanced the cursor past it.

**Upgrading a single-mailbox config:** if `security.allowSelfReplies` is already `true` and
every reply reports `dmarc-missing`, set `security.requireDmarcPass: false`. Setup writes that
for new configs; it never rewrites an existing one. `/mailbridge check` and
`pi-mailbridge --check` both report it — and because the shipped systemd unit runs `--check`
as `ExecStartPre`, that combination stops the unit from starting rather than starting a
daemon that rejects every reply.

### Daemon

- A session that attaches to an already-running daemon now reloads it when `config.json` is
  newer than the config the daemon read (`/health` carries `configLoadedAt`). Without this a
  hand-edited config or a headless `--setup` kept mailing the replaced address. The reload is
  fire-and-forget, single-flight, and its failure is reported rather than swallowed.

- `daemon/process.ts` — UID-cursor scan → authorize → route (short id / token / chain) → strip quotes
  → filter attachments → persist → advance. Ordering is the correctness property.
- `daemon/watcher.ts` — IMAP IDLE over an injectable client factory; renews under
  the ~29 min cutoff; bounded backoff; `start()` never throws on a dead server.
- `daemon/service.ts` — `/health`, `/events` (SSE), `/pending`, `/claim`, `/ack`,
  `/register`, `/ping`, `/bye`, `/mode`, `/send`, `/reload`, `/shutdown`;
  constant-time bearer auth; bounded bodies and streams. Ack removes the record, then
  journals it (the journal is consulted at scan time, so the reverse would open a
  double-injection window).
- `daemon/spawn.ts` — `probeHealth`, `ensureDaemon` (detached, unref'd), typed
  client.
- `daemon/main.ts` — server first, then catch-up scan, then watcher; SIGTERM
  handlers registered before dialling; `--check` (exit 2 config / 3 auth) and
  `--print-token`.

### Stores

- `pending-store` — durable deliveries with exclusive claim, same-instance
  re-claim, abandoned-claim TTL, claimant-only ack.
- `uid-cursor` — records the mailbox's UIDVALIDITY beside the cursor; a renumbering resets
  it (with `uidNext`-based detection for a cursor written by an older version), so a rebuilt
  folder is re-read instead of skipped.
- `journal` — capped acked-UID set for durable replay protection.
- `mode-store` — global on/off, default off, atomic replace.
- `registry` — one outstanding decision per session, TTL + hard cap.

### Extension

- Wires **`agent_settled` and never `agent_end`** (a test pins this).
- Mode mirror seeded from the daemon and refreshed each poll.
- `/afk`, `/back`, `/mailbridge`; `request_decision`, `notify_user`.
- Reply deliveries drain on `session_start` and on a 10 s poll, injected as
  `followUp` with attachments as content blocks.

### Reply identification

A reply is identified by the first rule that succeeds: the **short route id**
(`[pi:f913c9]`, a lookup key in `store/routes.ts`), then a **legacy signed token**
(still verified, no longer minted), then the **reply chain** (`In-Reply-To` /
`References` matched against Message-IDs recorded at send time in
`store/threads.ts`), then rejected as `no-token` and left unread. All three age out
with `security.tokenTtlHours`, and none of them authorizes anything. The chain
fallback means editing the subject no longer loses a reply;
`security.allowHeaderThreading: false` disables that rule only.

### In-pi commands

`/mailbridge` now takes subcommands, so the whole user-facing flow is inside pi:
`setup`, `check`, `auth`, `smoke`, `prime`, `restart`, plus the existing status. Only the
daemon itself stays a process (it must outlive pi); its CLI entry is documented as
the headless/systemd path, sharing `core/setup.ts`, `core/smoke.ts` and
`core/token-source.ts` with the commands so behaviour cannot drift.

- daemon: `POST /reload` re-reads config and restarts the watcher, so `setup` and
  `auth` take effect without killing anything by hand.
- fixed: the extension resolved the daemon script with `URL.pathname` instead of
  `fileURLToPath`, which mangles paths containing spaces or non-ASCII.
- `/mailbridge check` now warns when `oauth` is configured but neither account
  uses `XOAUTH2`, which would otherwise be silently ignored.

### Lifetime: singleton, and it exits with the last session

The daemon was already a singleton (the port is the lock) and already started by pi
(`ensureDaemon` from `session_start`). What it did not do was stop.

It now exits once no pi session has pinged for `daemon.idleTimeoutSecs` (default 120).
Sessions ping on their poll tick and send `/bye` on shutdown. Motivated by a real
failure: a daemon started at 15:09 kept serving old code through several package
changes because nothing could replace a running process. Stopping also means no session
means no watcher - nothing fetches and parses every incoming message for a session that
cannot claim it. Mail that arrives meanwhile is covered by the catch-up scan.

`daemon.exitWhenIdle: false` keeps it resident for a supervisor; the idle rule is
disabled until the first client has ever pinged, so a systemd-started daemon never
exits merely because pi is closed.

### systemd unit: paths that actually exist

Two things would have stopped the unit from starting on a real machine, both caught by
`systemd-analyze verify`:

- `/usr/bin/node` does not exist where pi ships its own Node. The unit now carries the
  pi-managed bin directory first in `PATH` and runs `/usr/bin/env node`, because systemd
  cannot expand a variable in the *executable* position - only in arguments.
- the package path assumed `pi install npm:...`, which is wrong for a local checkout.
  It is `Environment=PI_MAILBRIDGE_DIR`, with the local-path variant shown as a comment.

### Fixed: the catch-up scan never ran, and the daemon logged nothing

Found in a live `daemon.log` after a restart:

    imap ready; running catch-up scan
    catch-up: scan failed: pi-mailbridge: imap watcher not started

`start()` fires `onReady`, whose catch-up scan reads through the source proxy, but
`currentWatcher` was only assigned *after* `await watcher.start()`. Every catch-up scan
failed, so mail that arrived while the daemon was down was picked up only on the next
IDLE event - the opposite of what ARCHITECTURE.md promises.

- main.ts: assign `currentWatcher` before starting, with a packaging test that fails if
  the two statements are ever reordered
- spawn.ts: a detached daemon now appends to `daemon.log` instead of discarding stdio.
  `stdio: "ignore"` is why this failure was invisible; the log is what found it.

### Fixed: the daemon could die and nothing brought it back

Live symptom: a reply was received, injected and acked, then the bridge went silent.

The daemon's idle exit (added earlier this session) stopped the process 120s after the last
ping - correct - but nothing restarts it. The extension's poll tick only talked to a daemon
it assumed was alive, and `ensureDaemon` runs only on `session_start`. So once the daemon
exited, the session polled a dead port until a manual reload.

- the poll tick now treats a failed `ping` as "the daemon is gone": it respawns through
  ensureDaemon, rebuilds the client/notifier/runner, and resumes draining. Throttled to one
  attempt a minute so a dead daemon cannot cause a spawn storm.
- `session_start` and the recovery path share one `startRuntime()`, so they cannot drift.
- `/health` now reports `clients`, `lastPingAgoMs` and `idleExitEnabled`, which is what
  made this diagnosable: `clients: 0` with a live session proves the poll is not running.

### All notifications for a session thread into one conversation

Each notification used to be its own thread: the route id changed per message, so no two
subjects matched, and no `In-Reply-To`/`References` were set.

Two changes make one conversation per session:

- **One route per session**, reused and refreshed, instead of one per message. The subject
  is then byte-identical across a session's notifications, which is what Outlook's
  conversation topic keys on.
- **RFC 5322 headers**: `In-Reply-To` is the session's previous outbound Message-ID and
  `References` is its root, both derived from the outbound id registry that already
  existed for reply routing.

The extension passes `sessionId` on `/send`; the daemon looks the thread up before
sending, so the ids are read before the new message is recorded.

Threading is worth it for more than tidiness: a reply is now `In-Reply-To` a message we
already recorded, so the reply-chain fallback and the subject route agree.

### The signature block no longer prints `--` twice

Reported from a rendered notification: the block showed a top border *and* the literal
`--` line, reading as a duplicate divider.

The `--` line is now dropped from the HTML part only - the border is the divider there.
It stays in the text part, where RFC 3676 needs it and where quote stripping relies on
it, and the metadata below it is untouched.

### Local images are inlined as cid attachments

A Markdown image pointing at a local file rendered as `<img src="./shot.png">`, which a
mail client cannot resolve - the reader saw a broken image. Local images are now read and
attached with `multipart/related`, referenced by `cid:`, so a screenshot the agent
produced arrives as an actual picture.

Safety, because the src comes from model output and the result leaves the machine:

- the file must **sniff** as an image from magic bytes (PNG/JPEG/GIF/WebP), so a renamed
  text file or key is never attached
- 128 KB per image, 384 KB total, 4 images - a notification cannot become a file transfer
- unreadable, oversized or non-image paths degrade to a short bracketed note, never a
  broken image
- cids are content-addressed, so one screenshot referenced twice is attached once

Relative paths resolve against the sending session's project directory, which the
extension now passes to `/send` as `cwd`.

### Tables in mail need inline borders

Reported from a rendered notification: a Markdown table arrived as loose text. markdown-it
emits a bare <table>, and mail clients default to no borders, while a <style> block is
stripped by several of them.

The renderer rules for table_open/th_open/td_open now carry inline styles:
border-collapse, cellspacing/cellpadding attributes, and a 1px border plus padding on
every cell, with a shaded header row. Fenced blocks and inline code get monospace and a
background at the same time, since they had the same problem. Markdown column alignment
is preserved by merging with the attributes markdown-it already set.

### Fixed: the session name was never read

The notification printed `session:` and `session id:` with the same value, because the
code called `sessionManager.getName()` — which does not exist. The documented method is
`getSessionName()`, so the name was always undefined and fell back to the id. Naming a
session had no effect until now. The body also no longer repeats the id when a session is
unnamed.

### Fixed: the body collapsed onto one line

Reported after a live notification. The HTML part relied on `white-space: pre-wrap`
to preserve line breaks, and clients that sanitise inline styles - Outlook web does -
collapsed the whole body into a single line.

Newlines are now `<br>` in the markup, which survives sanitising. Structure belongs in
the markup, not in CSS.

### restart replaces the daemon process, not just its config

Found by testing short-id routing against a live daemon: the daemon was still running
the previous version, so it could not see `[pi:c05698]` and rejected the reply. A config
reload cannot swap running code, which means an updated package would also have kept
executing the old version after `pi update` until reboot.

- daemon: POST /shutdown, authenticated, acknowledges before exiting
- /mailbridge restart: stop the process, wait for the port, respawn through the
  supervisor, and report whether it came back

### Mail is now multipart: text plus HTML, and the HTML renders Markdown

The agent answers in Markdown, so the HTML part is rendered rather than escaped: the
reader sees headings, lists, tables, fenced code and clickable links instead of `**bold**`
and pipe tables.

Rendering is delegated to **markdown-it** (15.0.3) instead of the hand-rolled subset I
wrote first. The library earns its six small transitive dependencies:

- `html: false` escapes raw HTML by default, so there is no sanitiser to get wrong
- markdown-it's own `validateLink` refuses `javascript:`, `vbscript:` and `data:` hrefs
- `linkify` turns bare URLs into links, which is most of the value of a mail
- `breaks` keeps single newlines, matching how the body is written

The `--` signature block stays literal text (`<pre>`), because a line of `--` after text
is a setext heading underline and would swallow our metadata into an `<h2>`. It now
carries a top border so it reads as a divider rather than running into the answer.



### Multipart mail, so quoted history folds

Reported from a live reply: the quoted original did not fold away, it showed as raw
repeated text. Cause: every message was text/plain only, and clients collapse quoted
history only when the original is HTML (they quote as a <blockquote> they can fold).

- core/html.ts: escapeHtml + textToHtml, using white-space:pre-wrap so the layout
  survives without converting every newline to <br>
- mailer sends text and html, so it is multipart/alternative: plain clients and the
  scanner still get the text part unchanged
- escaping is mandatory, not cosmetic: the body is model output and an unescaped
  interpolation would inject markup into the recipient's mail client. Tested with
  <img onerror=...> and a javascript: link.

### Shorter subject: a local route id instead of a signed blob

The subject carried a signed token whose length dominated the line, so a notification preview showed
almost nothing but base64. New mail now carries a six-hex local route id:

    before  [pi:AgGhxFPy_HFpjIlpyT-hoVJRP2HY.e2uUO7fw] pi: fix-login @ ybc-linux is waiting for you   (87)
    after   [pi:f913c9] pi: fix-login @ ybc-linux is waiting for you                                    (56)

- store/routes.ts: id -> {sessionId, device, expiry}, capped at 2000, atomic, expired
  entries pruned on write. Routing only; authorization is still allowlist + DMARC.
- Routing preference is now: short id, then signed token (mail already in flight),
  then the reply chain.
- ids are local, so a route minted on one machine does not resolve on another - the
  behaviour we already wanted, now with no base64 in the subject.

### Fixed: the notification never contained the agent's answer

Every settle email said "(the agent produced no text this turn)". The extension never
populated `lastAssistantText`, so the body - the whole reason to read the mail from a
phone - was a placeholder.

It now reads the current session branch: the last assistant message whose `text` parts
are non-empty, ignoring thinking and tool calls, plus a turn count. Answer text is
capped at 4000 characters with an explicit truncation note, so a long response cannot
turn into a 200-line email.

### Fixed: /mailbridge reported a stale config

The extension loaded config once at startup and every command reused that snapshot.
A config written by `--setup` from a shell - or any hand edit - was therefore invisible
to `/mailbridge check` and `/mailbridge smoke`, which would keep reporting the previous
account. Commands now re-read config first; it is a small synchronous file read.

### Fixed: replies from real mail clients were rejected as no-token

Found by replying to a live test mail from Outlook. The subject came back as RFC 2047
encoded-words in gb2312:

    =?gb2312?B?UmU6IFtwaTpleUp6...?= =?gb2312?Q?ease_reply_to_this?=

Headers are read raw on purpose - Authentication-Results must keep its order and
multiplicity - so nothing decoded them and the routing token was unreadable. Every
reply from a client that encodes a subject (any non-ASCII character, including a
Chinese session name or an em dash) was rejected as no-token.

- core/header-encoding.ts: RFC 2047 decoder for B and Q words, dropping whitespace
  between adjacent encoded words per section 6.2, with a charset fallback instead of
  a throw
- watcher: From and Subject are decoded after extraction; Authentication-Results
  stays raw and ordered
- TextDecoder handles gb2312/gbk via Node's full ICU, so no new dependency
- reply-parse: strip the Outlook mobile signature, which the live reply carried into
  the body

Proof: rewinding the cursor and rescanning the same message turned
rejected/no-token into persisted/reasons {} with the correct session id.

### Verified: QQ attaches Authentication-Results

Checked a live QQ mailbox: external mail carries `Authentication-Results` with
authserv-id `mx.qq.com`, so the DMARC gate works there and needs no disabling. Mail
sent from QQ to QQ carries no header at all (nothing to authenticate on the same
server), so a self-addressed test never exercises that path - documented, because it
is an easy way to reach a false conclusion.

### prime: start watching from now

The first scan walks the entire existing mailbox to look for a routing token. On a
personal inbox that is slow and reads mail that was never addressed to pi (nothing
is stored or marked seen, but it is fetched and parsed).

`--prime` / `/mailbridge prime` sets the UID cursor to the newest message without
fetching anything, so watching begins at the next arrival.

### NetEase family added; QQ has a 14-day wait

QQ Mail refuses to enable IMAP/SMTP for accounts younger than 14 days
('你的QQ邮箱激活时间不满14天'), which blocks a freshly created mailbox outright.
NetEase has no such rule - only SMS verification - so 163, 126, yeah.net and 188.com
are added to the built-in provider table as the immediate-use option.

### check: an empty app password is now a reported problem

Running `--check` on a freshly written QQ config printed "config ok" while
`mail.imap.password` was still empty - which sends the user straight into a
confusing smoke failure. It now reports, per side, that the password is missing and
names the 授权码, because that is the string QQ's UI shows. Exit 2 instead of 0.

### Costs: Entra ID Free is enough

Documented that no paid Entra license is required. App registration, device-code
and PKCE OAuth2, and delegated IMAP/SMTP/Graph scopes all run on **Entra ID Free**,
included with any Azure subscription or Microsoft 365 tenant. P1/P2 buy Conditional
Access, PIM and Identity Protection, none of which this package touches - so the
'Entra ID P2, one month free then $10.50/user/month' offer should be declined.

Also recorded what happens when the Azure free trial ends without upgrading: the
subscription expires, the directory and app registration survive, and OAuth keeps
working. Nothing here consumes Azure resources, so there is nothing to bill.

### Correction: the Developer Program sandbox is gated

The E5 sandbox is only granted to Visual Studio Professional/Enterprise
subscribers, ISV Success members, AI Cloud Partner participants and Premier/Unified
Support customers. A personal account that joins gets the learning resources and a
Graph tutorial and **no option to provision a sandbox** - which is exactly what the
dashboard shows. docs/OAUTH.md no longer presents it as a route; the Azure free
account is the only way to a tenant for a personal mailbox.

### Microsoft 365 work/school tenants

A developer-sandbox or work mailbox has no ISPDB entry and an arbitrary subdomain.
Discovery now recognises the `*.onmicrosoft.com` suffix and resolves it to the work
preset: imap outlook.office365.com:993, smtp smtp.office365.com:587 (note the
different host from consumer mail), and the organizations authority rather than
consumers. A dev tenant therefore offers two usable mailboxes with different
trade-offs, documented in docs/OAUTH.md.

### China trap: Azure China cannot authenticate global Outlook

`azure.cn` (Azure operated by 21Vianet) is a physically isolated sovereign cloud
with its own identity endpoints (`login.partner.microsoftonline.cn`). An app
registered there cannot authenticate against global Outlook.com, so the device
flow against `login.microsoftonline.com` fails. config now warns when
`oauth.issuer` points at a sovereign-cloud domain.

docs/OAUTH.md gains the concrete steps for getting a tenant with a personal
Hotmail — global Azure free account (creates a default directory) or the
Microsoft 365 Developer Program (free sandbox tenant, no credit card) — **corrected below: the sandbox is now gated** — and the
note that an MSA already attached to a tenant joins that tenant instead of
getting a fresh directory.

### China: QQ Mail, Foxmail, 163 and 126 built in

Google is unreachable in mainland China, so the Gmail recommendation does not
apply there. Those providers authenticate with an app-specific code (授权码) used as
a password, which needs no OAuth app at all.

- KNOWN_PROVIDERS gains qq.com, foxmail.com, 163.com, 126.com — all LOGIN, over
  implicit TLS — so discovery works even when the autoconfig service is blocked
- verified from imapflow's source that it sends the IMAP `ID` command whenever the
  server advertises it, which is what 163/126 require ("Unsafe Login" otherwise)
- docs/OAUTH.md gains a mainland-China section including the `dmarc-missing`
  fallback (`requireDmarcPass: false`) for providers that emit no
  Authentication-Results header

### Setup: Gmail defaults to an app password

Corrected a wrong recommendation. Gmail *OAuth* is harder than Outlook's, not
easier: mail scopes are restricted (app verification plus an annual CASA
assessment to publish) and a consent screen in Testing issues refresh tokens that
expire after 7 days. Gmail's genuine advantage is the app password, which Microsoft
retired.

- discover: Google now resolves to `LOGIN`, Microsoft stays `XOAUTH2`
- buildSetupConfig: an OAuth preset is attached only when `XOAUTH2` is the chosen
  mode, so a Gmail app-password config no longer ships a clientId nobody needs
- docs/OAUTH.md and the README provider matrix carry the measured comparison,
  including the caveat that Google could retire app passwords

### Docs: personal Outlook needs an Entra tenant

Corrected a misleading instruction. A new Hotmail address is a Microsoft account,
not a tenant; signing in to the Entra admin centre lands in the shared "Microsoft
Services" tenant and reports "account does not exist". Registering an app requires
a directory (free Azure signup, or a work tenant). docs/OAUTH.md now explains the
distinction, the three routes, and recommends Gmail for a dedicated pi mailbox —
which needs no tenant and avoids the personal-Outlook IMAP/SMTP refusals too.

### DMARC: trust the delivering relay, pin only when possible

`trustedAuthservId` is now optional. Unset means the **topmost**
`Authentication-Results` header is used — correct because headers are prepended,
so the final hop's verdict is first and a sender's forged header ends up beneath
it. Pinning still works and still fails closed when the id is absent.

This was a real blocker rather than a refinement: Microsoft's consumer relay emits
bare `Authentication-Results` headers with no authserv-id, so requiring a pin
rejected every genuine Hotmail reply. `--check` now reports it as a note instead of
a config failure.

### Setup robustness

- Built-in provider table for the Microsoft and Google families (hotmail.com,
  outlook.com, live.com, msn.com, gmail.com, googlemail.com) as a fallback when
  ISPDB is unreachable or has no entry. ISPDB still wins when it answers, so the
  published document stays authoritative.
- A domain with no dot (e.g. someone typing `you@hotmail`) is now named as such
  and given the exact fix, instead of a generic "no published mail settings".
- Trailing dots on the domain are stripped (`hotmail.com.` works).

### Setup

- `pi-mailbridge --setup <address> [--to <your-address>]`: discovers the
  provider's IMAP/SMTP endpoints, ports and TLS mode from Thunderbird's
  autoconfig database, infers `LOGIN` vs `XOAUTH2` from the advertised
  authentication, attaches the Microsoft/Google OAuth preset when it recognises
  the provider, and writes `config.json`. Refuses to clobber without `--force`.
- Single-mailbox mode is chosen automatically when `--to` equals the address.

### Device identity

An idle notification identifies the machine as well as the session, and the
route record carries the device so several machines can share one mailbox
without competing for the same reply. `device.name` defaults to the first label
of `os.hostname()`; override with config or `PI_MAILBRIDGE_DEVICE`.

### Works from any device

No app, account, relay or push service. Any client that can read the mailbox —
another PC, a laptop, a tablet, a phone, webmail in a browser — can continue a
session, because replies carry the same short routing id whichever device answers —
routing never depends on the sender's device.

### Dependency upgrades

- `openid-client` 6.8.9 added — device-code OAuth2 for any provider.
- `imapflow` 1.7.8 → **2.11.0** (major), `nodemailer` 9.1.1 → **10.5.0** (major),
  `mailparser` → 3.14.3.
- The watcher and mailer now reach the real clients through **explicit adapters**
  instead of `as unknown as` casts, so every call is checked against the library's
  actual signature and a future major bump fails the build rather than the daemon.
- Fixed as a direct result: `imapflow.search()` can return `false`/`undefined` for
  an empty result set. The old cast hid it, so a quiet mailbox would have thrown
  inside the scan. The adapter normalizes to `[]` and a test pins it.

### Fixed during development

- Loop guard treated `mail.to` (the human) as "self", rejecting every genuine
  reply. Now uses the pi account only.
- `stripQuoted` fell back to the raw body, which would have replayed the agent's
  own quoted output back at it. A fully-quoted reply now yields empty and is
  rejected as `empty-body`.
- Settle gate consulted "client exists" instead of the daemon's mode.

### Known gaps

- **Microsoft Graph transport.** Personal `outlook.com` can reject IMAP/SMTP
  OAuth2 at the server (`User is authenticated but not connected`,
  `SmtpClientAuthentication is disabled`). Graph (`/me/sendMail`, `messages/delta`)
  avoids SMTP entirely and is the correct fix; it is not implemented yet. Paid
  turnkey alternative: EmailEngine (self-hosted) or Nylas (hosted).
- Creating a new session from mail (deliberately out of scope: `ctx.newSession()`
  replaces the active session).
- MIME/S-MIME signing and encryption.
- Live-mailbox integration test (everything is hermetic today).
