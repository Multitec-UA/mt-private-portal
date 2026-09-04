/**
 * The rules about feed names, kept away from anything that opens a database connection.
 *
 * Importing `@homarr/db` constructs the pool at module load, so a unit test that only wants
 * to ask "is `member-billing` allowed on the shared path?" would otherwise need a database.
 * These two functions are the security-relevant half of the feed routing and they deserve
 * tests that run in milliseconds with nothing configured.
 */

/**
 * A feed name that cannot be anything but a name.
 *
 * A whitelist and not a "reject the bad characters" blacklist: the value arrives from a URL
 * segment, the interesting attacks on those are the encodings nobody thought of, and a
 * whitelist has no opinion about encodings.
 */
export const isValidFeedName = (name: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);

/**
 * Feeds whose payload holds every member, keyed by email.
 *
 * These are only ever served through `/feed/me/<name>`, which filters to the caller. The
 * shared path must refuse them outright — it applies no filter, so serving one would hand
 * any signed-in member the whole association's rows.
 */
export const MEMBER_FEED_PREFIX = "member-";

export const isMemberFeed = (name: string): boolean => name.startsWith(MEMBER_FEED_PREFIX);

/** Is this name allowed on the shared, unfiltered path? */
export const isServableAsShared = (name: string): boolean => isValidFeedName(name) && !isMemberFeed(name);
