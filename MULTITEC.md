# MULTITEC.md — fork constitution

This repository is **`Multitec-UA/mt-private-portal`**, a fork of
[`homarr-labs/homarr`](https://github.com/homarr-labs/homarr) (Apache-2.0).

Upstream is a self-hosted dashboard. We are turning it into **the private portal for
Multitec UA members** — where a socio signs in once and sees their benefits, their links
and the association's internal services.

**The single constraint that shapes everything else: we must be able to pull a new
upstream release at any time.** Homarr ships roughly weekly (`v1.76.2` landed the day
this fork was taken). A fork that cannot follow upstream stops getting security fixes and
becomes a rewrite nobody signed up for. Every rule below exists to keep that merge cheap.

---

## Non-negotiables

1. **Additive first.** A file we *create* in a directory upstream does not use can never
   conflict. A file we *edit* conflicts every time upstream touches the same lines. Given
   a choice between a new module and a patch to an existing one, take the new module —
   even when the patch is shorter.
2. **Every edit to an upstream file is registered.** `docs/multitec/UPSTREAM-TOUCHPOINTS.md`
   lists each one with the reason and the shape of the change. The guard script
   (`docs/multitec/tools/upstream-guard.sh`) fails if reality and the registry disagree.
   An unregistered edit is a merge conflict nobody was warned about.
3. **Never delete an upstream file.** Deleting is the one operation git cannot merge
   quietly: upstream keeps editing a file we removed and every sync re-raises it. If
   something must go away, make it inert (feature flag, empty config) and leave the file.
4. **Never reformat, reorder or rename upstream code.** No import shuffling, no
   `oxfmt` sweep over files we did not otherwise touch, no renaming their symbols. A
   whitespace-only diff turns a clean merge into a manual one for zero benefit.
5. **Every feature we add is off by default.** With none of our env vars set, this fork
   must behave exactly like vanilla Homarr. That property is what lets us `git bisect`
   against upstream and lets us prove a bug is theirs and not ours.
6. **Our namespaces, always.**
   - env vars: `AUTH_IAP_*`, `MULTITEC_*`
   - our docs, ADRs and tooling: `docs/multitec/**`
   - our skills: `.agents/skills/multitec-*`
   - new packages, if ever needed: `packages/multitec-*` / `@homarr/multitec-*`
7. **Never touch upstream's generated or release-managed files.** `CHANGELOG.md` (written
   by semantic-release), `CHANGES.md`, `pnpm-lock.yaml` (only ever as the by-product of a
   real dependency change), `apps/docs/**`, `packages/translation/src/lang/*.json` beyond
   keys we own. Our changelog is `docs/multitec/CHANGELOG.md`.
8. **Never commit secrets or member data.** This fork is **public** — GitHub does not
   allow a fork of a public repository to be private. Member emails, IAP audience strings,
   OAuth client secrets, database URLs and Google service-account keys live in Secret
   Manager and in Terraform, never here. Sample values in docs are placeholders.
9. **If a change would be useful to everyone, send it upstream.** The cheapest diff is no
   diff. A generic `iap` auth provider is a plausible upstream contribution; "the Multitec
   member benefits board" is not.

---

## Branch model

| Branch | What it is | Rule |
|---|---|---|
| `dev` | a mirror of `upstream/dev` | **never commit here.** Only `git merge --ff-only upstream/dev` |
| `multitec` | upstream + our patch set — the deployable branch | default branch; PRs target it |
| `feat/*`, `fix/*` | our work | branch off `multitec`, merge back |

We **merge** upstream into `multitec`; we never rebase `multitec` onto upstream. Rebasing
rewrites shared history on a public branch and re-resolves the same conflicts on every
sync. Merging records each resolution once, and `git rerere` replays it next time.

Full procedure: **`docs/multitec/upstream-sync.md`**, or the `multitec-upstream-sync`
skill.

---

## Before you call anything done

```bash
docs/multitec/tools/upstream-guard.sh     # exit 0 required — the fork-hygiene linter
pnpm turbo typecheck                       # the change compiles across the monorepo
pnpm lint                                  # oxlint, not eslint
```

The guard is the deterministic half of rules 1–7: it classifies every path in
`git diff upstream/dev...HEAD`, fails on deletions of upstream files, fails on edits that
are not in the registry, and fails when the number of touched upstream files exceeds the
budget. It has its own self-test (`docs/multitec/tools/test-upstream-guard.sh`) so a
broken linter cannot silently start passing everything.

---

## House style, inherited from upstream

- Lint **oxlint**, format **oxfmt** — not ESLint, not Prettier.
- UI is **Mantine v9**, not Tailwind. Icons are `@tabler/icons-react`.
- Everything is TypeScript. Database access goes through Drizzle in `@homarr/db`.
- Read `AGENTS.md` (upstream's own agent rules) — it still applies, in full.
- Read `.agents/skills/codebase-context/SKILL.md` before writing code; it is upstream's
  own map of the monorepo and it is accurate.
- Our own orientation notes — what we learned reading the auth stack, and where the
  portal-relevant seams are — are in `docs/multitec/architecture-notes.md`.

## Language

Code, comments, commit messages, docs and **every user-facing string** are written in
**English** in this repository, exactly as in every other Multitec repo. The portal's
Spanish copy is a translation layer (`packages/translation`), not the source of truth.

## Changelog discipline

Every change lands with an entry in `docs/multitec/CHANGELOG.md` in the same commit —
what changed, why, and the evidence that it works. Upstream's `CHANGELOG.md` is generated
and is not ours to edit.
