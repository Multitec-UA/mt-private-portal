// @vitest-environment node
//
// Not jsdom, which is this repo's default. `jose` checks `payload instanceof Uint8Array`,
// and under jsdom the encoder returns a Uint8Array from a different realm — so every
// signature in this file failed with "payload must be an instance of Uint8Array" before
// the verifier was ever reached. Node is also the runtime this code actually runs in.

import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  AUTH_IAP_ADMIN_SOURCE: "/tmp/never-used-placeholder.json",
  AUTH_IAP_ADMIN_CACHE_SECONDS: 0,
  AUTH_IAP_ADMIN_GROUP: "admins",
  AUTH_IAP_MEMBER_GROUP: undefined as string | undefined,
  AUTH_IAP_SERVICE_ACCOUNTS: "",
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
const { resolveGroupsForEmailAsync, resetAdminCacheForTests } = await import("../iap/resolve-groups");

// A real file on disk, because the point of the design is that the portal reads bytes
// rather than calling an API — and "what happens when the file is missing or malformed" is
// the half of it that decides whether a broken sync locks the junta out or just logs.
const adminFile = join(tmpdir(), `iap-admins-${process.pid}.json`);
const writeAdmins = (body: unknown) => writeFileSync(adminFile, JSON.stringify(body));
mockEnv.AUTH_IAP_ADMIN_SOURCE = adminFile;

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
  mockEnv.AUTH_IAP_SERVICE_ACCOUNTS = "";
});

const AGENT = "quantumpc-agent@sergio-conejero.iam.gserviceaccount.com";

/** A service-account assertion: a real address and, as Google mints it, no `hd` at all. */
const signAsMachine = (email = AGENT) => sign({ email, hd: null, subject: "accounts.google.com:117" });

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

describe("resolveGroupsForEmailAsync", () => {
  beforeEach(() => {
    resetAdminCacheForTests();
    writeAdmins({ members: ["boss@multitecua.com"], syncedAt: "2026-08-29T00:00:00Z" });
  });

  test("gives the admin group only to a member of the exported group", async () => {
    expect(await resolveGroupsForEmailAsync("boss@multitecua.com")).toEqual(["admins"]);
    expect(await resolveGroupsForEmailAsync("member@multitecua.com")).toEqual([]);
  });

  test("matches regardless of case on either side", async () => {
    writeAdmins({ members: ["BOSS@Multitecua.com"] });
    expect(await resolveGroupsForEmailAsync("boss@multitecua.com")).toEqual(["admins"]);
    resetAdminCacheForTests();
    expect(await resolveGroupsForEmailAsync("BOSS@MULTITECUA.COM")).toEqual(["admins"]);
  });

  test("adds the member group to everyone when one is configured", async () => {
    mockEnv.AUTH_IAP_MEMBER_GROUP = "socios";
    expect(await resolveGroupsForEmailAsync("member@multitecua.com")).toEqual(["socios"]);
    expect(await resolveGroupsForEmailAsync("boss@multitecua.com")).toEqual(["admins", "socios"]);
  });

  test("fails CLOSED when the export is missing", async () => {
    // The important direction. A sync job that has never run, or a volume that failed to
    // mount, must not hand the portal to whoever signs in next.
    rmSync(adminFile, { force: true });
    resetAdminCacheForTests();
    expect(await resolveGroupsForEmailAsync("boss@multitecua.com")).toEqual([]);
  });

  test("fails closed on a malformed export rather than throwing", async () => {
    // A half-written file during a sync is a normal event, not an exception. Throwing here
    // would turn it into a failed login instead of a login without admin rights.
    writeFileSync(adminFile, "{ this is not json");
    resetAdminCacheForTests();
    expect(await resolveGroupsForEmailAsync("boss@multitecua.com")).toEqual([]);
  });

  test("an empty group is honoured, not treated as broken", async () => {
    writeAdmins({ members: [] });
    resetAdminCacheForTests();
    expect(await resolveGroupsForEmailAsync("boss@multitecua.com")).toEqual([]);
  });

  test("a read failure is not cached, so recovery does not wait for the TTL", async () => {
    mockEnv.AUTH_IAP_ADMIN_CACHE_SECONDS = 3600;
    rmSync(adminFile, { force: true });
    resetAdminCacheForTests();
    expect(await resolveGroupsForEmailAsync("boss@multitecua.com")).toEqual([]);

    // The sync job catches up. Without the "do not cache failures" rule this would stay
    // broken for an hour, which is exactly when somebody is trying to fix it.
    writeAdmins({ members: ["boss@multitecua.com"] });
    expect(await resolveGroupsForEmailAsync("boss@multitecua.com")).toEqual(["admins"]);
    mockEnv.AUTH_IAP_ADMIN_CACHE_SECONDS = 0;
  });
});

/**
 * The machine administrator: the agent holding a real session so it can drive Homarr's own
 * API instead of writing to the database. Sergio asked for that on 2026-08-29 and the whole
 * risk of it is concentrated here, because it is the one path that walks past the domain
 * check. These tests are the fence.
 */
describe("machine administrators", () => {
  test("the default is OFF — an unlisted service account is still refused", async () => {
    // The regression that matters most: deployments that never set the variable must behave
    // exactly as they did before this feature existed.
    expect(await verifyIapAssertionAsync(await signAsMachine())).toBeNull();
  });

  test("a listed service account is accepted despite having no hd", async () => {
    mockEnv.AUTH_IAP_SERVICE_ACCOUNTS = AGENT;
    expect(await verifyIapAssertionAsync(await signAsMachine())).toEqual({
      subject: "accounts.google.com:117",
      email: AGENT,
      hostedDomain: null,
    });
  });

  test("and it is an admin without the export existing at all", async () => {
    // The point of the design: the agent must still be able to fix the portal when the
    // admin export is missing, which is one of the things it would be fixing.
    mockEnv.AUTH_IAP_SERVICE_ACCOUNTS = AGENT;
    rmSync(adminFile, { force: true });
    resetAdminCacheForTests();
    expect(await resolveGroupsForEmailAsync(AGENT)).toEqual(["admins"]);
  });

  test("a DIFFERENT service account is refused while one is listed", async () => {
    // Exact match, not "any service account", and not a suffix test.
    mockEnv.AUTH_IAP_SERVICE_ACCOUNTS = AGENT;
    const other = await signAsMachine("someone-else@evil-project.iam.gserviceaccount.com");
    expect(await verifyIapAssertionAsync(other)).toBeNull();
  });

  test("a human address in the list is DROPPED, not honoured", async () => {
    // This is the attack the allowlist could otherwise enable: naming an ordinary address
    // here would walk it straight past AUTH_IAP_HOSTED_DOMAIN. Only *.gserviceaccount.com
    // is ever admitted, so the mistake fails safe instead of opening the domain.
    mockEnv.AUTH_IAP_SERVICE_ACCOUNTS = "outsider@gmail.com";
    const outsider = await sign({ email: "outsider@gmail.com", hd: null });
    expect(await verifyIapAssertionAsync(outsider)).toBeNull();
    expect(await resolveGroupsForEmailAsync("outsider@gmail.com")).toEqual([]);
  });

  test("a listed account presenting an hd is refused as impersonation", async () => {
    // A Google service account never carries `hd`; `hd` is a Workspace-user claim. Both at
    // once is not a shape anything legitimate produces.
    mockEnv.AUTH_IAP_SERVICE_ACCOUNTS = AGENT;
    const odd = await sign({ email: AGENT, hd: "multitecua.com" });
    expect(await verifyIapAssertionAsync(odd)).toBeNull();
  });

  test("a listed account still has to be signed by Google", async () => {
    // Being on the list changes the domain check and nothing else. Signature, issuer,
    // audience and expiry all still apply.
    mockEnv.AUTH_IAP_SERVICE_ACCOUNTS = AGENT;
    expect(await verifyIapAssertionAsync(await sign({ key: attacker.privateKey, email: AGENT, hd: null }))).toBeNull();
    expect(
      await verifyIapAssertionAsync(await sign({ email: AGENT, hd: null, audience: "/projects/1234/x" })),
    ).toBeNull();
    expect(await verifyIapAssertionAsync(await sign({ email: AGENT, hd: null, expiresIn: -120 }))).toBeNull();
  });

  test("the list tolerates spaces, case and several entries", async () => {
    mockEnv.AUTH_IAP_SERVICE_ACCOUNTS = ` One@a.iam.gserviceaccount.com , ${AGENT.toUpperCase()} `;
    expect(await verifyIapAssertionAsync(await signAsMachine())).not.toBeNull();
    expect(await verifyIapAssertionAsync(await signAsMachine("one@a.iam.gserviceaccount.com"))).not.toBeNull();
  });

  test("a machine admin does NOT also collect the member group", async () => {
    // It administers the portal; it is not a socio, and it should not appear in a group
    // whose purpose is to describe the association's members.
    mockEnv.AUTH_IAP_SERVICE_ACCOUNTS = AGENT;
    mockEnv.AUTH_IAP_MEMBER_GROUP = "socios";
    expect(await resolveGroupsForEmailAsync(AGENT)).toEqual(["admins"]);
  });

  test("humans are unaffected by the list existing", async () => {
    mockEnv.AUTH_IAP_SERVICE_ACCOUNTS = AGENT;
    writeAdmins({ members: ["boss@multitecua.com"] });
    resetAdminCacheForTests();
    expect(await verifyIapAssertionAsync(await sign())).not.toBeNull();
    expect(await resolveGroupsForEmailAsync("boss@multitecua.com")).toEqual(["admins"]);
    expect(await resolveGroupsForEmailAsync("member@multitecua.com")).toEqual([]);
  });
});
