# AGENTS.md — pi-mailbridge

Guidance for agents and contributors working in this repository.

## What this is

A pi extension plus a local daemon that let a human drive Pi sessions by email.
Read `docs/ARCHITECTURE.md` and `docs/MAPPING.md` before changing behaviour;
`docs/SECURITY.md` before touching anything on the auth path.

## Non-negotiable invariants

Break one of these and the package loses mail or becomes a hole:

1. **`\Seen` and the journal append happen only in `/ack`**, after a session has
   injected the reply. Never at parse time.
2. **The UID cursor advances only after the pending record is durable.** Never
   before, never on broadcast.
3. **Poll by UID cursor.** Never `UNSEEN`, never by SUBJECT alone. `\Seen` is
   shared mutable state.
4. **The routing id routes; it does not authorize.** Sender allowlist and DMARC come
   first, always (pinning the `authserv-id` is optional, and wrong for consumer accounts).
5. **One daemon per machine.** The port is the lock; `EADDRINUSE` means exit 0.
6. **`agent_settled`, not `agent_end`.** `agent_end` precedes retries,
   compaction and queued follow-ups.
7. **Injection is `deliverAs: "followUp"`.** Never inject as `steer` by default.
8. **Never log** the password, the bearer token, the HMAC key, or a full subject
   line that contains a token.

## Layout

```
src/extension.ts     pi entry: tools, commands, events, polling client
src/core/            config, mailer, token, reply parsing, strings
src/daemon/          main (HTTP+SSE), watcher (IDLE), process (scan pipeline)
src/store/           paths, secret, pending, uid-cursor, mode, registry
docs/                ARCHITECTURE, MAPPING, SECURITY
test/                unit tests — must never touch real IMAP or SMTP
```

## Style

- ESM only, `.ts` imports with explicit extension.
- Node built-ins first; the only runtime dependencies are `imapflow`, `mailparser`,
  `markdown-it`, `nodemailer` and `openid-client`. Justify any addition.
- Pure functions for anything testable: token signing, reply parsing, cursor
  maths, config merging.
- No `any` in `src/store` or `src/core/token.ts` — they are the trust boundary.

## Testing

```bash
npm test          # node --test, no network
npm run typecheck
```

Tests must be hermetic. Inject a fake SMTP transport; never open a socket.

## Scope boundary

This package **does not create or switch sessions.** `ctx.newSession()` replaces
the active session in-process, which is a different architecture (an RPC
supervisor owning `pi --mode rpc` children). Do not add it here without a design
doc.

## Publishing

`npm publish --access public` after: tests green, `docs/MAPPING.md` publish
checklist satisfied, no `config.json` or `secret.key` in the tarball
(`npm pack --dry-run` to verify).
