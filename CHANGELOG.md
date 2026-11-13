# Changelog

## 0.1.0 — unreleased

### The daemon always exits when idle; no residency switch

(0.1.0 is unreleased, so removing a `/health` field does not bump `API_VERSION`: no client ever
saw protocol 1 with it. A released protocol would have needed the bump, per AGENTS.md.)

`daemon.exitWhenIdle` is gone, along with `PI_MAILBRIDGE_EXIT_WHEN_IDLE` and the `/health`
field that reported it. The design has one rule: the daemon is pi's child, it serves sessions,
and it stops when the last one has been quiet for `daemon.idleTimeoutSecs`. A "stay resident"
option only ever existed to work around systemd, and it invited the reading that a sessionless
daemon is useful - it is not: it scans but cannot deliver.

Idleness is measured from the daemon's own start until a session pings, then from the last ping.
So a hand-started daemon with no pi attached now exits one `daemon.idleTimeoutSecs` after it
starts; there is no supported way to keep it running on its own. The timeout's floor is 30 s
(three poll intervals), because a shorter one reaps the daemon between pings.

### The systemd unit is gone

It was never required, and framing it as a way to keep watching mail when nobody was at pi
contradicted the design: no session means no consumer, so a sessionless daemon scans for nobody.
Removed with it: the unit, its documentation, the `PI_MAILBRIDGE_DIR` variable it introduced, and
every "three things the unit cannot guess" instruction. If your environment cannot let pi own a
child (a sandbox, or a container whose process tree is replaced), there is now no supported way to
keep a daemon resident: it is pi's child and exits with the last session.

Feature-complete for the single-user, one-mailbox case. Exercised end to end against a live QQ
mailbox in both layouts (two addresses, and one address for both roles); personal Outlook was
tried and rejected IMAP/SMTP OAuth2 server-side, as docs/OAUTH.md describes. No automated
live-mailbox test exists.

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
`pi-mailbridge --check` both report it — and because a supervisor typically preflights with `--check`
as `ExecStartPre`, that combination stops the unit from starting rather than starting a
daemon that rejects every reply.

### A reply can no longer sit unscanned behind a silent IDLE

Live: a reply sat in INBOX for minutes while `/health` reported `imap: connected`. The daemon
only scanned on connect, on an IMAP `EXISTS` event, and on mode-on — and the provider stopped
pushing `EXISTS`. `daemon.scanIntervalSecs` (default 60, `0` disables) sweeps on a timer while
mode is on, and `/mailbridge status` now distinguishes "no mail yet — last checked …" from a
dead daemon. The smoke echo probe was fixed in the same pass: it finds the delivered copy by the stamped id
and retries instead of reading "the newest message" once (which reported a false alarm on a
live account), and it now classifies what actually survived — our marker, our `Message-ID`, or
neither (safe only with the Sent-folder read-back). It used to claim the `Message-ID` survived
without comparing it, which on QQ printed an assurance that was false.

### The reply chain can match providers that rewrite Message-ID

A live test against QQ showed our stamped `<uuid@qq.com>` replaced by `<tencent_…@qq.com>` on
delivery, with the human's reply referencing the tencent id. The reply-chain fallback matches
ids we recorded, so on such a provider it never matched and the subject tag was the only route.
Setting `mail.imap.sentFolder` makes the daemon read the just-sent copy and record the
delivered id too. `setup` writes that key for `qq.com` and `foxmail.com` — the one provider
measured doing this, and the one you cannot fix from the reply side. Elsewhere it stays opt-in.
The read-back is best-effort: six attempts over ~112 s, one short-lived IMAP connection per
notification, and a miss is logged rather than failing the send.

### A queued reply cannot be delivered against the wrong numbering

Pending records now carry the `UIDVALIDITY` they were scanned under. Records tagged with
another numbering are dropped on every connect, and untagged ones (written before the field
existed) on a detected renumbering — live, one of those was claimed in a new space and
delivered a different message's body. On an ordinary connect untagged records are kept, so an
upgrade does not discard a reply that was still waiting.

Daemon log lines carry a full UTC timestamp (`2026-11-12T16:56:56Z`), so lines from different
runs can be told apart — a live review had to read TCP counters to establish timing because the
log carried no dates. Note that an empty sweep still logs nothing, so the log cannot prove the
poll cadence; `/health`'s `lastScan.checkedAt` is the instrument for that. `/health` also
reports `registry` (the same number as `sessions`, which counts sessions with an **outstanding
decision request** — the `POST /register` registry — not connected clients; the raw payload read
wrong next to `clients: 2`). `/mailbridge status` shows *last checked* whenever the daemon has
checked more than a minute after the last scan that saw mail, so a poll loop that died at 10:05
is visible behind a scan at 10:00.

`/mailbridge status` distinguishes "no mail yet — last checked …" from a daemon that has never
scanned, and reports when the last scan that saw mail happened. `daemon.scanIntervalSecs` is
validated (`null`/negative/strings are refused rather than read as "0", which means off), and
`/reload` can now turn the sweep back on after it has been disabled.

`loadConfig` no longer throws or silently loses defaults on a null config section. Every
section (`daemon`, `mail`, `mail.imap`, `mail.smtp`, `security`, `notify`, `tuning`, `device`)
is repaired by filling the defaults underneath whatever survived, with a warning naming it, so
`{"mail": {"smtp": null}}` cannot throw and `{"notify": null}` cannot quietly disable settle
notifications. A *partial* section produced by the env merge is repaired the same way, which
matters because `{"daemon": null}` plus any daemon env var used to yield a daemon with no host
and no port.

### `prime` runs once, and refuses after that

Priming moves the UID cursor past everything already in the mailbox. That is a first-run
decision: the cursor is what makes mail visible, so moving it after the bridge has been watching
silently skips any reply that arrived unscanned (mode off, daemon down) — no ack, no `\Seen`, no
error, just a mail nobody answers. Both surfaces (`--prime` and `/mailbridge prime`) now refuse
once prime has run or the cursor has moved past mail, say which uid they are watching from, and point at `uid-cursor.json` for a
deliberate re-prime; `--prime` exits 2. The rule lives in `core/prime.ts` so the two cannot
disagree.

### `/afk` and `/back` are now `/mailbridge on` and `/mailbridge off`

Mode was two top-level commands in pi's global command namespace. `back` is generic enough to be
shadowed silently by another extension — pi resolves commands by first match and warns about
nothing — and neither name appeared in `/mailbridge help`. They are subcommands now, named for the mode they set, and the usage text lists them. Both still
work as a mail reply, except `/mailbridge on`: with the mode off nothing is scanned or drained, so
it can only be re-opened from the terminal. Nothing was published, so there is no alias to carry.

### A session settles before it lets go

Quitting pi inside `notify.debounceMs` of a settle used to drop the notification: the shutdown
handler cancelled the debounce and the `flush()` path had no caller. A one-shot run therefore
mailed nothing at all. Shutdown now flushes a pending settle before dropping the notifier; the
daemon outlives the session for the idle timeout, so the send can still land.

### The extension spawns the build, and a replacement checks what it got

The build shipped for `bin` and the unit, but the extension - the path `pi install` actually uses -
still resolved `src/daemon/main.ts` and spawned it with `--experimental-strip-types` from inside
`node_modules`, which Node refuses. It now resolves the compiled daemon through one pure function
(`daemon/script.ts`), preferring `dist/` whenever it exists, and both layouts (checkout, installed)
are unit-tested.

Replacement had two ways to lie: `/shutdown` answers before the listener closes, so an immediate
probe found the dying daemon and "reused" it - reporting success while the old protocol was still
served; and the reuse probe never looked at the protocol at all. The replacement now waits for the
port to stop answering (bounded), and `ensureDaemon` refuses to reuse a daemon on another protocol,
reporting `incompatible` so the caller replaces rather than adopts. `startRuntime` is unchanged in
spirit but a respawn that still speaks another protocol now latches and says "restart pi", instead
of killing the daemon once a minute forever.

A legacy state file is schema 1 by name (`LEGACY_SCHEMA`), not "whatever is current": mapping it to
`STATE_VERSION` would have labelled pre-versioning files as current and skipped their migration on
the day the constant moved. `checkStateVersion` also refuses an older file when no migration is
registered, so a version bump cannot ship without one.

### A protocol version, separate from the package version

The daemon and the extension now have a wire contract with its own number (`API_VERSION`, reported
as `apiVersion` on `/health`), and additive features are advertised as `capabilities`. Compatibility
is strict equality on the protocol - a mismatch replaces the daemon, never negotiates - while the
package version becomes diagnostic. Comparing package versions was the wrong knob: a harmless patch
bump would have restarted a working daemon, and the number would mean something different the day a
second client exists.

The files whose shape matters - `pending`, `journal`, `routes`, `threads`, `uid-cursor` - gained a
schema version (`v`) under the "refuse newer, migrate older" rule: a file
without one is schema 1 and is stamped on its next save; a file from a newer build is refused for
reading and writing. `mode.json` and the OAuth token cache are deliberately unversioned: both are
regenerable, and refusing to start over a cache would be worse than rebuilding it, with one clear message naming both versions, instead of having its
unrecognised records filtered out and the file rewritten without them.

### A session replaces a daemon left over from the previous build

`pi update` reloads the extension while the daemon keeps executing what it started with; it mints
and resolves routing ids from the old code, so replies after an upgrade could be rejected with the
cursor already past them. `/health` now carries the daemon's package version, and a session
compares it against its own once a minute: a different build (or a daemon from before the field
existed) is shut down and respawned. If this build cannot identify itself, nothing is killed. A replacement that cannot respawn no
longer stops the poll loop - it warns and retries - because the loop had been re-armed only while a
runner existed, and the replacement clears it.

### The package ships a build, because Node cannot strip types inside node_modules

`pi install npm:pi-mailbridge` was broken in a way no local test could see: the extension loads
through jiti (so TypeScript works), but the daemon it spawns ran `node --experimental-strip-types`
on `src/daemon/main.ts` from inside `node_modules`, and Node refuses that with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. The first pi session after a usable config existed then showed "daemon not reachable;
replies will not arrive" and a stack trace in `daemon.log` (install itself starts nothing). Every live test until now ran from a checkout,
where the path has no `node_modules` segment.

`npm run build` now emits `dist/` (tsc with `rewriteRelativeImportExtensions`, so the `.ts` import
specifiers become `.js`), `prepublishOnly` builds first, the tarball ships `dist`, and `bin`, the
spawned daemon run plain `node` against the compiled entry. A packaging test
copies the built package into a temporary `node_modules` and starts it, so this cannot regress.

### One daemon per state directory, whatever port it thinks it owns

The port was the only single-instance guard, and `daemon.port` is a documented knob (plus a
per-process env override). Two processes that disagreed about it could each start a daemon on one
state directory — two IMAP watchers, and stores whose read-modify-write has no cross-process
lock, so a reply could be lost and another injected twice. A `daemon.lock` in the state directory
now decides: a live holder makes the newcomer exit 0, a dead one is stolen, and SIGTERM releases
it. A spawned daemon is also told the port the session probed (`--port`), so it cannot bind a
different one and leave the session reporting "unreachable".

### Smaller fixes from the same review

- `/mailbridge on` with no runtime (the "copy config.example.json yourself" path) now builds one
  before reporting ON; previously it wrote `mode.json`, toasted "ON", and nothing could mail or
  deliver until `setup`/`restart`.
- `daemon.idleTimeoutSecs` below 5 and `security.tokenTtlHours` below 1 are refused with a
  warning. A zero timeout made the daemon exit a second after the first ping (looks like a crash
  loop); a NaN TTL made every route immortal.
- a journal written before `UIDVALIDITY` tagging no longer answers "already seen" once the live
  numbering is known — after a renumbering that could skip a new message whose UID was reused.
- a failed `/reload` restores the token provider as well as the config.
- a failing `tokenCommand` no longer puts its full argv and stderr into `daemon.log` and
  `--check` output; the args are what `describeCommand()` hides because they may hold a secret.
- expiry under queue pressure releases the dead session's decision slot, like the UID-space drop
  already did.
- `daemon.log` is created 0600 (an older build left it 0644, and it carries addresses and session
  names) and rotates once at 5 MB.
- docs: `/mailbridge on` by mail cannot re-open the channel (`off` is one-way, as §6a said);
  stopping the daemon while pi is open is undone by the poll tick's respawn; a refused command is
  still delivered to the agent as text, so "cannot reconfigure" was too strong; §4 now lists what
  the bearer token actually authorises, including discarding queued replies.

### Notifications attach the files they link to

A notification could inline images but a link to any other local file stayed a relative href no
mail client can follow. Links to local files are attachments now, named with the file's own
basename and listed in the body as "[attached: report.pdf]". Caps are up and provider-aware: images 5 MB,
files 15 MB each, 18 MB in total and 10 attachments by default - chosen because base64 costs
about a third and Gmail and Outlook.com both stop at 25 MB. `notify.maxAttachmentMb` raises the
budget where the provider allows more (QQ: 50 MB per message). A file type outside the allowlist (`id_rsa`, `.env`) is
refused rather than mailed, because the path comes from model output.

### `off` by mail stops the batch it arrived in

A drain takes a snapshot of pending records and delivers them in order. If the human's
`/mailbridge off` reply was in that snapshot, the records behind it were still claimed and
injected — the opposite of "leave me alone at the terminal". The runner re-checks the mode
between records now: the switch is delivered and acked, everything behind it stays pending and
unseen for the next `/mailbridge on`.

### Commands by mail, dispatched here

A command that throws is reported and the delivery is still acked: `deliveries` retries an inject
failure on every poll tick, so re-running a failing `/mailbridge smoke` would have re-sent a real
mail every ten seconds.

A reply whose entire body is one command line now runs that command:
`/mailbridge [on|off|status|check|smoke|help]`. `setup`, `auth`, `restart` and `prime` are refused and
delivered as text, and anything longer than a single line is a message (so a quoted
`/mailbridge off` cannot change your mode). Dispatch happens in `core/mail-command.ts`, not through pi's
`expandPromptTemplates`, because pi's dispatcher returns `void`: a caller cannot distinguish a
command that ran from a prompt pi rejected, and this package acks and marks `\Seen` after the
call returns. Sending mail through that dispatcher would have consumed a reply the agent never
saw — which is also the failure this replaces, since pi can reject a plain-text prompt the same
way (no model, expired credentials, compaction).

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
- `journal` — capped acked-UID set for durable replay protection, tagged with the mailbox
  UIDVALIDITY so a renumbered folder is not treated as already-acked.
- `mode-store` — global on/off, default off, atomic replace.
- `registry` — one outstanding decision per session, TTL + hard cap.

### Extension

- Wires **`agent_settled` and never `agent_end`** (a test pins this).
- Mode mirror seeded from the daemon and refreshed each poll.
- `/mailbridge`; `request_decision`, `notify_user`.
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
the headless path, sharing `core/setup.ts`, `core/smoke.ts` and
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

the idle rule is
disabled until the first client has ever pinged, so an externally started daemon never
exits merely because pi is closed.

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
  `ensureDaemon`, re-creates the client/notifier/runner, and resumes draining. Throttled to one
  attempt a minute so a dead daemon cannot cause a spawn storm. (A respawn starts the compiled
  `dist/` already on disk; nothing is built at runtime — `prepublishOnly` builds once and
  `pi install` receives that.)
- `session_start` and the recovery path share one `startRuntime()`, so they cannot drift.
- `/health` now reports `clients` and `lastPingAgoMs`, which is what
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
