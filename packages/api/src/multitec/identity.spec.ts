import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  isOwnEndpoint,
  MEMBER_HEADER,
  SIGNATURE_HEADER,
  signedIdentityHeaders,
  TIMESTAMP_HEADER,
  verifySignedIdentity,
} from "./identity";

const MEMBER = "socio@multitecua.com";
const OWN = new URL("http://127.0.0.1:7575/api/multitec/feed/me/membership");
const NOW = 1_767_225_600;

const headersFrom = (pairs: [string, string][]) => {
  const headers = new Headers();
  for (const [key, value] of pairs) headers.set(key, value);
  return headers;
};

/**
 * The value of one header, or "" — rather than `headers.get(x)!`.
 *
 * `oxlint` forbids non-null assertions, including in tests, and it is right to: a test
 * that crashes on a null is a test that reports a bug in itself. An empty string flows on
 * into the assertion and fails it, which is what a reader wants to see.
 */
const headerValue = (headers: Headers, name: string): string => headers.get(name) ?? "";

const pairValue = (pairs: [string, string][], name: string): string =>
  pairs.find(([key]) => key === name)?.[1] ?? "";

describe("multitec identity forwarding", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.SECRET_ENCRYPTION_KEY = "a".repeat(64);
    process.env.AUTH_IAP_AUDIENCE = "/projects/882854291514/locations/europe-west1/services/mt-portal";
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  test("signs and verifies a round trip", () => {
    const pairs = signedIdentityHeaders(OWN, MEMBER, NOW);
    expect(pairs).toHaveLength(3);
    expect(verifySignedIdentity(headersFrom(pairs), NOW)).toBe(MEMBER);
  });

  // MULTITEC.md rule 5: with none of our env vars set, this fork must behave exactly like
  // vanilla Homarr. `AUTH_IAP_AUDIENCE` is the single switch for the whole feature, so
  // this is that rule as a test rather than as a paragraph.
  test("emits nothing at all when the feature is off", () => {
    delete process.env.AUTH_IAP_AUDIENCE;
    expect(signedIdentityHeaders(OWN, MEMBER, NOW)).toEqual([]);
  });

  test("verifies nothing when the feature is off, even with a signature made while it was on", () => {
    const pairs = signedIdentityHeaders(OWN, MEMBER, NOW);
    delete process.env.AUTH_IAP_AUDIENCE;
    expect(verifySignedIdentity(headersFrom(pairs), NOW)).toBeNull();
  });

  test("emits nothing without a signed-in member", () => {
    expect(signedIdentityHeaders(OWN, null, NOW)).toEqual([]);
    expect(signedIdentityHeaders(OWN, undefined, NOW)).toEqual([]);
    expect(signedIdentityHeaders(OWN, "", NOW)).toEqual([]);
  });

  test("emits nothing without the master key to derive from", () => {
    delete process.env.SECRET_ENCRYPTION_KEY;
    expect(signedIdentityHeaders(OWN, MEMBER, NOW)).toEqual([]);
  });

  // The one that matters most. A configuration mistake must not be able to send a
  // member's email to GitHub, Stripe or anyone else a widget happens to point at.
  test("never sends the identity anywhere but this container", () => {
    for (const url of [
      "https://api.github.com/orgs/Multitec-UA",
      "https://socios.multitecua.com/api/multitec/feed/me/membership",
      "http://127.0.0.1.evil.example/api",
      "http://169.254.169.254/computeMetadata/v1/",
      "http://10.0.0.5:7575/api/multitec/feed/x",
    ]) {
      expect(signedIdentityHeaders(new URL(url), MEMBER, NOW), url).toEqual([]);
    }
  });

  test("accepts every spelling of loopback and nothing else", () => {
    expect(isOwnEndpoint(new URL("http://127.0.0.1:7575/x"))).toBe(true);
    expect(isOwnEndpoint(new URL("http://localhost:7575/x"))).toBe(true);
    expect(isOwnEndpoint(new URL("http://[::1]:7575/x"))).toBe(true);
    expect(isOwnEndpoint(new URL("http://127.0.0.2:7575/x"))).toBe(false);
    expect(isOwnEndpoint(new URL("https://socios.multitecua.com/x"))).toBe(false);
  });

  test("rejects a forged member with no signature — the whole reason this is signed", () => {
    const forged = headersFrom([[MEMBER_HEADER, "presidente@multitecua.com"]]);
    expect(verifySignedIdentity(forged, NOW)).toBeNull();
  });

  test("rejects a signature moved onto a different member", () => {
    const pairs = signedIdentityHeaders(OWN, MEMBER, NOW);
    const headers = headersFrom(pairs);
    headers.set(MEMBER_HEADER, "presidente@multitecua.com");
    expect(verifySignedIdentity(headers, NOW)).toBeNull();
  });

  test("rejects a signature moved onto a different timestamp", () => {
    const headers = headersFrom(signedIdentityHeaders(OWN, MEMBER, NOW));
    headers.set(TIMESTAMP_HEADER, String(NOW + 1));
    expect(verifySignedIdentity(headers, NOW)).toBeNull();
  });

  test("rejects a tampered signature of the right length", () => {
    const headers = headersFrom(signedIdentityHeaders(OWN, MEMBER, NOW));
    const signature = headerValue(headers, SIGNATURE_HEADER);
    headers.set(SIGNATURE_HEADER, (signature[0] === "0" ? "1" : "0") + signature.slice(1));
    expect(verifySignedIdentity(headers, NOW)).toBeNull();
  });

  // timingSafeEqual THROWS on a length mismatch. Without the length guard this case is a
  // 500 instead of a 401, which is an unauthenticated caller crashing the endpoint.
  test("a short or long signature is refused, not a crash", () => {
    for (const bogus of ["", "ab", "f".repeat(63), "f".repeat(65), "f".repeat(4096)]) {
      const headers = headersFrom([
        [MEMBER_HEADER, MEMBER],
        [TIMESTAMP_HEADER, String(NOW)],
        [SIGNATURE_HEADER, bogus],
      ]);
      expect(() => verifySignedIdentity(headers, NOW)).not.toThrow();
      expect(verifySignedIdentity(headers, NOW), bogus.length.toString()).toBeNull();
    }
  });

  test("expires: valid inside the window, refused outside it", () => {
    const pairs = signedIdentityHeaders(OWN, MEMBER, NOW);
    expect(verifySignedIdentity(headersFrom(pairs), NOW + 119)).toBe(MEMBER);
    expect(verifySignedIdentity(headersFrom(pairs), NOW + 121)).toBeNull();
    // Also refused from the future, so a clock jumped backwards cannot open a window that
    // never closes.
    expect(verifySignedIdentity(headersFrom(pairs), NOW - 121)).toBeNull();
  });

  // `Number("12abc")` is NaN but `Number("1e9")` is 1e9 and `parseInt("12abc")` is 12 —
  // any of which would let a timestamp verify under a different string than the one that
  // was signed. Hence the strict `^\d{1,15}$` rather than a numeric cast.
  test("a non-numeric timestamp is refused rather than coerced", () => {
    const key = signedIdentityHeaders(OWN, MEMBER, NOW);
    for (const bogus of ["1767225600abc", "0x1", "1e9", "-1767225600", "", "+1767225600", "1767225600.0"]) {
      const headers = headersFrom(key);
      headers.set(TIMESTAMP_HEADER, bogus);
      expect(verifySignedIdentity(headers, NOW), JSON.stringify(bogus)).toBeNull();
    }
  });

  // Surrounding whitespace is NOT a vector, and this records why rather than pretending the
  // verifier rejects it. `" 1767225600"` was in the list above until it failed: `Headers`
  // implements Fetch's "normalize a header value", which strips leading and trailing HTTP
  // whitespace on the way in — so `headers.get()` returns the trimmed string and the code
  // under test never sees the space.
  //
  // That is safe, and worth a test of its own: both signer and verifier read through the
  // same `Headers` normalisation, so they cannot disagree about what was signed.
  test("Headers normalises surrounding whitespace before the verifier sees it", () => {
    const pairs = signedIdentityHeaders(OWN, MEMBER, NOW);
    const headers = headersFrom(pairs);
    headers.set(TIMESTAMP_HEADER, `  ${NOW}  `);
    expect(headerValue(headers, TIMESTAMP_HEADER)).toBe(String(NOW));
    expect(verifySignedIdentity(headers, NOW)).toBe(MEMBER);
  });

  test("a different master key produces a signature this instance refuses", () => {
    const pairs = signedIdentityHeaders(OWN, MEMBER, NOW);
    process.env.SECRET_ENCRYPTION_KEY = "b".repeat(64);
    expect(verifySignedIdentity(headersFrom(pairs), NOW)).toBeNull();
  });

  test("the derived key is not the master key, spelled out", () => {
    const signature = pairValue(signedIdentityHeaders(OWN, MEMBER, NOW), SIGNATURE_HEADER);
    expect(signature).not.toContain(process.env.SECRET_ENCRYPTION_KEY);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});
