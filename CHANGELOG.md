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

### In-pi commands

`/mailbridge` now takes subcommands, so the whole user-facing flow is inside pi:
`setup`, `check`, `auth`, `smoke`, `restart`, plus the existing status. Only the
daemon itself stays a process (it must outlive pi); its CLI entry is documented as
the headless/systemd path, sharing `core/setup.ts`, `core/smoke.ts` and
`core/token-source.ts` with the commands so behaviour cannot drift.

- daemon: `POST /reload` re-reads config and restarts the watcher, so `setup` and
  `auth` take effect without killing anything by hand.
- fixed: the extension resolved the daemon script with `URL.pathname` instead of
  `fileURLToPath`, which mangles paths containing spaces or non-ASCII.
- `/mailbridge check` now warns when `oauth` is configured but neither account
  uses `XOAUTH2`, which would otherwise be silently ignored.

### Setup

- `pi-mailbridge --setup <address> [--to <your-address>]`: discovers the
  provider's IMAP/SMTP endpoints, ports and TLS mode from Thunderbird's
  autoconfig database, infers `LOGIN` vs `XOAUTH2` from the advertised
  authentication, attaches the Microsoft/Google OAuth preset when it recognises
  the provider, and writes `config.json`. Refuses to clobber without `--force`.
- Single-mailbox mode is chosen automatically when `--to` equals the address.

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
