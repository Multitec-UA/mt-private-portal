#!/usr/bin/env bash
#
# drive-probe.sh — answer question 1 of the phase-0 spike from quantumpc, without a browser.
#
# Nobody at Multitec has ever authenticated to IAP programmatically, so the audience a
# Google-minted OIDC token needs is itself unknown. This script does not assume: it tries
# each candidate in turn and reports which one IAP accepts, because "it returned 401" is
# not a spike result — knowing *which* audience works is.
#
# It never prints a token. The probe service never echoes one either.
#
# Usage: drive-probe.sh [service-url]
#   With no argument the URL is read from Cloud Run.

set -uo pipefail

export PATH="$HOME/.local/bin:$PATH"
REGION=${REGION:-europe-west1}
PROJECT=${PROJECT:-multitecweb}
SERVICE=${SERVICE:-mt-iap-probe}
# The agent's own service account. Its key is the one identity on this machine that can
# mint an identity token for an arbitrary audience without a browser.
CONFIG=${CONFIG:-qpc-agent}

url=${1:-}
if [[ -z $url ]]; then
  url=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
        --format='value(status.url)' 2>/dev/null)
fi
if [[ -z $url ]]; then
  echo "could not resolve the service URL for $SERVICE in $PROJECT/$REGION" >&2
  exit 2
fi

echo "service: $url"
echo

# 1. No credential at all. This is the control: if this succeeds, IAP is not actually
#    protecting the service and every other result in this spike is meaningless.
code=$(curl -s -o /tmp/iap-probe-anon.out -w '%{http_code}' --max-time 30 "$url/probe.txt")
echo "anonymous                       -> HTTP $code $([[ $code == 200 ]] && echo '  *** IAP IS NOT PROTECTING THIS ***')"

# 2. Cloud Run's own invoker token (audience = service URL). Worth trying because it is
#    what every other Google-to-Cloud-Run call uses, and because if it works it tells us
#    IAP accepted a plain OIDC token rather than requiring an IAP client id.
try_audience() {
  local label=$1 aud=$2
  local token
  # No --include-email: it is only valid when impersonating, and a key-based service
  # account rejects it outright. That is itself part of the finding — see the report.
  token=$(CLOUDSDK_ACTIVE_CONFIG_NAME="$CONFIG" gcloud auth print-identity-token \
            --audiences="$aud" 2>/dev/null)
  if [[ -z $token ]]; then
    printf '%-31s -> could not mint a token for this audience\n' "$label"
    return 1
  fi
  local out="/tmp/iap-probe-${label// /_}.out"
  local code
  code=$(curl -s -o "$out" -w '%{http_code}' --max-time 30 \
           -H "Authorization: Bearer $token" "$url/probe.txt")
  printf '%-31s -> HTTP %s\n' "$label" "$code"
  if [[ $code == 200 ]]; then
    echo "    --- verdict from inside the container ---"
    sed -n '1,6p' "$out" | sed 's/^/    /'
    echo "$aud" > /tmp/iap-probe-working-audience
    return 0
  fi
  return 1
}

try_audience "aud=service URL" "$url"
try_audience "aud=service URL/*" "$url/*"

# 3. If IAP wants its own OAuth client id, find it and try that. For IAP enabled directly
#    on Cloud Run there may be no user-managed client at all, in which case this is a
#    finding rather than a failure.
brand=$(gcloud iap oauth-brands list --project "$PROJECT" --format='value(name)' 2>/dev/null | head -1)
if [[ -n $brand ]]; then
  client=$(gcloud iap oauth-clients list "$brand" --format='value(name)' 2>/dev/null | head -1)
  if [[ -n $client ]]; then
    try_audience "aud=IAP oauth client" "${client##*/}"
  else
    echo "aud=IAP oauth client            -> brand exists, no oauth client (service-level IAP does not create one)"
  fi
else
  echo "aud=IAP oauth client            -> no IAP oauth brand in this project"
fi

echo
if [[ -f /tmp/iap-probe-working-audience ]]; then
  echo "RESULT: reachable. Working audience: $(cat /tmp/iap-probe-working-audience)"
  echo "Full JSON in /tmp/iap-probe-*.out"
else
  echo "RESULT: no audience got past IAP. The probe can still be driven from a browser."
fi
