# Live test: one real mail, end to end, in Docker

This is the proof that the starter works against a real mailbox, not a fixture. It installs the packed
tarball (the artefact a release would publish), then:

1. writes a config for your account and runs `pi-mailbridge starter check`;
2. starts `starter run` in the background;
3. sends **one real mail** to the same address: subject `[pi-start] docker live <id>`, body with `cwd:`
   and `prompt:`;
4. waits for the journal to record a started request, lists the tmux session, and greps the spawned pi
   session for the literal prompt;
5. waits for `resultSent: true`, so the confirmation mail also went out.

It uses the package's own IMAP/SMTP path plus nodemailer for *sending* the request (a human's mail, not
the package's own stamped mail, which the starter correctly ignores).

## Requirements

- Docker.
- The account's **IMAP/SMTP authorisation code**, not the web password. For QQ: Settings → Account →
  Enable IMAP/SMTP → generate 授权码.
- pi's provider auth on the host (`~/.pi`), mounted read-only and copied into the container's HOME.

## Run

```bash
QQ_EMAIL='you@qq.com' \
QQ_AUTH='the-authorisation-code' \
STARTER_MODEL='deepseek/deepseek-flash' \
./scripts/live/run.sh
```

Optional:

- `REQUIRE_DMARC=0` — relax DMARC for transport debugging. The default is `1`, and `check` refuses a
  DMARC-off configuration by design, which is exactly what we want to prove.
- `PI_AUTH=/path/to/.pi` — a different pi auth directory.

Artifacts (journal, watcher log, tmux listing) are copied to a temp directory printed at the end.

## What a pass looks like

```
== starter check
starter: ok

== start the watcher

== send a real request
sent <...@qq.com>

== wait for the journal to record a started request

== tmux session
live-...: 1 windows (created ...)

== the spawned pi session recorded the literal prompt

== result recorded as sent

== LIVE TEST PASSED
```

## What it does not prove

- That the launched agent answers *correctly* — only that pi started a turn with the literal prompt.
- Multiple machines on one mailbox (there is no device tag; use distinct channels).
- That a provider keeps our headers; a marker-stripping provider is a documented prerequisite for echo
  detection.
