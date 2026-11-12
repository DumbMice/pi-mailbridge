# pi-mailbridge

Drive your Pi coding-agent sessions from your mailbox.

Your agent reaches a decision you can't answer from your desk. It emails you.
You reply — from your phone, a tablet, another PC, a webmail tab, anything that
can read the mailbox. That exact session continues.

- **Any device with email works.** No app, no account, no relay, no push service.
  If it can read mail — a second laptop, a work desktop, a tablet, a phone, a
  browser — it can drive the session.
- **Settle mails name the device *and* the session**, so with several machines running pi
  you can tell at a glance which one is asking. (The two agent tools — `request_decision`,
  `notify_user` — carry the routing id and the question, not the device line.) The agent's answer
  is rendered from Markdown, so headings, lists, tables, code and links look like a real
  email instead of raw syntax.
- **One mailbox connection per machine.** A small local daemon owns a single
  IMAP IDLE connection; every Pi session is a thin client. (`smoke`, `prime` and — when
  `mail.imap.sentFolder` is set — one short-lived read-back per notification are the
  deliberate exceptions.) N sessions, one
  watcher, no polling race.
- **Reply = resume.** The reply is injected into the session that sent the mail,
  as a follow-up, so it queues correctly if a run is still in flight. Reply with a
  screenshot or a log file instead of prose and it still counts: images and text
  attachments (up to 4 files / 1 MB) arrive as content blocks, not as a broken path.
- **Explicit, not inferred.** `/afk` turns email mode on; `/back` turns it off. Off means
  off in both directions: no notifications, and replies are not claimed or injected until
  you turn it back on (they wait in the mailbox).
  No focus heuristics, no "probably idle".
- **Crash-safe.** Mail is only marked seen *after* the reply is injected and
  acked. A crash leaves it unseen and durable, so nothing is lost.

## What an idle notification looks like

When an agent settles, you get one email that identifies both the machine and the
session, because that is all a notification preview shows:

```
Subject: [pi:f913c9] pi: fix-login @ dev-box-7 is waiting for you

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
routed by the short id in the subject, not by the sender's device.

With more than one machine, each daemon has its own `device.name`; a reply is only
claimed by the daemon whose device the route names, so two machines sharing one
mailbox never fight over the same message.

## One mailbox or two?

Two layouts work. Pick before you start, because it changes the allowlist.

**A. Dedicated mailbox (recommended).** pi gets its own address; your personal
address receives notifications and sends replies.

```
mail.imap.user / mail.smtp.user = pi@example.com      # pi's mailbox
mail.to                          = you@example.com     # you
security.allowFrom               = ["you@example.com"]
security.allowSelfReplies        = false               # the default
```

Isolation is real: a compromised pi mailbox is not your personal inbox, and the
loop guard stays strict.

**B. One mailbox (single personal account).** pi's mailbox *is* your address, so
notifications land in your inbox and you reply from the same address.

```
mail.imap.user / mail.smtp.user = you@qq.com
mail.to                          = you@qq.com
security.allowFrom               = ["you@qq.com"]
security.allowSelfReplies        = true      # required, or every reply is a "self" loop
security.requireDmarcPass        = false     # see below; /mailbridge setup sets this for you
```

Three things make this shape safe, and they are worth knowing because they constrain
how you reply:

1. **A marker header.** Every notification carries `X-Pi-Mailbridge: notification`, and
   inbound scanning refuses that marker before anything else. That is what stops pi
   re-ingesting its own mail.
2. **Reply evidence is mandatory.** A message from your own address is only considered
   at all when it carries `In-Reply-To` or `References` — which every reply has, and which our
   own notifications now carry too, so the marker and registry below are what actually
   separate them. **In this layout, Reply (or Forward-then-Reply) is the only supported
   way in.** A freshly composed mail from your address, even with the `[pi:…]` tag in the
   subject, is rejected as `self-echo`: the tag advice below applies to layout A.
3. **The outbound registry.** The scanner also compares the message's own `Message-ID`
   with the ids it recorded when sending, so a copy of our own mail is recognised even if
   the marker was stripped.

**DMARC cannot work here, and that is not a loophole to leave open by accident.** A
message from your address to the same address is submitted and delivered by your own
provider; some providers (QQ is one) add no `Authentication-Results` header at all for
such mail. Requiring one rejects every genuine reply, so `/mailbridge setup` writes
`requireDmarcPass: false` when the two addresses match and says so.

Be clear about what that costs: **DMARC is what would stop someone forging your address.**
With it off, a message that says `From: you@qq.com` is treated as you by the allowlist — and
the reply-evidence gate adds little, because anyone can set `In-Reply-To`. What actually
keeps a stranger out is **routing**: they would need a live `[pi:…]` route id (six hex,
local, 30-day TTL) or a recorded Message-ID from one of our notifications. Neither is
guessable. So the shape is safe against opportunists, not against someone who has read one of
your notifications. If you know your provider stamps `Authentication-Results` on self-mail,
set this back to `true`.

Point layout B at a mailbox you would not mind an agent reading, or prime it before your
first `/afk` (below). The isolation of layout A is real, and this layout gives it up.

Once configured, prove it without pi:

```bash
pi-mailbridge --smoke     # sends one real mail, then opens the folder and counts
```

## How a reply is identified

A reply is matched to a session by the **first rule that succeeds**:

| # | Rule | Survives | Notes |
| --- | --- | --- | --- |
| 1 | **Short route id in the subject** — `[pi:f913c9]`, matched anywhere in the subject | subject intact | What every new notification carries. A *lookup key in this machine's route table*, not a credential: an id that was never minted here resolves to nothing. TTL-bounded. `Re:`, `RE:`, `Aw:`, `Re[2]:` prefixes are fine because the id is not anchored. |
| 2 | **Legacy signed token** — `[pi:<payload>.<mac>]` | subject intact | Still verified (HMAC, TTL-bounded) so mail sent before the short id keeps working. New notifications no longer use it. |
| 3 | **The reply chain** — `In-Reply-To`, or any id in `References`, equals a Message-ID we recorded | subject edited, rewritten or purged | The id is recorded when the notification is sent, kept for the last 2,000 sends and aged out with `security.tokenTtlHours`. |
| 4 | None of the above | — | Rejected as `no-token`. The mail stays unread, but the cursor has passed it, so "retry" means replying again — editing the old subject is not re-read. |

Every rule is routing only. Authorization happens before it: the sender allowlist, plus
DMARC (which is off in the single-mailbox layout — see One mailbox or two?).

What this means in practice:

- **Reply normally.** Mail clients set `In-Reply-To` or at least `References`, and either is
  accepted, so a plain Reply works.
- **Editing the subject is safe** — the chain still routes it, until the TTL expires. On a
  provider that rewrites `Message-ID` (QQ does; `setup` names `Sent Messages` for `qq.com` and
  `foxmail.com` automatically), set `mail.imap.sentFolder` or this fallback
  cannot match: the reply references an id the provider invented, not the one we recorded.
- **Composing a brand-new email** with no id and no reference is *not* identified. In
  layout A, use Reply or keep the `[pi:…]` tag in the subject; in layout B (one address)
  the tag alone is not enough — only Reply carries the threading headers that gate
  requires.
- **Quoted text is stripped** before the agent sees it, so leave the quote in.
- **A reply to a reply** still works: the chain carries the original id.

Rule 3 is a convenience fallback, not authentication — a Message-ID is only
visible to the recipient, but it is unsigned. Set
`security.allowHeaderThreading: false` to switch *that rule* off. It does not make the
subject id authoritative: rule 1 is an unsigned lookup key either way, so if you want
no unauthenticated path at all, treat the mailbox as trusted input and rely on the
allowlist and DMARC (DMARC is off in single-mailbox mode).

## A reply did not arrive

Every scan records why each message was refused, so this is answerable:

```
/mailbridge status
```

```
mode: on
imap: connected
last scan with mail: 14:02:11 — examined 2, kept 1, rejected 1
rejections: not-allowlisted 1
```

A non-zero `rejected` count means mail was seen and not accepted: dropped, deferred because
the queue is full, or an echo of our own notification (shown under `handled:` — in the
single-mailbox layout every notification you send comes back). The reasons say why.
`handled:` lines are the accepted paths (`route-miss` means the route id had expired or came
from another machine; if the reply still reached a session it routed by the token or chain), `attachments dropped:` is a
partial loss, and a full queue defers rather than discards. `examined 0` means nothing
arrived. If mode is off nothing is scanned at all, so this panel keeps showing the
*previous* scan — that is why `/mailbridge status` is not proof the channel is open; the
`mode:` line is.

| Reason | What it means | Fix |
| --- | --- | --- |
| `no-from` / `not-allowlisted` | the `From:` header is missing, or not an exact `addr-spec` in `security.allowFrom` | add the address you actually reply from |
| `allowlist-empty` | `security.allowFrom` is empty, which denies everything | set it |
| `dmarc-missing` / `dmarc-failed` | no `Authentication-Results` with `dmarc=pass` from a trusted relay | check `security.requireDmarcPass`; Microsoft consumer accounts need `trustedAuthservId` unset |
| `no-token` | the subject lost its `[pi:…]` id **and** nothing in `In-Reply-To`/`References` matched | reply to the original mail; in layout A you can also keep the tag |
| `route-miss` | the subject's id was expired or minted on another machine | nothing, if it routed by the chain — it appears under `handled:` |
| `other-device` | the notification was minted by another pi machine, or `device.name` changed since | reply to a notification from this machine, or restore the old `device.name` |
| `self` | single-mailbox mode, but `security.allowSelfReplies` is false, so a reply from your own address is refused | set it `true` (see One mailbox or two?) |
| `self-echo` | our own notification looping back (the marker header or the recorded Message-ID identified it) | nothing to do; this is the guard working |
| `expired` | a queued reply aged out (only under queue pressure) and was dropped | send it again; the original was never delivered |
| `no-reply-evidence` | a message from your own address with no `In-Reply-To`/`References` — a freshly composed mail, or a client that dropped threading headers | reply to the notification instead; in single-mailbox mode the threading header is required |
| `auto-generated` | a robot, a mailing list, or a bounce (`mailer-daemon`, `postmaster`, null sender) | nothing to do |
| `empty-body` | no prose and no usable attachment | — |
| `attachment-*` | an attachment was dropped (type, size, count) | see the reason suffix |
| `pending-full` | the queue holds 1 000 undelivered replies | start a session so they drain |
| `too-large` | the message exceeds 8 MiB and was refused before its body was downloaded | send a smaller one (attachments are capped at 4 files and 1 MB *in total*) |

Where to look:

| Path | What it holds |
| --- | --- |
| `$XDG_STATE_HOME/pi-mailbridge/daemon.log` (default `~/.local/state/…`); under systemd, `journalctl --user -u pi-mailbridge` | scan summaries, connect errors, rejected reasons |
| `…/uid-cursor.json` | last seen UID + the mailbox's UIDVALIDITY; a change resets it |
| `…/mode.json` | the global on/off state `/afk` and `/back` write |
| `…/pending.json` | accepted replies waiting for a session |
| `…/routes.json` | short routing ids (`security.tokenTtlHours`) |
| `…/threads.json` | outbound Message-IDs used for threading and the reply chain |
| `…/journal.json` | acked UIDs, tagged with the mailbox UIDVALIDITY (replay protection within one numbering) |

`/mailbridge check` validates config and that credentials are present; `/mailbridge smoke`
is what proves they work. If `imap:` says `disconnected`, the credentials or the host are wrong even though the daemon
itself is up — that is the state a revoked app password leaves you in.

If a reply seems not to have arrived, allow up to a minute: the daemon sweeps on a timer
(`daemon.scanIntervalSecs`, default 60) as well as on IMAP events, because a provider can stop
pushing them. `no mail yet — last checked …` means the daemon is polling and has seen nothing;
`mode: off` means it is not scanning at all.

If `/mailbridge status` says the daemon is unreachable, either this session never built a
client (it started before a config existed) or the daemon process is down. `/mailbridge
restart` fixes both — it starts the daemon and wires the session — so run it and check
again.

## Security first

This package makes your inbox a control channel for an agent that can run shell
commands. **Read [docs/SECURITY.md](./docs/SECURITY.md) before installing.**

Gate order, all fail-closed: **journal (already-seen UID) → our own marker header → size
ceiling → `From:` present → loop guard (our own address) → auto-generated/bounce → sender
allowlist → DMARC → our own Message-ID → routing → durable ack**. DMARC reads `Authentication-Results`; it is required by
`security.requireDmarcPass` (on by default) and pinned to an `authserv-id` only when
`security.trustedAuthservId` is set. Routing is a short `[pi:f913c9]` id, a legacy
HMAC-signed token, or the reply chain. Routing identifiers never authorize anything:
authorization is the allowlist and DMARC alone (DMARC is off in single-mailbox
mode). Prefer a dedicated account or a filtered
folder, never a mailbox that receives untrusted mail.

## Install

Requires **Node.js ≥ 22.6** — the package ships TypeScript and runs it with
`--experimental-strip-types`, which older Node does not have. (`pi`'s own Node is fine.)

```bash
pi install npm:pi-mailbridge
```

Then, inside pi:

```
/mailbridge setup pi-you@gmail.com to you@gmail.com   # discovers servers + writes a config
```

`setup` fetches the provider's published mail settings (Thunderbird's autoconfig
database) and the auth it requires, so you never hand-write hosts, ports or TLS
modes. It refuses to overwrite an existing config unless you add `force`.

`to` is optional and defaults to the pi address — which selects the **single-mailbox**
layout (allowlist relaxed, DMARC off). Pass both addresses, as above, unless that is
what you want; it is the choice described under One mailbox or two?

**Setup cannot invent your password.** It writes the account with an empty password and
tells you where the file is; add the credential there, then send one real mail:

```
~/.config/pi-mailbridge/config.json      # set mail.imap.password and mail.smtp.password
```

For Gmail, QQ, 163, Fastmail and most providers that value is an **app password**
(see [docs/OAUTH.md](./docs/OAUTH.md) for where each provider hides it). Microsoft
accounts are the exception — they need OAuth, which means registering an app *first*:

```
/mailbridge auth      # after oauth.clientId is real; see docs/OAUTH.md
```

`/mailbridge check` validates the config's shape and that credentials are *present* —
without connecting to anything, so it cannot tell a wrong password from a right one.
`/mailbridge smoke` reloads the daemon if it is running (so it picks up the password you just
added), sends one real mail and then opens the folder and counts. That proves SMTP accepts and
IMAP reads, and it leaves the daemon using the new credentials.

In the **single-mailbox** layout it also checks that our own notification comes back in a form
the scanner can recognise: it finds the copy by the `X-Pi-Mailbridge-Id` we stamped (retrying
for about a minute, because providers deliver asynchronously) and says which of the two guards
survived — the `X-Pi-Mailbridge` marker, or our `Message-ID`. If the provider rewrote both, the
report says whether `mail.imap.sentFolder` covers it; with neither guard and no read-back, do not
leave that configuration running.

### Start watching from now, not from history

Do this **before your first `/afk`**, which is when the first scan runs. (The daemon may
already be running — in pi, `setup` starts it; headless `--setup` only writes the file — but
nothing is read while email mode is off.)

If the mailbox already has mail you don't want the agent to read (a personal inbox, for
instance), prime the cursor first:

```
/mailbridge prime        # or: pi-mailbridge --prime
```

That moves the UID cursor to the newest message without fetching anything, so the
scan begins at the next arrival. No mail is read and nothing is marked seen; the only thing
written is the cursor itself.

### Your first notification

Email mode starts **off**. Turn it on, let a turn settle, and the first mail arrives:

```
/afk
```

Reply to it from any device. The reply continues that same session. `/back` turns it off
again — in both directions: while it is off nothing is scanned, claimed or injected, and
replies wait in the mailbox until you `/afk`.

Prefer to write it yourself? Copy [`config.example.json`](./config.example.json).

### The headless entry point

There is a CLI: for running the daemon where pi cannot (a systemd unit, a container, a
remote box), and for the same first-run and diagnostic steps without pi
(`--setup`, `--check`, `--smoke`, `--auth`, `--prime`, `--print-token`).

`--setup <pi-address> [--to <your-address>] [--force]` — omitting `--to` selects the
single-mailbox layout, exactly as in pi.

`--print-token` prints the bearer/HMAC secret (`secret.key`) to stdout — never paste its
output into an issue or a log. Same code path, not a second workflow.

```bash
# Installed as `pi install npm:pi-mailbridge` (or a checkout: point at its src/).
node --experimental-strip-types \
  "${PI_MAILBRIDGE_DIR:-$HOME/.pi/agent/npm/node_modules/pi-mailbridge}/src/daemon/main.ts"
```

`pi-mailbridge --check` / `--prime` / `--smoke` / `--print-token` are the same entry point
through the package's `bin`. If the command is not on `PATH` (npm installs it under the
package's `node_modules/.bin`), call that file directly.


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
```

Three things the unit cannot guess, before enabling it:

1. `Environment=PATH` — where your Node lives (`command -v node`).
2. `Environment=PI_MAILBRIDGE_DIR` — where this package is installed; the default assumes
   `pi install npm:pi-mailbridge`.
3. The state directory must already exist. `ProtectHome=read-only` means the daemon cannot
   create it, and `ExecStartPre … --check` fails without it:

```bash
mkdir -p ~/.local/state/pi-mailbridge
```

```bash
systemctl --user enable --now pi-mailbridge
```

## Commands

| Command | Effect |
| --- | --- |
| `/afk` | Email mode on: decisions mail you and end the turn |
| `/back` | Email mode off: decisions ask in the terminal |
| `/mailbridge` | Status: daemon health, mode, session, secret, mailbox, allowlist, pending replies |
| `/mailbridge help` | Same command list, from inside the session |
| `/mailbridge setup <addr> [to <addr>] [force]` | Discover servers + auth, write the config, and start or reload the daemon |
| `/mailbridge check` | Validate the config and that credentials are present (in pi: no network; `--check` runs your `tokenCommand` if XOAUTH2 is configured) |
| `/mailbridge auth` | Start the OAuth2 device login; prints the URL, polls in the background |
| `/mailbridge smoke` | Reload the daemon, send one real mail, then open the folder and count |
| `/mailbridge restart` | Replace the daemon process (needed after an update; the daemon re-reads the config on `setup`/`smoke` and when a session finds a newer file, but this session's own copy — device name, shown mailbox — refreshes only when a `/mailbridge` command runs or pi restarts. `daemon.host`/`daemon.port` changes are re-read by the next `/mailbridge` command, and the session rebuilds its client on the new address within a poll tick or two — respawns are throttled to one a minute) |
| `/mailbridge prime` | Set the cursor to now, so existing mail is never read |

## Turning it off for good

`/back` closes the channel but leaves everything installed. To remove it:

```bash
# 1. the daemon (skip if you never installed the unit)
systemctl --user disable --now pi-mailbridge
rm -f ~/.config/systemd/user/pi-mailbridge.service
systemctl --user daemon-reload

# 2. the package — the reverse of however you installed it. For the documented
#    `pi install npm:pi-mailbridge`, run `pi remove npm:pi-mailbridge` (or
#    `pi uninstall npm:pi-mailbridge`); for a manual checkout, remove the package
#    directory and any entry you added to your pi config.

# 3. everything it wrote: credentials, routing ids, queued replies
rm -rf ~/.local/state/pi-mailbridge ~/.config/pi-mailbridge
```

Nothing is installed system-wide: the daemon runs as you, binds loopback, and its state is
the two directories above. If you also created an Entra app or a provider app password for
this, revoke those too — that is the credential that actually reaches your mailbox.

## Environment overrides

Config values can be overridden per-process, which is how the shipped systemd unit stays
resident without editing your config file:

| Variable | Sets |
| --- | --- |
| `PI_MAILBRIDGE_IMAP_HOST`, `PI_MAILBRIDGE_IMAP_USER`, `PI_MAILBRIDGE_IMAP_PASS` | `mail.imap.host`, `.user`, `.password` |
| `PI_MAILBRIDGE_SMTP_HOST`, `PI_MAILBRIDGE_SMTP_USER`, `PI_MAILBRIDGE_SMTP_PASS` | `mail.smtp.host`, `.user`, `.password` |
| `PI_MAILBRIDGE_TO` | `mail.to` |
| `PI_MAILBRIDGE_PORT` | `daemon.port` |
| `PI_MAILBRIDGE_DEVICE` | `device.name` |
| `PI_MAILBRIDGE_EXIT_WHEN_IDLE` | `daemon.exitWhenIdle` (`false` for a supervised daemon) |
| `PI_MAILBRIDGE_IMAP_TOKEN_CMD`, `PI_MAILBRIDGE_SMTP_TOKEN_CMD` | `mail.imap.tokenCommand`, `mail.smtp.tokenCommand` (argv list; JSON or comma-separated) |

## Agent tools

| Tool | Behaviour |
| --- | --- |
| `request_decision` | Emails a question with optional options and a recommendation, then ends the turn. One outstanding decision per session. Ending the turn is a convention the model follows, not an enforced gate — see [docs/SECURITY.md](./docs/SECURITY.md) §3. |
| `notify_user` | One-way update. Does not reserve a slot and does not wait. |

Both refuse cleanly when email mode is off or the daemon is unreachable.

## Configuration

`~/.config/pi-mailbridge/config.json`, merged over built-in defaults, then
`PI_MAILBRIDGE_*` environment variables. Working example (password auth; OAuth is shown in
[docs/OAUTH.md](./docs/OAUTH.md)):
[`config.example.json`](./config.example.json).

| Key | Default | Meaning |
| --- | --- | --- |
| `mail.imap.host` / `.port` / `.secure` | — / 993 / true | IMAP server |
| `mail.imap.user` | — | pi's mailbox account |
| `mail.imap.sentFolder` | — | where the account keeps sent mail (`Sent Messages` on QQ, `Sent Items` on Outlook). Set it when your provider rewrites the `Message-ID` we stamp — QQ does — so the reply chain can still match. Costs one short-lived IMAP connection per notification, and the copy must appear within about two minutes (the provider appends it asynchronously) |
| `mail.imap.password` | — | password or app password when `authType` is `LOGIN` |
| `mail.imap.folder` | `INBOX` | watched folder |
| `mail.imap.authType` | `LOGIN` | `LOGIN` or `XOAUTH2` |
| `mail.imap.tokenCommand` | `[]` | argv whose stdout is an access token (XOAUTH2) |
| `mail.smtp.host` / `.port` / `.secure` | — / 465 / true | SMTP server |
| `mail.smtp.user` | — | also the `From:` and the loop-guard identity |
| `mail.smtp.password` | — | password or app password when `authType` is `LOGIN` |
| `mail.smtp.authType` | `LOGIN` | `LOGIN` or `XOAUTH2` |
| `mail.smtp.tokenCommand` | `[]` | argv whose stdout is an access token (XOAUTH2) |
| `mail.to` | — | **your** address: where notifications go |
| `oauth.issuer` | — | OAuth2 discovery base URL (see the presets in docs/OAUTH.md) |
| `oauth.clientId` | — | your app registration's client id |
| `oauth.clientSecret` | — | only for confidential clients; omit for device code |
| `oauth.scope` | — | must include `offline_access` for a refresh token |
| `device.name` | first label of `os.hostname()` | machine name shown in every settle notification, and stored on the routing record |
| `security.allowFrom` | `[]` | senders allowed to command the agent; empty denies all |
| `security.requireDmarcPass` | `true` | require a DMARC pass (pinned to `trustedAuthservId` when that is set). For a single-mailbox setup this must be `false` **unless** your provider stamps `Authentication-Results` on self-addressed mail — and if you set it `true` there, `--check` fails, which stops the shipped unit at `ExecStartPre` |
| `security.trustedAuthservId` | unset | pin the trusted `Authentication-Results` host. Leave unset for Microsoft consumer accounts — their relay emits no authserv-id |
| `security.allowHeaderThreading` | `true` | accept a reply whose subject id was lost, by matching `In-Reply-To` / `References` against Message-IDs we minted |
| `security.allowSelfReplies` | `false` | one address for both roles (personal Hotmail/Gmail): accept a self-addressed message, but only a real reply |
| `security.tokenTtlHours` | `720` | lifetime of a route id, a signed token and a reply-chain entry; stale replies are refused |
| `daemon.host` / `.port` | `127.0.0.1` / `4177` | loopback HTTP for the extension; the port is the instance lock |
| `daemon.exitWhenIdle` | `true` | exit once no pi session is pinging; set `false` for a systemd-owned daemon |
| `daemon.idleTimeoutSecs` | `120` | grace period after the last ping |
| `daemon.scanIntervalSecs` | `60` | periodic catch-up scan while mode is on, so a silent IDLE cannot strand a reply; `0` disables |
| `notify.onSettled` | `true` | email when an agent settles |
| `notify.debounceMs` | `10000` | quiet period before the settle mail |
| `notify.notifyOnAborted` | `false` | also mail when you hit Escape |
| `tuning.idleRenewMs` | `1500000` | IDLE renew interval (keep under ~29 min) |
| `tuning.backoffInitialMs` / `.backoffMaxMs` | `1000` / `60000` | reconnect backoff bounds |

### Provider support

| Provider | Auth | Status |
| --- | --- | --- |
| Any IMAP/SMTP host (self-hosted, Posteo, Fastmail, Zoho…) | `LOGIN` — the account password or a provider app password | ✅ works |
| **QQ Mail / Foxmail** (mainland China) | `LOGIN` 授权码 | ✅ works, built into discovery — **QQ accounts must be 14 days old** before IMAP/SMTP can be enabled |
| **163 / 126 / yeah.net / 188.com** (mainland China) | `LOGIN` 授权码 | ✅ works, built into discovery — no waiting period; expects the IMAP `ID` command, which this client sends |
| Gmail | app password (`LOGIN`) recommended | ✅ works |
| Microsoft 365 / work accounts | `XOAUTH2` | ✅ usually works |
| **Personal** `@outlook.com` / `@hotmail.com` | `XOAUTH2` only | ⚠️ app passwords are rejected over IMAP; two obstacles — see below |

**Outlook needs OAuth2, not a password.** Enabling IMAP/SMTP in Outlook.com's
settings does *not* restore password login — the toggle makes the protocols
available, it does not change authentication. App passwords can still be created
and may work for SMTP, but **IMAP rejects them**, and IMAP is how your replies
arrive. This package ships a
device-code login, so you approve once from any device and it refreshes itself:

```bash
pi-mailbridge --check     # tells you exactly what is missing
pi-mailbridge --auth      # prints a URL + code, waits for approval
```

```json
"oauth": {
  "issuer": "https://login.microsoftonline.com/consumers/v2.0",
  "clientId": "<application (client) id>",
  "scope": "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send"
}
```

One-time setup (free, ~2 min): register an app in Entra, enable *Allow public
client flows*, copy the client id. Full walkthrough, including the scope tables
and the Gmail equivalent: **[docs/OAUTH.md](./docs/OAUTH.md)**.

#### Personal Outlook has *two* obstacles

1. **No Entra tenant.** A fresh Hotmail/MSA has no directory, so
   `entra.microsoft.com` says "account does not exist" — app registration needs a
   tenant. Fix: free Azure signup (card/phone usually required), or a work tenant
   you already have with *personal accounts* in the supported account types.
2. **The servers may refuse the token anyway.** See below.

**In mainland China, use QQ Mail or 163** — Google is unreachable and the 授权码
(authorization code) works exactly like an app password:

1. in the provider's web settings, enable **IMAP/SMTP服务**, then generate a 授权码
2. `/mailbridge setup pi-yourname@qq.com to you@hotmail.com`
3. paste the 授权码 into both password fields, then `/mailbridge smoke`
4. check that `mail.imap.sentFolder` is `"Sent Messages"` — `setup` writes it for `qq.com` and
   `foxmail.com`, because QQ replaces the `Message-ID` we stamp; without it a reply only routes
   while the `[pi:…]` tag survives. Add it by hand for any *other* provider that rewrites ids

`qq.com`, `foxmail.com`, `163.com` and `126.com` are in the built-in discovery
table, so setup works even if the autoconfig service is slow. See
[docs/OAUTH.md](./docs/OAUTH.md).

**Elsewhere, use Gmail with an app password.** No
OAuth app, no tenant, no verification — and no refresh token that dies weekly:

1. enable 2-Step Verification, then create an app password at
   <https://myaccount.google.com/apppasswords>
2. `/mailbridge setup pi-yourname@gmail.com to you@hotmail.com force`
3. paste the 16-character passcode into both password fields, then `/mailbridge smoke`

`--setup` picks `LOGIN` for Google automatically. Gmail *OAuth* is the harder path,
not the easier one: mail scopes are restricted (verification + CASA to publish),
and a consent screen left in Testing expires refresh tokens every 7 days.

Details and the measured comparison: [docs/OAUTH.md](./docs/OAUTH.md).

#### The personal-Outlook caveat

Honest warning, because it will save you an evening: **personal** `outlook.com`
sometimes rejects IMAP/SMTP OAuth2 even when the token is valid —
`User is authenticated but not connected`, or `SmtpClientAuthentication is
disabled for the Mailbox`. That is Microsoft's side, not this package's.

The reliable answer there is **Microsoft Graph** (`POST /me/sendMail`,
`GET /me/mailFolders/inbox/messages/delta`), which never speaks SMTP. It is free,
uses the same OAuth token, and needs no extra dependency — but it is **not
implemented here yet**. If Graph matters to you, that is the one open feature.

If you would rather pay for a turnkey service, [EmailEngine](https://emailengine.app/)
(self-hosted, paid) uses Graph natively for Microsoft accounts and exposes one REST
API over IMAP/SMTP/Gmail/Graph; [Nylas](https://www.nylas.com/) is the hosted
equivalent. Both solve this class of problem by owning the OAuth apps and protocol
quirks for you — at the cost of money and, for Nylas, your mail passing through a
third party.

### A token command instead

If you already run a broker, skip the built-in flow — `oauth.*` takes precedence
over `tokenCommand`, so remove the `oauth` block to use this:

```json
"authType": "XOAUTH2",
"tokenCommand": ["ortie", "token", "show", "-a", "outlook"]
```

Three consecutive failures from a token command disable OAuth2 for the session rather than
spawning a failing process on every scan. A single transient failure is retried — one DNS
blip should not stop your notifications until a restart.

## How it works

```
IMAP IDLE ──► scan (UID cursor) ──► authorize ──► route ──► strip quote ──► persist
                                                                     │
                     pi session ◄── claim ◄── poll ◄─────────────────┘
                          │
                          └──► inject as followUp ──► ack ──► \Seen + journal
```

One daemon per machine owns the mailbox; the session's delivery path never touches
IMAP. (`/mailbridge smoke` is the exception: a one-off diagnostic that sends one mail and
opens the folder and counts over its own short-lived connection; `/mailbridge prime`
also opens one, to move the cursor without reading anything.) Details and
the failure-mode table: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md). Module
map and the port from `opencode-afk`: [docs/MAPPING.md](./docs/MAPPING.md).

## Status

`0.1.0` — feature-complete for the single-user, one-mailbox case, and exercised end to end
against a live QQ mailbox in both layouts: two addresses (QQ for pi, Outlook/Hotmail for the
human — DMARC verified on the reply) and one address for both roles (self-delivery, the
self-echo guard, and a human-style reply routed by the reply chain).

What that does *not* buy you: there is **no automated live-mailbox test**. Provider behaviour
is observed, not guaranteed — a provider can change how it rewrites headers or pushes `EXISTS`.
The hermetic suite (`npm test`) covers the token, authz, scan pipeline, stores, daemon HTTP
surface, lifecycle, extension surface, tools, attachments and the full end-to-end loop; it
needs no network, no mailbox and no socket.

Not implemented: creating a *new* session from mail (`ctx.newSession()` replaces
the active session, which is a different architecture), and MIME/S-MIME.

## License

MIT
