# ADR 0003 — Where the portal runs: no load balancer, and the cron leaves the web service

- **Status:** accepted (the constraints), proposed (the database)
- **Date:** 2026-08-28
- **Supersedes** the deployment section of the first draft of ADR 0002, which assumed an
  external Application Load Balancer. It was wrong; see below.

## Context

The first analysis assumed the Multitec pattern was "Cloud Run behind an external
Application Load Balancer, IAP on the backend service", because `multitec-terrafrom` has a
`gcp.lb.tf` with a whole IAP-per-path-rule mechanism in it.

Reading the settings rather than the module shows that **mechanism is not in use**:

- `lb_enabled = can(local.settings.lb)` (`gcp.lb.tf:7`) and `settings/multitecweb.yaml`
  has no top-level `lb:` key. The `loadbalancer:` block in that file is commented out.
- IAP is applied to the Cloud Run service itself:
  `iap_enabled = try(each.value.cloudrun.iap.enabled, false)` (`gcp.cloudrun.tf:303`),
  passed straight into the Cloud Run module.
- Custom names come from **Cloud Run domain mappings**
  (`gcp.cloudrun.domain_mappings.tf`), not from a URL map.

So `minecraft.multitecua.com` and `mcmap.multitecua.com` reach Cloud Run with no load
balancer anywhere, and IAP is enforced by Cloud Run before its own IAM check.

Sergio, 2026-08-28, on being told the first version: *"no debe haber un load balancer en
este proyecto de Google, todas las peticiones van directamente a los contenedores y el IAP
se aplica directamente en los contenedores… el load balancer es un coste que no nos podemos
permitir."*

## Decision

### 1. No load balancer. IAP directly on Cloud Run.

The portal is one Cloud Run service with `cloudrun.iap.enabled: true`,
`allow_unauthenticated: false` and a domain mapping — exactly the shape the other two
services already have.

The consequence that matters for ADR 0002: **the JWT audience changes.** IAP on Cloud Run
issues assertions for

```
/projects/<PROJECT_NUMBER>/locations/<REGION>/services/<SERVICE_NAME>
```

not the `/global/backendServices/<id>` form used behind a load balancer. Google documents
the `x-goog-iap-jwt-assertion` header for Cloud Run and documents that audience format, so
the header is expected to be there — but **no Multitec service has ever read it**
(`minecraft-allowlist` only reads the unsigned email header), so it stays a phase-0
observation rather than an assumption.

Two limitations that come with this shape and are worth knowing before something breaks:
IAP cannot be on both the load balancer and the service, and Cloud Run enforces IAP
*before* the IAM check on the caller, so anything that authenticates itself — Pub/Sub push,
a machine-to-machine caller — needs an IAP-aware identity rather than an ordinary one.

### 2. The cron runner leaves the web service

Sergio: *"las tareas programadas, modificarlo para que sean Cloud Run Jobs y se ejecuten
como un servicio aparte."*

Reading the jobs first changes what that costs. **There are three of them**, all in
`packages/cron-jobs/src/jobs/`:

| Job | Schedule | What it does | For the portal |
|---|---|---|---|
| `ping` | **every minute** | reachability probes for the up/down dots on tiles | **not wanted** — our tiles link to external member benefits, not homelab services |
| `analytics` | weekly | usage telemetry to upstream | **not wanted** |
| `iconsUpdater` | weekly | refreshes the icon repositories | the only one worth running |

The first two are switched off **by configuration, not by code**: `initializeAsync` skips
any job whose `cron_job_configuration.isEnabled` is false (`cron-jobs-core/src/group.ts:44`),
and there is a management UI at `/manage/tools/tasks`. `ping` additionally becomes a no-op
when the `board.forceDisableStatus` server setting is on.

So the entire scheduled workload of this portal is **one weekly job**, which is a Cloud Run
Job triggered by Cloud Scheduler — not a second always-on service.

The entrypoint is small and lives in our namespace. `croner` tasks are created **paused**
(`cron-jobs-core/src/creator.ts:93`) and only resumed by `startAllAsync`, so a one-shot
process can initialise and trigger exactly one job without anything else firing:

```
initializeAsync()  →  runManuallyAsync("iconsUpdater")  →  exit
```

`runManuallyAsync` refuses jobs marked `preventManualExecution`, which is only `analytics`
— the one job we do not want anyway.

The web service then needs to *not* start the embedded scheduler. `apps/nextjs/src/instrumentation.ts`
starts tasks and the WebSocket server together, and the imports are dynamic, so a runtime
guard genuinely prevents loading: skip `startTasksAsync()` when `MULTITEC_EMBEDDED_TASKS`
is off, keep `startWebsocketAsync()`, which serves the browser and must stay. One hunk,
default-on, so with no env set the fork still behaves like vanilla Homarr.

### 3. What that buys: the min-instance problem disappears

This is the part that was not obvious, and it is worth more than the instruction that
produced it.

The reason the first draft said `min=1, max=1` with CPU always allocated — the expensive
shape of Cloud Run — was **entirely** the embedded cron: a second instance would run every
job twice, and scale-to-zero would stop them. Take the scheduler out and neither is true.
The service can idle to zero and cost nothing at rest, which is the same shape `mc-map`
already runs (`min_instances: 0`, `max_instances: 4`, behind IAP).

The image is small enough for that to be pleasant rather than theoretical: the official
`ghcr.io/homarr-labs/homarr` amd64 image is **~126 MB compressed**, measured with
`docker manifest inspect`, so a cold start is not a minute-long stall.

### 3b. Redis: required, but it never has to be a bill

**Redis is not optional in Homarr, and it is not a cache you can switch off.** Measured in
the code, not assumed:

- `/api/health/live` returns **500** when Redis does not answer
  (`apps/nextjs/src/app/api/health/live/route.ts` calls `handshakeAsync`).
- It carries the pub/sub for live board updates, the integration session store, the
  image-proxy and update-checker caches, and a lock (`createLockChannel`) whose entire
  purpose is stopping two instances doing the same work twice.

What it holds is nonetheless **all derived** — nothing in Redis is a source of truth, so
losing it on a cold start costs a repopulation and nothing else.

That matters because it decides the money. **Redis only becomes a paid service when more
than one instance has to share it.** Memorystore is a fixed monthly charge, which Sergio
has ruled out for every Multitec project. So:

> **`max_instances: 1`, and let the container run its own Redis.**

The official image already does exactly that — `scripts/run.sh:39` starts `redis-server`
unless `REDIS_IS_EXTERNAL=true`. Cost: nothing. One instance with `concurrency: 80` is far
more than an association's portal will ever need, and capping at one removes the only
failure this creates: two instances, two Redises, and an admin's edit not reaching a member
watching on the other one.

The escape hatch stays open and costs nothing to keep: the env schema already supports an
external Redis in full — host, port, username, password and a **TLS CA**
(`packages/core/src/infrastructure/redis/env.ts`) — so if the portal ever outgrows one
instance, a free-tier hosted Redis is four environment variables away. We are choosing not
to pay for scale we do not have, not painting ourselves into a corner.

One consequence to carry into the Cloud Run Job: the job process imports `@homarr/cron-jobs`,
which pulls `@homarr/redis` into its module graph even though `iconsUpdater` itself touches
only the database. The job image therefore needs a Redis connection to exist, not to be
shared — its own local one is fine.

### 4. The database is external, and the choice is Sergio's

Sergio: *"la base de datos también me preocupa porque va a tener coste… seguramente
contrate una base de datos externa en Supabase o alguna de estas que me da un tier
gratuito."* Cloud SQL is therefore out; this is a decision to take together, not one to
assume.

What the code requires, so the shortlist can be judged on facts:

- `DB_DRIVER=node-postgres` with either `DB_URL` (a connection string, so `sslmode=require`
  works) or the `DB_HOST`/`PORT`/`USER`/`PASSWORD`/`NAME` set. MySQL is equally supported.
- Migrations run at container start (`scripts/run.sh`), so the account needs DDL rights.
- **Uploaded media is a `blob` column, not a file** (`packages/db/schema/sqlite.ts:179`).
  That is why no persistent volume is needed at all — and it is also the thing that will
  eat a free tier's storage quota first. Whatever is chosen, check the size cap against
  "how many logos and background images will la junta upload", not against the row count.
- A serverless Postgres that sleeps when idle pairs badly with a service that also scales
  to zero: the first visit of the day pays both cold starts. Worth weighing against the
  saving.

### 5. The shape, concretely

What this adds up to, so the next person builds it rather than re-deriving it. Everything
below is expressed in `multitec-terrafrom/settings/multitecweb.yaml`; nothing is created by
hand.

| Piece | Choice | Fixed monthly cost |
|---|---|---|
| Web service | Cloud Run `mt-portal`, `iap.enabled: true`, `members: [domain:multitecua.com]`, a domain mapping, `min_instances: 0`, **`max_instances: 1`**, `concurrency: 80`, `cpu_idle: true` | **none** — billed per request |
| Identity | IAP on the service; the `iap` auth provider verifying the assertion (ADR 0002) | none |
| Redis | **bundled inside the container** (§3b) | **none** |
| Database | external free tier, Postgres over TLS (§4) | **none**, subject to the chosen tier |
| Media | `blob` rows in that database — no bucket, no volume | none |
| Cron | one Cloud Run **Job** for `iconsUpdater`, weekly, on Cloud Scheduler; `ping` and `analytics` disabled by configuration | none — a few seconds a week |
| Image | built from this fork by Cloud Build, as every other Multitec service is | none |

**Fixed monthly cost: zero.** That is the whole point of `max_instances: 1` and the bundled
Redis, and it is why Cloud SQL and Memorystore are both out.

The variant to keep in mind: if WebSockets through IAP had failed, the boards would fall
back to polling and everything else in this table would be unchanged. It is a change to how
the product feels, not to what it costs or how it is deployed.

## Consequences

- No load-balancer cost, and one less moving part. The whole perimeter is Cloud Run + IAP.
- The container needs **no persistent volume**: the database is external and uploaded media
  is a `blob` inside it. Redis stays bundled and in-memory (§3b) — the one piece of state
  that lives in the container, and the one it can afford to lose on every cold start.
- Two hunks in upstream files instead of the one the first draft implied
  (`instrumentation.ts` joins the list), plus a small entrypoint in our namespace.
- The `ping` job being off means tiles show no up/down status. For a benefits portal that
  is a feature; if anyone ever wants it back, it is a checkbox and a cron row, not a
  redeploy.
- **Everything here is expressed in `multitec-terrafrom`**, never by hand — the Cloud Run
  service, the IAP members, the domain mapping, the Cloud Run Job and its Scheduler
  trigger. The module already supports every one of those.

## Measured, 2026-08-28

The phase-0 spike ran and the two open questions are answered. Full findings, including the
recipe for authenticating a machine to IAP — which took four attempts and is not the one
the documentation gives — are in
[`../reports/0001-iap-probe.md`](../reports/0001-iap-probe.md).

- `x-goog-iap-jwt-assertion` **does** reach a Cloud Run container with service-level IAP,
  verifies against Google's JWKS, and carries the
  `/projects/<n>/locations/<r>/services/<s>` audience this ADR predicted. Lifetime 600s.
- IAP **does** replace client-supplied `x-goog-*` headers: a forged assertion sent
  alongside a valid credential never reached the application.
- Nothing gets past IAP without one — including a perfectly good Cloud Run invoker token,
  which confirms IAP is enforced before the IAM check.

What the spike deliberately did **not** prove: that Homarr itself runs on Cloud Run. It was
a purpose-built probe, not a Homarr deployment, so that a failure would implicate IAP rather
than a dashboard's migrations. Running the real image against the real database is the next
piece of work, and it is a different question.
