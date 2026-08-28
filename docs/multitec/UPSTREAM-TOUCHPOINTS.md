# Upstream touchpoints

Every file in this repository that belongs to `homarr-labs/homarr` **and that we have
changed** is listed below. Nothing else is allowed to differ.

This is not paperwork. When a Homarr release lands, this list is the complete set of
places a conflict can come from — it tells the person doing the merge where to look and,
more usefully, what the change was *for*, so they can re-apply the intent rather than
re-apply the diff.

`docs/multitec/tools/upstream-guard.sh` reads the fenced region below and fails if the
registry and the actual diff disagree in either direction: an unregistered edit fails, and
so does a registered path that no longer differs from upstream. Keeping the list honest is
therefore not optional.

## How to add an entry

1. Make the change as small and as anchored as you can. The end of an array, a new `case`
   in a `switch`, one extra prop — not a rewritten function.
2. Add a line inside the fenced region: `` - `path/to/file.ts` — one sentence on why. ``
3. Run the guard. It must exit 0.

## The list

<!-- BEGIN REGISTRY -->
<!-- END REGISTRY -->

*(Empty. As of the fork point, this repository differs from `upstream/dev` only by files
we created: `MULTITEC.md`, `CLAUDE.md`, `docs/multitec/**` and
`.agents/skills/multitec-*`. That is the ideal state and it will not last — but every
departure from it should be a decision someone made on purpose.)*

## Expected entries when the IAP work lands

Recorded here in advance, from the analysis in `architecture-notes.md`, so the size of
that change is agreed before it is written rather than discovered afterwards. These are
**not** registered yet — the guard would call them stale.

| File | Shape of the change |
|---|---|
| `packages/definitions/src/auth.ts` | add `"iap"` to the `supportedAuthProviders` tuple |
| `packages/auth/env.ts` | add an `authProviders.includes("iap")` env block, mirroring the oidc one |
| `packages/auth/configuration.ts` | one entry in the `filterProviders([...])` array; add `"iap"` to the credentials-session guard |
| `packages/auth/providers/check-provider.ts` | a `case "iap"` in `isGroupMembershipManagedLocally` |
| `apps/nextjs/src/app/api/auth/[...nextauth]/route.ts` | an `iap` branch in `extractProvider` |
| `apps/nextjs/src/app/[locale]/auth/login/page.tsx` | pass the auto-login flag through |
| `apps/nextjs/src/app/[locale]/auth/login/_login-form.tsx` | extend the auto-login effect to `iap` |
| `apps/nextjs/src/proxy.ts` | re-check the IAP identity against the live session |

Eight files, against a budget of twelve. Everything else the provider needs lives in new
files under `packages/auth/providers/iap/`, which the guard treats as ours once
registered.
