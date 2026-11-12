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
 now recognises the  suffix and resolves it to the work
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
Microsoft 365 Developer Program (free sandbox tenant, no credit card) — and the
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
