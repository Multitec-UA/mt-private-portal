#!/usr/bin/env bash
#
# test-upstream-guard.sh — self-test for upstream-guard.sh.
#
# A linter nobody tests is a linter that quietly starts passing everything. Each case here
# builds a throwaway git repository with a fake "upstream" branch, makes one specific kind
# of mess, and asserts the guard's exit code and its reason.
#
# Run: docs/multitec/tools/test-upstream-guard.sh   (exit 0 = all pass)

set -uo pipefail

guard=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/upstream-guard.sh
pass=0
fail=0

ok() {
  printf 'PASS  %s\n' "$1"
  pass=$((pass + 1))
}
ko() {
  printf 'FAIL  %s\n' "$1"
  fail=$((fail + 1))
}

# Builds a scratch repo: branch `upstream-dev` holds the pretend upstream, HEAD is our
# fork branch with the registry already in place.
scratch() {
  local dir
  dir=$(mktemp -d)
  git -C "$dir" init -q -b upstream-dev
  git -C "$dir" config user.email test@multitecua.com
  git -C "$dir" config user.name "guard test"
  mkdir -p "$dir/packages/auth" "$dir/packages/translation/src/lang"
  echo "upstream code" >"$dir/packages/auth/configuration.ts"
  echo "upstream code" >"$dir/packages/auth/env.ts"
  echo "generated" >"$dir/CHANGELOG.md"
  echo '{}' >"$dir/packages/translation/src/lang/en.json"
  git -C "$dir" add -A >/dev/null
  git -C "$dir" commit -qm "upstream"
  git -C "$dir" checkout -q -b multitec
  mkdir -p "$dir/docs/multitec/tools"
  printf '<!-- BEGIN REGISTRY -->\n<!-- END REGISTRY -->\n' >"$dir/docs/multitec/UPSTREAM-TOUCHPOINTS.md"
  echo "$dir"
}

# Rewrites the registry's fenced region with the given paths.
register() {
  local dir=$1
  shift
  {
    echo "<!-- BEGIN REGISTRY -->"
    local p
    for p in "$@"; do printf -- '- `%s` — because the test says so\n' "$p"; done
    echo "<!-- END REGISTRY -->"
  } >"$dir/docs/multitec/UPSTREAM-TOUCHPOINTS.md"
}

commit_all() {
  git -C "$1" add -A >/dev/null
  git -C "$1" commit -qm "work" >/dev/null
}

# run <dir> [env assignments...] -> prints output, sets RC
run_guard() {
  local dir=$1
  shift
  output=$(cd "$dir" && env UPSTREAM_REF=upstream-dev "$@" bash "$guard" 2>&1)
  rc=$?
}

expect() {
  local label=$1 want_rc=$2 want_text=${3:-}
  if [[ $rc -ne $want_rc ]]; then
    ko "$label (exit $rc, wanted $want_rc)"
    printf '%s\n' "$output" | sed 's/^/        /'
    return
  fi
  if [[ -n $want_text ]] && ! grep -qF -- "$want_text" <<<"$output"; then
    ko "$label (exit ok, but output did not mention '$want_text')"
    printf '%s\n' "$output" | sed 's/^/        /'
    return
  fi
  ok "$label"
}

# --- 1. our own namespace is always fine ------------------------------------------------
d=$(scratch)
echo "note" >"$d/docs/multitec/notes.md"
commit_all "$d"
run_guard "$d"
expect "adding files under docs/multitec/ passes" 0 "OK"
rm -rf "$d"

# --- 2. deleting an upstream file is never allowed --------------------------------------
d=$(scratch)
rm "$d/packages/auth/env.ts"
commit_all "$d"
run_guard "$d"
expect "deleting an upstream file fails" 1 "deleted an upstream file"
rm -rf "$d"

# --- 3. modifying an upstream file without registering it -------------------------------
d=$(scratch)
echo "our change" >>"$d/packages/auth/configuration.ts"
commit_all "$d"
run_guard "$d"
expect "unregistered modification fails" 1 "without registering it"
rm -rf "$d"

# --- 4. ... and passes once registered --------------------------------------------------
d=$(scratch)
echo "our change" >>"$d/packages/auth/configuration.ts"
register "$d" "packages/auth/configuration.ts"
commit_all "$d"
run_guard "$d"
expect "registered modification passes" 0 "1 upstream file(s) touched"
rm -rf "$d"

# --- 5. generated files are refused even when registered --------------------------------
d=$(scratch)
echo "our entry" >>"$d/CHANGELOG.md"
register "$d" "CHANGELOG.md"
commit_all "$d"
run_guard "$d"
expect "editing CHANGELOG.md fails even when registered" 1 "upstream regenerates this file"
rm -rf "$d"

d=$(scratch)
echo '{"a":1}' >"$d/packages/translation/src/lang/en.json"
register "$d" "packages/translation/src/lang/en.json"
commit_all "$d"
run_guard "$d"
expect "editing a Crowdin language file fails" 1 "upstream regenerates this file"
rm -rf "$d"

# --- 6. a registry entry with no matching edit is stale ---------------------------------
d=$(scratch)
register "$d" "packages/auth/env.ts"
commit_all "$d"
run_guard "$d"
expect "stale registry entry fails" 1 "Remove the stale entry"
rm -rf "$d"

# --- 7. the budget is enforced ----------------------------------------------------------
d=$(scratch)
echo "a" >>"$d/packages/auth/configuration.ts"
echo "b" >>"$d/packages/auth/env.ts"
register "$d" "packages/auth/configuration.ts" "packages/auth/env.ts"
commit_all "$d"
run_guard "$d" MAX_TOUCHED=1
expect "exceeding the budget fails" 1 "limit is 1"
run_guard "$d" MAX_TOUCHED=2
expect "sitting exactly on the budget passes" 0 "budget 2"
rm -rf "$d"

# --- 8. a brand new file inside upstream's tree still needs registering ------------------
d=$(scratch)
echo "new" >"$d/packages/auth/sneaky.ts"
commit_all "$d"
run_guard "$d"
expect "new file inside upstream's tree fails unregistered" 1 "new file inside upstream's tree"
rm -rf "$d"

d=$(scratch)
mkdir -p "$d/packages/auth/iap"
echo "new" >"$d/packages/auth/iap/provider.ts"
register "$d" "packages/auth/iap/provider.ts"
commit_all "$d"
run_guard "$d"
expect "new file inside upstream's tree passes when registered" 0 "OK"
rm -rf "$d"

# --- 9. a missing upstream ref must not look like success -------------------------------
d=$(scratch)
commit_all "$d"
run_guard "$d" UPSTREAM_REF=does-not-exist
expect "an unresolvable upstream ref exits 2, not 0" 2 "does not resolve"
rm -rf "$d"

d=$(mktemp -d)
output=$(cd "$d" && bash "$guard" 2>&1)
rc=$?
expect "running outside a git repository exits 2" 2 "not inside a git repository"
rm -rf "$d"

# --- 10. a rename of an upstream file is flagged ----------------------------------------
d=$(scratch)
git -C "$d" mv packages/auth/env.ts packages/auth/environment.ts >/dev/null
commit_all "$d"
run_guard "$d"
expect "renaming an upstream file fails" 1 "leave the path alone"
rm -rf "$d"

echo
echo "upstream-guard tests: $pass PASS, $fail FAIL"
[[ $fail -eq 0 ]] && echo "RESULT: all pass" || echo "RESULT: failures"
exit $((fail > 0))
