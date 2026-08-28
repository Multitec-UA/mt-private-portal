# CLAUDE.md

This is a **fork** of `homarr-labs/homarr`, maintained by Multitec UA as the private
member portal. Two documents govern work here, and both are mandatory reading before the
first edit:

1. **`MULTITEC.md`** — the fork constitution. Why this fork exists, the branch model, and
   the rules that keep upstream mergeable. Read it first.
2. **`AGENTS.md`** — upstream's own agent rules (monorepo layout, oxlint/oxfmt, Mantine,
   documentation-sync requirements). Still applies in full.

Orientation for the code itself: `docs/multitec/architecture-notes.md` and the upstream
skill `.agents/skills/codebase-context/SKILL.md`.

Skills live in `.agents/skills/` — `.claude/skills` is a symlink to it, which is
upstream's convention, not ours. Ours are prefixed `multitec-`.

Before calling anything done:

```bash
docs/multitec/tools/upstream-guard.sh
pnpm turbo typecheck
pnpm lint
```
