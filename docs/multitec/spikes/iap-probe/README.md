# Phase-0 spike — the IAP probe

**Status: the service is TEMPORARY and must be destroyed.** See *Teardown* below. Sergio
allowed it on the condition that it goes away: *"puedes crear una base de datos si quieres,
puedes crear un Redis si quieres, pero de forma temporal… recuerda que luego tendrás que
borrar estos recursos."* In the end it needed **neither** — see the report.

Findings: [`../../reports/0001-iap-probe.md`](../../reports/0001-iap-probe.md).

## What it is

A ~250-line FastAPI service, deliberately **not** Homarr, that answers the two questions
gating the members' portal (ADR 0002, ADR 0003):

1. Does `x-goog-iap-jwt-assertion` reach a container when IAP is enabled **directly on a
   Cloud Run service**, with no load balancer — and does it verify, with the audience in
   the `/projects/<n>/locations/<r>/services/<s>` form?
2. Does a WebSocket survive IAP, on Homarr's own `/websockets` path, past the ~10-minute
   life of an assertion?

A probe that fails must implicate IAP. Running Homarr for this would have added a
database, a Redis, migrations and a startup sequence — four other things that could break
and be mistaken for the answer.

**It never prints the assertion.** A signed JWT is a bearer credential for its lifetime and
this output is meant to be pasted into a report. It emits claims, verdicts and header
*names*.

## Layout

```
app/main.py            the probe: /, /probe.json, /probe.txt, /healthz, ws /websockets
Dockerfile             python:3.13-slim + uvicorn[standard] (the ws implementation)
requirements.txt
tools/drive-probe.sh   question 1, from quantumpc, no browser
tools/ws-soak.py       question 2: hold the socket, report how it ends
```

## Running it

Locally, which is where its own correctness was established — including that it rejects a
forged assertion carrying the right issuer and the right audience:

```bash
docker build -t mt-iap-probe:spike .
docker run -d --name p -p 18080:8080 \
  -e EXPECTED_AUDIENCE=/projects/882854291514/locations/europe-west1/services/mt-iap-probe \
  mt-iap-probe:spike
curl -s localhost:18080/probe.txt
```

Against the deployed service:

```bash
tools/drive-probe.sh          # tries each candidate audience and says which IAP accepts
```

## Teardown — do this when the questions are answered

```bash
# 1. Remove the `iap-probe:` block from settings/multitecweb.yaml in multitec-terrafrom
# 2. Plan, read it, apply it. Everything is scoped to iap-probe:
#    the Cloud Run service, its service account, the IAP bindings, the Artifact Registry
#    repository and the monitoring alert.
terraform plan -out=/tmp/tf-teardown.plan
terraform apply /tmp/tf-teardown.plan
terraform plan                # must say: No changes
```

**Checked before the spike was ever applied**, because it was the only step capable of
breaking something that was not ours: the four `google_project_service` resources in the
plan (`run`, `iam`, `monitoring`, `artifactregistry`) all carry
`disable_on_destroy = false`, so removing this block does **not** disable those APIs in
`multitecweb`. Verify that again if the modules are ever upgraded.

Nothing else needs cleaning: the probe has no database, no Redis, no bucket, no volume,
no domain mapping and no DNS record. The Artifact Registry repository goes with the
Terraform block, and the image inside it with the repository.
