# `docs/multitec/` — everything Multitec adds

Upstream owns the rest of this repository. This directory is ours, and it is the one place
upstream will never create a file, so nothing in here can ever conflict on a merge.

| File | What it is |
|---|---|
| [`../../MULTITEC.md`](../../MULTITEC.md) | **Start here.** The fork constitution: the rules that keep upstream mergeable. |
| [`architecture-notes.md`](architecture-notes.md) | What reading Homarr taught us, aimed at the portal: the auth stack traced, the seams an IAP provider attaches to, and the deployment facts that constrain everything. |
| [`operating-the-portal.md`](operating-the-portal.md) | Running it day to day: why a new board is invisible to members until you grant it, how `everyone` and home boards behave, and how to read the database safely. |
| [`upstream-sync.md`](upstream-sync.md) | How to pull a new Homarr release, what will conflict, and how to prove the sync. |
| [`UPSTREAM-TOUCHPOINTS.md`](UPSTREAM-TOUCHPOINTS.md) | The registry of every upstream file we have modified. The guard enforces it. |
| [`CHANGELOG.md`](CHANGELOG.md) | Our changelog. Upstream's `CHANGELOG.md` is generated; leave it alone. |
| [`adr/`](adr/) | Decisions: context → decision → consequences. |
| [`tools/upstream-guard.sh`](tools/upstream-guard.sh) | The fork-hygiene linter. Exit 0 before anything is called done. |
| [`tools/test-upstream-guard.sh`](tools/test-upstream-guard.sh) | Its self-test — 14 cases, because an untested linter drifts into passing everything. |

Skills for agents live in `.agents/skills/multitec-*`; `.claude/skills` is a symlink to
`.agents/skills`, which is upstream's arrangement, not ours.

## The one-minute version

We forked Homarr to build the private portal for Multitec members. Homarr already has the
boards, the permission model, the icons and the i18n; what it does not have is
"authenticate from the Google IAP identity with no login form", which is
[ADR 0002](adr/0002-iap-authentication.md).

Everything we write is additive and namespaced, every edit to an upstream file is
registered, and a script fails the build when that stops being true — because the whole
value of forking instead of rewriting is being able to merge upstream next week.
