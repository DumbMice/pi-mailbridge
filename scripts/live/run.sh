#!/usr/bin/env bash
# Live end-to-end test of the session starter, from a mail arriving over real IMAP to a pi turn starting
# in tmux and the result being recorded.
#
# Required env:
#   QQ_EMAIL   the account (also the allowlisted sender and the result recipient)
#   QQ_AUTH    its SMTP/IMAP authorisation code (QQ: Settings → Account → POP3/IMAP → 授权码)
#   PI_AUTH    host directory holding pi's auth (default: $HOME/.pi), mounted read-only
# Optional:
#   STARTER_MODEL  model id for the started session (default deepseek/deepseek-flash)
#   REQUIRE_DMARC  1 keeps security.requireDmarcPass true (default); 0 relaxes it for transport isolation
set -euo pipefail

need() { [ -n "${!1:-}" ] || { echo "live: $1 is required" >&2; exit 2; }; }
need QQ_EMAIL
need QQ_AUTH

MODEL="${STARTER_MODEL:-deepseek/deepseek-flash}"
# pi keeps auth in ~/.pi/agent; accepting either that or ~/.pi avoids mounting an entire install tree.
PI_AUTH_DIR="${PI_AUTH:-$HOME/.pi/agent}"
[ -f "$PI_AUTH_DIR/auth.json" ] || PI_AUTH_DIR="$HOME/.pi"
REQUIRE_DMARC="${REQUIRE_DMARC:-1}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNTIME="$(mktemp -d "${TMPDIR:-/tmp}/pmb-live-XXXXXX")"
IMAGE="pi-mailbridge-live:local"

echo "== build ($IMAGE)"
docker build -q -f "$ROOT_DIR/scripts/live/Dockerfile" -t "$IMAGE" "$ROOT_DIR"

echo "== pi auth: $PI_AUTH_DIR (only auth.json/settings.json are copied)"
[ -d "$PI_AUTH_DIR" ] || { echo "live: no pi auth at $PI_AUTH_DIR" >&2; exit 2; }
AUTH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pmb-auth-XXXXXX")"
for f in auth.json; do
	[ -f "$PI_AUTH_DIR/$f" ] && cp "$PI_AUTH_DIR/$f" "$AUTH_DIR/$f"
done
chmod 700 "$AUTH_DIR"

echo "== run"
# The container gets its own HOME and XDG dirs; only pi's auth is carried in, read-only.
docker run --rm -i \
	-e QQ_EMAIL -e QQ_AUTH -e STARTER_MODEL -e REQUIRE_DMARC \
	-v "$AUTH_DIR:/pi-auth:ro" \
	-v "$RUNTIME:/runtime" \
	"$IMAGE" 2>&1 | tee "$RUNTIME/console.log"

status=${PIPESTATUS[0]}
echo "== artifacts: $RUNTIME"
exit "$status"
