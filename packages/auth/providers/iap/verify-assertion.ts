import { createRemoteJWKSet, jwtVerify } from "jose";

import { createLogger } from "@homarr/core/infrastructure/logs";

import { env } from "../../env";

const logger = createLogger({ module: "iapAssertion" });

/**
 * The header Google IAP adds. It holds an ES256-signed JWT and it is the only thing on the
 * request worth trusting.
 *
 * IAP strips any client-supplied `x-goog-*` before adding its own — verified against the
 * real thing on 2026-08-28, not taken from the documentation: a request carrying a valid
 * credential AND a forged assertion for a different member reached the container with
 * IAP's own headers. See `docs/multitec/reports/0001-iap-probe.md` §2.
 */
export const IAP_ASSERTION_HEADER = "x-goog-iap-jwt-assertion";

/** Unsigned, kept only to cross-check. Google's own docs say not to rely on it. */
export const IAP_EMAIL_HEADER = "x-goog-authenticated-user-email";

export const IAP_ISSUER = "https://cloud.google.com/iap";
export const IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";

/**
 * Fetched once and cached by `jose`, which also handles re-fetching when an unknown `kid`
 * appears. A module-level singleton on purpose: one key set per process, not one per login.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
const getJwks = () => (jwks ??= createRemoteJWKSet(new URL(IAP_JWKS_URL)));

export interface IapIdentity {
  /** Stable per-user id, e.g. `accounts.google.com:1095…`. */
  subject: string;
  email: string;
  /** Workspace domain. **Null for service accounts** — see below. */
  hostedDomain: string | null;
}

/**
 * `accounts.google.com:someone@multitecua.com` -> `someone@multitecua.com`.
 */
export const stripNamespace = (raw: string) => raw.split(":").pop()?.trim().toLowerCase() ?? "";

/**
 * Verify an IAP assertion and return who it says the caller is, or `null`.
 *
 * Never throws and never logs the token: a signed assertion is a bearer credential for the
 * ten minutes it lives, and this runs on a login path whose logs are read by humans.
 */
export const verifyIapAssertionAsync = async (
  assertion: string | null | undefined,
  unsignedEmailHeader?: string | null,
): Promise<IapIdentity | null> => {
  if (!assertion) {
    logger.warn("Rejected an IAP sign-in", { reason: "ASSERTION_HEADER_ABSENT" });
    return null;
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(assertion, getJwks(), {
      issuer: IAP_ISSUER,
      // The exact resource string, with no default anywhere in the stack. This is what
      // makes an assertion minted for another IAP-protected Multitec service useless
      // here — without it, a member of any of them could sign in to this one.
      audience: env.AUTH_IAP_AUDIENCE,
      // Pinned. Accepting whatever the token's header claims is how algorithm-confusion
      // attacks work, and IAP only ever signs ES256.
      algorithms: ["ES256"],
      clockTolerance: env.AUTH_IAP_CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["sub", "email", "exp", "iat"],
    }));
  } catch (error) {
    logger.warn("Rejected an IAP sign-in", {
      reason: "ASSERTION_INVALID",
      // The library's message names which check failed (signature, audience, expiry). It
      // does not contain the token.
      detail: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }

  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  if (!email) {
    logger.warn("Rejected an IAP sign-in", { reason: "NO_EMAIL_CLAIM" });
    return null;
  }

  const hostedDomain = typeof payload.hd === "string" ? payload.hd.toLowerCase() : null;

  /**
   * `hd` is asserted when present and never demanded.
   *
   * Measured during the phase-0 spike: **a service account's assertion carries no `hd` at
   * all** — it is a Workspace-user claim. ADR 0002 originally said to require it, which
   * would have refused every machine caller the portal ever gains. The domain is enforced
   * by IAP's own member list (`domain:multitecua.com`) regardless; this is the second,
   * independent check, and a second check that rejects legitimate callers is worse than
   * no second check.
   */
  const expectedDomain = env.AUTH_IAP_HOSTED_DOMAIN;
  if (expectedDomain && hostedDomain !== null && hostedDomain !== expectedDomain) {
    logger.warn("Rejected an IAP sign-in", { reason: "HOSTED_DOMAIN_MISMATCH", email });
    return null;
  }

  /**
   * The signed email against the unsigned header. This can only disagree if something
   * between IAP and this process rewrites identity — which is not a subtle bug, so it
   * should not fail subtly.
   */
  if (unsignedEmailHeader) {
    const unsigned = stripNamespace(unsignedEmailHeader);
    if (unsigned && unsigned !== email) {
      logger.error("Rejected an IAP sign-in", { reason: "SIGNED_UNSIGNED_EMAIL_MISMATCH", email });
      return null;
    }
  }

  const subject = typeof payload.sub === "string" ? payload.sub : null;
  if (!subject) {
    logger.warn("Rejected an IAP sign-in", { reason: "NO_SUBJECT_CLAIM" });
    return null;
  }

  return { subject, email, hostedDomain };
};
