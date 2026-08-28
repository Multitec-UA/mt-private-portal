"""IAP probe — the phase-0 spike for the Multitec members' portal.

Two questions gate the whole build (ADR 0002, ADR 0003), and neither has ever been
answered at Multitec:

  1. Does `x-goog-iap-jwt-assertion` actually reach a container when IAP is enabled
     **directly on a Cloud Run service**, with no load balancer? Google documents it and
     documents the `/projects/<n>/locations/<r>/services/<s>` audience form, but
     `minecraft-allowlist` only ever reads the *unsigned* email header, so nobody here has
     observed the signed one. The portal's entire security design rests on it.
  2. Does a WebSocket survive IAP? Homarr's boards update live over `/websockets`, a
     long-lived connection, while an IAP assertion lives about ten minutes.

This service answers both and does nothing else. It is deliberately not Homarr: a probe
that fails should implicate IAP, not a dashboard's startup sequence, its database or its
Redis.

**It never prints the assertion.** A signed JWT is a bearer credential for its lifetime,
and this thing exists to be read from a terminal and pasted into a report. It emits
claims, verdicts and header *names* — never the token.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

import jwt
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from jwt import PyJWKClient

LOG = logging.getLogger("iap-probe")
logging.basicConfig(level=logging.INFO)

ASSERTION_HEADER = "x-goog-iap-jwt-assertion"
EMAIL_HEADER = "x-goog-authenticated-user-email"
USER_ID_HEADER = "x-goog-authenticated-user-id"

IAP_ISSUER = "https://cloud.google.com/iap"
IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk"

# The audience is the one constant the design pivots on, so it is supplied rather than
# guessed: Terraform writes the exact string it built the service with, and a mismatch is
# then a finding instead of a silent pass. No default on purpose.
EXPECTED_AUDIENCE = os.environ.get("EXPECTED_AUDIENCE", "").strip()

STARTED_AT = time.time()

# One client, so the JWKS is fetched once and cached rather than on every request. It is
# also the thing most likely to fail in a locked-down network, which is worth knowing.
_jwks_client: PyJWKClient | None = None


def jwks() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(IAP_JWKS_URL, cache_keys=True)
    return _jwks_client


def strip_namespace(raw: str) -> str:
    """`accounts.google.com:someone@multitecua.com` -> `someone@multitecua.com`."""
    return raw.split(":")[-1].strip().lower()


def redact(token: str) -> str:
    """What we are willing to say about a token: that it exists, and how big it is."""
    return f"<{len(token)} chars, ends …{token[-6:]}>" if token else "<absent>"


def verify_assertion(token: str) -> dict[str, Any]:
    """Full verification, the way the real provider will do it.

    Returns a verdict dict; never raises. Every failure keeps its reason, because "it did
    not work" is not a spike result — the point is to learn *which* check refuses.
    """
    result: dict[str, Any] = {
        "present": bool(token),
        "verified": False,
        "reason": None,
        "claims": None,
        "unverified_aud": None,
        "expected_aud": EXPECTED_AUDIENCE or None,
    }
    if not token:
        result["reason"] = "header absent"
        return result

    # Read the audience without verifying first, purely so a mismatch can be *reported*
    # rather than hidden behind a generic "invalid token". This value is never trusted.
    try:
        unverified = jwt.decode(token, options={"verify_signature": False})
        result["unverified_aud"] = unverified.get("aud")
    except Exception as exc:  # noqa: BLE001 - a malformed token is itself a finding
        result["reason"] = f"not a decodable JWT: {type(exc).__name__}"
        return result

    if not EXPECTED_AUDIENCE:
        result["reason"] = "EXPECTED_AUDIENCE is not set, refusing to validate against a guess"
        return result

    try:
        signing_key = jwks().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            audience=EXPECTED_AUDIENCE,
            issuer=IAP_ISSUER,
            options={"require": ["exp", "iat", "aud", "iss", "sub"]},
        )
    except Exception as exc:  # noqa: BLE001
        result["reason"] = f"{type(exc).__name__}: {exc}"
        return result

    result["verified"] = True
    result["claims"] = {
        "email": claims.get("email"),
        "hd": claims.get("hd"),
        "sub": claims.get("sub"),
        "iss": claims.get("iss"),
        "aud": claims.get("aud"),
        "iat": claims.get("iat"),
        "exp": claims.get("exp"),
        "lifetime_seconds": (claims.get("exp", 0) - claims.get("iat", 0)) or None,
        "google": claims.get("google"),
    }
    return result


def snapshot(request: Request) -> dict[str, Any]:
    token = request.headers.get(ASSERTION_HEADER, "")
    verdict = verify_assertion(token)

    unsigned_email_raw = request.headers.get(EMAIL_HEADER, "")
    unsigned_email = strip_namespace(unsigned_email_raw) if unsigned_email_raw else None
    signed_email = (verdict.get("claims") or {}).get("email")

    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "uptime_seconds": round(time.time() - STARTED_AT, 1),
        "path": request.url.path,
        # Names only. Values of x-goog-* headers are identity material and one of them is
        # a bearer token.
        "goog_headers_seen": sorted(k for k in request.headers.keys() if k.lower().startswith("x-goog")),
        "assertion": {**verdict, "token": redact(token)},
        "unsigned_email": unsigned_email,
        "unsigned_user_id_present": bool(request.headers.get(USER_ID_HEADER)),
        # The cross-check the real provider will do. Disagreement means something between
        # IAP and the app is rewriting identity, which is the loudest possible failure.
        "signed_and_unsigned_agree": (
            None if not (signed_email and unsigned_email) else signed_email == unsigned_email
        ),
        "forwarded_proto": request.headers.get("x-forwarded-proto"),
    }


def verdict_lines(data: dict[str, Any]) -> list[str]:
    """The answer to question 1, in the form a report can quote."""
    a = data["assertion"]
    lines = []
    lines.append(
        f"Q1  assertion header present: {'YES' if a['present'] else 'NO'}"
    )
    lines.append(
        f"Q1  signature + iss + aud + exp verified: {'YES' if a['verified'] else 'NO'}"
        + ("" if a["verified"] else f"  ({a['reason']})")
    )
    if a["unverified_aud"]:
        match = a["unverified_aud"] == a["expected_aud"]
        lines.append(f"Q1  audience matches the expected Cloud Run form: {'YES' if match else 'NO'}")
        if not match:
            lines.append(f"      received: {a['unverified_aud']}")
            lines.append(f"      expected: {a['expected_aud']}")
    if data["signed_and_unsigned_agree"] is not None:
        lines.append(
            f"Q1  signed email == unsigned header: {'YES' if data['signed_and_unsigned_agree'] else 'NO'}"
        )
    return lines


app = FastAPI(title="Multitec IAP probe", docs_url=None, redoc_url=None)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    """Cloud Run's own probe. Reached without IAP, so it must never require a token."""
    return "ok"


@app.get("/probe.json")
def probe_json(request: Request) -> JSONResponse:
    return JSONResponse(snapshot(request))

@app.get("/probe.txt", response_class=PlainTextResponse)
def probe_txt(request: Request) -> str:
    data = snapshot(request)
    return "\n".join(verdict_lines(data)) + "\n\n" + json.dumps(data, indent=2, sort_keys=True)


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> str:
    data = snapshot(request)
    ok = data["assertion"]["verified"]
    colour = "#2e7d32" if ok else "#c62828"
    body = "\n".join(f"  {line}" for line in verdict_lines(data))
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Multitec IAP probe</title>
<style>
 body {{ font: 15px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }}
 h1 {{ font-size: 1.2rem; }} pre {{ background:#f6f6f6; padding:1rem; overflow:auto; border-radius:6px; }}
 .v {{ color: {colour}; font-weight: 700; }}
</style></head><body>
<h1>Multitec IAP probe <span class="v">{'VERIFIED' if ok else 'NOT VERIFIED'}</span></h1>
<p>Phase-0 spike for the members' portal. This page is temporary and the service it runs on
will be destroyed. It never shows the assertion itself.</p>
<pre>{body}</pre>
<p>WebSocket probe: <code>wss://&lt;this host&gt;/websockets</code> — same path Homarr uses.</p>
<pre id="ws">connecting…</pre>
<script>
 const out = document.getElementById('ws');
 const started = Date.now();
 const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/websockets');
 const log = (m) => {{ out.textContent += "\\n" + new Date().toISOString() + "  " + m; }};
 ws.onopen = () => {{ out.textContent = "open"; ws.send("hello from the browser"); }};
 ws.onmessage = (e) => log("recv " + e.data);
 ws.onclose = (e) => log("CLOSED code=" + e.code + " reason=" + (e.reason || "-") + " after " + Math.round((Date.now()-started)/1000) + "s");
 ws.onerror = () => log("error");
</script>
<pre>{json.dumps(data, indent=2, sort_keys=True)}</pre>
</body></html>"""


@app.websocket("/websockets")
async def websocket_probe(websocket: WebSocket) -> None:
    """Question 2, on Homarr's own path.

    Accepts, then heartbeats forever. What matters is not that it works for ten seconds —
    it is whether IAP, or Cloud Run, or the client, cuts the connection, when, and with
    which close code. So every beat carries its elapsed time and the close is logged
    server-side with whatever reason arrived.
    """
    headers = websocket.headers
    token = headers.get(ASSERTION_HEADER, "")
    verdict = verify_assertion(token)
    LOG.info(
        "websocket handshake: assertion_present=%s verified=%s reason=%s email=%s",
        verdict["present"],
        verdict["verified"],
        verdict["reason"],
        (verdict.get("claims") or {}).get("email"),
    )

    await websocket.accept()
    opened = time.time()
    beats = 0
    try:
        await websocket.send_text(
            json.dumps(
                {
                    "event": "open",
                    # Whether the assertion reaches the *handshake* is its own finding:
                    # a WebSocket upgrade is one HTTP request, and if IAP strips or skips
                    # signing it there, header-based auth cannot cover subscriptions.
                    "assertion_on_handshake": verdict["present"],
                    "assertion_verified": verdict["verified"],
                    "reason": verdict["reason"],
                }
            )
        )
        while True:
            await asyncio.sleep(15)
            beats += 1
            elapsed = round(time.time() - opened)
            await websocket.send_text(
                json.dumps({"event": "beat", "n": beats, "elapsed_seconds": elapsed})
            )
    except WebSocketDisconnect as exc:
        LOG.info(
            "websocket closed by peer after %ss, %s beats, code=%s",
            round(time.time() - opened),
            beats,
            exc.code,
        )
    except Exception as exc:  # noqa: BLE001
        LOG.warning(
            "websocket ended after %ss, %s beats: %s: %s",
            round(time.time() - opened),
            beats,
            type(exc).__name__,
            exc,
        )
