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
- **spawn / replace / restart** - the daemon *process*. `ensureDaemon` spawns it, refuses to reuse one on another protocol, and
  the session replaces it; `/mailbridge restart` restarts it.
- **version** - the package version, one per build: diagnostic only, for the panel and bug reports.
- **protocol** (`API_VERSION` in `daemon/api.ts`) - the wire contract. Strict equality: another
  protocol is never negotiated down. **Direction decides who moves**: an older daemon is replaced
  (this session is current); a newer one is not killed, because it belongs to a newer pi - the
  session latches, drops its runtime and asks for a restart of pi. Killing a newer daemon would
  break every newer session on the machine, once a minute.
- **schema version** (`STATE_VERSION` in `store/schema.ts`) - the on-disk shape. Refuse newer,
  migrate older.

## Compatibility

Two clocks, because they recover differently. A **protocol** mismatch is fixed by replacing a
process (seconds). A **schema** mismatch is data: it can only be migrated, or refused.

- **Adding** to the wire inside one protocol version: new fields optional, new endpoints or fields
  gated by `CAPABILITIES`; never flip optional to required, never remove or rename a field, never
  narrow a type. A field you stop sending stays accepted.
- **Breaking** the wire: bump `API_VERSION`, and expect every running daemon to be replaced. The
  schema test in `test/api-schema.test.ts` freezes the endpoint list so this is deliberate.
- **State files** (`STATE_VERSION` in `store/schema.ts`): absent `v` means schema 1 (read it, stamp on the next save); older is migrated on
  read; newer is refused for both reading *and* writing. Filtering unknown records and saving the
  rest is how state is silently lost.
- **Shims** carry a tag: `// COMPAT(<name>): added in vX, remove after <date>`. `rg "COMPAT\("` is
  the cleanup backlog.

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

The exception is deliberate and local: `test/daemon-lifecycle.test.ts`,
`test/daemon-service.test.ts`, `test/e2e.test.ts`, `test/loopback-http.test.ts` and
`test/uid-space-chain.test.ts` bind a server on `127.0.0.1` — loopback only, nothing leaves the
machine, and the transport and service tests need a real socket to prove what they claim. The
transport adds no runtime dependency of its own (the package's runtime dependencies are listed
above); the devDependencies are TypeScript and type stubs.

## The daemon transport ignores proxies

pi installs a global proxy dispatcher, so `HTTP_PROXY` without loopback in `NO_PROXY` makes the
daemon look unreachable while it is up. The client uses `daemon/loopback-http.ts` — `node:http`
behind a `fetch` shape — so proxy configuration cannot reach it. Do **not** fix this by writing to
`NO_PROXY`: that works, but it mutates the environment of the whole pi process, which every other
extension and every child process inherits. Keep the fix package-scoped. If the daemon ever needs
compression or redirects, add them here rather than switching back to `fetch`.

## Scope boundary

This package's **daemon and extension do not create or switch sessions**; that is the session starter's
job, in its own process (§7a of ARCHITECTURE.md), and it is the only exception. Do not add session creation
to the extension: `ctx.newSession()` replaces
the active session in-process, which is a different architecture (an RPC
supervisor owning `pi --mode rpc` children). Do not add it here without a design
doc.

## Publishing

**A tag is published by a human, not inferred.** Pushing a `v*` tag publishes irreversibly, so it needs
an explicit go-ahead from the operator for *that* version - "build it" is not "release it", and an
announced intention is not consent. Two rules learned the hard way: never release code that changed
after the last review verdict (review the exact commit you tag), and never treat silence as approval.

A tag publishes; nothing does it from a laptop any more. Bump `package.json`
(and the two version mentions in the README, and `package-lock.json` — `npm version patch` does
both lockfile fields for you), date the changelog, then:

```bash
git tag -a v<version> -m "pi-mailbridge <version>" && git push origin main --tags
```

`.github/workflows/publish.yml` runs the gate, refuses a version already on the registry, and
publishes with **npm trusted publishing** (OIDC + provenance, `--access public`) - there is no
`NPM_TOKEN` anywhere. First publish of a new package still has to happen by hand, because npm can
only attach a trusted publisher to a package that exists.

Two traps that have already cost a version each:

- **the registry lags the green workflow by minutes, not seconds** (measured: 2 min for
  0.1.2, 4.5 min for 0.1.4) - poll
  `registry.npmjs.org/@dumbmice%2fpi-mailbridge/<version>` before concluding anything, and remember
  `npm view` caches locally (`--prefer-online`);
- **a published README cannot be edited.** The package page renders the *latest* version's README,
  so any README fix is a new version. Get it right before tagging.

README images must be **absolute and reachable by the reader**: npm renders the README out of the
tarball with no base URL, and `raw.githubusercontent.com` is unreachable on many mainland networks
(that is why 0.1.3 moved them to `cdn.jsdelivr.net/npm/@dumbmice/pi-mailbridge@latest/…`, which
also serves the published bytes). `test/packaging.test.ts` fails on a relative path or on the raw
host, so this cannot quietly regress.
