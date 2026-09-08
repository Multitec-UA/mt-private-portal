/**
 * Read one JSON feed that quantumpc has published into the portal's own database.
 *
 * WHY A PUBLISHED FEED AND NOT A LIVE QUERY
 * -----------------------------------------
 * Everything worth putting on the boards lives somewhere this container cannot reach. The
 * RAID array and the Minecraft server are in Sergio's house behind a router. The members'
 * book, the Drive folders and the mail groups need a Google Workspace credential this
 * service deliberately does not hold (`settings/multitecweb.yaml`: *"One job holds the
 * credential, one service reads"*). Stripe it does hold, but joining Stripe to the members'
 * book still needs the book.
 *
 * So the data is **pushed outwards**: `bin/qpc-portal-feed` on quantumpc collects it and
 * writes a row here; this reads that row. The widget stays a dumb reader, no new credential
 * lands in a web-facing container, and a publisher that stops running shows a stale
 * timestamp rather than taking a tile down.
 *
 * IT IS A BUCKET NOW, AND THE DATABASE COST REAL MONEY
 * ----------------------------------------------------
 * A GCS bucket was the first design. It was passed over on 2026-09-04 because it needed
 * Terraform and a full plan of the `multitecweb` workspace came back
 * `1 to add, 1 to change, 56 to destroy` — so anything needing Terraform was blocked. That
 * plan turned out to be a checkout seven commits behind an uncommitted file, and it was
 * corrected; the blocker never really existed.
 *
 * The database, meanwhile, did cost. Neon's free plan suspends an idle compute after five
 * minutes and the timeout cannot be disabled, so the publisher's one-second write billed
 * about SIX MINUTES of compute. Six of those an hour held the members' database awake 84 %
 * of the time and burnt 23.5 of the project's 100 monthly CU-hours in the first seven days
 * of September — measured from Neon's own wake/suspend log. Left alone, the quota ran out
 * around 23 September and Neon switches the compute off until the 1st.
 *
 * So when `MULTITEC_FEED_DIR` is set, feeds are read from JSON bundles on a read-only GCS
 * volume — the same mechanism this service already uses for the admin list — and the
 * publisher never opens a database connection at all. Reading an object costs no
 * compute-hours anywhere. Agent-repo ADR 0063 has the numbers.
 *
 * With the variable unset the database path below is used unchanged, which is what keeps
 * MULTITEC.md rule 5 true and makes the whole move revertible by removing one env var.
 *
 * THE TABLE IS OURS AND HOMARR DOES NOT KNOW IT EXISTS
 * ----------------------------------------------------
 * `multitec_feeds` is created by `qpc-portal-feed init`, never by a Drizzle migration, and
 * nothing in this fork writes it. Homarr's migrations are explicit SQL files, so a table it
 * has never heard of is not something a release can drop. Two plain columns and no
 * dialect-specific types, so the same statement works on all three databases Homarr
 * supports.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { db, sql } from "@homarr/db";

import { isValidFeedName } from "./feed-names";

/**
 * How long a fetched feed is reused. The publisher runs every few minutes, so a minute of
 * staleness is invisible; what it buys is that twenty members opening the board at once is
 * one query and not twenty.
 *
 * This caches the FEED, never a per-member response. A personal feed is one row holding
 * every member keyed by email, and the filtering happens above this layer — so a cache hit
 * can never hand one member another member's data.
 */
const FEED_TTL_MS = 60_000;

export interface Feed {
  name: string;
  payload: unknown;
  updatedAt: string;
}

const cache = new Map<string, { feed: Feed | null; fetchedAt: number }>();

/**
 * The single switch for everything under `/api/multitec`, and for the identity forwarding
 * in `packages/api/src/multitec/identity.ts`.
 *
 * `AUTH_IAP_AUDIENCE` rather than a new variable of its own: MULTITEC.md rule 5 says that
 * with none of our env vars set this fork must behave exactly like vanilla Homarr, and a
 * new variable would have to be added to the portal's Terraform — which is the one thing
 * that is blocked (see above). This one is already required by our deployment and set
 * nowhere else, so it means precisely "this is the Multitec portal".
 */
export const isEnabled = (): boolean => Boolean(process.env.AUTH_IAP_AUDIENCE);

/**
 * The row shape `db.execute` gives back, and the cast that gets to it.
 *
 * `@homarr/db`'s exported `db` is TYPED as the better-sqlite3 driver — `Database<TSchema>`
 * in `packages/core/src/infrastructure/db/drivers/index.ts` is literally
 * `ReturnType<typeof createSqliteDb>` — while at runtime it is whichever of the three
 * drivers the connection string selected. So the types offer `.all()` and the running
 * object offers `.execute()`, and no amount of narrowing reconciles that.
 *
 * Rather than pretend, this states the assumption in one place: our deployment is
 * node-postgres (`DB_DRIVER=node-postgres`, `settings/multitecweb.yaml`), whose `execute`
 * resolves to a pg `QueryResult`. If that ever stops being true the failure is a TypeError
 * on this line — loud, immediate and in one file — rather than wrong data on a tile.
 */
interface ExecutingDb {
  execute: (query: unknown) => Promise<{ rows?: Record<string, unknown>[] } | Record<string, unknown>[]>;
}

const rowsOf = (result: { rows?: Record<string, unknown>[] } | Record<string, unknown>[]) =>
  Array.isArray(result) ? result : (result.rows ?? []);

/**
 * The directory the feed bundles are mounted at, or undefined for the database path.
 *
 * Read through a function and not a module constant: a module constant is captured at
 * import time, which in a Next.js build means at BUILD time, and the value only exists in
 * the deployed revision.
 */
const feedDir = (): string | undefined => process.env.MULTITEC_FEED_DIR;

/**
 * One bundle object as the publisher writes it (`bin/qpc-portal-feed`, `bundle_document`).
 * There is a self-test on that side asserting this exact shape, because it is the contract
 * between two repositories and nothing else checks it.
 */
interface BundleDocument {
  bundle?: string;
  updatedAt?: string;
  feeds?: Record<string, { payload?: unknown; updatedAt?: string }>;
}

/**
 * All feeds from all bundles, cached as ONE entry.
 *
 * The database version cached per feed name because each name was a query. A bundle read
 * hands back every feed in it at once, so caching per name would re-read the same file up
 * to fourteen times a minute for no reason.
 */
let bundles: { feeds: Map<string, Feed>; fetchedAt: number } | null = null;

const readBundles = async (dir: string, now: number): Promise<Map<string, Feed>> => {
  if (bundles && now - bundles.fetchedAt < FEED_TTL_MS) return bundles.feeds;

  const feeds = new Map<string, Feed>();
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((entry) => entry.endsWith(".json"));
  } catch {
    // The mount is not there. Cached like any other answer so a missing volume cannot turn
    // every board render into a filesystem call, and re-tried a minute later.
    bundles = { feeds, fetchedAt: now };
    return feeds;
  }

  for (const file of names.sort()) {
    let document: BundleDocument;
    try {
      document = JSON.parse(await readFile(join(dir, file), "utf8")) as BundleDocument;
    } catch {
      // A bundle mid-write or hand-edited into invalid JSON. Skipped, not fatal: one broken
      // bundle must not take the other one's tiles down with it, and a tile showing nothing
      // is better than a 500 on the board.
      continue;
    }
    for (const [name, entry] of Object.entries(document.feeds ?? {})) {
      // Checked here as well as on the way in. The name becomes part of a URL path and of a
      // cache key, and this is a file the portal does not write.
      if (!isValidFeedName(name)) continue;
      feeds.set(name, {
        name,
        payload: entry?.payload ?? null,
        updatedAt: String(entry?.updatedAt ?? document.updatedAt ?? ""),
      });
    }
  }

  bundles = { feeds, fetchedAt: now };
  return feeds;
};

export const readFeed = async (name: string, now: number = Date.now()): Promise<Feed | null> => {
  if (!isValidFeedName(name)) return null;

  const dir = feedDir();
  if (dir) return (await readBundles(dir, now)).get(name) ?? null;

  const cached = cache.get(name);
  if (cached && now - cached.fetchedAt < FEED_TTL_MS) return cached.feed;

  // Parameterised through drizzle's own `sql` tag, so the name is a bound value and never
  // string-concatenated — belt as well as braces, next to `isValidFeedName`.
  const result = await (db as unknown as ExecutingDb).execute(
    sql`select name, payload, updated_at from multitec_feeds where name = ${name} limit 1`,
  );
  const row = rowsOf(result)[0];

  let feed: Feed | null = null;
  if (row) {
    // `payload` is stored as text on purpose (one statement for three dialects), so it
    // arrives as a string and is parsed here. A row whose payload is not JSON is treated as
    // a missing feed: the publisher wrote something broken, and a tile showing nothing is
    // better than a 500 on the board.
    try {
      feed = {
        name: String(row.name),
        payload: JSON.parse(String(row.payload)),
        updatedAt: String(row.updated_at ?? row.updatedAt ?? ""),
      };
    } catch {
      feed = null;
    }
  }

  cache.set(name, { feed, fetchedAt: now });
  return feed;
};

/**
 * Only for tests: the map `readBundles` builds, so the in-bundle name filter can be
 * observed at all.
 *
 * It exists because the filter is otherwise UNREACHABLE. `readFeed` rejects an illegal name
 * at its own front door, so a test that asks it for `../secrets` gets null whether or not
 * the loop below filters anything — which is exactly what happened on the first attempt:
 * deleting the filter left all nine tests green. Defence in depth that no test can
 * distinguish from its absence is not defence, it is decoration, so the seam is exported
 * rather than the check quietly trusted.
 */
export const __bundleFeedsForTest = async (dir: string, now: number = Date.now()) =>
  Object.fromEntries(await readBundles(dir, now));

/** Only for tests: the caches are process-wide by design. */
export const __resetFeedCache = () => {
  cache.clear();
  bundles = null;
};
