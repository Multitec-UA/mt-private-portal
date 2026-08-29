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
- `packages/definitions/src/auth.ts` — one entry added to the `supportedAuthProviders` tuple, so `AUTH_PROVIDERS=iap` parses. Lowest-risk shape there is: the end of a literal.
- `packages/auth/env.ts` — an `authProviders.includes("iap")` block, parallel to the oidc and ldap ones. `AUTH_IAP_AUDIENCE` deliberately has no default: a wrong audience would accept assertions minted for a different IAP-protected service.
- `packages/auth/configuration.ts` — three small hunks: an import, one entry appended to `filterProviders([...])`, and `"iap"` added to the credentials-session guard. The guard matters most: Auth.js does not create a database session for a credentials-shaped provider, so leaving it out is a successful sign-in that produces no session.
- `packages/auth/providers/filter-providers.ts` — resolve the provider's real id from `options` before filtering. **Without this the whole feature is inert**: `Credentials(config)` returns `id: "credentials"` and hides the real id in `options`, so `AUTH_PROVIDERS=iap` registered no providers at all. Worth sending upstream — as written, no new credentials-shaped provider can ever be enabled.
- `packages/auth/providers/test/filter-providers.spec.ts` — new. Pins that premise against Auth.js, and that enabling one credentials provider does not drag in the others.
- `packages/auth/providers/check-provider.ts` — a `case "iap"` returning false in `isGroupMembershipManagedLocally`. Membership comes from the admin allowlist, so a UI edit would be silently undone at the next sign-in.
- `packages/auth/providers/iap/verify-assertion.ts` — new. The security core: signature, issuer, audience, expiry, hosted domain, and the signed/unsigned cross-check.
- `packages/auth/providers/iap/resolve-groups.ts` — new. Email to Homarr groups. The one rule: nothing the browser can influence decides admin-ness.
- `packages/auth/providers/iap/iap-provider.ts` — new. The `authorize()` callback and first-sign-in user creation.
- `packages/auth/providers/test/iap-assertion.spec.ts` — new. Signs real ES256 tokens with a key the test controls and attacks the verifier with them.
- `apps/nextjs/src/app/api/auth/[...nextauth]/route.ts` — an `iap` branch in `extractProvider`, parallel to the existing three.
- `apps/nextjs/src/app/[locale]/auth/login/page.tsx` — one more prop passed to the form.
- `apps/nextjs/src/app/[locale]/auth/login/_login-form.tsx` — the auto-login effect extended to fire `signIn("iap")`. The most volatile of these: it is UI, and upstream changes login pages more often than auth packages. If it becomes painful, the auto-login can move to `proxy.ts` and this hunk disappears.
- `packages/auth/package.json` — `jose` declared as a dependency.
- `pnpm-workspace.yaml` — the matching `jose: ^6.2.3` catalog entry.
- `pnpm-lock.yaml` — the by-product of the two above. Never hand-edited: on a sync, take upstream's and re-run `pnpm install`.
<!-- END REGISTRY -->

**Fourteen entries, of which six are new files in a directory upstream does not have.** The
eight that genuinely modify upstream code are each a handful of lines at a stable anchor —
the end of a tuple, one more entry in an array, an extra `case`, one more prop.

`jose` is declared rather than inherited on purpose. It is already in the tree as a
transitive dependency of `@auth/core`, and with pnpm's hoisted layout an undeclared import
would resolve today — and break silently the day that transitive dependency moves. Not a
gamble worth taking on the code that verifies logins.

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
| `apps/nextjs/src/instrumentation.ts` | skip the embedded cron runner when `MULTITEC_EMBEDDED_TASKS` is off, keeping the WebSocket server (ADR 0003) |
| `apps/nextjs/src/proxy.ts` | **opt-in, default off** — re-check the IAP identity against the live session (ADR 0002 §4) |

Nine files, against a budget of twelve. Everything else lives in new files — the provider
under `packages/auth/providers/iap/`, and the one-shot Cloud Run Job entrypoint in our own
namespace — which the guard treats as ours once registered.

The last two are the ones to argue about before writing them. `instrumentation.ts` is what
lets the service scale to zero, so it earns its place; `proxy.ts` buys a case Sergio has
decided he can live with, so it should probably wait until something actually needs it.
