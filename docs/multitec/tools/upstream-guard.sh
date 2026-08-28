#!/usr/bin/env bash
#
# upstream-guard.sh — the fork-hygiene linter for Multitec-UA/mt-private-portal.
#
# The fork's whole value is that we can still merge a new Homarr release. That property
# does not survive good intentions; it survives a script that fails the build. This one
# classifies every path in the diff against upstream and refuses the shapes that make a
# merge expensive:
#
#   * deleting an upstream file        — git cannot merge that quietly, ever
#   * editing an upstream file without saying so in docs/multitec/UPSTREAM-TOUCHPOINTS.md
#   * editing a file upstream regenerates (CHANGELOG.md, the Crowdin language files, ...)
#   * letting the number of touched upstream files drift past a budget
#   * leaving a registry entry behind after the edit it described is gone
#
# Exit 0 = clean. Exit 1 = at least one violation. Exit 2 = the guard could not run
# (no upstream ref, not a git repository) — never silently "pass" in that case.
#
# Overridable for the self-test:
#   UPSTREAM_REF   ref to compare against            (default: upstream/dev, then origin/dev)
#   REGISTRY       path to the touchpoints registry  (default: docs/multitec/UPSTREAM-TOUCHPOINTS.md)
#   MAX_TOUCHED    budget for modified upstream files (default: 12)

set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "guard: not inside a git repository" >&2
  exit 2
}
cd "$repo_root" || exit 2

registry=${REGISTRY:-docs/multitec/UPSTREAM-TOUCHPOINTS.md}
max_touched=${MAX_TOUCHED:-12}

# Paths we own outright. Anything created under these can never collide with upstream,
# because upstream has no reason to invent the same names.
ours=(
  "docs/multitec/"
  ".agents/skills/multitec-"
  "packages/multitec-"
  "MULTITEC.md"
  "CLAUDE.md"
)

# Files upstream regenerates. Editing them guarantees a conflict on every release and
# loses the edit anyway.
generated=(
  "CHANGELOG.md"
  "CHANGES.md"
  "packages/translation/src/lang/"
)

resolve_upstream() {
  if [[ -n ${UPSTREAM_REF:-} ]]; then
    git rev-parse --verify --quiet "$UPSTREAM_REF^{commit}" >/dev/null && { echo "$UPSTREAM_REF"; return 0; }
    echo "guard: UPSTREAM_REF='$UPSTREAM_REF' does not resolve to a commit" >&2
    return 1
  fi
  for candidate in upstream/dev origin/dev; do
    if git rev-parse --verify --quiet "$candidate^{commit}" >/dev/null; then
      echo "$candidate"
      return 0
    fi
  done
  echo "guard: no upstream ref found. Run: git remote add upstream https://github.com/homarr-labs/homarr.git && git fetch upstream" >&2
  return 1
}

is_prefixed_by_any() {
  local path=$1
  shift
  local prefix
  for prefix in "$@"; do
    [[ $path == "$prefix"* ]] && return 0
  done
  return 1
}

# The registry is a markdown file so humans read it, but the guard only reads the fenced
# region, and only the first backticked token on each list item. That keeps the prose free
# and the parsing exact.
read_registry() {
  [[ -f $registry ]] || return 0
  sed -n '/<!-- BEGIN REGISTRY -->/,/<!-- END REGISTRY -->/p' "$registry" |
    sed -n 's/^[[:space:]]*-[[:space:]]*`\([^`]*\)`.*$/\1/p'
}

upstream_ref=$(resolve_upstream) || exit 2
base=$(git merge-base "$upstream_ref" HEAD 2>/dev/null) || {
  echo "guard: no merge base between $upstream_ref and HEAD" >&2
  exit 2
}

registered=$(read_registry)
violations=0
touched_count=0
declare -a seen_modified=()

report() {
  printf '  FAIL  %s\n' "$1"
  violations=$((violations + 1))
}

echo "upstream-guard: comparing HEAD against $upstream_ref (merge-base ${base:0:9})"

while IFS=$'\t' read -r status path rest; do
  [[ -z ${status:-} ]] && continue
  # Renames and copies arrive as R100<TAB>old<TAB>new; the new path is what matters, but
  # the old one is a deletion as far as a future merge is concerned.
  case $status in
    R* | C*)
      if ! is_prefixed_by_any "$path" "${ours[@]}"; then
        report "$path — renaming an upstream file is a delete plus an add; leave the path alone"
      fi
      path=${rest:-$path}
      status=M
      ;;
  esac

  if is_prefixed_by_any "$path" "${ours[@]}"; then
    continue
  fi

  case $status in
    D)
      report "$path — deleted an upstream file. Make it inert instead; never remove it."
      ;;
    A)
      if ! grep -Fxq "$path" <<<"$registered"; then
        report "$path — new file inside upstream's tree and not in $registry. Prefer docs/multitec/ or packages/multitec-*, or register it."
      else
        seen_modified+=("$path")
        touched_count=$((touched_count + 1))
      fi
      ;;
    M | T)
      if is_prefixed_by_any "$path" "${generated[@]}"; then
        report "$path — upstream regenerates this file. The edit will be lost and will conflict on every release."
        continue
      fi
      if ! grep -Fxq "$path" <<<"$registered"; then
        report "$path — modified an upstream file without registering it in $registry."
      else
        seen_modified+=("$path")
        touched_count=$((touched_count + 1))
      fi
      ;;
  esac
done < <(git diff --name-status -M "$base" HEAD)

# A registry that outlives its edits is worse than no registry: it teaches the next reader
# that a file is dangerous when it is not, and it hides the entries that still matter.
if [[ -n $registered ]]; then
  while IFS= read -r entry; do
    [[ -z $entry ]] && continue
    found=0
    for path in ${seen_modified[@]+"${seen_modified[@]}"}; do
      [[ $path == "$entry" ]] && found=1 && break
    done
    if [[ $found -eq 0 ]]; then
      report "$entry — registered in $registry but identical to $upstream_ref. Remove the stale entry."
    fi
  done <<<"$registered"
fi

if [[ $touched_count -gt $max_touched ]]; then
  report "budget: $touched_count upstream files touched, limit is $max_touched. Move the change into our own namespace or raise the budget deliberately."
fi

if [[ $violations -eq 0 ]]; then
  echo "upstream-guard: OK — $touched_count upstream file(s) touched, all registered (budget $max_touched)"
  exit 0
fi

echo "upstream-guard: $violations violation(s). See MULTITEC.md for the rules."
exit 1
