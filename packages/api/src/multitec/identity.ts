/**
 * Let a `customApi` widget tell our own feed endpoint WHO is looking at it.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * `customApi`'s `getData` is a `protectedProcedure`, so `ctx.session.user` is right there
 * — and with the `iap` provider that carries the member's verified corporate email. But
 * the outbound request is built as `new Headers({ Accept: "application/json" })` plus
 * whatever `applyAuth` adds, and nothing about the member goes out. Every member's browser
 * triggers the same request and gets the same answer, so the widget can show shared
 * information well and personal information not at all.
 *
 * WHY IT IS SIGNED, AND NOT JUST A HEADER
 * ---------------------------------------
 * The feed endpoint lives in this same application, behind the same IAP. A member can
 * therefore reach it from their own browser — and if it trusted a bare
 * `X-Multitec-Member` header, any member could ask it for another member's data by typing
 * a different address. An HMAC over (email, timestamp) closes that: only code holding the
 * key can produce a header the endpoint will accept, and that key never leaves the server.
 *
 * WHY THE KEY IS DERIVED AND NOT CONFIGURED
 * -----------------------------------------
 * `SECRET_ENCRYPTION_KEY` already exists, is already required, is already 32 bytes of
 * entropy, and already must never change. A second secret would mean a second Secret
 * Manager entry, a second Terraform change and a second thing to rotate wrongly. Deriving
 * with a fixed domain label is the standard answer to "I need a key for a different
 * purpose": `HMAC(master, "multitec-identity-v1")` is independent of the master for any
 * attacker who does not already hold the master — and one who holds it can decrypt every
 * integration secret in the database anyway, so this adds no new exposure.
 *
 * OFF BY DEFAULT (MULTITEC.md rule 5)
 * -----------------------------------
 * `AUTH_IAP_AUDIENCE` is the single switch, shared with the feed endpoints
 * (`apps/nextjs/src/app/api/multitec/_lib/feed-store.ts`). Unset — which is every vanilla
 * Homarr — `signedIdentityHeaders` returns nothing and the request that leaves this server
 * is byte-for-byte the one upstream would have sent.
 *
 * It reuses an existing variable rather than adding one because adding one means editing
 * the portal's Terraform, and on 2026-09-04 a full plan of that workspace came back
 * `56 to destroy`. `AUTH_IAP_AUDIENCE` is already required by our deployment, is set
 * nowhere else, and means exactly "this is the Multitec portal".
 *
 * AND ONLY TO OURSELVES
 * ---------------------
 * The allowed destination is loopback, hard-coded, not configurable. The feed endpoints are
 * in this same container (see `apps/nextjs/src/app/api/multitec/feed`), so loopback is the
 * complete list of places this identity is useful. Making it configurable would create a
 * way to leak a member's email to a third party through a configuration mistake, and buy
 * nothing: nothing else needs it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const MEMBER_HEADER = "x-multitec-member";
export const TIMESTAMP_HEADER = "x-multitec-ts";
export const SIGNATURE_HEADER = "x-multitec-sig";

/**
 * How stale a signature may be. Two minutes covers a slow feed read (the widget's own
 * fetch timeout is 10s) plus any clock skew inside one container, while keeping a captured
 * header useless almost immediately. Both signer and verifier run in the same process, so
 * there is no real clock skew to accommodate — this is margin, not synchronisation.
 */
const MAX_AGE_SECONDS = 120;

const KEY_LABEL = "multitec-identity-v1";

/**
 * Loopback, spelled every way a URL can spell it. `new URL("http://[::1]/").hostname`
 * keeps the brackets, so both forms are listed rather than stripped — a normaliser here
 * would be one more thing to get wrong in the code that decides who you are.
 */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const isFeatureEnabled = (): boolean => Boolean(process.env.AUTH_IAP_AUDIENCE);

const identityKey = (): Buffer | null => {
  const master = process.env.SECRET_ENCRYPTION_KEY;
  if (!master) return null;
  return createHmac("sha256", master).update(KEY_LABEL).digest();
};

const sign = (key: Buffer, email: string, timestamp: string): string =>
  createHmac("sha256", key).update(`${email}\n${timestamp}`).digest("hex");

/** Is this URL one of our own endpoints, i.e. inside this very container? */
export const isOwnEndpoint = (url: URL): boolean => LOOPBACK_HOSTNAMES.has(url.hostname);

/**
 * The identity headers to add to an outbound `customApi` request, or none at all.
 *
 * Returns an ARRAY OF PAIRS rather than a Headers or an object so the caller can do
 * `for (const [k, v] of ...) headers.set(k, v)` — three lines at the call site in an
 * upstream file, which is the whole point: the smallest possible touchpoint.
 */
export const signedIdentityHeaders = (
  url: URL,
  email: string | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): [string, string][] => {
  if (!isFeatureEnabled() || !email || !isOwnEndpoint(url)) return [];
  const key = identityKey();
  if (!key) return [];

  const timestamp = String(nowSeconds);
  return [
    [MEMBER_HEADER, email],
    [TIMESTAMP_HEADER, timestamp],
    [SIGNATURE_HEADER, sign(key, email, timestamp)],
  ];
};

/**
 * The member an incoming request proves it is for, or null.
 *
 * Null for every failure — missing headers, bad signature, stale timestamp, feature off —
 * on purpose. The caller's only correct response to any of them is the same 401, and a
 * verifier that explains WHICH check failed is a verifier that helps someone tune an
 * attack.
 */
export const verifySignedIdentity = (
  headers: Headers,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | null => {
  if (!isFeatureEnabled()) return null;

  const email = headers.get(MEMBER_HEADER);
  const timestamp = headers.get(TIMESTAMP_HEADER);
  const signature = headers.get(SIGNATURE_HEADER);
  if (!email || !timestamp || !signature) return null;

  // Parsed strictly: `Number("12 ")` is 12 and `parseInt("12abc")` is 12, either of which
  // would let one timestamp verify under a different string than the one that was signed.
  if (!/^\d{1,15}$/.test(timestamp)) return null;
  const age = nowSeconds - Number(timestamp);
  if (age < -MAX_AGE_SECONDS || age > MAX_AGE_SECONDS) return null;

  const key = identityKey();
  if (!key) return null;

  const expected = sign(key, email, timestamp);
  // Same length by construction (both are sha256 hex), but checked anyway: timingSafeEqual
  // THROWS on a length mismatch rather than returning false, which would turn a malformed
  // header into a 500.
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))) return null;

  return email;
};
