# Changelog

## 0.1.0 — unreleased

Feature-complete for the single-user, one-mailbox case. Not yet validated against
a live mailbox.

### Core

- `core/token.ts` — HMAC-signed routing tokens (`[pi:<payload>.<mac>]`) with TTL,
  constant-time verification, prefix-tolerant subject extraction, and an
  optional **device claim** so replies route to the machine that owns the session.
- `core/authz.ts` — fail-closed chain: loop guard (pi account) → machine-generated
  → allowlist (empty denies all) → DMARC pinned to `trustedAuthservId`.
- `core/reply-parse.ts` — quote stripping that cuts at the first recognisable
  boundary, addr-spec normalization, auto-generated detection,
  `findTrustedAuthResults` (topmost matching `authserv-id` only).
- `core/attachments.ts` — MIME allowlist, 4 files / 1 MB caps, reasons for every
  drop; images become `ImageContent`, text is inlined.
- `core/mailer.ts` — SMTP send, `LOGIN` and `XOAUTH2`, injectable transport.
- `core/oauth.ts` — token from an argv command (argc-safe, `shell:false`), cached
  until TTL, one refresh on 401, disabled after a failing command.
- `core/settle.ts` — `agent_settled`-only notifier, debounced, abort-aware,
  token-stamped subject naming the **device and session** (`pi: fix-login @ dev-box-7
  is waiting for you`), body with device/session id/project/turns/last text.
- `core/deliveries.ts` — claim → inject → ack runner; never acks a failed
  injection; absorbs replays after a failed ack.

### Daemon

- `daemon/process.ts` — UID-cursor scan → authorize → verify token → strip quotes
  → filter attachments → persist → advance. Ordering is the correctness property.
- `daemon/watcher.ts` — IMAP IDLE over an injectable client factory; renews under
  the ~29 min cutoff; bounded backoff; `start()` never throws on a dead server.
- `daemon/service.ts` — `/health`, `/events` (SSE), `/pending`, `/claim`, `/ack`,
  `/register`, `/mode`, `/send`; constant-time bearer auth; bounded bodies and
  streams; ack journals before removing the record.
- `daemon/spawn.ts` — `probeHealth`, `ensureDaemon` (detached, unref'd), typed
  client.
- `daemon/main.ts` — server first, then catch-up scan, then watcher; SIGTERM
  handlers registered before dialling; `--check` (exit 2 config / 3 auth) and
  `--print-token`.

### Stores

- `pending-store` — durable deliveries with exclusive claim, same-instance
  re-claim, abandoned-claim TTL, claimant-only ack.
- `uid-cursor` — monotonic, atomic, corrupt-tolerant.
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

A reply is identified by the first rule that succeeds: the **signed subject
token**, then the **reply chain** (`In-Reply-To` / `References` matched against
Message-IDs recorded at send time in `store/threads.ts`), then rejected as
`no-token` and left unread. The chain fallback means editing the subject no longer
loses a reply; `security.allowHeaderThreading: false` disables it.

### Device identity

An idle notification identifies the machine as well as the session, and the
routing token carries the device so several machines can share one mailbox
without competing for the same reply. `device.name` defaults to the first label
of `os.hostname()`; override with config or `PI_MAILBRIDGE_DEVICE`.

### Works from any device

No app, account, relay or push service. Any client that can read the mailbox —
another PC, a laptop, a tablet, a phone, webmail in a browser — can continue a
session, because replies are routed by the signed token rather than by the
sender's device.

### Fixed during development

- Loop guard treated `mail.to` (the human) as "self", rejecting every genuine
  reply. Now uses the pi account only.
- `stripQuoted` fell back to the raw body, which would have replayed the agent's
  own quoted output back at it. A fully-quoted reply now yields empty and is
  rejected as `empty-body`.
- Settle gate consulted "client exists" instead of the daemon's mode.

### Known gaps

- Creating a new session from mail (deliberately out of scope: `ctx.newSession()`
  replaces the active session).
- MIME/S-MIME signing and encryption.
- Live-mailbox integration test (everything is hermetic today).
