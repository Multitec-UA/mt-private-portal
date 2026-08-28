# Architecture notes — reading Homarr as a member portal

Written on 2026-08-28 against `upstream/dev` at `331925c19` (release `v1.76.2`). Line
numbers are from that commit; re-check them after a sync.

This is not a re-statement of `.agents/skills/codebase-context/SKILL.md` — that file is
upstream's own map and it is accurate. This one answers a narrower question: **what does
Multitec have to build, and where does it attach?**

---

## 1. The shape of the thing

A pnpm + Turborepo monorepo. Four apps, ~35 packages. What matters operationally is that
**the production image is one container running several processes**, and that two of them
are hidden inside the third:

- `nginx` on **7575** — the only exposed port, routes `/websockets` → 3001 and everything
  else → 3000 (`nginx.conf`).
- `redis` — bundled, unless `REDIS_IS_EXTERNAL=true` (`scripts/run.sh:39`).
- `node apps/nextjs/server.js` on **3000** — and inside it, via Next.js instrumentation
  (`apps/nextjs/src/instrumentation.ts`), **the cron runner (`@homarr/tasks`) and the
  WebSocket server (`@homarr/websocket`) start embedded in the same process.**

That last point is the single most important deployment fact in this repository. Homarr is
an **always-on, single-instance, stateful** application:

- the cron jobs live in every Next.js process, so *N* instances run every job *N* times;
- the WebSocket server backs tRPC subscriptions — boards update live over it;
- Redis is a hard dependency, not a cache you can drop.

Anything that scales this horizontally or lets it idle to zero breaks something. See
§5.

State lives in exactly two places: the SQL database and Redis. **Uploaded media is a
`blob` column in the database** (`packages/db/schema/sqlite.ts:179`), not a file on disk —
so with an external database, *the container needs no persistent volume at all*. The
`/appdata` volume only holds the bundled sqlite file and the redis dump.

Three database dialects are supported (sqlite / mysql / postgresql) with a schema file
each under `packages/db/schema/` and migrations per dialect under `packages/db/migrations/`.

---

## 2. What the portal needs, and how much of it already exists

The brief is: a socio signs in, sees their benefits and links, and cannot change the
board; an admin can. Reading the permission model, **that is configuration, not code.**

- `packages/definitions/src/permissions.ts` defines global group permissions —
  `board-create`, `board-view-all`, `board-modify-all`, `board-full-all`, an `app-*` and
  `integration-*` family, and `admin: true`, which resolves to all of them via
  `groupPermissionParents`.
- `boardGroupPermission` (`packages/db/schema/sqlite.ts:307`) grants a **group** one of
  `view | modify | full` on a **specific board**.
- Groups, group members and group permissions are ordinary tables with a management UI at
  `/manage/users` and `/manage/groups`.

So the target state is two groups: `socios` with `board-view-all` (or a `view` grant on
the portal board specifically) and `junta` with `admin`. Nothing in this repository has to
change for that to work. **The only thing missing is who decides which group a person
lands in — and that is the IAP question.**

The board itself — tiles, links, categories, icons (20k+ built in), widgets — is what
Homarr already is. Building "the benefits page" is authoring content in the product, not
writing React.

---

## 3. The auth stack, traced

NextAuth (Auth.js v5) with **database sessions**, wired in
`packages/auth/configuration.ts`.

**The provider list is data.** `supportedAuthProviders` is a three-element tuple
(`packages/definitions/src/auth.ts:1`); `AUTH_PROVIDERS` is a comma-separated env var
parsed against it (`packages/auth/env.ts`); `filterProviders`
(`packages/auth/providers/filter-providers.ts`) keeps only the enabled ones by
`provider.id`. Adding a provider is adding an entry to a tuple, an entry to an array, and
a new file.

**Two provider shapes already exist, and the difference matters.**

- `oidc` is a real OAuth redirect provider (`providers/oidc/oidc-provider.ts`). It sends
  the browser to an identity provider and comes back.
- `credentials` and `ldap` are `Credentials(...)` providers with an `authorize()` callback
  that returns a user object or `null`. Because Auth.js does not create database sessions
  for credentials providers, `configuration.ts:78` does it by hand — mints a session token,
  writes the `sessions` row, sets the cookie — but only when
  `provider === "credentials" || provider === "ldap"`.

**Group synchronisation is already generic.** In the sign-in event handler
(`packages/auth/events.ts:47`):

```ts
if ("groups" in user && Array.isArray(user.groups)) {
  await synchronizeGroupsWithExternalForUserAsync(db, user.id, user.groups as string[]);
}
```

That branch was written for LDAP, and it is untyped and provider-agnostic. **Any
credentials-style provider that returns `groups: string[]` gets membership sync for free,
with zero edits to `events.ts`.** Note what the sync does and does not do: it adds the user
to groups that *already exist by name* and removes them from groups they are no longer in.
It never creates a group. The groups must be seeded first.

**Auto-login already exists too.** `AUTH_OIDC_AUTO_LOGIN` makes the login page's client
component fire `signIn("oidc")` from a `useEffect` on mount
(`apps/nextjs/src/app/[locale]/auth/login/_login-form.tsx:107`). The same mechanism, with a
credentials-style provider, produces a login page that logs you in and redirects before you
can read it.

**The `provider` column is plain text.** `users.provider` is
`text().$type<SupportedAuthProvider>()` (`packages/db/schema/sqlite.ts:56`) — a TypeScript
type, not a database enum, in all three dialects. **Adding a provider needs no migration.**

**There is already a non-cookie authentication path.** `getSessionFromApiKeyAsync`
(`packages/auth/api-key/get-api-key-session.ts`) turns an `ApiKey` header into a full
`Session` via `createSessionAsync`, and the tRPC routes prefer it over the cookie
(`apps/nextjs/src/app/api/trpc/[trpc]/route.ts:41`). That is a working precedent for
"authenticate from a request header", and it is the template if header-per-request
authentication is ever preferred over minting a Homarr session.

### The seams, exactly

An `iap` provider touches these upstream files and no others:

| File | Change | Conflict risk |
|---|---|---|
| `packages/definitions/src/auth.ts:1` | add `"iap"` to the tuple | low — one-line tuple |
| `packages/auth/env.ts` | add an `authProviders.includes("iap")` block | low — parallel to the oidc/ldap blocks |
| `packages/auth/configuration.ts:64` | add one entry to the `filterProviders([...])` array | low — end of array |
| `packages/auth/configuration.ts:78` | add `"iap"` to the credentials-session guard | **medium** — inside a conditional |
| `apps/nextjs/src/app/api/auth/[...nextauth]/route.ts:46` | add an `iap` branch to `extractProvider` | low — parallel `if` |
| `apps/nextjs/src/app/[locale]/auth/login/page.tsx:54` | pass one more prop | low |
| `apps/nextjs/src/app/[locale]/auth/login/_login-form.tsx:107` | extend the auto-login effect | medium |
| `packages/auth/providers/check-provider.ts:22` | optional `case "iap"` | low — the `default` is already safe |

Everything else is new files under `packages/auth/providers/iap/`.

That is **eight small hunks in seven files**, all of them additive in shape. It is a small
change measured against how much it buys.

---

## 4. Identity: what IAP actually hands us

Google IAP sits in front of the load balancer and adds three headers
([signed headers](https://docs.cloud.google.com/iap/docs/signed-headers-howto)):

- `x-goog-iap-jwt-assertion` — an **ES256-signed JWT**. The only trustworthy one.
- `X-Goog-Authenticated-User-Email` — `accounts.google.com:someone@multitecua.com`.
- `X-Goog-Authenticated-User-Id`.

IAP strips any client-supplied copy of `x-goog-*` before adding its own. Google's own
documentation still says the two unsigned headers *"are available for compatibility, but
you shouldn't rely on them as a security mechanism"*.

JWT claims: `iss` = `https://cloud.google.com/iap`, `sub`, `email`, `hd` (hosted domain),
`exp`/`iat` (**≈10 minute lifetime**), `google.access_levels`, and `aud`, whose exact form
depends on the resource:

- backend service behind an external ALB — `/projects/<number>/global/backendServices/<id>`
- IAP enabled directly on Cloud Run — `/projects/<number>/locations/<region>/services/<name>`

Public keys: `https://www.gstatic.com/iap/verify/public_key-jwk`.

**What IAP does not give us is group membership.** There is no `groups` claim; IAM can
grant IAP access *to* a Google group, but the app never learns which groups the user is
in. So the admin/socio distinction has to come from somewhere else — an env allowlist, or
the Workspace Directory API. Multitec already has both an
[`ADMIN_EMAILS` env allowlist in `minecraft-allowlist`](https://github.com/Multitec-UA/minecraft-allowlist)
and a Directory-API service in `mt-workspace-users-api`.

Also worth knowing: the IAP session is Google's, not ours. **IAP has no way to tell the
application that a user's access was revoked** — it simply stops letting them past. If
Homarr has already minted a 30-day database session (`AUTH_SESSION_EXPIRY_TIME` defaults to
`30d`), that session outlives the revocation for anyone who can reach the origin. Two
mitigations, and we want both: short Homarr sessions, and re-checking the IAP identity on
every request rather than only at sign-in.

Full design and threat model: **`docs/multitec/adr/0002-iap-authentication.md`**.

---

## 5. Deployment consequences

The Multitec pattern for this is settled and proven twice (`minecraft-allowlist`,
`mc-map`): Cloud Run with `allow_unauthenticated: false`, behind the external Application
Load Balancer, with IAP on the backend service restricted to `domain:multitecua.com`. It
is all already expressed in `multitec-terrafrom` (`gcp.lb.tf`, the `iap:` block in
`settings/multitecweb.yaml`).

Homarr fits that pattern, with four caveats that come straight from §1:

1. **`min_instances: 1`, `max_instances: 1`, CPU always allocated.** Cron jobs run inside
   the Next.js process, so a second instance duplicates every job and scale-to-zero stops
   them. This is the expensive shape of Cloud Run — an always-warm instance with CPU
   allocated costs on the order of a small VM, and a plain GCE instance behind the same
   LB+IAP would be cheaper. Worth pricing before committing.
2. **Database: Cloud SQL (PostgreSQL or MySQL).** Not the bundled sqlite — a single
   Cloud Run instance with a sqlite file on a GCS FUSE mount is a corruption story. With
   Cloud SQL, media blobs live in the database and the container needs no volume.
3. **Redis.** Bundled Redis works while there is exactly one instance; Memorystore is the
   clean answer and `REDIS_IS_EXTERNAL=true` is already supported.
4. **WebSockets through IAP are the open risk.** The board UI subscribes over
   `/websockets`. The external ALB proxies WebSocket upgrades, and IAP authenticates the
   HTTP handshake — but the interaction of a ~10-minute IAP assertion with a long-lived
   connection is not something Google documents clearly, and no Multitec service has ever
   run a WebSocket behind IAP. **This needs a spike before anything else is built**; if it
   fails, the fallback is polling, which Homarr supports but which changes the feel of the
   product.

Two more, smaller:

- `AUTH_SECRET` is regenerated on every container start (`scripts/run.sh:20`). Harmless
  here because sessions are rows in the database, not JWTs — but do not build anything
  that assumes it is stable.
- The **first-run onboarding wizard** (`/init`, `packages/definitions/src/onboarding.ts`)
  will greet whoever arrives first if the instance is published before onboarding is
  finished. Complete onboarding on a closed deployment, then open IAP.

---

## 6. Things that will bite

- **`pnpm-lock.yaml` conflicts are the usual reason a fork sync hurts.** Never hand-merge
  it: take upstream's version and re-run `pnpm install`.
- **`packages/translation/src/lang/*.json`** is Crowdin-managed upstream. Our Spanish copy
  belongs in keys we own, in our own namespace, or it will be overwritten by a translation
  sync.
- **`CHANGELOG.md` is written by semantic-release.** It conflicts on literally every
  release. Ours is `docs/multitec/CHANGELOG.md`.
- **`apps/docs/`** is upstream's Docusaurus site. `AGENTS.md` requires documenting
  user-facing changes there; for changes that stay in this fork, document them in
  `docs/multitec/` instead and note the deviation in the touchpoints registry.
- Lint is **oxlint** and format is **oxfmt**. Running Prettier over this repo would create
  a five-figure-line diff and permanent conflicts.
