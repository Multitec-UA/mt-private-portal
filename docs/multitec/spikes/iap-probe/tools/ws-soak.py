"""ws-soak.py — answer question 2 of the phase-0 spike: does a WebSocket survive IAP?

Homarr's boards update live over `/websockets`, a connection that stays open for as long
as the tab does. An IAP assertion lives about ten minutes. Nobody has ever run the two
together at Multitec, and Google documents neither support nor a limitation.

Two things make this a real answer rather than a smoke test:

  * it holds the connection for a duration the operator chooses, past the ten-minute mark
    where an assertion would expire, and reports **when** and **how** it ended — the close
    code is the whole finding;
  * it asks the server whether the assertion reached the *handshake*. A WebSocket upgrade
    is one HTTP request; if IAP does not sign that one, header-based authentication cannot
    cover subscriptions even when the socket itself works.

Run inside the probe image so the `websockets` library is present:

  docker run --rm -i mt-iap-probe:spike python - < ws-soak.py <wss-url> <minutes> [token]
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

import websockets


async def soak(url: str, minutes: float, token: str | None) -> int:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    deadline = time.time() + minutes * 60
    started = time.time()
    beats = 0

    def stamp() -> str:
        return f"[{round(time.time() - started):>5}s]"

    # websockets renamed extra_headers -> additional_headers in v14. Supporting both keeps
    # this script runnable against whatever the image happens to ship.
    kwargs = {"open_timeout": 30, "ping_interval": 20, "ping_timeout": 20}
    try:
        connect = websockets.connect(url, additional_headers=headers, **kwargs)
    except TypeError:
        connect = websockets.connect(url, extra_headers=headers, **kwargs)

    try:
        async with connect as ws:
            print(f"{stamp()} OPEN  handshake accepted")
            while time.time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=60)
                except asyncio.TimeoutError:
                    print(f"{stamp()} WARN  no frame for 60s (heartbeat is every 15s)")
                    continue
                try:
                    msg = json.loads(raw)
                except ValueError:
                    print(f"{stamp()} recv  {raw!r}")
                    continue
                if msg.get("event") == "open":
                    print(
                        f"{stamp()} SERVER assertion_on_handshake="
                        f"{msg.get('assertion_on_handshake')} verified={msg.get('assertion_verified')}"
                        + (f" reason={msg.get('reason')}" if msg.get("reason") else "")
                    )
                else:
                    beats = msg.get("n", beats)
                    # One line a minute is enough to read; the point is the ending.
                    if beats % 4 == 0:
                        print(f"{stamp()} beat {beats} alive")
            print(f"{stamp()} DONE  held open for the full {minutes} min, {beats} beats, never dropped")
            return 0
    except websockets.exceptions.ConnectionClosed as exc:
        print(f"{stamp()} CLOSED code={exc.code} reason={exc.reason!r} after {beats} beats")
        return 1
    except Exception as exc:  # noqa: BLE001 - the failure mode IS the result
        print(f"{stamp()} FAILED {type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(64)
    url = sys.argv[1]
    minutes = float(sys.argv[2])
    token = sys.argv[3] if len(sys.argv) > 3 else None
    sys.exit(asyncio.run(soak(url, minutes, token)))
