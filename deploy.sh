#!/bin/sh
# Deploy this checkout to the server it runs on (run as root): game files for Caddy, the match server, config.
# Safe to run again; it only restarts what changed.
set -eu
cd "$(dirname "$0")"
id blockwars >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin blockwars
command -v sqlite3 >/dev/null || apt-get install -y -qq sqlite3 >/dev/null

install -d /var/www/block_wars /srv/block_wars/server
install -m 644 sim.html /var/www/block_wars/index.html
install -m 644 sim-core.js /var/www/block_wars/sim-core.js
install -m 644 sim-core.js /srv/block_wars/sim-core.js
install -m 644 server/server.js /srv/block_wars/server/server.js

for f in block-wars.service block-wars-backup.service block-wars-backup.timer; do install -m 644 "ops/$f" "/etc/systemd/system/$f"; done
systemctl daemon-reload
systemctl enable --now block-wars-backup.timer >/dev/null
systemctl enable block-wars >/dev/null 2>&1
systemctl restart block-wars

install -m 644 ops/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy

sleep 1
systemctl is-active --quiet block-wars && echo "deployed: https://cubewars.io (server $(systemctl is-active block-wars))"
