#!/usr/bin/env python3
"""Export the membership of the portal's admin Workspace group to a JSON file.

The portal decides who is an administrator by reading this file (see
`packages/auth/providers/iap/resolve-groups.ts`). It deliberately never calls the Directory
API itself: reading a group needs a domain-wide-delegated key, and such a key can
impersonate users across the whole domain. That has no business in a web-facing container.
One job holds the credential, one service reads bytes — the same split `mc-allowlist` uses.

**Nested groups are expanded, and that is not a nicety.** Measured on 2026-08-29:
`homarr-admin@multitecua.com` contains three members and one of them is the *group*
`direccion@multitecua.com`. The Directory API's `members.list` returns direct members only,
so a naive export would have silently left the entire board without admin rights, with no
error anywhere — the symptom being "I added them to direccion@ and it does not work".

Usage:
    sync-admin-group.py --key <sa.json> --subject <admin@domain> \\
        --group homarr-admin@multitecua.com [--out admins.json]

The key is a service-account JSON with domain-wide delegation for
`admin.directory.group.member.readonly`. It is never printed.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import jwt

SCOPE = "https://www.googleapis.com/auth/admin.directory.group.member.readonly"
TOKEN_URL = "https://oauth2.googleapis.com/token"
DIRECTORY = "https://admin.googleapis.com/admin/directory/v1"


def access_token(key: dict, subject: str) -> str:
    """Domain-wide delegation: sign a JWT asserting `subject`, exchange it for a token."""
    now = int(time.time())
    assertion = jwt.encode(
        {
            "iss": key["client_email"],
            "sub": subject,
            "scope": SCOPE,
            "aud": TOKEN_URL,
            "iat": now,
            "exp": now + 3600,
        },
        key["private_key"],
        algorithm="RS256",
        headers={"kid": key["private_key_id"]},
    )
    body = urllib.parse.urlencode(
        {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion}
    ).encode()
    with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=body), timeout=30) as resp:
        return json.load(resp)["access_token"]


def members_of(token: str, group: str) -> list[dict]:
    """Direct members of one group, following pagination."""
    out: list[dict] = []
    page = None
    while True:
        params = {"maxResults": "200"}
        if page:
            params["pageToken"] = page
        url = f"{DIRECTORY}/groups/{urllib.parse.quote(group)}/members?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
        out.extend(data.get("members", []))
        page = data.get("nextPageToken")
        if not page:
            return out


def expand(token: str, group: str, seen: set[str] | None = None) -> set[str]:
    """Every human address in a group, following nested groups.

    `seen` guards against a cycle: Workspace will happily let two groups contain each other,
    and the failure mode without this is a recursion that never ends during a nightly cron.
    """
    seen = seen if seen is not None else set()
    if group.lower() in seen:
        return set()
    seen.add(group.lower())

    people: set[str] = set()
    for member in members_of(token, group):
        email = (member.get("email") or "").strip().lower()
        if not email:
            continue
        if member.get("type") == "GROUP":
            people |= expand(token, email, seen)
            continue
        # Service accounts get filtered: one may legitimately be a member of the group for
        # its own read access, and it is not a person who administers anything.
        if email.endswith(".gserviceaccount.com"):
            continue
        # SUSPENDED members keep their membership but cannot sign in; leaving them in would
        # quietly re-grant admin the day somebody is un-suspended.
        if member.get("status") not in (None, "ACTIVE"):
            continue
        people.add(email)
    return people


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key", required=True, help="service-account JSON with DWD")
    parser.add_argument("--subject", required=True, help="Workspace admin to impersonate")
    parser.add_argument("--group", required=True)
    parser.add_argument("--out", default="-", help="output file, or - for stdout")
    args = parser.parse_args()

    with open(args.key) as fh:
        key = json.load(fh)

    try:
        token = access_token(key, args.subject)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()[:200]
        print(f"could not get a token: HTTP {exc.code} {detail}", file=sys.stderr)
        # 401 unauthorized_client here means the scope is not granted to this client in the
        # Admin console. That is the one failure a reader of this output will not guess.
        return 2

    try:
        people = sorted(expand(token, args.group))
    except urllib.error.HTTPError as exc:
        print(f"could not read {args.group}: HTTP {exc.code}", file=sys.stderr)
        return 2

    if not people:
        # Not an error — a group can be empty — but never silent. An export of zero means
        # nobody can administer the portal, and that should be a decision, not a surprise.
        print(f"warning: {args.group} expands to no active people", file=sys.stderr)

    payload = {
        "group": args.group,
        "members": people,
        "syncedAt": datetime.now(timezone.utc).isoformat(),
    }
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"

    if args.out == "-":
        sys.stdout.write(text)
    else:
        with open(args.out, "w") as fh:
            fh.write(text)
        print(f"wrote {len(people)} member(s) to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
