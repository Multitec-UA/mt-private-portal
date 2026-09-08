import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * A stub rather than this repo's usual `importActual` + `createDb()`, and deliberately so:
 * every test here exercises the bundle path, which must never touch a database. A real
 * in-memory db would also make the suite depend on better-sqlite3's native module being
 * built for the running ABI, which is a dependency these tests have no reason to have.
 *
 * That is itself the point being asserted — if `readFeed` ever starts reaching for `db`
 * while MULTITEC_FEED_DIR is set, these tests break loudly.
 */
vi.mock("@homarr/db", () => ({
  db: {
    execute: () => {
      throw new Error("the bundle path must not touch the database");
    },
  },
  sql: (strings: TemplateStringsArray) => strings.join(""),
}));

import { __bundleFeedsForTest, __resetFeedCache, readFeed } from "./feed-store";

/**
 * The bundle path only — the database path needs a live Postgres and is covered by the
 * publisher's own self-test on the quantumpc side.
 *
 * Every case here has a counterpart that MUST come back null. A test that only ever asserts
 * "the good bundle is read" would still pass if the name check, the JSON guard and the
 * missing-mount guard were all deleted.
 */
const bundle = (feeds: Record<string, { payload: unknown; updatedAt?: string }>, updatedAt = "2026-09-08T10:00:00Z") =>
  JSON.stringify({ bundle: "fast", updatedAt, feeds });

describe("feed bundles on a mounted volume", () => {
  let dir: string;
  const original = process.env.MULTITEC_FEED_DIR;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mt-feeds-"));
    process.env.MULTITEC_FEED_DIR = dir;
    __resetFeedCache();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.MULTITEC_FEED_DIR;
    else process.env.MULTITEC_FEED_DIR = original;
    __resetFeedCache();
  });

  test("reads a feed out of a bundle", async () => {
    await writeFile(join(dir, "fast.json"), bundle({ minecraft: { payload: { online: 3 } } }));
    const feed = await readFeed("minecraft");
    expect(feed).toEqual({ name: "minecraft", payload: { online: 3 }, updatedAt: "2026-09-08T10:00:00Z" });
  });

  test("merges several bundles, which is how two cadences coexist", async () => {
    await writeFile(join(dir, "fast.json"), bundle({ minecraft: { payload: { online: 3 } } }));
    await writeFile(join(dir, "slow.json"), bundle({ stripe: { payload: { pagos: 7 } } }));
    __resetFeedCache();
    expect((await readFeed("minecraft"))?.payload).toEqual({ online: 3 });
    expect((await readFeed("stripe"))?.payload).toEqual({ pagos: 7 });
  });

  test("a feed's own timestamp wins over the bundle's", async () => {
    await writeFile(
      join(dir, "fast.json"),
      bundle({ minecraft: { payload: {}, updatedAt: "2026-09-08T11:22:33Z" } }),
    );
    expect((await readFeed("minecraft"))?.updatedAt).toBe("2026-09-08T11:22:33Z");
  });

  test("a feed that is in no bundle is null, not an error", async () => {
    await writeFile(join(dir, "fast.json"), bundle({ minecraft: { payload: {} } }));
    expect(await readFeed("stripe")).toBeNull();
  });

  test("an illegal feed name is never served, even out of a bundle we wrote", async () => {
    await writeFile(join(dir, "fast.json"), JSON.stringify({ feeds: { "../secrets": { payload: { leak: 1 } } } }));
    expect(await readFeed("../secrets")).toBeNull();
  });

  /**
   * The one above passes even with the in-bundle filter deleted, because `readFeed` already
   * refuses the name. This one goes at the map directly, so it is the test that actually
   * fails if the filter is removed.
   */
  test("an illegal name never even enters the map", async () => {
    await writeFile(
      join(dir, "fast.json"),
      JSON.stringify({
        feeds: {
          "../secrets": { payload: { leak: 1 } },
          Upper: { payload: { leak: 2 } },
          "with space": { payload: { leak: 3 } },
          minecraft: { payload: { online: 1 } },
        },
      }),
    );
    expect(Object.keys(await __bundleFeedsForTest(dir))).toEqual(["minecraft"]);
  });

  test("one broken bundle does not take the other one's tiles down", async () => {
    await writeFile(join(dir, "broken.json"), "{ this is not json");
    await writeFile(join(dir, "fast.json"), bundle({ minecraft: { payload: { online: 3 } } }));
    expect((await readFeed("minecraft"))?.payload).toEqual({ online: 3 });
  });

  test("a missing mount is a missing feed, not a crash", async () => {
    process.env.MULTITEC_FEED_DIR = join(dir, "does-not-exist");
    __resetFeedCache();
    expect(await readFeed("minecraft")).toBeNull();
  });

  test("a non-json file in the directory is ignored", async () => {
    await writeFile(join(dir, "README.txt"), "not a bundle");
    await writeFile(join(dir, "fast.json"), bundle({ minecraft: { payload: { online: 1 } } }));
    expect((await readFeed("minecraft"))?.payload).toEqual({ online: 1 });
  });

  test("a bundle written after the read is not seen until the cache expires", async () => {
    await writeFile(join(dir, "fast.json"), bundle({ minecraft: { payload: { online: 1 } } }));
    const first = Date.now();
    expect((await readFeed("minecraft", first))?.payload).toEqual({ online: 1 });
    await writeFile(join(dir, "fast.json"), bundle({ minecraft: { payload: { online: 2 } } }));
    expect((await readFeed("minecraft", first + 1_000))?.payload).toEqual({ online: 1 });
    expect((await readFeed("minecraft", first + 61_000))?.payload).toEqual({ online: 2 });
  });
});
