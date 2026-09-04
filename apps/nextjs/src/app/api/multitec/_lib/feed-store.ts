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
 * WHY THIS DATABASE AND NOT A BUCKET
 * ----------------------------------
 * A GCS bucket was the first design and is arguably the more natural home for a blob. It
 * needs one new bucket, two IAM bindings and one env var — all of which are Terraform, and
 * on 2026-09-04 a full plan of the `multitecweb` workspace came back
 * `1 to add, 1 to change, 56 to destroy`: the repository's YAML no longer describes what
 * exists, and an apply there would take out the Claude seats system. Until that is fixed,
 * anything needing Terraform is blocked, and this needs none: quantumpc already holds this
 * database's credential (it takes the nightly backup) and this service already has a pool
 * open to it.
 *
 * THE TABLE IS OURS AND HOMARR DOES NOT KNOW IT EXISTS
 * ----------------------------------------------------
 * `multitec_feeds` is created by `qpc-portal-feed init`, never by a Drizzle migration, and
 * nothing in this fork writes it. Homarr's migrations are explicit SQL files, so a table it
 * has never heard of is not something a release can drop. Two plain columns and no
 * dialect-specific types, so the same statement works on all three databases Homarr
 * supports.
 */

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

export const readFeed = async (name: string, now: number = Date.now()): Promise<Feed | null> => {
  if (!isValidFeedName(name)) return null;

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

/** Only for tests: the cache is process-wide by design. */
export const __resetFeedCache = () => cache.clear();
