# pi-mailbridge

Drive your Pi coding-agent sessions from your mailbox.

Your agent reaches a decision you can't answer from your desk. It emails you.
You reply from your phone. That exact session continues.

- **One mailbox connection per machine.** A small local daemon owns a single
  IMAP IDLE connection; every Pi session is a thin client. N sessions, one
  watcher, no polling race.
- **Reply = resume.** The reply is injected into the session that sent the mail,
  as a follow-up, so it queues correctly if a run is still in flight.
- **Explicit, not inferred.** `/afk` turns email mode on; `/back` turns it off.
  No focus heuristics, no "probably idle".
- **Crash-safe.** Mail is only marked seen *after* the reply is injected and
  acked. A crash leaves it unseen and durable, so nothing is lost.

## Install

```bash
pi install npm:pi-mailbridge
```

Then write `~/.config/pi-mailbridge/config.json` from
[`config.example.json`](./config.example.json) and start the daemon.

## Commands

| Command | Effect |
| --- | --- |
| `/afk` | Email mode on: decisions mail you and end the turn |
| `/back` | Email mode off: decisions ask in the terminal |
| `/mailbridge` | Status: mode, session, secret, mailbox, daemon health |

## Security first

This package makes your inbox a control channel for an agent that can run shell
commands. **Read [docs/SECURITY.md](./docs/SECURITY.md) before installing.**

It gate-keeps with, in order: a sender allowlist, DMARC pinned to a trusted
`authserv-id`, an HMAC-signed routing token with a TTL, and a durable replay
journal. The token routes — it never authorizes.

Prefer a dedicated account or a filtered folder. Do not run this against a
mailbox that receives untrusted mail.

## Design

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — topology, delivery pipeline,
  daemon HTTP surface, failure modes
- [docs/MAPPING.md](./docs/MAPPING.md) — module-by-module port from
  [`opencode-afk`](https://github.com/7emotions/afk), and what we deliberately
  changed

## Status

`0.1.0` — workspace scaffold. The routing-token core, config layer, secret
store and daemon skeleton are in place and tested; the IMAP watcher, the reply
pipeline and the extension's daemon client are stubs. Not yet safe to install.

## License

MIT
