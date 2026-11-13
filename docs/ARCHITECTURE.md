# ARCHITECTURE

## 1. Shape

```
                  one mailbox
                       │
        ┌──────────────▼───────────────┐
        │  daemon (one per machine)    │   IMAP IDLE, 1 connection
        │  port 4177, token-auth'd     │   UID-cursor scan
        │                              │
        │  pending store (durable)     │
        │  registry (1 decision/sess)  │
        └───────┬──────────────┬───────┘
                │ poll: /pending│   poll: /mode
      ┌─────────▼────┐   ┌─────▼────────┐
      │ pi session A │   │ pi session B │   thin clients (in-process extensions)
      │ claim → ack  │   │ claim → ack  │
      └──────────────┘   └──────────────┘
```

**One watcher, many sessions.** The daemon owns the single IMAP connection (plus one short-lived read-back per notification when
`mail.imap.sentFolder` is set); pi
sessions are thin clients over loopback HTTP: they poll `/pending` and replay it, which
needs no reconnect logic because replay is idempotent. (`/events` also offers SSE for a
push client; nothing uses it today.) This is the same
topology as `opencode-afk` and it is the reason multi-session works: there is no
N-way race for mailbox state, because only one process reads the mailbox.

The extension (inside pi) never touches IMAP or SMTP on the delivery path: it sends mail
through the daemon and receives replies from it. The one exception is the `/mailbridge
smoke` diagnostic, which sends a real mail and then opens the folder over its own
short-lived connection to prove both sides work (and `/mailbridge prime`, which opens one
to move the cursor without reading anything).

## 2. Delivery pipeline (the part that must not lose mail)

```
new UID ──► fetch ──► self-echo marker ──► authorize ──► route (id / token / chain) ──► persist pending (durable)
                                                        │
                                                        ▼
                                     waiting for the next poll tick
                                                        │
                              ┌─────────────────────────┴──────────┐
                              │ every session sees it; only the    │
                              │ one whose session id matches claims│
                              └─────────────────────────┬──────────┘
                                                        ▼
                                          pi.sendUserMessage(body, followUp)
                                                        │
                                                        ▼
                                       ack ──► \Seen + journal append
```

Invariants:

- **Nothing is marked `\Seen` before the ack.** A crash at any earlier point
  leaves mail unseen and the pending entry durable → retried, not lost.
- **The cursor only advances after persist**, never after broadcast.
- **At-least-once, deduped by journal.** A duplicated delivery is caught by the
  journal (UID already acked), not by timing.
- **The claim is short-lived.** It prevents two sessions with the same id (an
  old and new runtime during `/reload`) from injecting twice.

## 3. Daemon HTTP surface

Loopback only by default (`daemon.host`). Every request except `/health` carries
`Authorization: Bearer <token>` from
`$XDG_STATE_HOME/pi-mailbridge/secret.key`; comparison is constant-time.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness probe; **unauthenticated** by design (mode, pending/client counts, the decision-registry size, emitted as both `sessions` and `registry` — sessions *with an outstanding decision*, not live sessions; live ones are `clients` — ping timing, idle-exit armed, SSE subscribers, the last scan's summary, `configLoadedAt`; no content, no addresses) |
| GET | `/events` | SSE: `delivery`, `mode` (no client uses it; sessions poll) |
| GET | `/pending` | the delivery channel: polled every 10 s, and replayed on reconnect |
| POST | `/claim` | `{uid, instanceId, uidValidity?}` — atomic claim; refused as `stale-space` when the record belongs to another UID space |
| POST | `/ack` | `{uid, instanceId, uidValidity?}` — claimant-only; refused as `stale-space` when the record (or the caller) belongs to another UID space; journals in the **record's** space, then `\Seen` + prune |
| POST | `/register` | reserve a session's single outstanding decision |
| POST | `/bye` | a session is leaving; the daemon exits when the last one goes |
| POST | `/ping` | heartbeat, the other half of the idle exit |
| DELETE | `/register` | release the reservation |
| GET/POST | `/mode` | global `on`/`off`, persisted + broadcast |
| POST | `/send` | send mail (the daemon owns SMTP config) |
| POST | `/reload` | re-read config: stop the watcher, reload, redial. On failure it restores the previous config and warns; a refused connect returns `ok` with a warning |
| POST | `/shutdown` | stop the daemon (used by the restart path) |

Bounds: body ≤ 1 MB, registry ≤ 10 000 entries, SSE clients ≤ 100. A second
daemon start fails with `EADDRINUSE` and exits quietly — that *is* the
single-instance lock.

## 4. Routing token

Subject format:

```
[pi:f913c9] <human subject>
```

A six- to eight-hex-character **local route id**, resolved from `store/routes.ts`. It replaced a
signed token (39 characters, in an 87-character subject) that made every subject unreadable in a notification
preview. Signed tokens still verify, so mail already in flight keeps working.

The id is a lookup key, not a credential: an unknown id resolves to nothing, and
authorization remains the sender allowlist plus DMARC (SECURITY.md §2.2) — except in the
single-mailbox layout, where DMARC is off (README, One mailbox or two?). Because routes are
local, an id minted on one machine simply does not resolve on another — which is the
desired behaviour, not an error.

- A local lookup key, not a signature: an id that was never minted here resolves to
  nothing. (Legacy tokens *are* HMAC-signed, and are verified when they appear.)
- Records the **device that minted it**. A daemon only persists a delivery whose
  route (or chain entry, or legacy token) names its own device, so several machines
  sharing one mailbox never hold stale copies of each other's replies. A record with
  no device claim is accepted (single-device installs).
- Replies keep the id because mail clients prefix — `Re: [pi:…] …`. Parsing
  tolerates `Re:`, `RE:`, `AW:`, `Re[2]:`.
- Expiry bounds replay: an id older than `tokenTtlHours` resolves to nothing, and the
  reply chain ages out on the same clock.

### What identifies a reply

An inbound message is matched to a session by the first rule that succeeds:

1. **Short route id** — `[pi:f913c9]`, matched anywhere in the subject, so `Re:` /
   `RE:` / `Aw:` / `Re[2]:` prefixes are irrelevant. This is what every new
   notification carries. It is a lookup key into this machine's `store/routes.ts`, not a
   signature: an id minted elsewhere (or expired) resolves to nothing, and then rule 2 is
   tried.
2. **Legacy signed token** — `[pi:<payload>.<mac>]`, a 39-character HMAC-signed payload
   carrying `sessionId`, expiry and the minting device. Still verified so mail sent before
   the short id keeps working; no longer minted.
3. **Reply chain** — `In-Reply-To`, or any id in `References`, equals a Message-ID
   recorded in `store/threads.ts`. This is what survives a human editing the
   subject or a client rewriting it. The chain is searched newest-first, so the
   closest ancestor wins, and entries age out with `security.tokenTtlHours` so the chain
   cannot route mail forever.
   Some providers replace the `Message-ID` we stamp (QQ rewrites it to `<tencent_…@qq.com>`),
   so the id the reply actually references is one we never minted. With
   `mail.imap.sentFolder` set — which `setup` writes automatically for `qq.com` and
   `foxmail.com`, so a QQ install holds this extra connection by default — the daemon reads the
   just-sent copy back and records the
   delivered id as well. Best-effort: it retries for about two minutes — six attempts totalling 112 s (the provider appends the
   copy asynchronously) and matches on the `X-Pi-Mailbridge-Id` header we stamp, so it can only
   ever record the copy of that exact notification. A capture in flight when the daemon stops
   is lost, and that notification falls back to the subject id.
4. Otherwise the message is rejected (`no-token`) and left unread - the cursor has moved
   past it, so the retry is a new reply, not an edited subject.

None of these is authentication: they route, they do not authorize. Authorization is the
allowlist plus DMARC (off in the single-mailbox layout), and it happens before any of this
(§2). A signed token is not
stronger than a short id for routing purposes — the signature stops someone *predicting*
an id, but guessing is pointless when any unresolvable id simply falls through to no
route. `security.allowHeaderThreading: false` disables rule 3 only.

The token is **not** authentication. It routes; it does not authorize. See
SECURITY.md.

### Device identity

`device.name` defaults to the first label of `os.hostname()`. It appears in every **settle**
notification's subject and body, and is stored on the routing record so the daemon that
minted the reply can claim it. (The two agent tools carry the routing id and their own
text, not a device line.) It exists for two reasons:

1. **Human routing.** With pi on a laptop, a desktop and a build box, "which
   machine is asking?" must be answerable from a notification preview.
2. **Machine routing.** Two daemons watching one mailbox would otherwise both
   fetch every reply. The device claim lets the non-owner skip it at scan time
   (`other-device`), without persisting and without marking it seen.

### UIDVALIDITY, and what a renumbered mailbox does

UIDs are only meaningful within one `UIDVALIDITY`. If a provider recreates, migrates or
"repairs" a folder, UIDs restart at 1 - and a persisted high-water cursor then skips every
future message, with `examined 0` as the only symptom.

The daemon records the mailbox's `UIDVALIDITY` beside the cursor and compares it on every
connect. On a change it resets the cursor (except the first observation after an upgrade, unless the
cursor has fallen outside the new range) and ignores `journal.json` entries from the old
numbering (they describe a space that no longer exists). Queued records tagged with another numbering are dropped
on **every** connect, not only on a change - a crash between the cursor write and the drop
would otherwise leave a record that nothing can claim and nothing ever removes. Records with
*no* space tag predate that field: an ordinary connect keeps them (an upgrade must not discard
a queued reply), but a detected renumbering drops them too, because they cannot be shown to
belong to the new numbering - live, one was claimed there and delivered a different message's
body.
The cost is explicit: **a renumbering can re-deliver replies that were acked inside the
route TTL**, because the only durable dedupe is UID-based. Nothing is lost; recent mail may
arrive once more. The daemon logs the change, the reset and how many records it dropped.

## 5. Modes

`/mailbridge on` → mode `on`: decisions mail the human and end the turn.
`/mailbridge off` → mode `off`: decisions use the terminal as usual. A drain re-checks the mode
between records, so an `off` arriving as a reply stops the batch it came in — the records behind
it stay pending and unseen until the mode goes back on.

Mode is global per machine (one human, one mailbox) and persisted, so a daemon
restart does not silently re-enable mailing. Each session reads it on its poll tick (the
daemon also broadcasts it to any `/events` subscriber, of which there are none today).

## 6. Deliberately out of scope: creating sessions

`ctx.newSession()` **replaces** the active session in-process, and only a
command handler can call it — which is why `opencode-afk` needs a two-phase
`create`→`resume` dance and why `pi-wechat-assistant` gates on `ctx.isIdle()`.

pi-mailbridge does not create or switch sessions. It notifies about, and
resumes, sessions the human already started. Anything else needs a different
process topology (an RPC supervisor owning `pi --mode rpc` children).

## 6a. Lifetime: singleton, and it stops when you do

**Who starts it.** Whichever comes first: the extension on `session_start`; `/mailbridge
setup` or `/mailbridge restart` when the session has no runtime yet; a supervisor (the
systemd unit); or the poll tick, which respawns a daemon that exited while the session was
still alive. It is spawned *detached* so it outlives the process that started it and can
serve other sessions. When a session finds one already running, it compares `/health`'s
`configLoadedAt` with `config.json`'s mtime and issues `/reload` if the file is newer, so a
hand-edited config is not served stale. Two limits worth knowing: the comparison is mtime
based, so an edit that preserves the mtime (`cp -p`, a restore) is not noticed until
`smoke`/`restart`; and only the daemon re-reads — the session's own copy of the config
refreshes on the next `/mailbridge` command or pi restart.

**Singleton.** `daemon.lock` in the state directory is the lock, with the owner's pid inside: a
live holder makes the newcomer exit 0, and a file left by a crash is stolen by an atomic rename
(not an unlink-then-retake, which lets two starters both win). The listening port is a second
guard, for a foreign listener - a bind failure also exits 0. `ensureDaemon()` then probes `/health` and reuses the winner.

**Two versions, two clocks.** `/health` carries both: `apiVersion` (the wire contract, `API_VERSION`)
and `version` (the package build, diagnostic). A session replaces a daemon whose `apiVersion`
differs - never negotiates - and additive wire changes are gated by `capabilities` rather than a
protocol bump. State files carry `v` (`STATE_VERSION`): absent means schema 1 and is read and
stamped on the next save, older is migrated on read, newer is refused for reading *and* writing.

**It starts when a session needs it.** `pi install` runs nothing. On `session_start`, if the config
is usable, the extension probes `/health` and spawns the daemon detached when nothing answers; in-pi
`/mailbridge setup` does the same after writing the config, while headless `--setup` only writes
the file. The daemon is not tied to the mode: `on`/`off` gate scanning and delivery, not existence.

**A supervisor is respected.** `exitWhenIdle: false` in `/health` marks a daemon that something
else owns (the shipped unit). A session will not shut such a daemon down for a protocol mismatch:
it would exit 0, `Restart=on-failure` would leave it down, and the spawned replacement would not
belong to the unit. It asks the operator to restart it where it is managed.

**It stops when the last session does.** Every session pings `/ping` on its poll tick
(10s) and sends `/bye` on `session_shutdown`. Once no ping has arrived for
`daemon.idleTimeoutSecs` (default 120), the daemon exits. This is deliberate:

- an updated package cannot leave an orphaned process running old code - the exact trap
  that cost an evening, where a daemon started at 15:09 kept serving after several code
  changes because nothing could replace it. Idle exit alone is not enough while a session is
  open, so `/health` reports the daemon's version and a session replaces a daemon from another
  build (throttled to once a minute);
- no session means no consumer: settle notifications are sent *by* a session, and no
  session can claim a pending reply;
- a daemon with no sessions still fetches and parses every incoming message looking for
  a routing tag. Stopping it stops reading a mailbox nothing will use.

Mail that arrives while it is down is not lost: the **catch-up scan** runs on the next
start, from the stored UID cursor.

Set `daemon.exitWhenIdle: false` when a supervisor owns the process instead - a systemd
unit wants a resident daemon, and the unit in `docs/systemd/` does exactly that. The
idle rule is also disabled until the first client has ever pinged, so a
systemd-started daemon never exits just because pi happens to be closed.

## 7. Failure modes

| Failure | Behaviour |
| --- | --- |
| IMAP drops | exponential backoff 1 s → 60 s; IDLE renews at 25 min |
| IDLE `EXISTS` never fires | a catch-up scan runs every `daemon.scanIntervalSecs` (default 60, `0` disables) while mode is on and the watcher is healthy — observed live after a reply sat unscanned |
| Daemon dies | sessions keep working; extension reconnects; missed mail recovered from `/pending` |
| Session exits before ack | mail stays unseen, pending durable → redelivered |
| SMTP fails | decision is *not* reserved as outstanding; error surfaces to the tool |
| Mailbox full of non-token mail | cursor advances, nothing is claimed, no state grows |
| Clock skew | expiry is compared against the local clock (`expiresAt <= now`), so a clock more than a TTL **ahead** refuses fresh ids, and a clock **behind** keeps expired ones alive |

## 8. Module layout

```
src/
  extension.ts          pi entry: tools, commands, polling client, session lifecycle
  core/
    attachments.ts      image/markdown attachment rendering
    authz.ts            loop/bounce → robot → allowlist → DMARC (off for one mailbox)
    commands.ts         /mailbridge parsing + usage text
    config.ts           layered config, env overrides, type validation
    config-freshness.ts  is the daemon's config older than the file?
    deliveries.ts       claim → inject → ack, serialized per process
    discover.ts         account autodiscovery
    header-encoding.ts  RFC 2047 decode/encode
    html.ts             text → HTML with quoted-history folding
    inline-images.ts    local images → cid: parts; linked files → attachments (inside the project)
    mailer.ts           nodemailer transport (password | XOAUTH2), headers
    mail-command.ts     a reply that is a command → the safe subset, else text
    prime.ts            "watch from now on" - first run only, guarded by the cursor
    markdown.ts         notifications render as markdown
    oauth*.ts           device-code + OpenID flows, one-retry token provider
    reply-parse.ts      quote stripping, address + AR-header pinning
    settle.ts           idle debounce, turn-settled notification
    status.ts           scan summary → the lines /mailbridge status prints
    version.ts          this build's version, and when a daemon must be replaced
    sent-index.ts       record the Message-ID the provider actually delivered
    setup.ts            first-run scaffolding
    smoke.ts            end-to-end send-and-read-back check
    token.ts            HMAC sign/verify, subjects
    token-source.ts     XOAUTH2 command tokens
  daemon/
    api.ts              the wire contract: API_VERSION, capabilities, endpoint list
    imapflow.ts         imapflow adapter
    main.ts             CLI + lifecycle
    process.ts          UID-cursor scan → authorize → route → parse → persist
    scan-queue.ts       one scan at a time; bursts coalesce into a follow-up
    script.ts           which daemon entry to spawn: the build when one exists
    source-proxy.ts     the MailSource the daemon really uses: live watcher + UIDVALIDITY
    service.ts          the HTTP surface: /health /pending /claim /ack /send /events …
    spawn.ts            ensureDaemon, single-instance
    watcher.ts          imapflow IDLE, renew, backoff
  store/
    journal.ts          acked UIDs — durable replay protection
    mode-store.ts       on/off
    oauth-store.ts      refresh tokens, 0600
    paths.ts            XDG dirs
    pending-store.ts    durable pending + claim/ack state machine
    registry.ts         one outstanding decision per session
    schema.ts           on-disk schema version: refuse newer, migrate older
    routes.ts           short routing ids, TTL
    secret.ts           shared HMAC/bearer key, atomic 0600
    threads.ts          outbound Message-IDs: threading + reply chain
    uid-cursor.ts       cursor + UID space; resets when the mailbox is renumbered
test/                   hermetic unit tests; no IMAP, no SMTP, no sockets
```

`/events` (SSE) exists on the daemon for push clients; the extension currently polls
`/pending` every few seconds instead, because replaying it is idempotent and needs no
reconnect logic.

`MailSource` (in `daemon/process.ts`) is the seam: `watcher.ts` implements it over
imapflow, tests implement it over an in-memory fixture. That is why the whole
pipeline is testable without a mailbox.
