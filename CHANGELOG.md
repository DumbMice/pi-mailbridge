# Changelog

## 0.1.0 — unreleased (workspace scaffold)

Initial workspace. Not yet installable.

### Added

- `src/core/token.ts` — HMAC-signed routing tokens (`[pi:<payload>.<mac>]`) with
  TTL, constant-time verification, and prefix-tolerant subject extraction.
- `src/store/paths.ts` — single XDG state directory for key, cursor, pending,
  journal and mode.
- `src/store/secret.ts` — 32-byte shared key, atomic `wx` create at mode 0600,
  first-writer-wins.
- `src/core/config.ts` — layered config (defaults → file → env) with
  non-throwing validation and human-readable warnings.
- `src/extension.ts` — pi entry: `/afk`, `/back`, `/mailbridge`; debounced
  `agent_settled` notification path; `request_decision` and `notify_user` tool
  shapes; abort-aware.
- `src/daemon/main.ts` — daemon skeleton: single-instance port lock, constant-time
  bearer auth, SSE endpoint, bounded bodies and clients, mode routes.
- `docs/` — architecture, module mapping from `opencode-afk`, security model.
- `test/token.test.ts` — token round-trip, prefix tolerance, MAC forgery,
  tampering, expiry, malformed input.

### Known gaps

- IMAP IDLE watcher (`src/daemon/watcher.ts`) — stub.
- Scan pipeline (`src/daemon/process.ts`) — stub.
- Pending/claim/ack, uid-cursor, mode store, registry — not yet ported.
- Extension's daemon client (SSE subscribe, claim, inject) — not yet wired.
- Reply parsing / quote stripping — pending port from `core/reply-parse.js`.
- Multi-session: daemon topology is designed for it; the claim path is unbuilt.
- OAuth2 / XOAUTH2 sender path for Outlook — configured, unimplemented.
