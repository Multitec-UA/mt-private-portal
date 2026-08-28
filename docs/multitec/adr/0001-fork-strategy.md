# ADR 0001 — Fork Homarr as `mt-private-portal`, and keep it mergeable

- **Status:** accepted
- **Date:** 2026-08-28
- **Fork point:** `upstream/dev` @ `331925c19`, release `v1.76.2`

## Context

Multitec UA wants a private portal where a socio signs in and finds their benefits, links
and the association's internal services. Building it from scratch means writing
authentication, a permission model, a drag-and-drop editor, an icon library and a
theming system — all of which [Homarr](https://github.com/homarr-labs/homarr) already has,
under Apache-2.0, with roughly weekly releases.

The obvious risk of adopting someone else's application is the obvious risk of every fork:
it drifts, upstream security fixes stop arriving, and two years later "just update it" is a
rewrite.

## Decision

**Fork it, and treat "we can still merge upstream" as a hard requirement rather than an
aspiration.**

1. A real GitHub fork at `Multitec-UA/mt-private-portal`, parented to
   `homarr-labs/homarr`. GitHub does not allow a fork of a public repository to be
   private, so **this repository is public** — chosen deliberately over a private mirror,
   for the network relationship and the ability to send changes back upstream. The portal's
   *content* and *access* are private; its code is not, and Apache-2.0 does not require it
   to be either way.
2. Branches: `dev` mirrors upstream and is never committed to; `multitec` is upstream plus
   our patch set and is the default branch; work branches off `multitec`.
   We **merge** upstream in, never rebase.
3. Rules in `MULTITEC.md`: additive over invasive, no deletions of upstream files, no
   reformatting, our own namespaces (`AUTH_IAP_*`, `MULTITEC_*`, `docs/multitec/**`,
   `.agents/skills/multitec-*`), every feature off by default.
4. Every edit to an upstream file is registered in `UPSTREAM-TOUCHPOINTS.md`, and
   `docs/multitec/tools/upstream-guard.sh` fails the build when reality and the registry
   disagree. The guard has its own self-test.

## Why a linter and not a convention

Because conventions in a fork decay in exactly one way: someone in a hurry edits an
upstream file, it works, nobody notices, and the cost arrives months later as an
unexplained conflict in a file nobody remembers touching. The rule that matters is the one
that fails the build. The guard is deliberately small — five checks — because a linter
people route around protects nothing.

## Consequences

- Merging a Homarr release should be a half-hour job with a known list of files to look
  at, not an archaeology exercise.
- Some things we might want will be *harder* than they need to be, because the additive
  route is longer than the invasive one. That is the price, and it is paid on purpose.
- The public repository means secrets and member data can never be committed here, which is
  a discipline we already have but which now has no safety net of obscurity.
- If a change is generally useful, the cheapest outcome is upstreaming it. A generic `iap`
  auth provider is a plausible contribution to Homarr; the Multitec benefits board is not.

## Alternatives considered

- **Private mirror instead of a fork.** Syncs just as well (`git merge upstream/dev`), and
  keeps our commits out of public view. Rejected: it loses the upstream relationship and
  the ability to open PRs, and the code itself is not what is confidential.
- **Vanilla Homarr, configured, with no fork at all.** Genuinely viable for the boards and
  permissions — see `architecture-notes.md` §2, none of that needs code. It fails on the
  one requirement that matters most: signing in with an IAP identity and no password.
- **Build the portal from scratch.** Rejected on effort. What Homarr gives away — boards,
  permissions, icons, i18n, widgets — is months of work.
