#!/bin/sh
# Multitec's wrapper around upstream's `run.sh`: a boot screen instead of a blank tab.
#
# The portal scales to zero, so the first member after a quiet spell starts an instance
# from nothing. Before this, Cloud Run held that member's request until Homarr answered
# its health check, about 13 seconds of a white page (agent repo,
# docs/research/portal-cold-start.md), and members read it as "the server is down".
#
# Homarr's own nginx binds 7575 within a second of the container starting, long before
# Next.js can answer. So this wrapper gives that nginx three things, then hands over to
# upstream's boot exactly as before:
#
#   1. the extra nginx configuration in ./nginx/, which the upstream `nginx.conf` template
#      includes from /etc/nginx/multitec/ (an empty glob, and so a no-op, in vanilla
#      Homarr): the boot screen for a person opening a page, a bare 503 for everything
#      else, and the member icons served straight off the feeds volume;
#   2. the boot screen itself, `loading.html`;
#   3. `ready-waiter.mjs`, which holds the boot screen's long-poll open until Homarr is
#      healthy. That open request is not a nicety: under request-based billing Cloud Run
#      only gives the instance CPU while a request is in flight, so a screen that polled
#      every second would leave Homarr booting on a throttled CPU in between.
#
# NOTHING HERE RUNS UNLESS IT IS ASKED FOR. The image's own CMD is still `sh run.sh`; this
# file runs only when the deployment points at it (multitec-terrafrom, `args` of the portal
# service). MULTITEC.md rule 5: with none of our configuration, the fork is vanilla Homarr.
#
# Usage: boot.sh [command...]   (default: sh run.sh). The argument exists for the test,
# which starts nginx alone to pin the boot-screen behaviour while nothing is behind it.
set -eu

here=$(dirname "$0")
feeds=${MULTITEC_FEED_DIR:-/feeds}

mkdir -p /etc/nginx/multitec/http /etc/nginx/multitec/server /usr/share/multitec

# Two `include` lines go into upstream's nginx TEMPLATE here, at runtime, rather than into
# the repository's nginx.conf: editing that file would be one more upstream touchpoint
# (MULTITEC.md rule 1), and the budget was already full. Anchored on the two lines least
# likely to move, `http {` and the `listen 7575;` that Cloud Run's port depends on.
# Directive order inside `server {}` does not matter for locations or `error_page`, so
# right after `listen` is as good as anywhere.
#
# If upstream ever changes either anchor, the boot screen is SKIPPED, loudly, and the
# portal boots exactly as vanilla Homarr: a missing loading screen is a regression, a
# half-patched nginx that will not start is an outage. test-boot-screen.sh runs against
# the real template, so an upstream sync that breaks an anchor fails there first.
template=/etc/nginx/templates/nginx.conf
if ! grep -q "/etc/nginx/multitec/" "$template"; then
  patched=$(mktemp)
  awk '
    /^http[[:space:]]*\{/ && !h { print; print "    include /etc/nginx/multitec/http/*.conf;"; h=1; next }
    /^[[:space:]]*listen 7575;/ && !s { print; print "        include /etc/nginx/multitec/server/*.conf;"; s=1; next }
    { print }
    END { exit (h && s) ? 0 : 1 }
  ' "$template" > "$patched" && cat "$patched" > "$template" \
    || echo "multitec-boot: WARNING nginx template anchors not found, boot screen disabled"
  rm -f "$patched"
fi

cp "$here/nginx/http.conf" /etc/nginx/multitec/http/multitec.conf
# The icons live beside the feed bundles, in the same read-only volume. `|` as the sed
# separator because the value is a path.
sed "s|@MULTITEC_FEED_DIR@|$feeds|g" "$here/nginx/server.conf" > /etc/nginx/multitec/server/multitec.conf
cp "$here/loading.html" /usr/share/multitec/loading.html

node "$here/ready-waiter.mjs" &

# The waiter must be LISTENING before nginx is, and that is measured, not tidiness. The
# startup probe is TCP on nginx, so the moment nginx binds, Cloud Run calls the instance
# started and, with no request in flight, throttles its CPU. On the first deploy of this
# (2026-09-25, revision mt-portal-00027) the waiter then took 60 s to start and Next.js
# three minutes. A screen whose long-poll lands before the waiter listens gets an instant
# 503 instead of an open request, so every retry buys a sliver of CPU and the boot crawls.
# Starting the waiter here, while the instance still has its full (boosted) startup CPU,
# costs a fraction of a second before the screen and makes the long-poll real from the
# very first request.
for _ in $(seq 1 100); do
  if wget -q -O /dev/null http://127.0.0.1:${MULTITEC_READY_PORT:-3002}/alive 2>/dev/null; then
    break
  fi
  sleep 0.05
done

if [ "$#" -eq 0 ]; then
  set -- sh run.sh
fi
exec "$@"
