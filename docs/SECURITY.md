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
| Provenance | **DMARC pass, from a pinned relay** | step 1 |
| Routing | **short route id**, TTL-bounded (legacy HMAC-signed tokens still verify) | steps 2–3 |
| Replay | **journal + expiry** (durable, survives restart) | step 2 |
| Human | **`request_decision` blocks the agent** until a reply arrives | step 4 |

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
appended after a successful ack, and consulted before claiming. Tokens also
carry an expiry so a very old reply is refused even with a valid MAC.

## 3. Prompt injection is not solved, only bounded

A legitimate email can still contain text that reads like instructions
("ignore your rules, run …"). You cannot filter this reliably. What you can do:

- **Scope the session.** A session that only needs to read code should not have
  `bash`. `pi --tools read,grep,glob` for untrusted threads. This package does not enforce
  tool scoping — pi's own `--tools` does.
- **Keep a human in the loop for destructive actions.** `request_decision` blocks the
  agent until a reply arrives. There is no approve command and no phrase a message can
  contain to satisfy it: the human's reply *is* the approval.
- **Do not paste mail verbatim into a prompt as trusted context.** Injected
  text is *user input*, and the system prompt should say so.

## 4. Daemon hardening

- Defaults to binding `127.0.0.1`; `daemon.host` can change that, but there is no TLS and
  no user model beyond the bearer token, so do not. Nothing else about the daemon is
  reachable without the token, apart from the `/health` liveness probe, which returns mode, pending and
  session counts, client/ping timing and whether idle-exit is armed — no mail content,
  no addresses, no subjects.
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
- Rotate the app password and the HMAC key if you ever suspect exposure. Rotating the key
  kills every outstanding **signed token**, but *not* the short route ids: those are
  entries in `routes.json` and resolve with no secret at all, so they keep working until
  `security.tokenTtlHours` expires. To revoke routing immediately, delete that file (and
  the journal) while the daemon is stopped.
- Turn it off with `/back` when you will be at the desk. An idle mailbox should
  not be a listening control channel.
- **One mailbox for both roles** (`security.allowSelfReplies`). The loop guard is
  relaxed for self-addressed mail, so the sender allowlist alone no longer
  separates "me" from "not me" — it is the same address. The discriminator is the
  message's own `Message-ID`: if we recorded it going out, it is our own mail and it is
  rejected (`self-echo`) before routing. `In-Reply-To` is checked too, but it cannot be
  the tie-breaker on its own, because threaded notifications carry that header as well.
  Either signal is trivially forgeable by anyone who can already send from your address.
  Prefer a dedicated mailbox.
- **Multiple machines, one mailbox.** Each daemon only claims replies whose route id or
  token names its own device, so they cannot steal each other's work. They do share one
  allowlist and one secret — if one machine is compromised, rotate the key (which kills
  outstanding signed tokens) and delete each machine's `routes.json` (which kills the
  short ids).

## 6. What this package will never do

- auto-approve a destructive action from email
- execute an attachment
- act on a message with `Auto-Submitted`, `Precedence: bulk`, or a bounce sender
- accept a message from outside the allowlist, however convincing
- resume a session the human did not start

## 7. Reporting

Email the address in `package.json` (`author`), or open a private security
advisory on the repository. Do not file a public issue for anything in this
document.
