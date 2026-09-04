/**
 * Serve one Multitec feed to a `customApi` widget.
 *
 *   GET /api/multitec/feed/<name>          the shared feed <name>, same answer for everyone
 *   GET /api/multitec/feed/me/<name>       the caller's own row out of the feed member-<name>
 *
 * ONE ROUTE AND NOT TWO, ONE STORE AND NOT TWO
 * --------------------------------------------
 * A personal feed is not a different kind of thing — it is one row holding every member,
 * keyed by email, with the filtering done here. That means a new personalised tile is a new
 * feed published by `bin/qpc-portal-feed` and a new widget definition, with **no change to
 * this fork and no twenty-minute build**. Everything that could change often lives on
 * quantumpc; what lives here is only "read a row, check who is asking, hand back their
 * part".
 *
 * WHY `member-` IS A RESERVED PREFIX
 * ----------------------------------
 * `/feed/<name>` refuses any name starting with `member-`, and that single line is what
 * stands between one member and everybody else's data: those feeds contain every member's
 * row, and the shared path applies no filter at all. Enforced as a refusal on the shared
 * path rather than as a naming convention, because a convention is a thing people follow
 * until they are in a hurry.
 */

import { auth } from "@homarr/auth/next";
import { verifySignedIdentity } from "@homarr/api/multitec/identity";

import { isValidFeedName, isServableAsShared, MEMBER_FEED_PREFIX } from "../../_lib/feed-names";
import { isEnabled, readFeed } from "../../_lib/feed-store";

/**
 * `private, no-store` on everything, personal or not.
 *
 * The personal case is obvious: Cloud Run's front end would otherwise be free to hand one
 * member another member's tile. The shared case gets it too because the difference between
 * the two is one URL segment, and a rule that only sometimes applies is a rule that will
 * one day be applied to the wrong one. Freshness is handled inside `readFeed`, which caches
 * the row in memory — so this costs a query per member per minute, not per render.
 */
const NO_STORE = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
} as const;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: NO_STORE });

/**
 * The payload with its metadata alongside it, NOT nested under a `data` key.
 *
 * `customJsx` binds the whole response body to `data` (`SAFE_BINDINGS` in
 * `packages/widgets/src/custom-api/jsx-whitelist.ts`), so a response shaped
 * `{ data: payload }` makes every template read `data.data.raid.state`. Flattening turns
 * that into `data.raid.state`, and templates are the part of this system that gets rewritten
 * most often — a JSON shape is cheap to choose well once and expensive to type around daily.
 *
 * `feed` and `updatedAt` are written AFTER the spread, so they are reserved: a payload that
 * happens to contain them cannot shadow the caller's only way of telling how fresh the tile
 * is. Collectors stamp their own time as `collectedAt` for exactly this reason.
 */
const flatten = (feed: { name: string; updatedAt: string }, payload: unknown) => ({
  ...(payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {}),
  feed: feed.name,
  updatedAt: feed.updatedAt,
});

export const GET = async (request: Request, props: { params: Promise<{ path: string[] }> }) => {
  if (!isEnabled()) {
    // Vanilla Homarr has no feeds and no business answering here. 404 rather than 501: the
    // route genuinely does not exist in that configuration.
    return json({ error: "not found" }, 404);
  }

  const { path } = await props.params;
  // Destructured rather than indexed, so nothing needs a non-null assertion: `oxlint`
  // forbids those, and rightly — `segments[1]!` on a catch-all route is a promise about a
  // URL shape, made in the one place where a URL is whatever someone typed.
  const [first, second, ...rest] = path ?? [];

  if (first !== undefined && second === undefined) {
    const name = first;
    if (!isServableAsShared(name)) {
      return json({ error: "not found" }, 404);
    }
    const feed = await readFeed(name);
    if (!feed) return json({ error: "no such feed", name }, 404);
    return json(flatten(feed, feed.payload));
  }

  if (first === "me" && second !== undefined && rest.length === 0) {
    const name = second;
    if (!isValidFeedName(name)) return json({ error: "not found" }, 404);

    // Two ways to prove who is asking, and both are the server's own word for it:
    //
    //  1. the signature `custom-api.ts` attached, which is how the widget arrives — the
    //     request comes from this container over loopback and carries no cookie;
    //  2. a real signed-in session, which is how a browser (or `curl` with a session)
    //     arrives, and is what makes this endpoint testable at all from outside.
    //
    // What is NOT accepted is an unsigned `X-Multitec-Member` header, which is the whole
    // reason the forwarding is signed.
    const signed = verifySignedIdentity(request.headers);
    const email = signed ?? (await auth())?.user.email ?? null;
    if (!email) return json({ error: "unauthenticated" }, 401);

    const feed = await readFeed(`${MEMBER_FEED_PREFIX}${name}`);
    if (!feed) return json({ error: "no such feed", name }, 404);

    const rows = (feed.payload ?? {}) as Record<string, unknown>;
    // Lower-cased on both sides: Google addresses are case-insensitive, the publisher reads
    // them out of a spreadsheet a human maintains, and a capital letter in the members'
    // book must not be the reason a tile says "you are not a member".
    const wanted = email.toLowerCase();
    const found = Object.entries(rows).find(([key]) => key.toLowerCase() === wanted)?.[1];

    // `known` rather than an empty object or a 404: "we have this feed and you are not in
    // it" is a real, renderable answer — a new member whose row has not been published yet
    // should see a tile that says so, not a broken one.
    return json({ ...flatten(feed, found ?? {}), known: found !== undefined });
  }

  return json({ error: "not found" }, 404);
};
