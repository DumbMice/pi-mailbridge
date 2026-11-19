# Mailbridge reference

[Setup and everyday use](../README.md) · [Session starter](STARTER.md) · [OAuth setup](OAUTH.md)

## Configuration

Mailbridge reads `~/.config/pi-mailbridge/config.json` (under `$XDG_CONFIG_HOME` if set). Values in this file override the defaults; environment variables override the file. For the JSON structure, see [`config.example.json`](https://github.com/DumbMice/pi-mailbridge/blob/main/config.example.json).

| Key | Default | Meaning |
| --- | --- | --- |
| `mail.imap.host` / `.port` / `.secure` | none / 993 / true | IMAP server |
| `mail.imap.user` | none | pi's mailbox account |
| `mail.imap.sentFolder` | none | where the account keeps sent mail (`Sent Messages` on QQ, `Sent Items` on Outlook). Set it when the provider rewrites the `Message-ID` we stamp: QQ does, and `setup` writes it for `qq.com`/`foxmail.com`. Costs one short-lived IMAP connection per notification; the copy must appear within about two minutes |
| `mail.imap.password` | none | password or app password for `LOGIN` |
| `mail.imap.folder` | `INBOX` | watched folder |
| `mail.imap.authType` | `LOGIN` | `LOGIN` or `XOAUTH2` |
| `mail.imap.tokenCommand` | `[]` | argv whose stdout is an access token |
| `mail.smtp.host` / `.port` / `.secure` | none / 465 / true | SMTP server |
| `mail.smtp.user` | none | also the `From:` and the loop-guard identity |
| `mail.smtp.password` | none | password or app password for `LOGIN` |
| `mail.smtp.authType` | `LOGIN` | `LOGIN` or `XOAUTH2` |
| `mail.smtp.tokenCommand` | `[]` | argv whose stdout is an access token |
| `mail.to` | none | **your** address: where notifications go |
| `oauth.issuer` | none | OAuth2 discovery base URL |
| `oauth.clientId` | none | your app registration's client id |
| `oauth.clientSecret` | none | confidential clients only; omit for device code |
| `oauth.scope` | none | must include `offline_access` for a refresh token |
| `device.name` | hostname | machine name in settle notifications and routing records |
| `security.allowFrom` | `[]` | senders allowed to command the agent; empty denies all |
| `security.requireDmarcPass` | `true` | require a DMARC pass, pinned to `trustedAuthservId` when set. `false` for a single mailbox unless your provider stamps `Authentication-Results` on self-mail |
| `security.trustedAuthservId` | unset | pin the trusted `Authentication-Results` host; leave unset for Microsoft consumer accounts |
| `security.allowHeaderThreading` | `true` | accept a reply whose subject id was lost, by matching `In-Reply-To`/`References` |
| `security.allowSelfReplies` | `false` | one address for both roles: accept a self-addressed message, but only a real reply |
| `security.tokenTtlHours` | `720` | lifetime of a signed token and a reply-chain entry; a route id is refreshed once half its TTL is left, so it is guaranteed for at least `tokenTtlHours / 2` after the last notification, and the chain covers the rest |
| `daemon.host` / `.port` | `127.0.0.1` / `4177` | loopback HTTP; a lock file in the state directory is the instance lock, and the port is a second guard |
| `daemon.idleTimeoutSecs` | `120` | grace period after the last ping |
| `daemon.scanIntervalSecs` | `60` | catch-up scan while mode is on, so a silent IDLE cannot strand a reply; `0` disables |
| `notify.onSettled` | `true` | email when an agent settles, unless that answer was already mailed (a settled turn that wrote nothing) |
| `notify.debounceMs` | `10000` | quiet period before the settle mail |
| `notify.notifyOnAborted` | `false` | also mail when you hit Escape |
| `notify.maxAttachmentMb` | `18` | total size of files attached to one notification, before base64. Default sits under Gmail/Outlook.com's 25 MB; QQ allows 50 MB, so a QQ account can raise it |
| `notify.inlineSvg` | `true` | allow a recognised SVG as an inline image; when `false`, an SVG image reference gets a refusal note. An ordinary file link still attaches it |
| `notify.rasteriseSvg` | `true` | convert a referenced SVG to PNG before inlining when `rsvg-convert`, ImageMagick `convert` or `inkscape` is on `PATH`, because Outlook mobile and most Android galleries render no SVG. Falls back to the SVG when no converter works |
| `tuning.idleRenewMs` | `1500000` | IDLE renew interval (keep under ~29 min) |
| `tuning.backoffInitialMs` / `.backoffMaxMs` | `1000` / `60000` | reconnect backoff bounds |

### Sending local files

The sender can include PNG, JPEG, GIF and WebP inline. For SVG, use a simple `<svg>` root with either no namespace or the SVG namespace. A doctype or a processing instruction other than a UTF-8 XML declaration prevents recognition. If an SVG is refused, link the file instead of embedding it. See [attachment rules and allowed file types](SECURITY.md#6b-attachments-in-notifications) for the path checks and size limits.

`notify.maxAttachmentMb` counts the attached bytes before encoding. Base64 adds about a third on the wire. If your provider refuses a large message, lower the limit or send fewer files. The bridge checks the path and type, not whether a file contains secrets.

## Environment overrides

Config values can be overridden per-process, which is useful for a container or a shell that starts
the daemon without editing your config file:

| Variable | Sets |
| --- | --- |
| `PI_MAILBRIDGE_IMAP_HOST`, `PI_MAILBRIDGE_IMAP_USER`, `PI_MAILBRIDGE_IMAP_PASS` | `mail.imap.host`, `.user`, `.password` |
| `PI_MAILBRIDGE_SMTP_HOST`, `PI_MAILBRIDGE_SMTP_USER`, `PI_MAILBRIDGE_SMTP_PASS` | `mail.smtp.host`, `.user`, `.password` |
| `PI_MAILBRIDGE_TO` | `mail.to` |
| `PI_MAILBRIDGE_PORT` | `daemon.port` |
| `PI_MAILBRIDGE_DEVICE` | `device.name` |
| `PI_MAILBRIDGE_IMAP_TOKEN_CMD`, `PI_MAILBRIDGE_SMTP_TOKEN_CMD` | `mail.imap.tokenCommand`, `mail.smtp.tokenCommand` (argv list; JSON or comma-separated) |
| `PI_MAILBRIDGE_SESSION_MODE` | this session's email-mode override at start (`on`/`off`), set by the session starter and by anything else that wants a started session to mail you back |
| `PI_MAILBRIDGE_START_REQUEST`, `PI_MAILBRIDGE_START_PROMPT`, `PI_MAILBRIDGE_START_READY`, `PI_MAILBRIDGE_START_MAX_BYTES` | the session starter's bootstrap: the request id, the `0600` prompt file it reads and removes, the readiness marker it writes, and the size cap it enforces (not for humans to set by hand) |
| `PI_MAILBRIDGE_SVG_RASTERISER` | `0` disables converting a referenced SVG to PNG (see `notify.rasteriseSvg`); any other value is ignored |
| `PI_MAILBRIDGE_BOOTSTRAP` | absolute path to the bootstrap extension, for a starter that is not running from the package layout (`starter check` and the dry run use it) |

## Provider support

| Provider | Auth | Status |
| --- | --- | --- |
| Any IMAP/SMTP host (self-hosted, Posteo, Fastmail, Zoho…) | `LOGIN`: account or app password | ✅ works |
| **QQ Mail / Foxmail** | `LOGIN` 授权码 | ✅ built-in discovery; QQ accounts must be 14 days old before IMAP/SMTP can be enabled |
| **163 / 126 / yeah.net / 188.com** | `LOGIN` 授权码 | ✅ built-in discovery; no waiting period |
| Gmail | app password (`LOGIN`) | ✅ works |
| Microsoft 365 / work accounts | `XOAUTH2` | The tenant must allow IMAP and SMTP. |
| Personal Outlook.com / Hotmail | `XOAUTH2` | Microsoft can refuse IMAP or SMTP even with a valid token. |

For provider-specific login instructions, see [OAuth and app passwords](OAUTH.md).

## One mailbox or two?

| | A. Dedicated mailbox (recommended) | B. One mailbox |
| --- | --- | --- |
| Who | pi gets its own address, you use yours | one address for both |
| `mail.to` | `you@example.com` | `you@qq.com` |
| `security.allowSelfReplies` | `false` (default) | `true`; required |
| `security.requireDmarcPass` | `true` (default) | `false`; setup writes this |
| Isolation | a compromised pi mailbox is not your inbox | none; point it at a mailbox you would not mind an agent reading |

### A. Dedicated mailbox

pi gets its own address; your personal address receives notifications and sends replies.

```text
mail.imap.user / mail.smtp.user = pi@example.com      # pi's mailbox
mail.to                          = you@example.com     # you
security.allowFrom               = ["you@example.com"]
security.allowSelfReplies        = false               # the default
```

### B. One mailbox (single personal account)

pi's mailbox *is* your address, so notifications land in your inbox and you reply from the same
address.

```text
mail.imap.user / mail.smtp.user = you@qq.com
mail.to                          = you@qq.com
security.allowFrom               = ["you@qq.com"]
security.allowSelfReplies       = true      # required, or every reply is a "self" loop
security.requireDmarcPass       = false     # see below; /mailbridge setup writes this
```

These checks distinguish a reply from a copy of pi's own mail:

1. **A marker header.** Every notification carries `X-Pi-Mailbridge: notification`, and the
   scanner ignores mail carrying that marker.
2. **Reply evidence.** A self-addressed message must carry `In-Reply-To` or `References`;
   **Reply (or Forward-then-Reply) is the only supported way in.** A freshly composed mail is
   rejected as `no-reply-evidence`.
3. **The outbound registry.** Our own `Message-ID`s are recorded when sending, so a copy of our
   own mail is recognised even if the marker was stripped.

Some providers omit DMARC results on self-mail. QQ, for example, adds no `Authentication-Results` header to those messages. Setup disables the DMARC requirement when both addresses match. Someone forging your address could then pass the sender check; delivering an ordinary reply would still require a matching route id or reply chain. The optional starter accepts new mail without either, so prefer a dedicated mailbox with DMARC for the starter.

If your provider stamps a DMARC pass on self-mail, you can restore `security.requireDmarcPass`. Both checks warn about this combination. The in-pi check reports it; headless `--check` exits non-zero.

Once configured, prove it without pi:

```bash
pi-mailbridge --smoke     # sends one real mail, then opens the folder and counts
```

## Commands

| Command | Effect |
| --- | --- |
| `/mailbridge` or `/mailbridge status` | daemon health, mode, session, secret, mailbox, allowlist, pending replies |
| `/mailbridge on` | email mode on for this session (`--all`: every session) |
| `/mailbridge off` | email mode off for this session (`--all`: every session) |
| `/mailbridge setup <pi-address> [to <your-address>] [force]` | discover servers + auth, write the config, start or reload the daemon |
| `/mailbridge check` | validate config and that credentials are *present* (no network in pi; `--check` runs your `tokenCommand` when XOAUTH2 is configured) |
| `/mailbridge auth` | start the OAuth2 device login |
| `/mailbridge smoke` | reload the daemon, send one real mail, read the folder back |
| `/mailbridge prime` | **first run only**: skip the mailbox's existing mail |
| `/mailbridge restart` | replace the daemon process (after an update) |
| `/mailbridge help` | the same list |

### Commands by mail

Put one command on a line by itself above the quoted message. The bridge strips the quote and signature before checking the command.

| Reply | Effect |
| --- | --- |
| `/mailbridge on` | only while the mode is already on (a no-op). It cannot re-open the channel from off: nothing scans and no session drains, so the reply is never read. Use the terminal |
| `/mailbridge off` | email mode OFF for this session; by mail it is one-way, since re-opening needs a terminal the mailbox cannot reach; anything else in that batch stays pending |
| `/mailbridge` or `/mailbridge status` | the status panel |
| `/mailbridge check` / `/mailbridge smoke` | validate the config / send one test mail |
| `/mailbridge help` | the command list |

Command output appears in the pi session. Four commands are not runnable by mail: `setup`, `auth`, `restart` and `prime`. Those commands, commands with arguments (including `--all`), and multiline replies reach the agent as text.

### The headless entry point

Run `pi-mailbridge` with one of these flags:

| Flag | Effect |
| --- | --- |
| *(none)* | run the daemon in the foreground |
| `--setup <pi-address> [--to <your-address>] [--force]` | write the config and exit; nothing is started. Omitting `--to` selects the single-mailbox layout |
| `--check` | validate config and credential *presence*, exit non-zero on a problem; runs `tokenCommand` for XOAUTH2 |
| `--smoke` | send one real mail, read the folder back |
| `--auth` | OAuth2 device login |
| `--prime` | first-run cursor move; exits 2 if it has already run |
| `--print-token` | print the bearer secret to stdout; never paste it anywhere |

If `pi-mailbridge` is not on your shell’s `PATH`, use `npx --package @dumbmice/pi-mailbridge pi-mailbridge --check`, substituting the command you need.

## Lifecycle: who starts what

| Event | What happens |
| --- | --- |
| `pi install npm:@dumbmice/pi-mailbridge` | **Nothing runs.** The package is placed; no config, no daemon, no state directory. |
| first pi session after a usable config exists | the extension probes `/health` and, if nothing answers, spawns the daemon detached; that is why a daemon can appear without you running `setup` in that session |
| `/mailbridge setup` | writes the config, then starts (or reloads) the daemon and wires this session to it |
| `/mailbridge smoke` | re-read the config in the running daemon (mail password, allowlist) |
| `/mailbridge restart` | stop the process, so it comes back running the current code |
| `pi-mailbridge --setup` (headless) | writes the config and exits, with **no daemon**. Start it yourself, and run `/mailbridge restart` in an already-open session so that session attaches |
| last pi session closes | the daemon exits after `daemon.idleTimeoutSecs` (120 s), always; there is no "stay resident" switch |

Sessions share one daemon per state directory. Switching email off stops delivery; it does not stop the process.

A session replaces a daemon on an older protocol. A newer daemon is not killed: restart pi to load the matching extension. A different package version on the same protocol does not trigger replacement; use `/mailbridge restart` to pick up the installed code. Queued replies and the global email switch survive a restart.

## How a reply is identified

A reply is matched to a session by the first rule that succeeds:

| # | Rule | Survives | Notes |
| --- | --- | --- | --- |
| 1 | **Short route id**: `[pi:f913c9]`, matched anywhere in the subject | subject intact | What every notification carries. A lookup key in this machine's route table, not a credential: an id never minted here resolves to nothing. TTL-bounded. `Re:`, `RE:`, `Aw:`, `Re[2]:` are fine because the id is not anchored. |
| 2 | **Legacy signed token**: `[pi:<payload>.<mac>]` | subject intact | Still verified (HMAC, TTL-bounded) so older mail keeps working. New notifications no longer use it. |
| 3 | **The reply chain**: `In-Reply-To`, or any id in `References`, equals a Message-ID we recorded | subject edited, rewritten or purged | Recorded when the notification is sent, kept for the last 2,000 sends, aged out with `security.tokenTtlHours`. |
| 4 | None of the above | n/a | Rejected as `no-token`. The mail stays unread, but the cursor has passed it, so reply again rather than editing the old subject. |

Every rule is routing only. Authorization happens before it: the sender allowlist, plus DMARC
(off in the single-mailbox layout; see One mailbox or two?).

- Reply normally. Mail clients set `In-Reply-To` or at least `References`; either is accepted.
- **Editing the subject is safe**: the chain still routes it until the TTL expires. On a
  provider that rewrites `Message-ID` (QQ does; `setup` names `Sent Messages` for
  `qq.com`/`foxmail.com`), set `mail.imap.sentFolder` or this fallback cannot match: the reply
  references an id the provider invented, not the one we recorded.
- **Composing a brand-new email** with no id and no reference is not identified.
- Quoted text is stripped before the agent sees it, so leave the quote in.
- **A reply to a reply** still works: the chain carries the original id.

Rule 3 is a convenience fallback, not authentication. Set `security.allowHeaderThreading: false`
to switch it off; the subject id is an unsigned lookup key either way.
