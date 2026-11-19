# Troubleshooting

[Setup](../README.md) · [Mailbox settings](REFERENCE.md#configuration)

## A reply did not arrive

Open the pi session that sent the notification and run:

```
/mailbridge status
```

```
daemon: healthy (http://127.0.0.1:4177) — daemon version 0.3.1, protocol 1
device: dev-box-7
mode: on (global)
imap: connected
session: 01a1c453-…
secret: present
mailbox: you@example.com
allowlist: you@example.com
pending replies: 0
last scan with mail: 14:02:11 — examined 2, kept 1, rejected 1
rejections: not-allowlisted 1
```

Check `mode:` first. When mail is off, the panel can still show an earlier scan. A healthy daemon with `imap: disconnected` cannot receive replies. If the daemon uses an older protocol, pi replaces it. A newer daemon is not replaced; restart pi to load the matching extension. See [daemon lifecycle](REFERENCE.md#lifecycle-who-starts-what).

In the example, `not-allowlisted` explains the missed reply. Look under `handled:` for events such as a copy of your own notification, and under `attachments dropped:` for a file that didn't reach the agent. A full queue defers delivery; the cursor waits.

| Reason | What it means | Fix |
| --- | --- | --- |
| `no-from` / `not-allowlisted` | no `From:`, or not an exact address in `security.allowFrom` | add the address you reply from |
| `allowlist-empty` | `security.allowFrom` is empty, which denies everything | set it |
| `dmarc-missing` / `dmarc-failed` | no `Authentication-Results` with `dmarc=pass` from a trusted relay | check `security.requireDmarcPass`; Microsoft consumer accounts need `trustedAuthservId` unset |
| `no-token` | the subject lost its `[pi:…]` id **and** no `In-Reply-To`/`References` matched | reply to the original mail |
| `route-miss` | the subject's id expired or was minted on another machine | nothing, if it routed by the chain; it appears under `handled:` |
| `other-device` | the notification came from another pi machine, or `device.name` changed | reply to a notification from this machine |
| `self` | single-mailbox mode with `security.allowSelfReplies: false` | set it `true` |
| `self-echo` | our own notification looping back, which is the guard working | nothing |
| `starter-request` | mail for the session starter's channel (`[pi-start] …`), which the daemon deliberately does not deliver; the starter reads it on its own cursor | nothing |
| `expired` | a queued reply aged out under queue pressure, reported on its own `aged out under queue pressure:` line, not under `rejections:` | send it again; the original never arrived |
| `no-reply-evidence` | a self-addressed mail with no threading headers | reply to the notification instead |
| `empty-body` from a `From:`/`>`-leading reply | the first line starts with a quote marker, so the whole body is treated as quoted | write your text above the quote, or paste logs after a sentence |
| `auto-generated` | a robot, mailing list or bounce | nothing |
| `attachment-only-dropped` | the reply's only content was an attachment nothing could deliver (a refused type, or past 20 MB); a note naming the drop is delivered | send the text, or a type in [Replying with a file](#replying-with-a-file) |
| `empty-body` | no prose, no attachment at all | n/a |
| `attachment-*` | an attachment was dropped (type, size, count, or `write-failed`/`attachment-write-failed` for a document that could not be saved) | check the reason suffix |
| `pending-full` | the queue is at its limit: 1 000 undelivered replies, or 8 MB of queued bodies and attachments - a few attachment-heavy replies can fill it | start a session so they drain; nothing is discarded, the cursor waits |
| `send_budget` | more than ten notifications in a minute were requested. This is a tool's refusal message, never a scan reason, so it is not on the `rejections:` line | a loop is mailing; the budget refuses rather than spending the account's quota |
| `too-large` | over 40 MB, refused before the body was downloaded | send a smaller one; a document is capped at 20 MB and 25 MB per reply, images are inlined below 1 MB |

Check these files under `~/.local/state/pi-mailbridge` (or `$XDG_STATE_HOME/pi-mailbridge`):

| Path | What it holds |
| --- | --- |
| `…/uid-cursor.json` | last seen UID + the mailbox UIDVALIDITY |
| `…/daemon.lock` | the running daemon's pid; this is the file to look at when a start says another daemon is already running |
| `…/routes.lock` | held for the instant a routing id is minted |
| `…/daemon.log` | the daemon's own log (0600, rotates once at 5 MB): scan summaries, connect errors, refusal reasons |
| `…/mode.json` | the persisted global switch, written by `/mailbridge on --all` and `off --all`; a bare `on`/`off` lives in the daemon's memory, and only falls back to this file when no daemon is running |
| `…/pending.json` | accepted replies waiting for a session (each stamped with the device that scanned it; `held for another device` counts the ones this device will not claim) |
| `…/routes.json` | short routing ids (`security.tokenTtlHours`) |
| `…/threads.json` | outbound Message-IDs for threading and the reply chain |
| `…/journal.json` | acked UIDs, tagged with the UIDVALIDITY |

If `imap:` says `disconnected`, check the connection, host and credentials. A revoked app password can leave the daemon running but unable to read mail. If the daemon itself is unreachable, run `/mailbridge restart` in this session.

Allow up to a minute for a reply: the daemon sweeps on a timer (`daemon.scanIntervalSecs`,
default 60) as well as on IMAP events, because a provider can stop pushing them. `no mail yet —
last checked …` means it is polling and has seen nothing.

## Replying with a file

A reply can carry:

| You attach | What the agent gets |
| --- | --- |
| PNG / JPEG / GIF / WebP, up to 4 and 1 MB in total per reply | the images themselves, as message parts it can see |
| `text/plain`, `text/markdown`, `application/json`, same 1 MB in total | the text, inline |
| PDF, PPT/PPTX, DOC/DOCX, XLS/XLSX, ODT/ODP, CSV, ZIP, GZ, TAR, MD, TXT, LOG, JSON, SVG, HEIC/HEIF, or an image too big to inline, up to 20 MB each | the file, written to `~/.local/state/pi-mailbridge/attachments/`, with its absolute path in the message. The agent opens it with its own tools |
| anything else (video, executables, an unknown extension) | not delivered; the drop is named in the agent's message and counted under `/mailbridge status` (`attachments dropped:`) |

Up to 10 files and 25 MB per reply; the mail itself may be up to 40 MB, because base64 inflates by
a third and a 25 MB reply is ~33 MB on the wire. Documents are kept for 7 days and the directory is
capped at 200 MB, oldest first - enough to be read, not an archive. If a file cannot be written
(disk full, permissions), the reply still arrives with a note naming it and `write-failed` in the
scan reasons.

A daemon from before this feature cannot deliver documents, and it is on the same protocol, so
nothing replaces it automatically: after upgrading, run `/mailbridge restart` once. The session says
so if it finds such a daemon.

A PDF or a deck is delivered as a **path**, because a model cannot be handed one as a message part.
If the agent needs the contents, it has to open it: `read` for text-ish files, or its own tooling
(`pdftotext`, `unzip`) through a shell.
