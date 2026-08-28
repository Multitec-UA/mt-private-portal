# Report 0002 — Supabase for the members' portal: free tier, pausing, Terraform, and the alternatives

- **Date:** 2026-08-28
- **Asked for by:** Sergio — *"quiero que analices Supabase… su tier gratuito, el provider de Terraform,
  y mira a ver si esto es lo que nos serviría. Míralo desde varios puntos de vista… sé creativo"*
- **Context:** ADR 0003 §4 left the database open. Cloud SQL is out on cost; the portal must have
  **zero fixed monthly cost**.
- **Everything below is quoted from the vendors' own pages and specs**, with two things measured
  on this machine.

---

## Verdict first

**Supabase's free tier fits the portal on every dimension except one, and that one is the whole
question: a Free project is paused after 7 days of inactivity, and this portal will absolutely have
quiet weeks.** August exists. Exam season exists.

That is survivable — the pause can be prevented *and* recovered from without a human, and §4 shows
how — but it is a mechanism we would be permanently working against, on a plan whose vendor says in
its own production checklist that Free is not for applications needing guaranteed availability.

**So: Supabase is a defensible yes, and it comes down to one trade-off.**

- [**Neon**](#8-the-alternatives-honestly) makes the problem *structural instead of operational*: its
  free plan suspends after 5 minutes and **resumes automatically in a few hundred milliseconds on the
  next connection**. No keep-alive, no watchdog, no human. Everything §4 describes simply does not
  need to exist. But its Terraform provider is community-maintained, not the vendor's.
- **Supabase** keeps the estate describable — an official, mature Terraform provider that even hands
  Terraform the connection string. The price is that we would be permanently working around the
  pause, on a plan whose vendor says in its own production checklist that Free is not for
  applications needing guaranteed availability.

So the real question is whether the portal's database must meet the same "described in code" standard
as everything else this house runs, or whether that can bend once. **That is Sergio's call, not
mine** — §10 says which way I lean and why, and how much it costs to be wrong either way.

---

## 1. What the portal actually needs

The bar, from the code (see `../architecture-notes.md`), so each option can be scored rather than
admired:

| Requirement | Detail |
|---|---|
| **Postgres or MySQL** | `DB_DRIVER=node-postgres` with a connection string. SQLite is out — Cloud Run's filesystem is in-memory. |
| **DDL rights** | Migrations run at container start (`scripts/run.sh`). |
| **A long-lived connection** | One Cloud Run instance, `max_instances: 1`. Not serverless-per-request. |
| **IPv4** | **Non-negotiable.** Cloud Run has no IPv6 egress without Direct VPC egress on a dual-stack subnet, and our services run `vpc_access_enabled: false`. quantumpc has no IPv6 either (already in the backlog), so any tooling from the house is IPv4 too. |
| **Modest size** | See §3 — the honest estimate is tens of MB, not hundreds. |
| **Availability without a human** | Sergio is rarely at a keyboard. Anything whose recovery is "click a button in a dashboard" is a poor fit by construction. |
| **Zero fixed cost** | The constraint that started this. |

---

## 2. The Supabase Free plan, in numbers

From [the pricing page](https://supabase.com/pricing):

| | Free | Pro (from $25/mo) |
|---|---|---|
| Database | **500 MB**, shared CPU, **up to 0.5 GB RAM** ("Nano") | 8 GB included |
| File storage | 1 GB | 100 GB |
| Egress | **5 GB** (+5 GB cached) | 250 GB |
| Backups | **none** | daily, kept 7 days |
| Log retention | **1 day** (DB & API) | 7 days |
| Active projects | 2 | — |
| **Inactivity** | **"Free projects are paused after 1 week of inactivity"** | never paused |

Compute detail from [compute-and-disk](https://supabase.com/docs/guides/platform/compute-and-disk):
Nano is **60 direct Postgres connections, 200 pooler clients, 250 IOPS and 5 MB/s baseline disk**.
That disk figure is the one to keep in mind — it is slow, and Nano "is restricted to the free plan".

### Does 500 MB fit?

Yes, with room, and the reasoning matters more than the number:

- **Icons are not stored.** `iconsUpdater` writes *metadata* — name, URL, checksum
  (`packages/db/schema/sqlite.ts`, `icons.url`). Twenty thousand rows of that is single-digit MB.
- **Uploaded media is stored**, as a `blob` column. Logos are tens of KB; a background image is
  hundreds of KB to a couple of MB. A realistic portal is well under 50 MB.

### But watch the egress, not the size

**Media served out of the database counts as Supabase egress.** A 2 MB background image, uncached,
on a few thousand page views, is measured in gigabytes against a **5 GB/month** allowance. Browser
caching and Homarr's image proxy make this unlikely rather than impossible — but it is the limit
that would bite in month three, not the 500 MB. If backgrounds are heavy, keep them small or serve
them from a GCS bucket instead of uploading them into the dashboard.

---

## 3. The pause: how it actually works

From [Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing):

- A Free project is paused after **7 days** of insufficient **user** database activity. The doc is
  reassuringly specific about the bar: *"a few user requests to the database each day over the
  previous week is enough to keep the project from being paused."*
- A warning email arrives **roughly a week before** the pause.
- Paused projects keep their data. There is a **1-year window** to restore, and community reports
  say restore is one click **within 90 days** and a harder migration after that.

Three traps worth knowing before designing around it:

1. **`pg_cron` does not save you.** A schedule running *inside* the database is not user activity,
   and when the project pauses the schedule pauses with it. The clock has to live outside.
2. **The Free plan has no backups you can download** — Supabase's own
   [production checklist](https://supabase.com/docs/guides/platform/going-into-prod) says
   *"Database backups are not available for download for Free Plan projects."* So a pause that goes
   wrong has no fallback but the platform's own restore.
3. **Restore is not instant.** Even when it works it is minutes, and there are public reports of
   projects stuck in `PAUSING`. A pause is an outage, not a hiccup.

### The good news nobody writes about

I pulled the Management API spec (`https://api.supabase.com/api/v1-json`, 335 KB) and looked, rather
than trusting the blog posts that all say "restore it from the dashboard":

```
POST /v1/projects/{ref}/restore          v1-restore-a-project — "Restores the given project"
GET  /v1/projects                        returns status ∈ [..., INACTIVE, PAUSING, RESTORING, ...]
```

**A pause is therefore detectable and reversible from a script.** That changes the risk from "the
portal is down until Sergio finds a laptop" to "the portal is down for a few minutes and fixes
itself". It is the single most important finding in this report and it is not in any of the
guides.

---

## 4. Keeping it alive — the creative part, and which design is actually robust

Sergio's instinct was right; the question is where the clock lives and what happens when the
keep-alive itself fails.

| Design | Cost | Verdict |
|---|---|---|
| `pg_cron` inside the database | free | **Does not work.** Internal, and dies with the project. |
| GitHub Actions cron pinging the DB | free | Works, and it is what the internet does. But it puts a Multitec production dependency in a repo's CI, and the token lives there. |
| **The portal's own weekly Cloud Run Job** | free | Already exists for `iconsUpdater` — but **weekly is exactly the 7-day edge**. One late run and the project pauses. Only safe if the schedule moves to daily. |
| **A cron on quantumpc** | free, no GCP resource | Tier 1, no approval, no new infrastructure. It is a `SELECT 1` through the pooler in a `postgres:17-alpine` container. Depends on the house being up. |
| **Cloud Scheduler → tiny Cloud Run Job, daily** | ~free | Independent of the house, inside the project it serves, and expressed in Terraform like everything else. |

**What I would build is two layers, because a keep-alive that fails silently is worse than none:**

1. **Prevention — daily, from Cloud Scheduler.** Not weekly. The margin between "weekly job" and
   "7-day pause" is zero, and the failure is invisible until the portal is down.
2. **Recovery — a watchdog on quantumpc.** A cron that reads `GET /v1/projects`, and if the status
   is `INACTIVE`, calls `POST /v1/projects/{ref}/restore` and notifies over Telegram. This is where
   the house *is* the right place: it already has the notification channel, the credential
   discipline and the cron habit, and it is a different failure domain from GCP.

Two layers in two failure domains, and the second one turns the worst case from an outage into a
message saying it fixed itself.

### The honest caveat

Supabase does not forbid this — its own documentation tells you the activity bar in plain terms, and
the warning email is clearly meant to let you act. But we would be deliberately defeating the
mechanism that makes the free plan affordable for them, forever, for a service the association
depends on. That is a judgement for Sergio, not an engineering detail. If the portal matters, the
€25 of Pro is the honest answer; if it is a nice-to-have, the free plan with a keep-alive is a
reasonable use of a free tier.

---

## 5. The connectivity trap, and it is a real one

**Supabase's direct connection is IPv6-only.** IPv4 on the direct connection is a
[paid add-on](https://supabase.com/docs/guides/platform/ipv4-address).

That matters here more than for most people:

- **Cloud Run has no IPv6 egress** unless you attach Direct VPC egress on a **dual-stack subnet in a
  custom-mode VPC**, which needs extra IAM, is Preview for internal IPv6, and Google warns brings
  *"elevated cold-start latencies"*. Our services deliberately run `vpc_access_enabled: false`.
- **quantumpc has no IPv6 either** — that is already an open backlog item, and it is why half the
  HTTPS checks on this machine flake.

So the direct connection is unusable for us on both ends. **The answer is Supavisor, the pooler,
which is IPv4 and on every tier:**

| Mode | Port | IPv4 | Prepared statements | Use |
|---|---|---|---|---|
| Direct | 5432 | **no** (IPv6 only) | yes | not available to us |
| **Supavisor session** | 5432 | yes | **yes** | **ours** — a long-lived server |
| Supavisor transaction | 6543 | yes | **no** | serverless per-request |

**Session mode is the right choice** and it is not a compromise: Supabase's own guidance is
*"if you need long-lasting connections in an IPv4-only environment and do not want to enable the
IPv4 Add-On, session mode resolves this issue."* Transaction mode would be a live trap — Drizzle
over `node-postgres` with prepared statements would fail in ways that look like application bugs.

**This is the single most likely way to lose an afternoon**, and it is worth writing into the
deployment notes before anyone pastes a connection string from the dashboard: take the **session
pooler** string, not the direct one.

---

## 6. The Terraform provider

[`supabase/terraform-provider-supabase`](https://github.com/supabase/terraform-provider-supabase) —
MPL-2.0, **v1.10.1 (2026-07-29)**, last pushed 2026-08-20, 71 stars. Small and quiet, but alive and
official.

**Resources:** `project`, `settings`, `branch`, `apikey`, `edge_function`, `edge_function_secrets`,
`third_party_auth`.
**Data sources:** `apikeys`, `branch`, `network_bans`, **`pooler`**.

What that means for us:

- **It can create the project** — `supabase_project` takes `organization_id`, `name`, `region`,
  `database_password`, `instance_size`. So the database becomes a Terraform resource like everything
  else, which is exactly the discipline this house already has for GCP.
- **`data.supabase_pooler` returns "a map of pooler mode to connection string"** — so the session-mode
  URL can be wired into the Cloud Run service from Terraform, rather than copied by hand out of a
  dashboard. That is a genuinely nice fit: it closes the gap between "external vendor" and "described
  in code".
- **`supabase_settings` can set `network.restrictions`** — an allowlist of CIDRs. Worth knowing, and
  worth *not* over-using: Cloud Run's egress IPs are not stable without a NAT, so restricting to
  quantumpc's address while leaving the portal open is the realistic shape.
- **What it cannot do:** anything about schema, roles or extensions (that is the database's own job,
  and Homarr's migrations handle it), and **it cannot pause or restore** — those are Management API
  calls, which is why §4's watchdog is a script and not a Terraform resource.

### Two credential problems, and they are not small

1. **`database_password` is a required, sensitive attribute of `supabase_project`** — so it lands in
   Terraform state, which for us is `gs://multitec-tfstate-bucket`. That bucket becomes a secret
   store. It is private and access-controlled, so this is a "know it and decide" rather than a
   blocker, but it sits awkwardly beside a constitution that says secrets live in 0600 files outside
   git. The cleaner shape: generate the password out of band, keep it in Secret Manager, and have
   Terraform *import* the project rather than create it.
2. **The provider authenticates with `SUPABASE_ACCESS_TOKEN`, a personal access token** generated
   from a human's account. There is no service-account equivalent. That token controls the whole
   organisation, and it would be the second credential in this house tied to Sergio personally
   rather than to a machine identity. It needs the Telegram-token treatment: 0600, never in git,
   never in a transcript, and a documented rotation.

---

## 7. The backup gap, and how we close it ourselves

Free = **no backups**, and none downloadable. For a members' portal that is the second-worst
property after the pause.

But this house is unusually well placed to fix it, and the fix costs nothing:

- quantumpc already runs an **offsite archive to GCS** (`gs://sc-quantumpc-archive`), verified daily
  by the health check, with a ten-year Duplicati retention ladder next to it.
- The database is reachable from here **over IPv4 through the session pooler**.
- **Measured on this machine:** there is no `pg_dump` installed (Ubuntu 20.04 would ship v12 anyway,
  which cannot dump a modern server), but
  `docker run --rm postgres:17-alpine pg_dump` works and reports **17.11**. Docker needs no sudo
  here.

So a nightly `pg_dump | gzip` into the existing bucket is a Tier 1 cron and perhaps thirty lines.
That turns "no backups" into "backups we own, in a bucket we already trust, with a restore path we
can rehearse" — which is better than what the Pro plan would have given us anyway, because Pro's
backups cannot be downloaded on demand either.

**This is the part I would not skip regardless of which vendor wins.** A free database with our own
backups is safer than a paid one without them.

---

## 8. The alternatives, honestly

| | Supabase Free | **Neon Free** | Cloud SQL (db-f1-micro) |
|---|---|---|---|
| Storage | 500 MB | 0.5 GB per project | as provisioned |
| Idle behaviour | **paused after 7 days, needs an API call or a human** | **suspends after 5 min, resumes automatically in a few hundred ms** | always on |
| Compute allowance | shared CPU, Nano | 100 CU-hours/month (~400 h at 0.25 CU) | dedicated |
| Egress | 5 GB | 5 GB | GCP egress |
| Backups | none | 6-hour instant-restore window, 1 manual snapshot | automatic |
| IPv4 | via pooler only | yes | yes |
| Terraform | **official, v1.10.1, vendor-maintained** | **weak — see below** | in-repo already |
| Fixed cost | **€0** | **€0** | **~€9/mo — ruled out** |

**Neon's scale-to-zero is not the same thing as Supabase's pause, and the difference is the entire
argument.** Both stop the compute when nobody is looking. Supabase requires an external actor to
start it again; Neon starts it on the next connection, in *"a few hundred milliseconds"*. For a
portal that may sit untouched for a month between term-time bursts, that is the difference between a
system that needs a babysitter and one that does not.

What Neon costs us in exchange, and the second point is the one that gives me pause:

- **A 100 CU-hour monthly allowance**, generous for this traffic but a *meter* that can run out —
  where Supabase's limit is a size cap we are nowhere near. And a compute woken twenty times a day
  by different members stays up more than the arithmetic suggests; there is a public discussion of
  exactly that surprise.
- **Its Terraform story is markedly weaker than Supabase's.** I assumed "official provider" and
  checked: `neondatabase/terraform-provider-neon` exists but has **1 star and no description**
  (pushed 2026-08-27), while the mature one,
  [`kislerdm/terraform-provider-neon`](https://github.com/kislerdm/terraform-provider-neon), is
  **community-maintained with 116 stars**. Supabase's, by contrast, is the vendor's own, at v1.10.1.
  For a house whose first rule is that infrastructure is described in code and never touched by
  hand, that is not a footnote — it is the difference between the database being a Terraform
  resource and being a thing somebody clicked.
- Neon's free tier keeps only a 6-hour instant-restore window, so §7's own backups matter just as
  much either way.

The connectivity story, though, is simpler than Supabase's: **Neon endpoints on AWS serve both IPv4
and IPv6**, so the direct connection works from Cloud Run with no pooler and no add-on. Worth
knowing that Neon's pooler is PgBouncer in **transaction mode only** — no prepared statements — so
the direct endpoint is the one to use, which is also the one that supports everything.

Also considered and dismissed:

- **Turso / libSQL** — Homarr speaks `better-sqlite3`, not libSQL over HTTP. Out on compatibility.
- **SQLite + Litestream replicating to GCS.** Genuinely tempting: no vendor at all, everything stays
  in GCP, costs pennies, and `max_instances: 1` gives the single writer it needs. Dismissed because
  Cloud Run can evict an instance without warning and Litestream ships the WAL asynchronously — the
  window is small and the data loss would be silent. For a portal edited a few times a month that is
  *probably* fine, which is not a sentence I want to write about the only copy of the data.
- **A second free project as a warm standby** (the Free plan allows 2). Cute, and it doubles the
  keep-alive surface and the sync problem for a portal that does not need it.

---

## 9. The angles that are not technical

- **A vendor outside GCP is new ground for this house.** The constitution says GCP is modified only
  through Terraform, and that discipline is what keeps the estate describable. Supabase-through-
  Terraform preserves the *shape* of that rule, which is more than most external services would
  allow — but it is still a second control plane, a second status page, and a second place to look
  when something breaks at 9pm.
- **Latency.** Nearest Supabase EU regions are `eu-west-3` (Paris) and `eu-west-2` (London), against
  Cloud Run in `europe-west1` (Belgium). That is single-digit to low-teens milliseconds per query,
  versus sub-millisecond for a co-located database. A server-rendered board doing a dozen queries
  pays that a dozen times, once per render. Noticeable, not painful — and it is the price of free.
- **Disk.** Nano's 250 IOPS / 5 MB/s baseline is slow. Fine for a dashboard; it would not be fine for
  anything analytical.
- **Log retention is one day.** Debugging something that happened yesterday afternoon is not possible.
- **Who owns the account.** A personal access token and an organisation registered to a person is a
  bus-factor question for an association whose junta rotates every year. Whatever is chosen, it
  should be registered to a Multitec Workspace account, not to Sergio's personal identity.

---

## 10. Recommendation

**It is closer than it looked when I started, and the deciding question is one only Sergio can
answer: does the portal's infrastructure have to be describable in Terraform to the same standard as
everything else in this house?**

- **If yes — Supabase.** Its provider is the vendor's own and mature, `data.supabase_pooler` hands
  Terraform the connection string, and the database becomes a resource like every other. The price is
  the pause, and §4 is the tax: two crons, in two failure domains, that must not silently stop.
- **If that standard can bend for one external dependency — Neon.** It removes the problem instead of
  managing it: suspend after 5 minutes, automatic resume in a few hundred milliseconds, no
  keep-alive, no watchdog, no human. The price is a community-maintained provider and a CU-hour
  meter to watch.

**My own lean is Neon**, because "keep the database awake, and watch for it falling asleep" is
ongoing work that can fail quietly, while "the Terraform provider is community-maintained" is a
known, static cost — and because a portal nobody visits for a month is the *normal* state of an
association's site in August, not an edge case. But I hold that loosely: the Terraform argument for
Supabase is real and it is exactly the kind of discipline this house has been right to insist on.

**If Sergio prefers Supabase** — for the ecosystem, or because he already has an account, or because
Neon's CU-hour meter worries him more than Supabase's pause — it is a real option and the plan is:

1. Project in `eu-west-3` (Paris), created through the Terraform provider, password out of band in
   Secret Manager.
2. **Session pooler** connection string (port 5432), never the direct one. Written into the
   deployment notes in capitals.
3. Daily keep-alive from Cloud Scheduler — daily, not weekly.
4. Watchdog on quantumpc: `GET /v1/projects` → if `INACTIVE`, `POST /restore`, and tell Telegram.
5. Nightly `pg_dump` through `postgres:17-alpine` into the existing archive bucket.
6. The access token treated like the Telegram token.

Steps 5 and 6 are needed **whichever vendor wins**. Only 3 and 4 are the Supabase tax.

---

## 11. What I could not answer from a desk

- **Real query latency** from `europe-west1` to a Paris or Frankfurt Postgres, under Homarr's actual
  query pattern. Ten minutes of measurement once a project exists, and worth doing before committing.
- **Whether Homarr's migrations run clean through Supavisor session mode.** They should — session
  mode supports everything — but "should" is what phase 0 taught us to distrust.
- **Neon's CU-hour burn for this traffic shape.** Measurable in a week of real use, not before — and
  it is the number that would decide whether the free plan holds.
- **Whether the community Neon provider is good enough**, if Neon wins. 116 stars is healthy for a
  community provider and nothing like a vendor commitment.

Each of those is small, and each is the sort of thing that is cheap to check and expensive to assume.
