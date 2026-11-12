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
                │ SSE: delivery│   SSE: mode
      ┌─────────▼────┐   ┌─────▼────────┐
      │ pi session A │   │ pi session B │   thin clients (in-process extensions)
      │ claim → ack  │   │ claim → ack  │
      └──────────────┘   └──────────────┘
```

**One watcher, many sessions.** The daemon owns the single IMAP connection; pi
sessions are thin clients that connect over loopback SSE. This is the same
topology as `opencode-afk` and it is the reason multi-session works: there is no
N-way race for mailbox state, because only one process reads the mailbox.

The extension (inside pi) never touches IMAP or SMTP for *reading*. It sends
mail through the daemon, and receives replies from it.

## 2. Delivery pipeline (the part that must not lose mail)

```
new UID ──► fetch ──► parse body ──► verify token ──► persist pending (durable)
                                                        │
                                                        ▼
                                              broadcast `delivery` (SSE)
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

Loopback only. Every request carries `Authorization: Bearer <token>` from
`$XDG_STATE_HOME/pi-mailbridge/secret.key`; comparison is constant-time.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness probe |
| GET | `/events` | SSE: `delivery`, `mode` |
| GET | `/pending` | catch-up list for reconnecting clients |
| POST | `/claim` | `{uid, sessionId, instanceId}` — atomic claim |
| POST | `/ack` | claimant-only → `\Seen` + journal + prune |
| POST | `/register` | reserve a session's single outstanding decision |
| DELETE | `/register` | release the reservation |
| GET/POST | `/mode` | global `on`/`off`, persisted + broadcast |
| POST | `/send` | send mail (the daemon owns SMTP config) |

Bounds: body ≤ 1 MB, registry ≤ 10 000 entries, SSE clients ≤ 100. A second
daemon start fails with `EADDRINUSE` and exits quietly — that *is* the
single-instance lock.

## 4. Routing token

Subject format:

```
[pi:f913c9] <human subject>
```

A six-hex-character **local route id**, resolved from `store/routes.ts`. It replaced a
signed token (~88 characters) that made every subject unreadable in a notification
preview. Signed tokens still verify, so mail already in flight keeps working.

The id is a lookup key, not a credential: an unknown id resolves to nothing, and
authorization remains the sender allowlist plus pinned DMARC (§2.2). Because routes are
local, an id minted on one machine simply does not resolve on another — which is the
desired behaviour, not an error.

- Signed with the shared secret, so a reply to a forged subject is rejected.
- Carries the **device that minted it**. A daemon only persists a delivery whose
  token names its own device, so several machines sharing one mailbox never hold
  stale copies of each other's replies. A token with no device claim is accepted
  (single-device installs, and tokens minted before devices were tracked).
- Replies keep the token because mail clients prefix — `Re: [pi:…] …`. Parsing
  tolerates `Re:`, `RE:`, `AW:`, `Re[2]:`.
- Expiry bounds replay: a token older than `tokenTtlHours` is refused even if
  the MAC is valid.

### What identifies a reply

An inbound message is matched to a session by the first rule that succeeds:

1. **Signed subject token** — `[pi:<payload>.<mac>]`, matched anywhere in the
   subject, so `Re:` / `RE:` / `Aw:` / `Re[2]:` prefixes are irrelevant. It
   carries `sessionId`, expiry and the minting device, and is HMAC-signed.
2. **Reply chain** — `In-Reply-To`, or any id in `References`, equals a Message-ID
   recorded in `store/threads.ts`. This is what survives a human editing the
   subject or a client rewriting it. The chain is searched newest-first, so the
   closest ancestor wins.
3. Otherwise the message is rejected (`no-token`) and left unread.

The token is authoritative because it is signed; the chain is unsigned and only a
convenience. `security.allowHeaderThreading: false` disables rule 2.

The token is **not** authentication. It routes; it does not authorize. See
SECURITY.md.

### Device identity

`device.name` defaults to the first label of `os.hostname()` and appears in every
notification subject and body. It exists for two reasons:

1. **Human routing.** With pi on a laptop, a desktop and a build box, "which
   machine is asking?" must be answerable from a notification preview.
2. **Machine routing.** Two daemons watching one mailbox would otherwise both
   fetch every reply. The device claim lets the non-owner skip it at scan time
   (`other-device`), without persisting and without marking it seen.

## 5. Modes

`/afk` → mode `on`: decisions mail the human and end the turn.
`/back` → mode `off`: decisions use the terminal as usual.

Mode is global per machine (one human, one mailbox) and persisted, so a daemon
restart does not silently re-enable mailing. It is pushed to every connected
session over SSE.

## 6. Deliberately out of scope: creating sessions

`ctx.newSession()` **replaces** the active session in-process, and only a
command handler can call it — which is why `opencode-afk` needs a two-phase
`create`→`resume` dance and why `pi-wechat-assistant` gates on `ctx.isIdle()`.

pi-mailbridge does not create or switch sessions. It notifies about, and
resumes, sessions the human already started. Anything else needs a different
process topology (an RPC supervisor owning `pi --mode rpc` children).

## 7. Failure modes

| Failure | Behaviour |
| --- | --- |
| IMAP drops | exponential backoff 1 s → 60 s; IDLE renews at 25 min |
| Daemon dies | sessions keep working; extension reconnects; missed mail recovered from `/pending` |
| Session exits before ack | mail stays unseen, pending durable → redelivered |
| SMTP fails | decision is *not* reserved as outstanding; error surfaces to the tool |
| Mailbox full of non-token mail | cursor advances, nothing is claimed, no state grows |
| Clock skew | token expiry is a bound, not a gate; ±minutes is tolerated |

## 8. Module layout

```
src/
  extension.ts          pi entry: tools, commands, events, own SSE client   [skeleton]
  core/
    config.ts           layered config + env overrides                     [done]
    mailer.ts           nodemailer transport (password | XOAUTH2)          [todo]
    authz.ts            loop → robot → allowlist → pinned DMARC            [done]
    reply-parse.ts      quote stripping, address + AR-header pinning        [done]
    token.ts            HMAC sign/verify                                   [done]
    messages.ts         user-facing strings                                [todo]
  daemon/
    main.ts             HTTP + SSE + lock + lifecycle                      [skeleton]
    watcher.ts          imapflow IDLE, renew, backoff                      [todo]
    process.ts          UID-cursor scan → authorize → parse → persist     [done]
  store/
    paths.ts            XDG state dir                                      [done]
    secret.ts           shared HMAC/bearer key, atomic 0600                [done]
    pending-store.ts    durable pending + claim/ack state machine          [done]
    uid-cursor.ts       monotonic cursor                                   [done]
    journal.ts          acked UIDs — durable replay protection             [done]
    mode-store.ts       on/off                                             [todo]
    registry.ts         one outstanding decision per session               [todo]
test/                   hermetic unit tests; no IMAP, no SMTP, no sockets
```

`MailSource` (in `daemon/process.ts`) is the seam: `watcher.ts` implements it over
imapflow, tests implement it over an in-memory fixture. That is why the whole
pipeline is testable without a mailbox.
```
