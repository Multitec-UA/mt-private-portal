// @vitest-environment node
//
// Not jsdom, which is this repo's default. `jose` checks `payload instanceof Uint8Array`,
// and under jsdom the encoder returns a Uint8Array from a different realm — so every
// signature in this file failed with "payload must be an instance of Uint8Array" before
// the verifier was ever reached. Node is also the runtime this code actually runs in.

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * These tests attack the verifier rather than demonstrate it.
 *
 * Every case below signs a **real** ES256 token with a key this test controls, and the
 * verifier is pointed at a JWKS this test serves. That is the only way to exercise the
 * paths that matter: an attacker does not send a malformed string, they send a perfectly
 * well-formed token that is wrong in exactly one way.
 *
 * The corresponding positive result was measured against Google itself during the phase-0
 * spike — see `docs/multitec/reports/0001-iap-probe.md`.
 */

const mockEnv = vi.hoisted(() => ({
  AUTH_IAP_AUDIENCE: "/projects/1234/locations/europe-west1/services/mt-portal",
  AUTH_IAP_HOSTED_DOMAIN: "multitecua.com" as string | undefined,
  AUTH_IAP_CLOCK_TOLERANCE_SECONDS: 30,
  AUTH_IAP_ADMIN_EMAILS: ["boss@multitecua.com"],
  AUTH_IAP_ADMIN_GROUP: "admins",
  AUTH_IAP_MEMBER_GROUP: undefined as string | undefined,
}));

vi.mock("../../env", () => ({ env: mockEnv }));

const ISSUER = "https://cloud.google.com/iap";

// One key pair is IAP's, the other is an attacker's. Both produce valid ES256 tokens; only
// one of them is in the key set the verifier trusts.
const real = await generateKeyPair("ES256");
const attacker = await generateKeyPair("ES256");

const jwks = {
  keys: [{ ...(await exportJWK(real.publicKey)), kid: "iap-key", alg: "ES256", use: "sig" }],
};

// `jose`'s createRemoteJWKSet fetches over the network; this keeps the whole suite offline
// and makes "the key is not in the set" a first-class case rather than a network error.
vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } })),
  ),
);

const { stripNamespace, verifyIapAssertionAsync } = await import("../iap/verify-assertion");
const { resolveGroupsForEmail } = await import("../iap/resolve-groups");

interface TokenOptions {
  key?: CryptoKey;
  kid?: string;
  issuer?: string;
  audience?: string;
  email?: string | null;
  hd?: string | null;
  subject?: string | null;
  expiresIn?: number;
}

const sign = async (options: TokenOptions = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {};
  if (options.email !== null) payload.email = options.email ?? "member@multitecua.com";
  if (options.hd !== null) payload.hd = options.hd ?? "multitecua.com";

  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: options.kid ?? "iap-key" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? mockEnv.AUTH_IAP_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresIn ?? 600));

  if (options.subject !== null) jwt = jwt.setSubject(options.subject ?? "accounts.google.com:1095");

  return await jwt.sign(options.key ?? real.privateKey);
};

beforeEach(() => {
  mockEnv.AUTH_IAP_HOSTED_DOMAIN = "multitecua.com";
  mockEnv.AUTH_IAP_MEMBER_GROUP = undefined;
});

describe("verifyIapAssertionAsync", () => {
  test("accepts an assertion signed by IAP's key with the right issuer and audience", async () => {
    const identity = await verifyIapAssertionAsync(await sign());
    expect(identity).toEqual({
      subject: "accounts.google.com:1095",
      email: "member@multitecua.com",
      hostedDomain: "multitecua.com",
    });
  });

  test("refuses a missing header rather than falling back to the unsigned email", async () => {
    // The whole design rests on never trusting x-goog-authenticated-user-email. If the
    // signed header is absent, a present unsigned one must change nothing.
    expect(await verifyIapAssertionAsync(null, "accounts.google.com:member@multitecua.com")).toBeNull();
    expect(await verifyIapAssertionAsync("", "accounts.google.com:member@multitecua.com")).toBeNull();
  });

  test("refuses a token signed by someone else, however well formed", async () => {
    // Right issuer, right audience, right claims, wrong key. This is the attack.
    const forged = await sign({ key: attacker.privateKey, email: "impostor@multitecua.com" });
    expect(await verifyIapAssertionAsync(forged)).toBeNull();
  });

  test("refuses a token whose kid is not in the key set", async () => {
    expect(await verifyIapAssertionAsync(await sign({ key: attacker.privateKey, kid: "unknown" }))).toBeNull();
  });

  test("refuses an audience minted for a different service", async () => {
    // Same Google, same signing key, different IAP resource — a member of another
    // multitecua service replaying their own valid assertion here.
    const other = await sign({ audience: "/projects/1234/locations/europe-west1/services/mt-mc-map" });
    expect(await verifyIapAssertionAsync(other)).toBeNull();
  });

  test("refuses a different issuer", async () => {
    expect(await verifyIapAssertionAsync(await sign({ issuer: "https://accounts.google.com" }))).toBeNull();
  });

  test("refuses an expired assertion", async () => {
    // Beyond the clock tolerance, so this is expiry and not drift.
    expect(await verifyIapAssertionAsync(await sign({ expiresIn: -120 }))).toBeNull();
  });

  test("refuses an assertion with no email claim", async () => {
    expect(await verifyIapAssertionAsync(await sign({ email: null }))).toBeNull();
  });

  test("refuses an assertion with no subject", async () => {
    expect(await verifyIapAssertionAsync(await sign({ subject: null }))).toBeNull();
  });

  test("refuses a hosted domain that is not ours", async () => {
    expect(await verifyIapAssertionAsync(await sign({ hd: "example.com" }))).toBeNull();
  });

  test("accepts a member whose assertion carries NO hd, on the strength of the address", async () => {
    // `hd` is a Workspace-user claim and the spike measured assertions arriving without
    // it, so requiring the claim would refuse legitimate callers. The address still has to
    // be ours — an absent claim is not an absent check.
    const identity = await verifyIapAssertionAsync(await sign({ hd: null, email: "member@multitecua.com" }));
    expect(identity?.email).toBe("member@multitecua.com");
    expect(identity?.hostedDomain).toBeNull();
  });

  test("refuses an identity with no hd AND an address outside the domain", async () => {
    // The hole the first version had: comparing `hd` only when present meant an identity
    // without it skipped the domain check entirely. Unreachable while IAP admits only
    // domain:multitecua.com — and silently exploitable the moment one guest address is
    // added to that member list, from a different file.
    expect(
      await verifyIapAssertionAsync(await sign({ hd: null, email: "robot@project.iam.gserviceaccount.com" })),
    ).toBeNull();
  });

  test("hd wins when present, even against an address that looks right", async () => {
    // This is the case that killed the OR: `hd` is Google stating which Workspace the
    // account belongs to. If it says somewhere else, the address agreeing with us is not
    // a reason to admit them — it is a reason to be suspicious.
    expect(
      await verifyIapAssertionAsync(await sign({ hd: "example.com", email: "member@multitecua.com" })),
    ).toBeNull();
  });

  test("...and a correct hd admits an address outside the domain", async () => {
    // A Workspace can host addresses on secondary domains. `hd` is the membership claim.
    expect(
      await verifyIapAssertionAsync(await sign({ hd: "multitecua.com", email: "member@alias.example" })),
    ).not.toBeNull();
  });

  test("refuses when the signed and unsigned emails disagree", async () => {
    // Nothing between IAP and this process should be able to rewrite identity. If it
    // happens, it is not a subtle bug and it must not fail subtly.
    const token = await sign({ email: "member@multitecua.com" });
    expect(await verifyIapAssertionAsync(token, "accounts.google.com:someone.else@multitecua.com")).toBeNull();
  });

  test("accepts when they agree, whatever the namespace prefix and case", async () => {
    const token = await sign({ email: "member@multitecua.com" });
    expect(await verifyIapAssertionAsync(token, "accounts.google.com:Member@Multitecua.com")).not.toBeNull();
  });

  test("lowercases the email, so an allowlist match cannot be defeated by casing", async () => {
    const identity = await verifyIapAssertionAsync(await sign({ email: "Boss@Multitecua.com" }));
    expect(identity?.email).toBe("boss@multitecua.com");
  });
});

describe("stripNamespace", () => {
  test("takes the address out of the namespaced header", () => {
    expect(stripNamespace("accounts.google.com:someone@multitecua.com")).toBe("someone@multitecua.com");
  });

  test("tolerates a bare address", () => {
    expect(stripNamespace("someone@multitecua.com")).toBe("someone@multitecua.com");
  });
});

describe("resolveGroupsForEmail", () => {
  test("gives the admin group only to a listed address", () => {
    expect(resolveGroupsForEmail("boss@multitecua.com")).toEqual(["admins"]);
    expect(resolveGroupsForEmail("member@multitecua.com")).toEqual([]);
  });

  test("matches the allowlist regardless of case", () => {
    expect(resolveGroupsForEmail("BOSS@multitecua.com")).toEqual(["admins"]);
  });

  test("adds the member group to everyone when one is configured", () => {
    mockEnv.AUTH_IAP_MEMBER_GROUP = "socios";
    expect(resolveGroupsForEmail("member@multitecua.com")).toEqual(["socios"]);
    expect(resolveGroupsForEmail("boss@multitecua.com")).toEqual(["admins", "socios"]);
  });
});
