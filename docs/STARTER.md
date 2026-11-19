# Start a pi session by mail

The optional starter launches a detached pi session in tmux. Ordinary Mailbridge replies continue an existing session and do not need a starter.

## Enable the starter

First [configure the mailbox](../README.md#quick-start). Use a dedicated account with DMARC if possible: unlike ordinary session replies, a start request needs no routing id. Install `tmux` and make sure `pi` is on the starter's `PATH`.

In `config.json`, set `starter.enabled` to `true`. Choose a parent directory for projects you want to start by mail. The session must start **below** a root, not at the root itself. Once running, it has the same tool access as a session you start in the terminal. See [starter security](SECURITY.md#4a-mail-that-starts-processes-the-session-starter).

Merge this section into your existing config and use a project root that exists on this machine:

```json
{
  "starter": {
    "enabled": true,
    "roots": ["~/Work"],
    "models": ["deepseek/deepseek-flash"],
    "autoEnableMail": true
  }
}
```

Run `pi-mailbridge starter check`, then `pi-mailbridge starter run`. Keep that process running separately from pi. If the command is not on your `PATH`, see the [headless CLI](REFERENCE.md#the-headless-entry-point).

## Send a request

```
To:      your mailbox (or the `starter.channel.address` you configure)
Subject: [pi-start] fix the flaky auth test

cwd:   ~/Work/myapp
model: deepseek/deepseek-flash
prompt: |
  The auth test is flaky on CI. Reproduce it, fix it, run the suite.
```

Values are literal: there are no inline comments, so `model: deepseek/deepseek-flash  # optional` would be
read as part of the model id and refused. `model` is optional but must be on `starter.models`.

If you omit `prompt`, pi starts with `hi`. The subject supplies the default session name. A successful request gets a `started` reply with the `tmux attach` command and the exact `stop:` line. A refused request normally gets a reason. Start another session with a new message; a reply to a result accepts only `stop:` or `list:`.

If the `started` mail cannot be sent, the starter retries on a later scan, even if you have since stopped the session. Refusals skipped because of the hourly confirmation limit are not retried. If `list:` reports "tmux did not answer", the starter could not check which sessions are live.

`stop:` and `list:` are **body** lines, not subjects. The subject only has to stay on-channel: a reply to the
result mail already reads `Re: [pi-start] …` (with the address channel, its `To:` is what matches), and a new
mail with `[pi-start]` in the subject works the same way. In a reply, the command is read above the quoted
history, so it has to be typed at the top.

<picture>
  <source srcset="https://cdn.jsdelivr.net/npm/@dumbmice/pi-mailbridge@latest/docs/images/starter-mail.svg" type="image/svg+xml">
  <img src="https://cdn.jsdelivr.net/npm/@dumbmice/pi-mailbridge@latest/docs/images/starter-mail.png" alt="The request mail with its subject tag and literal key block, the threaded result mail with the attach line and stop command, the command replies, and the mail that gets no reply">
</picture>

## Commands

```bash
pi-mailbridge starter check            # config, roots, tmux, pi, DMARC; refuses on a problem
pi-mailbridge starter repair           # after an unreadable journal: set it aside, keep the bytes
pi-mailbridge starter locks             # report stale locks (path + pid); removal is yours to make
pi-mailbridge starter run              # the watcher (singleton; run it under a supervisor)
pi-mailbridge starter list             # live sessions
pi-mailbridge starter stop <name>      # stop one, by its recorded session id
pi-mailbridge starter attach <name>    # tmux attach
pi-mailbridge starter once --dry-run   # show what an interrupted request would run; starts nothing
```

How the request travels: the starter reads its own folder on its own cursor, runs the gates, journals a
reservation before spawning, and mails the result. `stop:` and `list:` come back the same way and act on that
journal.

## Limits and recovery

- **One machine, one channel.** There is no device tag; two starters watching the same mailbox will both
  act on the same request. Give each machine its own prefix, address or folder.
- **`starter-journal.json` has one budget of 500 records** shared by starts, commands and refusals. If it
  fills, admission fails closed, including a mailed `stop:`, until old enough records age out or you run
  `starter repair`. Stop the starter before repair: it sets the old journal aside and starts a new one, losing both replay history and the record of which sessions the starter owns.
- **Receipts grow without bound** by design: one tiny `.handled` file per request and one intent receipt per
  started session. They are what makes a reload safe; deleting them reopens what a reload would reapply.
- **A crash can need a human.** A `SIGKILL` leaves a lock file; nothing clears it automatically. Use
  `starter locks`, confirm the pid is gone, and remove the file by hand.
- Result delivery retries. A crash after SMTP accepted a result but before it was recorded can
  duplicate that mail.

For a single mailbox, `security.allowSelfReplies` must be `true`. QQ does not stamp an `Authentication-Results` header on self-mail, so requiring DMARC there causes the starter to ignore the request. Turning DMARC off leaves only the sender address to authorise a launch. `starter check` reports that risk; the watcher log records why a message was ignored.

## Starter settings

| Key | Default | Meaning |
| --- | --- | --- |
| `starter.enabled` | `false` | The switch. `false` ignores all starter mail (silently); `starter check` refuses while it is off |
| `starter.roots` | `[]` | A session's `cwd` must be *inside* one of these; empty means **no** mail can start a session |
| `starter.channel.subjectPrefix` | `"pi-start"` | The subject tag that addresses this starter |
| `starter.channel.address` | `""` | A dedicated address; when set it replaces the prefix rather than adding to it |
| `starter.channel.folder` | `""` | A separate folder for the starter to watch; empty means `mail.imap.folder` |
| `starter.defaultCwd` | `""` | Used when a request has no `cwd:`; still validated against `roots` |
| `starter.models` | `[]` | An explicit `model:` must be on this list |
| `starter.defaultModel` | `""` | Used when a request names no model; must be `provider/model` |
| `starter.maxSessions` | `4` | Live sessions; a swept-dead session frees its slot |
| `starter.startsPerHour` | `6` | Attempts per hour, counted by launch (a stop does not refund); `0` disables the limit |
| `starter.parserAttemptsPerHour` | `6` | Budget for stage B (the optional parser), separately |
| `starter.confirmationsPerHour` | `12` | Result mails per hour; `0` disables the limit |
| `starter.promptMaxChars` | `8000` | Longer prompts are refused, not truncated |
| `starter.autoEnableMail` | `true` | The started session mails you back (`PI_MAILBRIDGE_SESSION_MODE=on`) |
| `starter.requestMaxAgeHours` | `48` | Freshness window *and* the minimum tombstone lifetime; `0` means unlimited |
| `starter.scanIntervalSecs` | `60` | The sweep; IDLE is the fast path |
| `starter.parse.agent` | `false` | Stage B: one isolated pi run proposes a missing `cwd` |
| `starter.parse.model` | `""` | Required when `parse.agent` is on; stage B never inherits a default |
| `starter.parse.tools` | `"read,grep,find,ls"` | Validated against the read-only set; anything else is ignored with a warning |
| `starter.parse.timeoutMs` | `120000` | Must be positive |
| `starter.log.maxBytes` / `.keep` | `5` MB / `3` | Rotated append-only log in the state directory |

## How delivery works

<picture>
  <source srcset="https://cdn.jsdelivr.net/npm/@dumbmice/pi-mailbridge@latest/docs/images/starter-flow.svg" type="image/svg+xml">
  <img src="https://cdn.jsdelivr.net/npm/@dumbmice/pi-mailbridge@latest/docs/images/starter-flow.png" alt="The mailbox, the starter process and the tmux session, numbered from fetch through spawn, readiness and result, with stop and list routed above and the gate order below">
</picture>
