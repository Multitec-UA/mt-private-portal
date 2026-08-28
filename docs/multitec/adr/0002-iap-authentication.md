# ADR 0002 — Sign in with the Google IAP identity, with no login form

- **Status:** proposed — this is the design, not yet the implementation
- **Date:** 2026-08-28
- **Depends on:** ADR 0001. Runtime shape: **ADR 0003**. Evidence for every claim about the
  code: `../architecture-notes.md`

> **Revised the same day, after Sergio read the first draft.** Two things in it were his to
> decide and I had decided them for him. There is **no load balancer** in this project —
> IAP is applied directly on the Cloud Run service, which changes the audience string the
> whole security design pivots on (ADR 0003). And session lifetime stays at Homarr's
> default: *"no me preocupan las sesiones largas… hay muy pocas altas y bajas en esta
> asociación."* §4 below is what that costs, stated plainly, so the trade is on the record
> rather than assumed.

## Context

The portal will be served from Google Cloud behind **Identity-Aware Proxy**, exactly like
`minecraft-allowlist` and `mc-map` already are: a Cloud Run service with
`allow_unauthenticated: false` and `cloudrun.iap.enabled: true`, restricted to
`domain:multitecua.com`. **No load balancer** — IAP is enforced by Cloud Run itself, and
the custom name comes from a Cloud Run domain mapping. See ADR 0003.

By the time a request reaches the container, Google has **already** authenticated the
person. Asking them for a Homarr username and password after that is worse than
redundant: it is a second, weaker credential store to keep, reset and eventually leak.

What we want instead:

- a socio opens the URL, passes IAP, and **is already logged in** — no form, no click;
- their Homarr account is created on first visit and matched to their Google identity
  afterwards;
- members of a defined admin set get Homarr's `admin` permission and can edit the boards;
- everyone else can look and not touch.

## What IAP gives us, precisely

Three headers ([signed headers](https://docs.cloud.google.com/iap/docs/signed-headers-howto)):

| Header | Trust |
|---|---|
| `x-goog-iap-jwt-assertion` | **ES256-signed JWT. The only one worth anything.** |
| `X-Goog-Authenticated-User-Email` | `accounts.google.com:someone@multitecua.com` — unsigned |
| `X-Goog-Authenticated-User-Id` | unsigned |

IAP strips any client-supplied `x-goog-*` before adding its own, and Google's own docs say
the two unsigned headers *"are available for compatibility, but you shouldn't rely on them
as a security mechanism"*.

Claims in the JWT: `iss` (`https://cloud.google.com/iap`), `sub`, `email`, `hd`, `exp`/`iat`
(**≈10 minute lifetime**), `google.access_levels`, and `aud` — which **for IAP enabled
directly on a Cloud Run service**, which is our shape, is the exact string

```
/projects/<PROJECT_NUMBER>/locations/<REGION>/services/<SERVICE_NAME>
```

and *not* the `/global/backendServices/<id>` form used behind a load balancer. Getting this
wrong does not fail open — an assertion simply never validates — but it is the single most
error-prone constant in the design, which is why it has no default in the env schema.

**There is no groups claim.** IAM can grant IAP access to a Google group, but the
application never learns which groups the person belongs to. Admin-ness has to come from
somewhere else.

## Decision

### 1. A new auth provider, `iap`, credentials-shaped

Homarr's provider list is data, not code: `supportedAuthProviders` is a tuple,
`AUTH_PROVIDERS` selects from it, `filterProviders` filters by `provider.id`. `credentials`
and `ldap` are already `Credentials(...)` providers whose `authorize()` returns a user or
`null` — and Auth.js hands `authorize()` the request, so **a credentials-shaped provider can
read the IAP header**. That is the whole trick.

```
packages/auth/providers/iap/
  iap-provider.ts        createIapConfiguration(db) — the authorize() callback
  verify-assertion.ts    JWT verification, no database, no framework   ← the security core
  resolve-groups.ts      email -> group names (strategy; env allowlist first)
  test/…                 unit tests, especially for the failure paths
```

`authorize()`, in order, refusing at the first failure and returning `null`:

1. read `x-goog-iap-jwt-assertion`; **absent ⇒ refuse.** No fallback to the unsigned header,
   ever.
2. verify the signature against `https://www.gstatic.com/iap/verify/public_key-jwk` with
   `jose` (already at `6.2.3` in the tree), algorithm pinned to **ES256**;
3. `iss === "https://cloud.google.com/iap"`;
4. `aud === AUTH_IAP_AUDIENCE`, exact match, **no default and no wildcard** — this is what
   makes an assertion minted for a *different* IAP-protected Multitec service useless here.
   For us that string is the Cloud Run form above;
5. `exp`/`iat` within a small clock skew;
6. `hd === AUTH_IAP_HOSTED_DOMAIN` when set, and the email domain matches;
7. cross-check `X-Goog-Authenticated-User-Email` against the JWT's `email` and refuse on
   disagreement — it costs nothing and it catches a misconfigured proxy loudly instead of
   silently;
8. find or create the Homarr user by `(email, provider = "iap")`;
9. resolve group names and return `{ id, name, email, groups }`.

Step 9 is why this stays small: `packages/auth/events.ts:47` already synchronises group
membership for **any** provider whose user object carries `groups: string[]`. That branch
was written for LDAP and is provider-agnostic. We get membership sync for free.

The database session is then minted by the existing hand-rolled path in
`configuration.ts:78`, which needs `"iap"` added to its guard.

### 2. Admin comes from the server, never from the request

Two strategies behind one interface:

- **now:** `AUTH_IAP_ADMIN_EMAILS`, a comma-separated allowlist read from the environment,
  supplied by Terraform from Secret Manager. This is the pattern `minecraft-allowlist`
  already uses (`ADMIN_EMAILS`), and it is enough for a junta of a handful of people.
- **later:** the Google Workspace **Directory API**, so membership of
  `junta@multitecua.com` *is* the admin list and nobody edits an env var to add a board
  editor. Multitec already runs `mt-workspace-users-api` and `workspace-dynamic-groups`.

The rule that outlives both: **nothing the browser can influence may decide admin-ness.**
Not a claim, not a header, not a field on the user's own Homarr profile.

Groups map to Homarr groups that must already exist — `synchronizeGroupsWithExternalForUserAsync`
adds and removes memberships but never creates a group. Seed `socios` (permission
`board-view-all`) and `junta` (permission `admin`) before switching the provider on.

### 3. Auto-login, reusing the mechanism that is already there

`AUTH_OIDC_AUTO_LOGIN` already makes the login page fire `signIn("oidc")` from a
`useEffect` on mount. `AUTH_IAP_AUTO_LOGIN` does the same with `signIn("iap")`. Because
`iap` is credentials-shaped there is no redirect round trip: the page mounts, posts, gets a
session cookie and moves on. The user sees a flash of the login page at worst.

### 4. Session lifetime stays at the default — and here is the bill

The first draft proposed short Homarr sessions plus a per-request identity check. Sergio
overruled it, and the reasoning is sound for this association: **IAP has no way to tell the
application that someone's access was revoked** — it just stops letting them past the front
door — but a Homarr database session lives for `AUTH_SESSION_EXPIRY_TIME`, which defaults to
**30 days**. With a handful of joins and leaves a year, a member who leaves keeps a working
session for at most a month, on a device they already had, on a portal of internal links.
That is a real risk and it is a small one, and shortening every session for everybody is not
a proportionate answer to it.

So: **leave `AUTH_SESSION_EXPIRY_TIME` alone.** What that costs, on the record:

- someone who loses IAP access keeps their existing Homarr session until it expires. Killing
  it early is a `DELETE` on the `sessions` row, which is a one-liner worth putting in a
  runbook rather than in the request path;
- **a shared browser shows the wrong person.** Auto-login only fires when there is no
  session, so if two people use the same machine, the second inherits the first's Homarr
  identity while IAP correctly says they are someone else. This is a correctness bug, not
  only a security one, and it is invisible when it happens.

The per-request check therefore survives as an **opt-in flag, default off**
(`MULTITEC_IAP_VERIFY_EVERY_REQUEST`): compare the IAP identity on this request against the
session's, and bounce through login on a mismatch. It is a few lines in
`apps/nextjs/src/proxy.ts` and it costs nothing to have written and unused. Turn it on the
day the portal is opened on a shared machine.

### 5. Close the other doors

- `AUTH_PROVIDERS=iap` and nothing else in production. No credentials, no LDAP — a password
  door that exists is a password door that gets brute-forced.
- The onboarding wizard creates a `credentials` admin. Finish onboarding on a **closed**
  deployment, seed the groups, then switch `AUTH_PROVIDERS` to `iap` and delete or disable
  that account. Never publish an instance whose `/init` has not been completed.
- **Logging out is a trap.** Clearing Homarr's cookie while the IAP cookie stands means
  auto-login signs the person straight back in. Point `AUTH_LOGOUT_REDIRECT_URL` at IAP's
  sign-out endpoint so both are cleared, or remove the logout control entirely — on an
  IAP-gated portal it does not mean what users think it means.
- Homarr's REST/MCP API and its `ApiKey` header are on the same Cloud Run service, so IAP
  blocks them for anything without a Google identity. That is the behaviour we want; it also
  means any future machine-to-machine caller needs an IAP OIDC token, not just an API key —
  and note Cloud Run enforces IAP *before* the IAM check, so a service account that is
  merely `run.invoker` is not enough.

## Threat model, briefly

| Threat | What stops it |
|---|---|
| Someone forges `X-Goog-Authenticated-User-Email` | We never read it as an authority. The JWT signature does the work. |
| Someone reaches the container without passing IAP | With IAP on the Cloud Run service, Cloud Run enforces it before its own IAM check — there is no path to the container that skips it. And even then, no valid assertion ⇒ no session. |
| An assertion stolen from another IAP-protected Multitec service | The exact `aud` check. Assertions are bound to one backend service. |
| Replay of a captured assertion | ≈10-minute `exp`, plus the bypass defences above — the attacker still has to reach the origin. |
| A member promotes themselves to admin | Admin-ness is computed server-side from an env allowlist / Directory API. Nothing in the request participates. |
| An ex-member keeps browsing after losing access | **Accepted, deliberately** (§4): the session outlives the revocation by up to 30 days. Kill the `sessions` row to end it now. |
| A shared browser hands person B person A's identity | **Not covered by default** (§4). `MULTITEC_IAP_VERIFY_EVERY_REQUEST` closes it when it matters. |
| Compromised board content leaks to the public internet | IAP is domain-restricted; there is no anonymous path to the origin at all. |

**Defence in depth is the point.** `minecraft-allowlist` trusts the unsigned header, and it
is defensible there because nothing reaches it without IAP — but it is *one* control, and
its failure mode is silent. The portal gets two independent ones: the platform enforcing
IAP, and a signature we verify ourselves.

## Effort, honestly

| Phase | Work | Estimate |
|---|---|---|
| **0. Spike** | Prove two things on a throwaway deployment: that `x-goog-iap-jwt-assertion` actually arrives at a Cloud Run container behind the ALB, and that Homarr's `/websockets` survives IAP. | **½–1 day, and it must come first** |
| 1. Infrastructure | Terraform in `multitec-terrafrom`: the Cloud Run service with `iap.enabled`, the domain mapping, the external database and Redis, and the weekly Cloud Run Job. No load balancer. See ADR 0003. | 1–2 days |
| 2. The provider | `packages/auth/providers/iap/` + the eight upstream hunks + unit tests. ~300–400 lines. | 1–2 days |
| 3. Session hygiene | Logout behaviour, and the opt-in `proxy.ts` identity check left switched off. | ¼ day |
| 4. Groups from Workspace | Directory API strategy replacing the env allowlist. | 1–2 days, later |
| 5. Content and branding | Boards, tiles, Multitec theme, Spanish copy. Not engineering. | open-ended |

So: **about a week** to "opens the URL and is already signed in, admins can edit, members
cannot". The code is the small part. The risk is concentrated in phase 0.

### What could make this go badly

- **WebSockets behind IAP.** Homarr's boards update live over `/websockets`. No Multitec
  service has ever run a WebSocket behind IAP and Google does not document the interaction
  between a ~10-minute assertion and a long-lived connection. If it fails, the fallback is
  polling — supported, but it changes how the product feels. This is the one unknown big
  enough to change the plan.
- **Cost — largely solved by ADR 0003.** The reason the first draft needed an always-warm
  instance was the embedded cron. Moving it to a Cloud Run Job lets the web service scale to
  zero, provided Redis is external. What remains to decide is the database, and that is
  Sergio's call, not an engineering one.
- **Upstream moving the login page.** Two of our eight hunks are in the login UI, which is
  more volatile than the auth package. If it becomes painful, the auto-login can move to
  `proxy.ts` instead and the UI hunks disappear.

## Alternatives considered

- **OIDC with Google as the identity provider** (`AUTH_PROVIDERS=oidc`, `AUTH_OIDC_AUTO_LOGIN=true`).
  Zero fork changes — it is upstream functionality — and it gives real group claims and a
  real logout. Rejected as the primary design because it is a second authentication on top
  of IAP's, with its own client secret and its own redirect; and with auto-login it still
  round-trips through Google. **It stays the fallback if the `iap` provider proves
  unworkable**, and it is worth keeping the option alive: it is a config change, not a
  rewrite.
- **Trust `X-Goog-Authenticated-User-Email` like `minecraft-allowlist` does.** Simpler, and
  sound *given* the ingress lock. Rejected: one control instead of two, on a system that
  will hold more than a list of IP addresses, and the failure mode is silent.
- **A header-session on every request** (the `getSessionFromApiKeyAsync` shape, no Homarr
  session at all). Conceptually cleanest — the IAP assertion *is* the session — but every
  RSC and tRPC entry point resolves the session through NextAuth's cookie, so this touches
  far more upstream surface than eight hunks. Rejected on merge cost, which is the thing
  ADR 0001 exists to protect.
