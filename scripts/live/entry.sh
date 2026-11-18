#!/usr/bin/env bash
# Runs inside the container. Writes a starter config, proves `check`, starts the watcher, sends one real
# request to the account itself, and waits for the whole chain: journal reservation -> tmux session ->
# pi turn -> result recorded.
set -euo pipefail

: "${QQ_EMAIL:?QQ_EMAIL is required}"
: "${QQ_AUTH:?QQ_AUTH is required}"
MODEL="${STARTER_MODEL:-deepseek/deepseek-flash}"
# DMARC is required by default: the live test should prove the real gate, not a relaxed one. Set
# REQUIRE_DMARC=0 only to isolate a mail-transport problem, and note that `check` then reports it.
REQUIRE_DMARC="${REQUIRE_DMARC:-1}"
REQUEST_ID="live-$(date +%s)"

export HOME=/root
export XDG_CONFIG_HOME=/runtime/config
export XDG_STATE_HOME=/runtime/state
mkdir -p "$HOME" "$XDG_CONFIG_HOME/pi-mailbridge" "$XDG_STATE_HOME" /work/project
# pi needs its provider auth. /pi-auth holds only the small files (auth.json, settings.json); copying the
# whole ~/.pi would drag in installs and sessions and make the test take minutes.
mkdir -p "$HOME/.pi/agent"
for f in auth.json; do
	[ -f "/pi-auth/$f" ] && cp "/pi-auth/$f" "$HOME/.pi/agent/$f"
done
[ -f "$HOME/.pi/agent/auth.json" ] || { echo "live: no pi auth.json was provided" >&2; exit 2; }

cat >"$XDG_CONFIG_HOME/pi-mailbridge/config.json" <<JSON
{
  "mail": {
    "imap": { "host": "imap.qq.com", "port": 993, "secure": true, "user": "$QQ_EMAIL", "password": "$QQ_AUTH", "folder": "INBOX" },
    "smtp": { "host": "smtp.qq.com", "port": 465, "secure": true, "user": "$QQ_EMAIL", "password": "$QQ_AUTH", "authType": "LOGIN" },
    "to": "$QQ_EMAIL"
  },
  "device": { "name": "docker-live" },
  "security": { "allowFrom": ["$QQ_EMAIL"], "requireDmarcPass": $([ "$REQUIRE_DMARC" = 1 ] && echo true || echo false), "allowSelfReplies": true, "tokenTtlHours": 24 },
  "notify": { "onSettled": false, "debounceMs": 0, "notifyOnAborted": false, "maxAttachmentMb": 8 },
  "starter": {
    "enabled": true,
    "roots": ["/work"],
    "models": ["$MODEL"],
    "defaultModel": "$MODEL",
    "channel": { "subjectPrefix": "pi-start", "address": "", "folder": "" },
    "autoEnableMail": false,
    "scanIntervalSecs": 3,
    "requestMaxAgeHours": 24,
    "maxSessions": 2,
    "startsPerHour": 4,
    "confirmationsPerHour": 20
  }
}
JSON
chmod 600 "$XDG_CONFIG_HOME/pi-mailbridge/config.json"

step() { printf '\n== %s\n' "$*"; }

step "starter check"
set +e
CHECK_OUT="$(pi-mailbridge starter check 2>&1)"
CHECK_CODE=$?
set -e
printf '%s\n' "$CHECK_OUT"
if [ "$REQUIRE_DMARC" = 1 ]; then
	[ "$CHECK_CODE" = 0 ] || { echo "live: starter check reported a problem"; exit 1; }
else
	# With DMARC deliberately off, `check` must complain about exactly that and nothing else.
	OTHER="$(printf '%s\n' "$CHECK_OUT" | grep -v 'requireDmarcPass is false' | grep -v 'starter: 1 problem' | grep '^!' || true)"
	[ -z "$OTHER" ] || { echo "live: starter check reported an unexpected problem: $OTHER"; exit 1; }
fi

step "start the watcher"
step "send a real request, then place the cursor just before it"
SUBJECT="[pi-start] docker live $REQUEST_ID"
SUBJECT="$SUBJECT" BODY='cwd: /work/project
prompt: Reply with the single word ok, and nothing else.' node /usr/local/bin/live-send.mjs
node /usr/local/bin/live-await-prime.mjs "$SUBJECT"

# The request is already in the mailbox and the cursor sits immediately before it.
pi-mailbridge starter run >/runtime/starter.out 2>&1 &
RUNNER=$!
dump() {
	local code=$?
	kill $RUNNER 2>/dev/null || true
	for f in starter-journal.json starter.log starter.out; do
		[ -f "$XDG_STATE_HOME/pi-mailbridge/$f" ] || [ -f "/runtime/$f" ] || continue
		src="$XDG_STATE_HOME/pi-mailbridge/$f"; [ -f "$src" ] || src="/runtime/$f"
		cp "$src" "/runtime/$f" 2>/dev/null || true
	done
	{ tmux -L pimail list-sessions; for s in $(tmux -L pimail list-sessions -F '#{session_id}' 2>/dev/null); do echo "--- pane $s"; tmux -L pimail capture-pane -p -t "$s" | tail -15; done; } >/runtime/tmux.txt 2>&1 || true
	ps -eo pid,args | grep -E "[p]i |[t]mux" >/runtime/ps.txt 2>&1 || true
	chmod -R a+rX /runtime 2>/dev/null || true
	exit $code
}
trap dump EXIT

step "wait for the journal to record a started request"
JOURNAL="$XDG_STATE_HOME/pi-mailbridge/starter-journal.json"
for _ in $(seq 1 25); do
	if [ -f "$JOURNAL" ] && grep -q '"state":"ready"' "$JOURNAL"; then break; fi
	sleep 1
done
[ -f "$JOURNAL" ] && grep -q '"state":"ready"' "$JOURNAL" || { echo "live: no ready request"; cat /runtime/starter.out; exit 1; }

step "tmux session"
tmux -L pimail list-sessions

step "the spawned pi session recorded the literal prompt"
# pi writes one session file per pi session id under the cwd-keyed directory.
PROMPT_OK=0
for _ in $(seq 1 15); do
	if grep -rl "Reply with the single word ok" "$HOME/.pi/agent/sessions" >/dev/null 2>&1; then PROMPT_OK=1; break; fi
	sleep 1
done
[ "$PROMPT_OK" = 1 ] || { echo "live: the prompt never reached a session"; exit 1; }

step "result recorded as sent"
for _ in $(seq 1 15); do
	if grep -q '"resultSent":true' "$JOURNAL"; then break; fi
	sleep 1
done
grep -q '"resultSent":true' "$JOURNAL" || { echo "live: the result mail was never recorded as sent"; exit 1; }

step "artifacts"
cp "$JOURNAL" /runtime/journal.json
cp /runtime/starter.out /runtime/starter.log 2>/dev/null || true
tmux -L pimail list-sessions >/runtime/tmux.txt 2>&1 || true
printf 'request: %s\njournal: /runtime/journal.json\ntmux: /runtime/tmux.txt\n' "$REQUEST_ID"

echo "== LIVE TEST PASSED"
