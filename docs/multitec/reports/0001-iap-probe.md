# Report 0001 — Phase-0 spike: IAP on Cloud Run, measured

- **Date:** 2026-08-28
- **Approved by:** Sergio, with a condition: *"puedes crear una base de datos si quieres,
  puedes crear un Redis si quieres, pero de forma temporal… recuerda que luego tendrás que
  borrar estos recursos."*
- **Answers:** ADR 0002 and ADR 0003, both of which said "unproven" in three places
- **Probe:** [`../spikes/iap-probe/`](../spikes/iap-probe/) — service `mt-iap-probe` in
  `multitecweb`, europe-west1
- **Cost:** it needed **neither a database nor a Redis**. See §5.

Everything below was observed, not read. Where a document says one thing and the machine
said another, the machine is quoted.

---

## 1. The signed assertion arrives, and it verifies

**Question:** does `x-goog-iap-jwt-assertion` reach a container when IAP is enabled
directly on a Cloud Run service, with no load balancer? Nobody at Multitec had ever seen
it: `mc-allowlist` and `mc-map` read only the *unsigned* email header.

**Answer: yes, and every check passes.**

```
Q1  assertion header present: YES
Q1  signature + iss + aud + exp verified: YES
Q1  audience matches the expected Cloud Run form: YES
Q1  signed email == unsigned header: YES
```

The claims, in full:

```json
{
  "aud": "/projects/882854291514/locations/europe-west1/services/mt-iap-probe",
  "iss": "https://cloud.google.com/iap",
  "email": "quantumpc-agent@sergio-conejero.iam.gserviceaccount.com",
  "sub": "accounts.google.com:109512945015217663163",
  "hd": null,
  "google": null,
  "lifetime_seconds": 600
}
```

Three things to carry into the implementation:

- **The audience is the Cloud Run form**, exactly as ADR 0003 predicted after the
  load-balancer correction. `AUTH_IAP_AUDIENCE` is
  `/projects/<PROJECT_NUMBER>/locations/<REGION>/services/<SERVICE_NAME>`.
- **The lifetime is 600 seconds**, confirming the ten minutes the design assumed.
- **`hd` is `null` for a service account.** It is a Workspace-user claim. A provider that
  *requires* `hd` would therefore reject every machine caller. Make the `hd` check
  conditional — assert it when present, never demand it. This is a bug the design would
  have shipped.

Headers seen by the container: `x-goog-iap-jwt-assertion`,
`x-goog-authenticated-user-email`, `x-goog-authenticated-user-id`. All three.

## 2. IAP really does replace client-supplied headers — tested, not quoted

Google's documentation says IAP strips client `x-goog-*` headers. ADR 0002 leans on that,
so it was worth attacking rather than believing.

A request was sent with **a valid IAP credential** and, alongside it, a **forged**
`x-goog-iap-jwt-assertion` — a well-formed ES256 token carrying the correct issuer, the
correct audience, and `email: impostor@multitecua.com` — plus a matching forged
`x-goog-authenticated-user-email`.

```
verified                : True
email the app believes  : quantumpc-agent@sergio-conejero.iam.gserviceaccount.com
unsigned email header   : quantumpc-agent@sergio-conejero.iam.gserviceaccount.com

VERDICT: IAP REPLACED the forged headers
```

The impersonation attempt left no trace in what the application saw. Separately, and
locally, the probe was shown to *reject* that same forged token when it is the only one
present — its `kid` is not in Google's JWKS — which proves the verification is doing work
rather than decorating a request that was already trustworthy.

## 3. Nothing gets past IAP without a credential

The control that makes every other result meaningful:

| request | result |
|---|---|
| anonymous `GET /` | **302** to `accounts.google.com` |
| anonymous `GET /probe.json` | **302** |
| anonymous `GET /probe.txt` | **302** |
| anonymous `GET /healthz` | **404** — see §3b, this one is not IAP |
| OIDC token, `aud` = service URL | **401** `Invalid IAP credentials: Invalid bearer token. Invalid JWT audience.` |

The 401 on a perfectly good Cloud Run invoker token confirms **IAP is enforced before the
IAM check**. There is no "I have run.invoker so I am in" path.

The practical consequence of the 302s: **an unauthenticated uptime check cannot work
through IAP.** If the portal ever needs external monitoring, that monitor needs an IAP
credential (§4) — worth planning rather than discovering when the first alert never fires.

## 3b. `/healthz` never reaches the container, and that is not IAP

Chased because the first reading of the table above was wrong. `/healthz` returns 404
**even with a valid credential**, so it looked like an IAP quirk. It is not:

| authenticated request | who answered |
|---|---|
| `GET /nope` | **FastAPI** — `{"detail": ...}`, and it appears in the container's log |
| `GET /api/health/live` | **FastAPI** |
| `GET /healthz` | **Google's edge** — an HTML 404 page, and no log line in the container at all |

So **`/healthz` is swallowed in front of Cloud Run and never arrives.** Two things follow:

- Do not put anything on `/healthz` in this project. It will 404 and the container will
  never see the request, which is a miserable thing to debug.
- **Homarr is unaffected**: its health endpoint is `/api/health/live`, and that path was
  measured reaching the container. Confirmed rather than assumed, because the alternative
  was a startup probe that could never pass.

## 4. How a machine authenticates to IAP here — the recipe nobody at Multitec had

This took four attempts and the working one is not the obvious one. Recorded in full
because the portal will eventually need a machine caller, and because the two failures are
more instructive than the success.

| attempt | result |
|---|---|
| `gcloud auth print-identity-token --audiences=<service URL>` | **401** Invalid JWT audience |
| same, `--audiences=<IAP OAuth client id>` | **401** Invalid JWT audience |
| self-signed SA JWT, `aud = <service URL>` | **401** `Audience specified does not match requested endpoint` |
| **self-signed SA JWT, `aud = <service URL>/*`** | **200** |

So: **the IAP resource URL with a `/*` path wildcard, in a JWT the service account signs
itself with RS256** — not a Google-minted OIDC token, and not the OAuth client id.

Two side notes:

- `gcloud auth print-identity-token --include-email` **fails outright** for a key-based
  service account: *"Invalid account type for `--include-email`. Requires an impersonate
  service account."* The self-signed route sidesteps this by putting `email` in the
  payload directly.
- The IAP OAuth client id is discoverable without any API call — it is in the `client_id`
  of the 302 redirect an anonymous request receives. For service-level Cloud Run IAP it
  belongs to a **Google-owned project**, and `gcloud iap oauth-clients list` shows the
  project's brand with no client under it. That is why "set the audience to your client
  id" — which the IAP documentation says — does not apply here.

## 5. It needed no database and no Redis

Sergio approved creating a temporary Cloud SQL and a temporary Redis. Neither was created,
because the spike was built as a purpose-made probe rather than as a Homarr deployment.

That was a design choice with a reason: a probe that fails must implicate **IAP**. Standing
up Homarr would have added migrations, a database, a Redis and a startup sequence — four
other things that can fail and be mistaken for the answer. The whole experiment is one
container with no state at all.

Cost of the spike: a Cloud Run service with `min_instances: 0`, up for about half an hour,
plus an Artifact Registry repository holding one image of **65 MB**. Both are deleted (§7).

## 6. WebSockets through IAP

**The handshake carries a verified assertion.** This was the open question that could have
changed the product, because a WebSocket upgrade is a single HTTP request and if IAP did
not sign *that* one, header-based authentication could not cover Homarr's live board
subscriptions at all.

```
[    0s] OPEN  handshake accepted
[    0s] SERVER assertion_on_handshake=True verified=True
```

**And the connection survives.** Held open for **22 minutes — 2.2× the ten-minute life of an
assertion — 88 heartbeats, never dropped:**

```
[    0s] OPEN  handshake accepted
[    0s] SERVER assertion_on_handshake=True verified=True
[  600s] beat 40 alive          <- an assertion minted at t=0 has now expired
[ 1320s] beat 88 alive
[ 1320s] DONE  held open for the full 22.0 min, 88 beats, never dropped
```

So IAP authenticates the upgrade and then stays out of the way. The ten-minute assertion
governs *requests*, not established connections — which is the behaviour Homarr's live
boards need and the thing no document would confirm.

Two honest limits on that result:

- The client used 20-second WebSocket pings, which is what a real client does; this says
  nothing about a connection left completely idle.
- **Cloud Run still caps a request at 60 minutes**, and an open socket is a request. A tab
  left open all afternoon will be cut and must reconnect. That is a Cloud Run limit, not an
  IAP one, and it is why `timeout: 3600s` is set explicitly rather than left at the 60s some
  other services use.

### What this spike deliberately did not prove

It is a probe, not a portal. **That Homarr itself runs on Cloud Run** — its image, its
migrations against an external Postgres, its cold start, its own `/websockets` through
nginx — is a separate question, and the next piece of work. The value of keeping them apart
is that if Homarr misbehaves next week, IAP is already ruled out.

## 7. Teardown

The condition of the approval. Procedure and the check that makes it safe:
[`../spikes/iap-probe/README.md`](../spikes/iap-probe/README.md#teardown--do-this-when-the-questions-are-answered).

Verified **before** the spike was applied, because it was the only step capable of breaking
something that was not ours: the four `google_project_service` resources in the plan
(`run`, `iam`, `monitoring`, `artifactregistry`) all carry `disable_on_destroy = false`, so
removing the block cannot disable those APIs in `multitecweb`.

## 8. What this changes in the design

- **ADR 0002 §1 step 6 is wrong as written.** `hd` must be asserted when present, never
  required, or every machine caller is rejected.
- **`AUTH_IAP_AUDIENCE` is confirmed**, and its value is the Cloud Run form.
- **The two "unproven" flags in ADR 0003 come off** for the assertion, and the
  header-stripping claim in ADR 0002's threat model is now measured rather than cited.
- **Programmatic access is documented** (§4) — a prerequisite for anything automated the
  portal ever needs, and something the two existing IAP services never had to solve.
