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

That last point is the single most important deployment fact in this repository. **Out of
the box** Homarr is an always-on, single-instance, stateful application:

- the cron jobs live in every Next.js process, so *N* instances run every job *N* times;
- the WebSocket server backs tRPC subscriptions — boards update live over it;
- Redis is a hard dependency, not a cache you can drop.

Out of the box, therefore, anything that scales it horizontally or lets it idle to zero
breaks something. §5 is about how much of that is actually load-bearing for us: the cron
constraint can be lifted, and once it is, the other two stop forcing an always-warm
instance.

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

Google IAP sits in front of the container — for us, enabled directly on the Cloud Run
service, with no load balancer (§5) — and adds three headers
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

- **IAP enabled directly on Cloud Run — `/projects/<number>/locations/<region>/services/<name>`.
  This is ours.**
- backend service behind an external ALB — `/projects/<number>/global/backendServices/<id>`.
  Not ours, and picking this one by mistake means no assertion ever validates.

Public keys: `https://www.gstatic.com/iap/verify/public_key-jwk`.

**What IAP does not give us is group membership.** There is no `groups` claim; IAM can
grant IAP access *to* a Google group, but the app never learns which groups the user is
in. So the admin/socio distinction has to come from somewhere else — an env allowlist, or
the Workspace Directory API. Multitec already has both an
[`ADMIN_EMAILS` env allowlist in `minecraft-allowlist`](https://github.com/Multitec-UA/minecraft-allowlist)
and a Directory-API service in `mt-workspace-users-api`.

Also worth knowing: the IAP session is Google's, not ours. **IAP has no way to tell the
application that a user's access was revoked** — it simply stops letting them past. A Homarr
database session lives for `AUTH_SESSION_EXPIRY_TIME`, which defaults to `30d`, so it
outlives the revocation. **Sergio has accepted that** — this association has very few joins
and leaves, and shortening every session for everyone is not proportionate to it. The
consequences, including the shared-browser case it also leaves open, are written out in
ADR 0002 §4 rather than silently designed around.

Full design and threat model: **`docs/multitec/adr/0002-iap-authentication.md`**.

---

## 5. Deployment consequences

**Corrected 2026-08-28 after Sergio read the first version.** It assumed an external
Application Load Balancer, because `multitec-terrafrom` contains a whole IAP-per-path-rule
mechanism in `gcp.lb.tf`. That mechanism is not in use: `lb_enabled = can(local.settings.lb)`
and `settings/multitecweb.yaml` has no `lb:` key. **IAP is applied directly to the Cloud Run
service** (`gcp.cloudrun.tf:303`), and custom names come from Cloud Run domain mappings.
There is no load balancer anywhere in this project, and there will not be one — it is a cost
the association will not carry. The full reasoning is **ADR 0003**; what follows is the shape
of the application that constrains it.

### The three jobs, and why that number matters

The cron runner is embedded in the Next.js process (§1), which is what would otherwise
force an always-warm, single-instance deployment. Before designing around that, count the
jobs. There are **three**, in `packages/cron-jobs/src/jobs/`:

| Job | Schedule | For a benefits portal |
|---|---|---|
| `ping` | every minute | not wanted — our tiles link to external sites, not homelab services |
| `analytics` | weekly | not wanted — telemetry to upstream |
| `iconsUpdater` | weekly | the only one worth running |

The first two switch off **by configuration**: `initializeAsync` skips any job whose
`cron_job_configuration.isEnabled` is false (`packages/cron-jobs-core/src/group.ts:44`), and
`/manage/tools/tasks` is the UI for it. `ping` additionally no-ops when the
`board.forceDisableStatus` server setting is on.

So the scheduled workload is one weekly job — a Cloud Run Job on a Cloud Scheduler trigger,
not a second always-on service. The one-shot entrypoint is easy because croner tasks are
created **paused** (`packages/cron-jobs-core/src/creator.ts:93`) and only resumed by
`startAllAsync`: `initializeAsync()` → `runManuallyAsync("iconsUpdater")` → exit runs
exactly that job and nothing else. (`runManuallyAsync` refuses jobs flagged
`preventManualExecution`, which is only `analytics`.)

### What that unlocks

Take the scheduler out of the web service — a runtime guard in
`apps/nextjs/src/instrumentation.ts`, keeping `startWebsocketAsync()` — and the two reasons
it could not scale disappear. The service can then **scale to zero and run more than one
instance**, because the WebSocket server is backed by Redis pub/sub.

That requires **external Redis**. `REDIS_IS_EXTERNAL=true` with host, port, username,
password and a TLS CA is already in the env schema
(`packages/core/src/infrastructure/redis/env.ts`); the bundled in-container Redis makes each
instance an island and dies on scale-down.

Expect this behaviour, which is not a defect: a browser holding a board open keeps its
instance alive, because Cloud Run counts an open WebSocket as an in-flight request. At the
request timeout the connection is cut and the client reconnects.

### The database

External, and the choice is Sergio's — Cloud SQL is out on cost. What the code needs, so a
free tier can be judged on facts:

- `DB_DRIVER=node-postgres` with `DB_URL` (a connection string, so `sslmode=require` works)
  or the `DB_HOST`/`PORT`/`USER`/`PASSWORD`/`NAME` set. MySQL is equally supported
  (`packages/core/src/infrastructure/db/env.ts`).
- Migrations run at container start (`scripts/run.sh`), so the account needs DDL rights.
- **Uploaded media is a `blob` column** (§1). No volume is needed anywhere — and that same
  fact is what will eat a free tier's storage quota first. Judge the size cap against how
  many logos and backgrounds la junta will upload, not against the row count.
- A serverless Postgres that sleeps when idle pairs badly with a service that also scales to
  zero: the first visit of the day pays both cold starts.

### Two smaller ones

- `AUTH_SECRET` is regenerated on every container start (`scripts/run.sh:20`). Harmless,
  because sessions are rows in the database rather than JWTs — but nothing may assume it is
  stable, and that matters more now that there can be several instances.
- The **first-run onboarding wizard** (`/init`, `packages/definitions/src/onboarding.ts`)
  will greet whoever arrives first if the instance is published before onboarding is
  finished. Complete onboarding on a closed deployment, then open IAP.

### Still unproven

**WebSockets behind IAP.** The board UI subscribes over `/websockets`. Google documents
neither support nor a limitation for a long-lived connection under a ~10-minute assertion,
and no Multitec service has ever run one behind IAP. **This needs a spike before anything
else is built**; if it fails, the fallback is polling, which Homarr supports but which
changes how the product feels.

**That the signed assertion arrives at all.** Google documents `x-goog-iap-jwt-assertion`
for Cloud Run and documents the `/projects/…/locations/…/services/…` audience form, so it is
expected — but `minecraft-allowlist` only ever reads the *unsigned* email header, so nobody
here has observed it. The security design in ADR 0002 rests on it.

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
