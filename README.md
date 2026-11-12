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
mail.imap.user / mail.smtp.user = you@hotmail.com
mail.to                          = you@hotmail.com
security.allowFrom               = ["you@hotmail.com"]
security.allowSelfReplies        = true      # required, or every reply is a "self" loop
```

`allowSelfReplies` accepts a message from your own address **only when it carries
`In-Reply-To`** — i.e. only when it is genuinely a reply. Your own outbound
notification has no `In-Reply-To` and is still rejected (`self-echo`), so pi cannot
re-ingest its own mail as instructions.

Once configured, prove it without pi:

```bash
pi-mailbridge --smoke     # sends one real mail, then opens the folder and counts
```

## How a reply is identified

A reply is matched to a session by the **first rule that succeeds**:

| # | Rule | Survives | Notes |
| --- | --- | --- | --- |
| 1 | **Signed token in the subject** — `[pi:<payload>.<mac>]`, matched anywhere in the subject | subject intact | Authoritative: HMAC-signed, TTL-bounded. `Re:`, `RE:`, `Aw:`, `Re[2]:` prefixes are fine because the token is not anchored. |
| 2 | **The reply chain** — `In-Reply-To`, or any id in `References`, equals a Message-ID we minted | subject edited, rewritten or purged | The id is recorded when the notification is sent, and kept for the last 2,000 sends. |
| 3 | Neither | — | Rejected as `no-token`; the mail is left **unread** so you can retry. |

What this means in practice:

- **Reply normally.** Every mail client sets `In-Reply-To`, so a plain Reply works
  either way.
- **Editing the subject is safe** — the chain still routes it.
- **Composing a brand-new email** with no token and no reference is *not*
  identified. Use Reply, or keep the `[pi:…]` tag in the subject.
- **Quoted text is stripped** before the agent sees it, so leave the quote in.
- **A reply to a reply** still works: the chain carries the original id.

Rule 2 is a convenience fallback, not authentication — a Message-ID is only
visible to the recipient, but it is unsigned. Set
`security.allowHeaderThreading: false` if you want the signed token to be the only
way in.

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
```

Then do everything from inside pi — no shell required:

```
/mailbridge setup pi-xyz@outlook.com to you@outlook.com   # discovers servers + auth
/mailbridge auth                                          # approve once, on any device
/mailbridge smoke                                         # send one real mail, then read it back
```

`setup` fetches the provider's published mail settings (Thunderbird's
autoconfig database) and the auth it requires, so you never hand-write hosts,
ports or TLS modes. It refuses to overwrite an existing config unless you add
`force`.

Prefer to write it yourself? Copy [`config.example.json`](./config.example.json).

### Start watching from now, not from history

If the mailbox already has mail you don't want the agent to read (a personal
inbox, for instance), prime the cursor before starting the daemon:

```
/mailbridge prime        # or: pi-mailbridge --prime
```

That moves the UID cursor to the newest message without fetching anything, so the
scan begins at the next arrival. Nothing is stored and nothing is marked seen
either way — priming is about not reading mail that was never addressed to pi.

### The headless entry point

There is a CLI, but only for running the daemon where pi cannot: a systemd unit,
a container, a remote box. It is the same code path, not a second workflow.

```bash
node src/daemon/main.ts            # run the daemon
node src/daemon/main.ts --check    # for ExecStartPre
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
| `/mailbridge setup <addr> [to <addr>] [force]` | Discover servers + auth, write the config, reload the daemon |
| `/mailbridge check` | Validate config and credentials; says what is missing |
| `/mailbridge auth` | Start the OAuth2 device login; prints the URL, polls in the background |
| `/mailbridge smoke` | Send one real mail, then read the folder back |
| `/mailbridge restart` | Re-read config and restart the daemon's watcher |
| `/mailbridge prime` | Set the cursor to now, so existing mail is never read |

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
| `oauth.issuer` | — | OAuth2 discovery base URL (see the presets in docs/OAUTH.md) |
| `oauth.clientId` | — | your app registration's client id |
| `oauth.clientSecret` | — | only for confidential clients; omit for device code |
| `oauth.scope` | — | must include `offline_access` for a refresh token |
| `device.name` | first label of `os.hostname()` | machine name shown in every notification and carried in the routing token |
| `security.allowFrom` | `[]` | senders allowed to command the agent; empty denies all |
| `security.requireDmarcPass` | `true` | require a DMARC pass from the pinned relay |
| `security.trustedAuthservId` | unset | pin the trusted `Authentication-Results` host. Leave unset for Microsoft consumer accounts — their relay emits no authserv-id |
| `security.allowHeaderThreading` | `true` | accept a reply whose subject token was lost, by matching `In-Reply-To` / `References` against Message-IDs we minted |
| `security.allowSelfReplies` | `false` | one address for both roles (personal Hotmail/Gmail): accept a self-addressed message, but only a real reply |
| `security.tokenTtlHours` | `720` | routing-token lifetime; stale replies are refused |
| `daemon.host` / `.port` | `127.0.0.1` / `4177` | loopback HTTP for the extension; the port is the instance lock |
| `notify.onSettled` | `true` | email when an agent settles |
| `notify.debounceMs` | `10000` | quiet period before the settle mail |
| `notify.notifyOnAborted` | `false` | also mail when you hit Escape |
| `notify.subject` | `"pi"` | unused by the settle mail; reserved for custom notifications |
| `tuning.idleRenewMs` | `1500000` | IDLE renew interval (keep under ~29 min) |
| `tuning.autoIdleDelayMs` | `1000` | quiet period before imapflow re-issues IDLE |
| `tuning.backoffInitialMs` / `.backoffMaxMs` | `1000` / `60000` | reconnect backoff bounds |

### Provider support

| Provider | Auth | Status |
| --- | --- | --- |
| Any IMAP/SMTP host (self-hosted, Posteo, Fastmail, Zoho…) | `LOGIN` app password | ✅ works |
| **QQ Mail / Foxmail / 163 / 126** (practical in mainland China) | `LOGIN` 授权码 | ✅ works, built into discovery |
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
battle-tested against a live mailbox. 269 hermetic tests cover the token, authz,
scan pipeline, stores, daemon HTTP surface, lifecycle, extension surface, tools,
attachments and the full end-to-end loop.

Not implemented: creating a *new* session from mail (`ctx.newSession()` replaces
the active session, which is a different architecture), and MIME/S-MIME.

## License

MIT
