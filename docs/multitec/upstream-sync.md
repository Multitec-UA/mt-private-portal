# Pulling a new Homarr release into the fork

Homarr releases roughly weekly. This procedure is meant to be boring and to be run often —
**a sync you postpone for three months is not one sync, it is twelve, resolved at once,
by someone who has forgotten why.**

Set this once per clone. It makes git remember how you resolved a conflict and replay it
on the next sync, which is the single biggest saving in a long-lived fork:

```bash
git config rerere.enabled true
git remote add upstream https://github.com/homarr-labs/homarr.git   # if missing
```

## The loop

```bash
# 1. Fetch, and move our mirror of dev forward. --ff-only is the guard: if this refuses,
#    someone committed to `dev`, which nothing is allowed to do.
git fetch upstream --tags
git checkout dev
git merge --ff-only upstream/dev

# 2. Merge into our branch. Do it on a branch, not on `multitec` directly, so a sync that
#    goes badly is a branch you delete rather than a history you have to fix.
git checkout multitec
git checkout -b sync/$(git describe --tags --abbrev=0 upstream/dev 2>/dev/null || date +%Y-%m-%d)
git merge dev
```

## When it conflicts

- **`pnpm-lock.yaml`** — never resolve it by hand. Take upstream's file wholesale and
  regenerate:
  ```bash
  git checkout --theirs pnpm-lock.yaml && pnpm install --no-frozen-lockfile
  git add pnpm-lock.yaml
  ```
- **A file in `docs/multitec/UPSTREAM-TOUCHPOINTS.md`** — expected. Read the registry entry
  first: it says what our change was *for*. Re-apply the intent against upstream's new
  code; do not paste our old lines back in.
- **A file *not* in the registry** — stop. Either the registry is out of date (fix it) or
  someone changed an upstream file without saying so, and the merge is the wrong place to
  find that out.
- **Anything under `packages/db/migrations/`** — upstream added migrations. Take theirs
  untouched. We do not write migrations; if we ever need one it goes in its own dialect
  directory with a name that cannot collide.

## Proving the sync

In this order, and all of them:

```bash
docs/multitec/tools/upstream-guard.sh   # our diff is still the shape we agreed
pnpm install --frozen-lockfile
pnpm turbo typecheck
pnpm lint
pnpm turbo build --filter=@homarr/nextjs...
```

Then run it. A green typecheck says our code still compiles against upstream's types; it
says nothing about whether logging in still works. **Sign in as a member and as an admin
before merging the sync branch** — the auth stack is exactly where our patches live, and
it is the part a type checker cannot vouch for.

Finally:

```bash
git checkout multitec && git merge --no-ff sync/<tag>
# add an entry to docs/multitec/CHANGELOG.md: which upstream version, what conflicted, what you verified
git push origin multitec
```

## Why merge and not rebase

`multitec` is public and shared. Rebasing it rewrites commits other people have checked
out, and it re-resolves every historical conflict on every sync — the same work, forever.
Merging records each resolution once, `rerere` remembers it, and the history stays honest
about the fact that this is a fork of somebody else's project.

## The best sync is the one you do not have to do

If a change we need is genuinely useful to every Homarr user — an auth provider, a bug
fix, a widget — open a PR upstream instead of carrying it here. Code that lands in
`homarr-labs/homarr` costs us nothing to maintain forever. See `CONTRIBUTING` upstream.
