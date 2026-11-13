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
3. **Scan on a timer, not only on IMAP events.** `daemon.scanIntervalSecs` (default 60) sweeps
   while mode is on: a provider can stop pushing `EXISTS`, and a reply must not depend on it.
   Poll by UID cursor. Never `UNSEEN`, never by SUBJECT alone. `\Seen` is
   shared mutable state.
4. **The routing id routes; it does not authorize.** Sender allowlist and DMARC come first
   (pinning the `authserv-id` is optional, and wrong for consumer accounts). DMARC is off in
   the single-mailbox layout, where the provider stamps no header on self-addressed mail.
5. **One daemon per state directory.** `daemon.lock` decides: `wx` create with the pid
   inside, a live holder means exit 0, a dead one is stolen by renaming the file aside (never
   unlinking it - two stealers must not both win), and SIGTERM releases it. The port is a second
   guard, not the lock, because two processes can disagree about `daemon.port`.
6. **`agent_settled`, not `agent_end`.** `agent_end` precedes retries,
   compaction and queued follow-ups.
7. **Injection is `deliverAs: "followUp"`.** Never inject as `steer` by default.
8. **Never log** the password, the bearer token, the HMAC key, or a full subject
   line that contains a token.

## Layout

`docs/ARCHITECTURE.md` §8 is the authoritative module map (a test checks it against
`src/` in both directions). Read it there rather than keeping a copy here that goes stale.

```
src/extension.ts     pi entry: tools, commands, events, polling client
src/core/            authz, config, mailer, token, reply parsing, oauth, rendering, settle
src/daemon/          main (CLI, lifecycle, periodic sweep), service (HTTP), watcher (IDLE), process (scan)
src/store/           paths, secret, pending, journal, routes, threads, cursor, mode, registry, oauth
docs/                ARCHITECTURE, SECURITY, OAUTH, MAPPING
test/                unit tests — must never touch real IMAP or SMTP
```

## Wording

Four words for four different things. They have already been confused once, in a way that made a
release note say the daemon "rebuilds" - as if `tsc` ran on a user's machine.

- **build** - compiler output only: `npm run build` → `dist/`, run by `prepublishOnly` and
  `pretest`. Never at runtime. "The compiled daemon", "the package build".
- **wire / re-create** - the session's in-process objects (`client`, `notifier`, `runner`).
  Never "rebuild". `startRuntime()` wires them; a replacement re-creates them.
- **spawn / replace / restart** - the daemon *process*. `ensureDaemon` spawns it; a version
  mismatch replaces it; `/mailbridge restart` restarts it.
- **version** - the package version, one per build. `/health` carries `version`, the panel prints
  "daemon version", and the object that compares them is `needsRestart`.

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
