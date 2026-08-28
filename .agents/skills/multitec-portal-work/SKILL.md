---
name: multitec-portal-work
description: The mandatory procedure for changing anything in Multitec-UA/mt-private-portal, the Homarr fork that serves as the private member portal. Use BEFORE the first edit in this repository, whenever deciding where a change should live, when adding an env var or an auth provider, and before calling any change done. Encodes the additive-first rule that keeps upstream mergeable and the deterministic guard that enforces it.
---

# Working in the Multitec fork of Homarr

This repository is a fork of `homarr-labs/homarr`. Its value is that we can still merge a
new Homarr release — upstream ships roughly weekly. Every rule here protects that.

Read `MULTITEC.md` for the full constitution and `docs/multitec/architecture-notes.md` for
the map. This skill is the procedure.

## Before the first edit: decide where the change lives

Ask, in this order:

1. **Is this configuration rather than code?** Boards, tiles, groups, per-group board
   permissions, icons, themes, translations of existing keys — Homarr does all of this in
   the product. `docs/multitec/architecture-notes.md` §2 is explicit: "socios can view,
   admins can edit" needs *no code at all*. Writing code for something the product already
   does is the most expensive mistake available here.
2. **Can it be a new file in our namespace?** `docs/multitec/**`,
   `.agents/skills/multitec-*`, `packages/multitec-*`, or a new subdirectory inside an
   upstream package (`packages/auth/providers/iap/`). New files in new directories never
   conflict.
3. **Only then, edit an upstream file** — and make the hunk as small and as anchored as it
   can be: the end of an array, a new `case`, one extra prop. Never a rewritten function,
   never a reordering, never a reformat.

## When you must edit an upstream file

1. Make the change.
2. Add it to `docs/multitec/UPSTREAM-TOUCHPOINTS.md`, inside the
   `<!-- BEGIN REGISTRY -->` region, as `` - `path/to/file.ts` — one sentence on why. ``
   The *why* matters more than the diff: at the next sync, someone re-applies the intent
   against upstream's new code.
3. Run the guard. It must exit 0.

**Never delete an upstream file.** Git cannot merge a deletion quietly — upstream keeps
editing the file and every sync re-raises it. Make it inert instead: a feature flag, an
empty config, an unused export. Renaming counts as deleting.

**Never edit** `CHANGELOG.md`, `CHANGES.md`, `packages/translation/src/lang/*.json`, or
anything under `apps/docs/` for a fork-only change. The guard refuses the first three
outright; they are regenerated upstream and the edit is lost as well as conflicting.

## Naming, always

| Thing | Namespace |
|---|---|
| env vars | `AUTH_IAP_*`, `MULTITEC_*` |
| docs, ADRs, tooling | `docs/multitec/**` |
| skills | `.agents/skills/multitec-*` |
| new packages | `packages/multitec-*` → `@homarr/multitec-*` |

## Every feature is off by default

With none of our env vars set, this fork must behave exactly like vanilla Homarr. That is
not tidiness — it is what lets us `git bisect` against upstream and prove a bug is theirs.
A new provider that only registers when `AUTH_PROVIDERS` names it has this property for
free; copy that shape.

## Never commit

Secrets, tokens, service-account keys, database URLs, the IAP audience string, member
emails or any member data. **This repository is public** — GitHub does not allow a fork of
a public repo to be private. Real values live in Secret Manager and Terraform
(`~/code/multitec-terrafrom`); docs use placeholders.

## Before calling anything done

```bash
docs/multitec/tools/upstream-guard.sh   # exit 0 — fork hygiene
pnpm turbo typecheck                     # compiles across the monorepo
pnpm lint                                # oxlint, NOT eslint
```

For a change to auth, sessions, or the login page, a green typecheck proves nothing about
whether people can still log in. **Sign in as a member and as an admin.**

House style, from upstream's own `AGENTS.md`: oxlint + oxfmt (not ESLint/Prettier),
Mantine v9 (not Tailwind), `@tabler/icons-react`, Drizzle through `@homarr/db`.

## Record it

Append to `docs/multitec/CHANGELOG.md` in the same commit: what changed, why, and the
evidence — the command run and what it printed. Upstream's changelog is not ours.

## The cheapest change is the one upstream accepts

If what you are building would be useful to every Homarr user — an auth provider, a bug
fix, a widget — open a PR against `homarr-labs/homarr` instead. Code that lands upstream
costs us nothing to maintain forever. Fork-only work should be the things that are
genuinely about Multitec.
