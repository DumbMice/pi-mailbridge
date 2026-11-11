# Changelog

## 0.1.0 — unreleased (workspace scaffold)

Initial workspace. Not yet installable.

### Added

- `src/daemon/process.ts` — the scan pipeline: UID-cursor search → fetch →
  authorize → verify token → strip quotes → persist → advance. Ordering is the
  correctness property; a thrown fetch/persist stops the scan with the cursor
  before the offending UID so it is retried.
- `src/core/authz.ts` — fail-closed authorization chain: loop guard (self) →
  machine-generated → allowlist (empty denies all) → DMARC pinned to
  `trustedAuthservId`.
- `src/core/reply-parse.ts` — blunt quote stripping (cut at the first
  `On … wrote:`, Outlook banner, underscore rule, `>` block, or RFC 3676
  signature), address normalization, auto-generated detection, and
  `findTrustedAuthResults` which selects only the header bearing our relay's
  `authserv-id` (topmost match).
- `src/store/pending-store.ts` — durable deliveries with a claim state machine
  (exclusive claim, same-instance re-claim, abandoned-claim TTL, claimant-only
  ack).
- `src/store/uid-cursor.ts` — monotonic, atomic, corrupt-file tolerant.
- `src/store/journal.ts` — acked UIDs, capped, for durable replay protection.
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
- `test/` — 44 assertions across token, reply parsing, stores, and the full
  scan pipeline (authorized path, allowlist denial, DMARC failure, **forged
  top `Authentication-Results`**, missing token, forged MAC, loop guards,
  journal dedupe, vanished message, transient-error cursor behaviour,
  incremental second scan, fully-quoted reply).

### Known gaps

- IMAP IDLE watcher (`src/daemon/watcher.ts`) — stub; must implement
  `MailSource`.
- Pending/claim/ack HTTP handlers, uid-cursor, mode store, registry — stores are
  built, the daemon does not call them yet.
- Extension's daemon client (SSE subscribe, claim, inject, ack) — not yet wired.
- Mailer (nodemailer) and `messages.ts` — not yet ported.
- Multi-session: topology and claim path are built; end-to-end unproven.
- OAuth2 / XOAUTH2 sender path for Outlook — configured, unimplemented.
