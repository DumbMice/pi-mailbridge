# pi-mailbridge

Drive your Pi coding-agent sessions from your mailbox.

Your agent reaches a decision you can't answer from your desk. It emails you.
You reply — from your phone, a tablet, another PC, a webmail tab, anything that
can read the mailbox. That exact session continues.

- **Any device with email works.** No app, no account, no relay, no push service.
  If it can read mail — a second laptop, a work desktop, a tablet, a phone, a
  browser — it can drive the session.
- **Every notification names the device *and* the session**, so with several
  machines running pi you can tell at a glance which one is asking.
- **One mailbox connection per machine.** A small local daemon owns a single
  IMAP IDLE connection; every Pi session is a thin client. N sessions, one
  watcher, no polling race.
- **Reply = resume.** The reply is injected into the session that sent the mail,
  as a follow-up, so it queues correctly if a run is still in flight.
- **Explicit, not inferred.** `/afk` turns email mode on; `/back` turns it off.
  No focus heuristics, no "probably idle".
- **Crash-safe.** Mail is only marked seen *after* the reply is injected and
  acked. A crash leaves it unseen and durable, so nothing is lost.

## What an idle notification looks like

When an agent settles, you get one email that identifies both the machine and the
session, because that is all a notification preview shows:

```
Subject: [pi:<signed token>] pi: fix-login @ dev-box-7 is waiting for you

Done: the failing test passes now.

--
device: dev-box-7
session: fix-login
session id: 01a1c453-f2fc-7169-8c89-69c93fa1a152
project: /home/ybc/Work/proj
turns: 3

Reply above this line to continue the session.
```

Reply from **any device**: a tablet on the sofa, your work laptop, a second PC in
another room, a webmail client on a machine that has never run pi. The reply is
routed by the signed token, not by the sender's device.

With more than one machine, each daemon has its own `device.name`; a reply is only
claimed by the daemon whose device the token names, so two machines sharing one
mailbox never fight over the same message.

## Security first

This package makes your inbox a control channel for an agent that can run shell
commands. **Read [docs/SECURITY.md](./docs/SECURITY.md) before installing.**

Gate order, all fail-closed: sender allowlist → pinned DMARC (`authserv-id`
must match) → HMAC-signed routing token with a TTL → durable replay journal. The
token routes; it never authorizes. Prefer a dedicated account or a filtered
folder, never a mailbox that receives untrusted mail.

## Install

```bash
pi install npm:pi-mailbridge
cp ./config.example.json ~/.config/pi-mailbridge/config.json   # then edit
```

In pi:

```
/mailbridge          # status: daemon, mode, session, mailbox, allowlist, pending
/afk                 # email mode on
/back                # email mode off
```

The daemon can be started by the extension on demand. To keep it resident:

```bash
mkdir -p ~/.config/systemd/user
cp docs/systemd/pi-mailbridge.service ~/.config/systemd/user/
systemctl --user enable --now pi-mailbridge
```

## Commands

| Command | Effect |
| --- | --- |
| `/afk` | Email mode on: decisions mail you and end the turn |
| `/back` | Email mode off: decisions ask in the terminal |
| `/mailbridge` | Status: daemon health, mode, session, secret, mailbox, allowlist, pending replies |

## Agent tools

| Tool | Behaviour |
| --- | --- |
| `request_decision` | Emails a question with optional options and a recommendation, then ends the turn. One outstanding decision per session. |
| `notify_user` | One-way update. Does not reserve a slot and does not wait. |

Both refuse cleanly when email mode is off or the daemon is unreachable.

## Configuration

`~/.config/pi-mailbridge/config.json`, merged over built-in defaults, then
`PI_MAILBRIDGE_*` environment variables. Full example:
[`config.example.json`](./config.example.json).

| Key | Default | Meaning |
| --- | --- | --- |
| `mail.imap.host` / `.port` / `.secure` | — / 993 / true | IMAP server |
| `mail.imap.user` | — | pi's mailbox account |
| `mail.imap.password` | — | app password when `authType` is `LOGIN` |
| `mail.imap.folder` | `INBOX` | watched folder |
| `mail.imap.authType` | `LOGIN` | `LOGIN` or `XOAUTH2` |
| `mail.imap.tokenCommand` | `[]` | argv whose stdout is an access token (XOAUTH2) |
| `mail.smtp.host` / `.port` / `.secure` | — / 465 / true | SMTP server |
| `mail.smtp.user` | — | also the `From:` and the loop-guard identity |
| `mail.smtp.password` | — | app password when `authType` is `LOGIN` |
| `mail.smtp.authType` | `LOGIN` | `LOGIN` or `XOAUTH2` |
| `mail.smtp.tokenCommand` | `[]` | argv whose stdout is an access token (XOAUTH2) |
| `mail.to` | — | **your** address: where notifications go |
| `device.name` | first label of `os.hostname()` | machine name shown in every notification and carried in the routing token |
| `security.allowFrom` | `[]` | senders allowed to command the agent; empty denies all |
| `security.requireDmarcPass` | `true` | require a DMARC pass from the pinned relay |
| `security.trustedAuthservId` | — | the only `Authentication-Results` host that is trusted |
| `security.tokenTtlHours` | `720` | routing-token lifetime; stale replies are refused |
| `daemon.host` / `.port` | `127.0.0.1` / `4177` | loopback HTTP for the extension; the port is the instance lock |
| `notify.onSettled` | `true` | email when an agent settles |
| `notify.debounceMs` | `10000` | quiet period before the settle mail |
| `notify.notifyOnAborted` | `false` | also mail when you hit Escape |
| `notify.subject` | `"pi"` | unused by the settle mail; reserved for custom notifications |
| `tuning.idleRenewMs` | `1500000` | IDLE renew interval (keep under ~29 min) |
| `tuning.autoIdleDelayMs` | `1000` | quiet period before imapflow re-issues IDLE |
| `tuning.backoffInitialMs` / `.backoffMaxMs` | `1000` / `60000` | reconnect backoff bounds |

### Outlook / Hotmail

Microsoft retired SMTP basic auth for `outlook.com`/`hotmail.com` on
2024-09-16, so an app password **does not work**. Use `XOAUTH2` with a token
command — any argv that prints an access token on stdout:

```json
"authType": "XOAUTH2",
"tokenCommand": ["ortie", "token", "show", "-a", "outlook"]
```

A failing token command disables OAuth2 for the session rather than spawning a
failing process on every scan.

## How it works

```
IMAP IDLE ──► scan (UID cursor) ──► authorize ──► verify token ──► persist
                                                                     │
                     pi session ◄── claim ◄── SSE/poll ◄─────────────┘
                          │
                          └──► inject as followUp ──► ack ──► \Seen + journal
```

One daemon per machine owns the mailbox; sessions never touch IMAP. Details and
the failure-mode table: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). Module
map and the port from `opencode-afk`: [docs/MAPPING.md](./docs/MAPPING.md).

## Status

`0.1.0` — feature-complete for the single-user, one-mailbox case, not yet
battle-tested against a live mailbox. 189 hermetic tests cover the token, authz,
scan pipeline, stores, daemon HTTP surface, lifecycle, extension surface, tools,
attachments and the full end-to-end loop.

Not implemented: creating a *new* session from mail (`ctx.newSession()` replaces
the active session, which is a different architecture), and MIME/S-MIME.

## License

MIT
