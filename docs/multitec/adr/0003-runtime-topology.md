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
With the WebSocket server backed by Redis pub/sub, the web service can scale to zero and
can run more than one instance.

That requires Redis to be **external** (`REDIS_IS_EXTERNAL=true`; the env schema already
supports host, port, username, password and a TLS CA). The bundled in-container Redis makes
each instance an island and dies on scale-down.

Behaviour to expect, not a defect: a browser holding the board open keeps its instance
alive, because Cloud Run counts an open WebSocket as an in-flight request. At the request
timeout the connection is cut and the client reconnects.

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

## Consequences

- No load-balancer cost, and one less moving part. The whole perimeter is Cloud Run + IAP.
- The portal is a **stateless** container again: no volume, no bundled Redis, no bundled
  database. That is what makes scale-to-zero real.
- Two hunks in upstream files instead of the one the first draft implied
  (`instrumentation.ts` joins the list), plus a small entrypoint in our namespace.
- The `ping` job being off means tiles show no up/down status. For a benefits portal that
  is a feature; if anyone ever wants it back, it is a checkbox and a cron row, not a
  redeploy.
- **Everything here is expressed in `multitec-terrafrom`**, never by hand — the Cloud Run
  service, the IAP members, the domain mapping, the Cloud Run Job and its Scheduler
  trigger. The module already supports every one of those.

## What is still unproven

`x-goog-iap-jwt-assertion` arriving at a Cloud Run container with service-level IAP is
documented but has never been observed at Multitec, and the security design in ADR 0002
rests on it. It is the first thing the phase-0 spike checks, together with whether Homarr's
`/websockets` survives IAP at all.
