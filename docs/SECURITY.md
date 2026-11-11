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
| Authenticity | **HMAC-signed token**, TTL-bounded | steps 2–3 |
| Replay | **journal + expiry** (durable, survives restart) | step 2 |
| Scope | per-session tool restriction | step 4 |
| Human | decisions require explicit one-shot approval phrases | step 4 |

### 2.1 DMARC — pin the header, do not just read it

`Authentication-Results` is an ordinary, append-only, sender-writable header.
A message can arrive with a forged `Authentication-Results` from the attacker's
own infrastructure *and* the real one added by your provider.

Rules:

1. Only accept an `Authentication-Results` header whose `authserv-id` matches
   the configured `security.trustedAuthservId`.
2. Never accept an AR header that appears *below* a `Received` header you
   cannot attribute to your provider.
3. Treat DMARC pass as **necessary, not sufficient** — it authenticates the
   sending domain, not the authority to command your agent. A allowlisted
   sender whose account is compromised still passes DMARC.

### 2.2 The token is routing, not authorization

A valid `[pi:…]` token proves the subject was minted by this installation. It
does **not** prove the message came from you. Anyone who replies to one of your
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
  `bash`. `pi --tools read,grep,glob` for untrusted threads.
- **Never auto-approve.** `request_decision` / `!approve` flows exist so a human
  is in the loop for destructive actions.
- **Do not paste mail verbatim into a prompt as trusted context.** Injected
  text is *user input*, and the system prompt should say so.

## 4. Daemon hardening

- Binds `127.0.0.1` only. Never expose it; there is no TLS and no user model.
- Bearer token from `secret.key`, mode `0600`, created first-writer-wins,
  compared in constant time.
- Body cap 1 MB; registry cap 10 000; SSE client cap 100.
- `EADDRINUSE` on start is treated as "already running" — an attacker cannot
  displace a running daemon by racing the port, because the loser exits.
- The token never appears in logs, error strings, or the notification email.

## 5. Mailbox hygiene

- Prefer a **dedicated account or a filtered folder**. Do not point this at a
  mailbox where you receive untrusted mail.
- Do not let the tool **delete** mail on a shared account; mark `\Seen` and move
  to a folder.
- Rotate the app password and the HMAC key if you ever suspect exposure; rotating
  the key invalidates every outstanding token.
- Turn it off with `/back` when you will be at the desk. An idle mailbox should
  not be a listening control channel.
- **One mailbox for both roles** (`security.allowSelfReplies`). The loop guard is
  relaxed for self-addressed mail, so the sender allowlist alone no longer
  separates "me" from "not me" — it is the same address. The tie-breaker is
  `In-Reply-To`: only a reply is accepted, and that header is trivially forgeable
  by anyone who can already send from your address. Prefer a dedicated mailbox.
- **Multiple machines, one mailbox.** Each daemon only claims replies whose token
  names its own device, so they cannot steal each other's work. They do share one
  allowlist and one secret — if one machine is compromised, rotate the key and
  every outstanding token dies with it.

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
