#!/usr/bin/env bash
# The boot screen's check. Runs a portal image locally with THIS checkout's runtime files
# mounted over /app/multitec, so it tests the working tree even on an image built before
# them, and against the image's OWN nginx template, so an upstream change to the anchors
# boot.sh patches fails here.
#
#   docs/multitec/runtime/test-boot-screen.sh <image>
#
# Needs docker and curl, nothing else. Exit 0 only if every check passes.
#
# Three phases:
#   A. nginx with NOTHING behind it, the state a cold instance is in for its first seconds.
#      Who gets the screen, who gets a bare 503, that the long-poll really holds the
#      request, and that icons are served with a year's cache (and a 404 is not).
#   B. The NEGATIVE CONTROL: the same requests against upstream's own boot. The screen
#      checks must fail there, or phase A proves nothing.
#   C. A real boot against a throwaway Postgres, migrations run beforehand exactly as the
#      build now does and disabled at boot exactly as the deployment does: the screen
#      comes first, the long-poll returns when Homarr is healthy, and after it the page
#      is Homarr's own.
set -uo pipefail
export LC_ALL=C

image=${1:?usage: test-boot-screen.sh <image>}
here=$(cd "$(dirname "$0")" && pwd)
tag="mtboot-$$"
work=$(mktemp -d)
fails=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

cleanup() {
  docker rm -f "$tag-a" "$tag-b" "$tag-c" "$tag-pg" >/dev/null 2>&1
  docker network rm "$tag" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

docker network create "$tag" >/dev/null
mkdir -p "$work/feeds/icons"
printf 'RIFF\0\0\0\0WEBPfake' > "$work/feeds/icons/0123456789abcdef.webp"

mounts=(-v "$here:/app/multitec:ro" -v "$work/feeds:/feeds:ro")
nginx_only='envsubst "\${NGINX_LISTEN_IPV6}" < /etc/nginx/templates/nginx.conf > /etc/nginx/nginx.conf && exec nginx -g "daemon off;"'

# Into a file first, then grep: `docker logs | grep -q` under pipefail fails whenever grep
# exits early and docker logs dies of SIGPIPE, which is a flaky FAIL on a line that is there.
logs_have() { docker logs "$1" > "$work/logs.txt" 2>&1; grep -q "$2" "$work/logs.txt"; }
wait_log() { for _ in $(seq 1 100); do logs_have "$1" "$2" && return 0; sleep 0.1; done; return 1; }

wait_port() { # name port
  for _ in $(seq 1 100); do
    curl -s -o /dev/null "http://127.0.0.1:$2/" && return 0
    sleep 0.1
  done
  return 1
}
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

# request <port> <outfile-prefix> [curl args...] -> writes .code .headers .body .time
request() {
  local port=$1 out=$2; shift 2
  curl -s -o "$out.body" -D "$out.headers" -w '%{http_code} %{time_total}' "$@" "http://127.0.0.1:$port${path:-/}" > "$out.meta"
  read -r code time < "$out.meta"; echo "$code" > "$out.code"; echo "$time" > "$out.time"
}
nav=(-H "Sec-Fetch-Mode: navigate" -H "Accept: text/html,application/xhtml+xml")

screen_checks() { # port label
  local p=$1 l=$2
  path=/ request "$p" "$work/nav" "${nav[@]}"
  check "$l: a navigation gets 503" '[ "$(cat "$work/nav.code")" = 503 ]'
  check "$l: ... with the boot screen in it" 'grep -q multitec-boot-screen "$work/nav.body"'
  check "$l: ... not cacheable" 'grep -qi "^cache-control: no-store" "$work/nav.headers"'
  check "$l: ... and a Retry-After" 'grep -qi "^retry-after: 2" "$work/nav.headers"'
  check "$l: ... served as HTML" 'grep -qi "^content-type: text/html" "$work/nav.headers"'
  path=/ request "$p" "$work/old" -H "Accept: text/html"
  check "$l: an old browser (no Sec-Fetch-Mode) asking for HTML gets the screen" 'grep -q multitec-boot-screen "$work/old.body"'
}

echo "== A. nginx with nothing behind it"
pa=$(free_port)
docker run -d --name "$tag-a" -p "127.0.0.1:$pa:7575" "${mounts[@]}" -e MULTITEC_READY_TIMEOUT_MS=1500 \
  --entrypoint sh "$image" /app/multitec/boot.sh sh -c "$nginx_only" >/dev/null
wait_port a "$pa" || fail "nginx never listened"
wait_log "$tag-a" "waiter listening" || fail "the waiter never listened"
screen_checks "$pa" A

path=/api/trpc/board.getHomeBoard request "$pa" "$work/trpc" -H "Accept: */*" -H "Sec-Fetch-Mode: cors"
check "A: a tRPC call gets 503" '[ "$(cat "$work/trpc.code")" = 503 ]'
check "A: ... and NOT the screen" '! grep -q multitec-boot-screen "$work/trpc.body"'
check "A: ... with a Retry-After" 'grep -qi "^retry-after: 2" "$work/trpc.headers"'
path=/api/webhook request "$pa" "$work/post" -X POST -H "Accept: text/html" -H "Content-Type: application/json" --data '{}'
check "A: a POST asking for HTML still gets a bare 503, never the screen" '[ "$(cat "$work/post.code")" = 503 ] && ! grep -q multitec-boot-screen "$work/post.body"'
path=/api/trpc/x request "$pa" "$work/fetchhtml" -H "Accept: text/html" -H "Sec-Fetch-Mode: cors"
check "A: a fetch() that asks for HTML is not a navigation" '! grep -q multitec-boot-screen "$work/fetchhtml.body"'
path=/__multitec/ready request "$pa" "$work/ready"
check "A: the long-poll HOLDS the request while Homarr is down (>= 1.4 s of a 1.5 s budget)" \
  'awk "BEGIN{exit !($(cat "$work/ready.time") >= 1.4)}"'
check "A: ... and then says 503" '[ "$(cat "$work/ready.code")" = 503 ]'
path=/multitec-static/icons/0123456789abcdef.webp request "$pa" "$work/icon"
check "A: an icon is served 200 while Next.js is still down" '[ "$(cat "$work/icon.code")" = 200 ]'
check "A: ... as image/webp" 'grep -qi "^content-type: image/webp" "$work/icon.headers"'
check "A: ... cached privately for a year, immutable" 'grep -qi "^cache-control: private, max-age=31536000, immutable" "$work/icon.headers"'
path=/multitec-static/icons/missing.webp request "$pa" "$work/noicon"
check "A: a missing icon is a 404 that is NOT cached for a year" \
  '[ "$(cat "$work/noicon.code")" = 404 ] && ! grep -qi "max-age=31536000" "$work/noicon.headers"'

echo "== B. negative control: upstream's boot, no wrapper"
pb=$(free_port)
docker run -d --name "$tag-b" -p "127.0.0.1:$pb:7575" "${mounts[@]}" \
  --entrypoint sh "$image" -c "$nginx_only" >/dev/null
wait_port b "$pb" || fail "vanilla nginx never listened"
before=$fails
screen_checks "$pb" "B (expected to FAIL)" >/dev/null
if [ "$fails" -gt "$before" ]; then
  pass "B: without the wrapper the screen checks fail ($((fails - before)) of them), so phase A is measuring the wrapper"
  fails=$before
else
  fail "B: the screen checks PASS without the wrapper, so they prove nothing"
fi
path=/ request "$pb" "$work/vanilla" "${nav[@]}"
check "B: vanilla Homarr answers a cold navigation with nginx's bare 502" '[ "$(cat "$work/vanilla.code")" = 502 ]'

echo "== C. a real boot against a throwaway Postgres"
docker run -d --name "$tag-pg" --network "$tag" -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=portal postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$tag-pg" pg_isready -q >/dev/null 2>&1 && break; sleep 0.5; done
sleep 1
db="postgres://postgres:pw@$tag-pg:5432/portal"
docker run --rm --network "$tag" -w /app --entrypoint node -e DB_DRIVER=node-postgres -e DB_DIALECT=postgresql \
  -e DB_URL="$db" -e DISABLE_REDIS_LOGS=true "$image" ./db/migrations/postgresql/migrate.cjs ./db/migrations/postgresql >/dev/null 2>&1
migrated=$?
check "C: migrations run on their own, outside the boot, as the build runs them" '[ "$migrated" -eq 0 ]'

pc=$(free_port)
t0=$(date +%s.%N)
docker run -d --name "$tag-c" --network "$tag" --cpus=1 -p "127.0.0.1:$pc:7575" "${mounts[@]}" \
  -e DB_DRIVER=node-postgres -e DB_DIALECT=postgresql -e DB_URL="$db" -e DB_MIGRATIONS_DISABLED=true \
  -e SECRET_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  "$image" sh -c "unset PORT; exec sh /app/multitec/boot.sh" >/dev/null
wait_port c "$pc" || fail "nginx never listened in a real boot"
path=/ request "$pc" "$work/first" "${nav[@]}"
t_first=$(echo "$(date +%s.%N) - $t0" | bc)
check "C: the first navigation of a real boot is the screen" 'grep -q multitec-boot-screen "$work/first.body"'
# As the screen does: ask again when the answer is not 200. The first ask can land before
# the waiter itself is listening (node takes half a second), which nginx turns into a
# plain 503, and the screen simply retries.
for _ in $(seq 1 90); do
  path=/__multitec/ready request "$pc" "$work/cready"
  [ "$(cat "$work/cready.code")" = 200 ] && break
  sleep 1
done
t_ready=$(echo "$(date +%s.%N) - $t0" | bc)
check "C: the long-poll returns 200 once Homarr is healthy" '[ "$(cat "$work/cready.code")" = 200 ]'
path=/ request "$pc" "$work/after" "${nav[@]}"
check "C: after it, the navigation is Homarr's own answer, not the screen" \
  '[ "$(cat "$work/after.code")" != 503 ] && ! grep -q multitec-boot-screen "$work/after.body"'
check "C: migrations really were skipped at boot" 'logs_have "$tag-c" "DB migrations are disabled"'
check "C: the waiter logged the boot time" 'logs_have "$tag-c" "multitec-boot: homarr healthy"'
check "C: nginx really was patched (no anchor warning)" '! logs_have "$tag-c" "anchors not found"'
check "C: the waiter woke the database" 'logs_have "$tag-c" "multitec-boot: database answered"'
printf '  info  screen after %.1fs, portal healthy after %.1fs (1 vCPU, local Postgres)\n' "$t_first" "$t_ready"

echo
if [ "$fails" -eq 0 ]; then echo "test-boot-screen: OK"; exit 0; fi
echo "--- last lines of the real boot, for the failure above:"
docker logs --tail 30 "$tag-c" 2>&1 | grep -v "Skipping seeding"
echo "test-boot-screen: $fails FAILED"; exit 1
