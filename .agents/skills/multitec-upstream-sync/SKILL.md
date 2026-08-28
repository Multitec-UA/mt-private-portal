---
name: multitec-upstream-sync
description: Pull a new Homarr release from homarr-labs/homarr into this fork. Use whenever upstream publishes a version, when this fork is behind, when a merge conflicts, or when asked to update/rebase/sync with upstream. Encodes the merge-never-rebase rule, which conflicts are expected and how to resolve each, and the checks that must pass before the sync is merged.
---

# Syncing with upstream Homarr

Upstream ships roughly weekly. **Sync often.** A sync postponed for three months is not one
merge, it is twelve, resolved at once, by someone who has forgotten why our patches exist.

Full prose version: `docs/multitec/upstream-sync.md`. This is the operating procedure.

## Once per clone

```bash
git config rerere.enabled true
git remote add upstream https://github.com/homarr-labs/homarr.git   # if missing
```

`rerere` makes git remember conflict resolutions and replay them at the next sync. In a
long-lived fork it is the single biggest saving available.

## The loop

```bash
git fetch upstream --tags

# `dev` is a mirror of upstream. --ff-only is the guard: if it refuses, somebody
# committed to `dev`, which nothing is allowed to do. Fix that before continuing.
git checkout dev && git merge --ff-only upstream/dev

# Merge on a throwaway branch, so a bad sync is a branch you delete rather than
# a history you have to repair.
git checkout multitec
git checkout -b "sync/$(git describe --tags --abbrev=0 upstream/dev)"
git merge dev
```

**Merge, never rebase.** `multitec` is public and shared; rebasing rewrites commits other
people have checked out and re-resolves every historical conflict on every sync.

## Expected conflicts, and what to do

| Conflict | Resolution |
|---|---|
| `pnpm-lock.yaml` | Never hand-merge. `git checkout --theirs pnpm-lock.yaml && pnpm install --no-frozen-lockfile && git add pnpm-lock.yaml` |
| A file listed in `docs/multitec/UPSTREAM-TOUCHPOINTS.md` | Expected. **Read the registry entry first** — it says what our change was *for*. Re-apply the intent against upstream's new code; do not paste the old lines back. |
| A file **not** in the registry | Stop. Either the registry is stale, or somebody edited an upstream file without registering it. A merge is the worst place to discover that; fix the cause. |
| `packages/db/migrations/**` | Take upstream's, untouched. We do not write migrations. |
| `CHANGELOG.md`, `packages/translation/src/lang/*.json` | Take upstream's wholesale. These are generated; we never have a legitimate change in them. |

## Proving it — all of these, in order

```bash
docs/multitec/tools/upstream-guard.sh          # our diff is still the agreed shape
pnpm install --frozen-lockfile
pnpm turbo typecheck
pnpm lint
pnpm turbo build --filter=@homarr/nextjs...
```

Then **run it and log in, as a member and as an admin.** A green typecheck says our code
compiles against upstream's types. It says nothing about whether authentication still
works — and authentication is precisely where our patches live.

## Landing it

```bash
git checkout multitec && git merge --no-ff "sync/<tag>"
git push origin multitec
```

Add an entry to `docs/multitec/CHANGELOG.md` in the same commit: which upstream version
came in, what conflicted, and what you verified. The next person syncing reads that entry
before they read the diff.

## If a patch of ours keeps conflicting

That is the signal to remove it, not to keep re-applying it. Options, in order of
preference: move the logic into a new file in our namespace; upstream the change so there
is no diff at all; or drop the feature. Three painful syncs in a row is data, not bad luck.
