# SECURITY

**This package turns your inbox into a control channel for a shell-capable agent.**
Read this before installing.

## 1. Threat model

If an attacker can get one message into the watched mailbox, they may be able to
make your agent do work — with whatever tools that session has. The agent has
`bash`, `edit`, and `write`. That is remote code execution with extra steps.

Sequence:

1. message lands in the inbox (spoofed, forwarded, or from a compromised account)
2. it carries a plausible `[pi:…]` token (guessed, replayed, or copied from a
   mail you forwarded)
3. the daemon parses it, a session claims it, `pi.sendUserMessage` injects it
4. the agent treats it as you speaking

Every control below exists to break one link in that chain.

## 2. Defence in depth — all layers, not a subset

| Layer | Control | Breaks |
| --- | --- | --- |
| Envelope | **Sender allowlist**, exact `addr-spec` match after RFC 5322 parsing | step 1 |
| Provenance | **DMARC pass** from the authenticated relay (`security.requireDmarcPass`, pinned to `trustedAuthservId` when set) | step 1 |
| Routing | **short route id**, TTL-bounded (legacy HMAC-signed tokens still verify) | steps 2–3 |
| Replay | **journal + expiry** (durable, survives restart) | step 2 |
| Human | **`request_decision` asks and ends the turn**; only a reply resumes it | step 4 |

### 2.1 DMARC — trust the delivering relay's header

`Authentication-Results` is an ordinary, append-only, sender-writable header. A
message can arrive with a forged `Authentication-Results` from the attacker's own
infrastructure *and* the real one your provider added.

What makes that safe is header ordering: headers are **prepended** as a message
traverses relays, so the **topmost** `Authentication-Results` is the one the final
hop — your provider — wrote on delivery. A sender's forged header necessarily ends
up *below* it.

Rules:

1. Read the **topmost** `Authentication-Results` header and require `dmarc=pass`
   in it.
2. Optionally pin it harder: setting `security.trustedAuthservId` means only a
   header bearing that `authserv-id` is considered, and its absence **fails
   closed** rather than falling back.
3. Do **not** pin an authserv-id for Microsoft consumer accounts: the outlook.com
   relay emits bare headers with no authserv-id at all
   (`Authentication-Results: spf=pass …; dmarc=pass …`), so a pinned value would
   reject every genuine reply. Leave it unset there.
4. Treat DMARC pass as **necessary, not sufficient** — it authenticates the
   sending domain, not the authority to command your agent. An allowlisted sender
   whose account is compromised still passes DMARC.

### 2.2 The routing tag is not authorization

A valid `[pi:…]` tag proves the subject was minted by this installation — nothing
more. New notifications carry a short local route id (`[pi:f913c9]`); older ones carry
a signed token, and both are accepted. Neither proves the message came from you. Anyone who replies to one of your
notification emails (or forwards it) can carry the token into the mailbox.

That is why token verification is *never* the only gate — the allowlist and
DMARC come first, and the token only routes.

### 2.3 Replay protection must be durable

An in-memory "seen UIDs" set dies with the daemon. The journal is a file,
appended after a successful ack and consulted at scan time, so an acked mail is never
offered again. Routing ids, signed tokens and the reply chain all carry an expiry, so a
very old reply is not routed even with a valid id or MAC.

## 3. Prompt injection is not solved, only bounded

A legitimate email can still contain text that reads like instructions
("ignore your rules, run …"). You cannot filter this reliably. What you can do:

- **Scope the session.** A session that only needs to read code should not have
  `bash`. `pi --tools read,grep,glob` for untrusted threads. This package does not enforce
  tool scoping — pi's own `--tools` does.
- **Keep a human in the loop for destructive actions.** `request_decision` sends the
  question and ends the turn; nothing resumes the session except a reply. There is no
  approve command and no phrase a message can contain to satisfy it: the human's reply *is*
  the approval. This is a convention the model follows, not an enforced gate - a model that
  ignores the tool can keep working, which is why tool scoping matters.
- **Do not paste mail verbatim into a prompt as trusted context.** Injected
  text is *user input*, and the system prompt should say so.

## 4. Daemon hardening

- Defaults to binding `127.0.0.1`; `daemon.host` can change that, but there is no TLS and
  no user model beyond the bearer token, so do not. Nothing else about the daemon is
  reachable without the token, apart from the `/health` liveness probe. That returns mode,
  pending/session/client counts, ping timing, whether idle-exit is armed, the last scan's
  reason *counts*, and the config file's mtime — no mail content, no addresses, no subjects.
- Bearer token from `secret.key`, mode `0600`, created first-writer-wins,
  compared in constant time.
- Body cap 1 MB; registry cap 10 000; SSE client cap 100.
- `EADDRINUSE` on start is treated as "already running" — an attacker cannot
  displace a running daemon by racing the port, because the loser exits.
- The token never appears in logs, error strings, or the notification email.

## 5. Mailbox hygiene

- Prefer a **dedicated account or a filtered folder**. Do not point this at a
  mailbox where you receive untrusted mail.
- The tool marks a delivered message `\Seen` and journals it. It never deletes or moves
  mail, so a shared account keeps its history.
- Rotate the app password and the HMAC key if you ever suspect exposure, and restart the
  daemon afterwards: it caches the bearer token at startup, so a rotation without a restart
  makes every poll 401 until you do. Rotating the key
  kills every outstanding **signed token**, but *not* the short route ids: those are
  entries in `routes.json` and resolve with no secret at all, so they keep working until
  `security.tokenTtlHours` expires. Rotating the key does not stop delivery on its own.
  To revoke, stop the daemon and clear the state directory
  (`${XDG_STATE_HOME:-~/.local/state}/pi-mailbridge`):
  - `routes.json` — short ids. Resolve with no secret.
  - `threads.json` — the reply chain. Resolves recorded Message-IDs with no secret.
  - `pending.json` — **already-accepted replies waiting for a session.** Deleting the two
    routing stores stops new mail being routed *by id or chain*, but anything persisted
    before is still delivered on the next drain - and a legacy token still resolves until
    it expires or you rotate the key. If the session is compromised, this is the queue
    that matters.
  - `journal.json` — only the ack dedupe. Clearing it re-opens replay of already-acked
    mail, so prefer leaving it unless you also cleared the mailbox.
  Secrets (`secret.key`, `oauth.json`) live beside them; rotating those is covered above.
- Turn it off with `/back` when you will be at the desk: while mode is off the daemon
  does not scan and the extension does not claim or inject, so the mailbox is not a
  listening control channel in either direction. Replies that arrive meanwhile stay in the
  mailbox and are processed when you `/afk` again — which also means turning it back on can
  deliver a burst. To stop entirely, stop the daemon (`systemctl --user stop pi-mailbridge`,
  or let it exit: it quits ~120 s after the last pi session stops pinging).
- **One mailbox for both roles** (`security.allowSelfReplies`). The loop guard is
  relaxed for self-addressed mail, so the sender allowlist alone no longer
  separates "me" from "not me" — it is the same address. The discriminator is the
  message's own `Message-ID`: if we recorded it going out, it is our own mail and it is
  rejected (`self-echo`) before routing. Every notification also carries an
  `X-Pi-Mailbridge: notification` header, and inbound scanning refuses that marker outright —
  so the guard does not depend on the id having been recorded, nor on the transport
  returning one. `In-Reply-To` is checked too, but it cannot be the tie-breaker on its own,
  because threaded notifications carry that header as well. All of these are forgeable by
  anyone who can already send from your address; they exist to stop loops, not attackers.
  Prefer a dedicated mailbox.
- **Multiple machines, one mailbox.** Each daemon only claims replies whose route id, token
  or chain entry names its own device, so they cannot steal each other's work. They share
  the allowlist (one config each), but **each machine has its own `secret.key`** — it is a
  local file, never synced through the mailbox. So there is no "the key" to rotate: rotate
  the compromised machine's, clear its state directory as described above (`routes.json`,
  `threads.json`, `pending.json`), and review the others separately.

## 6. What this package will never do

- auto-approve a destructive action from email
- execute an attachment
- act on a message with `Auto-Submitted`, `Precedence: bulk`, or a bounce sender
- accept a message from outside the allowlist, however convincing
- resume a session the human did not start

## 7. Reporting

Open a private security advisory on the repository (`repository` in `package.json`).
Do not file a public issue for anything in this document.
