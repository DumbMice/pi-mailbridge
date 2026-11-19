# A disposable, live end-to-end harness for the session starter.
#
# It installs the package from the tarball this checkout would publish (not from source), plus tmux and
# pi, so the test exercises the same files a user gets: dist/starter/bootstrap.js, the bin shim, the
# starter watch/send path, and a real IMAP/SMTP round trip against the account in QQ_EMAIL.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux ca-certificates procps \
 && rm -rf /var/lib/apt/lists/*

# The coding agent the starter launches. Kept global so `pi` is on PATH exactly as for a user.
RUN npm install -g @earendil-works/pi-coding-agent@latest

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm pack --pack-destination /tmp

# Install the packed tarball, so the test runs the shipped artefact rather than the checkout.
RUN npm install -g /tmp/dumbmice-pi-mailbridge-*.tgz

# Warm pi's TUI first-run as root (the HOME the test uses): on first interactive start pi npm-installs
# ~200 packages, which otherwise eats the starter's readiness window. Headless `pi --version` does not
# trigger it, so this starts a real tmux session and waits for the install to finish.
RUN mkdir -p /work && tmux -L warm new-session -d -s warm -c /work -- pi -n warm --session-id pi-warm-1 --model openai-codex/gpt-6.1-sol \
 && sleep 45 && tmux -L warm kill-server || true

WORKDIR /work
COPY scripts/live/entry.sh /usr/local/bin/live-entry
COPY scripts/live/send.mjs /usr/local/bin/live-send.mjs
COPY scripts/live/await-prime.mjs /usr/local/bin/live-await-prime.mjs
COPY scripts/live/tmux-restart.mjs /usr/local/bin/live-tmux-restart.mjs
RUN chmod +x /usr/local/bin/live-entry

ENTRYPOINT ["/usr/local/bin/live-entry"]
