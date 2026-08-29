// @vitest-environment node

import Credentials from "@auth/core/providers/credentials";
import { describe, expect, test, vi } from "vitest";

/**
 * The bug these pin, found on the running service and not in review.
 *
 * `Credentials(config)` returns `{ id: "credentials", …, options: config }` — the real id
 * lives in `options`, and Auth.js merges it later. So a filter that reads `provider.id`
 * sees "credentials" for every credentials-shaped provider, and `AUTH_PROVIDERS=iap`
 * registered **nothing at all**: `/api/auth/providers` came back with only the `empty`
 * placeholder, the login page had no way to sign anybody in, and there was no error
 * anywhere to explain it.
 */

const mockEnv = vi.hoisted(() => ({ AUTH_PROVIDERS: [] as string[] }));
vi.mock("../../env", () => ({ env: mockEnv }));

const { filterProviders } = await import("../filter-providers");

// Shaped exactly like the real ones in configuration.ts, so this test breaks if Auth.js
// ever changes where the id lives.
const credentials = Credentials({ id: "credentials", name: "Credentials", authorize: () => null });
const ldap = Credentials({ id: "ldap", name: "Ldap", authorize: () => null });
const iap = Credentials({ id: "iap", name: "Google IAP", authorize: () => null });
const empty = { id: "empty", name: "Empty", type: "oauth" as const };

const kept = (enabled: string[]) => {
  mockEnv.AUTH_PROVIDERS = enabled;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return filterProviders([credentials, ldap, empty, iap] as any).map(
    (p) => (p as { options?: { id?: string } }).options?.id ?? p.id,
  );
};

describe("filterProviders", () => {
  test("Credentials() hides the real id in options — the premise of everything below", () => {
    expect(iap.id).toBe("credentials");
    expect((iap as { options?: { id?: string } }).options?.id).toBe("iap");
  });

  test("iap alone registers iap, and no password form with it", () => {
    const result = kept(["iap"]);
    expect(result).toContain("iap");
    expect(result).not.toContain("credentials");
    expect(result).not.toContain("ldap");
  });

  test("credentials alone does NOT drag in iap", () => {
    // The mirror of the bug: resolving the id must not make every credentials provider
    // appear whenever any one of them is enabled.
    expect(kept(["credentials"])).not.toContain("iap");
  });

  test("the existing credentials/ldap behaviour is unchanged", () => {
    // Upstream admits both together — ldap's provider is indistinguishable from
    // credentials' at this point. Preserved deliberately: this fix is for the new
    // provider, not a redesign of theirs.
    expect(kept(["credentials"])).toEqual(expect.arrayContaining(["credentials", "ldap"]));
    expect(kept(["ldap"])).toEqual(expect.arrayContaining(["credentials", "ldap"]));
  });

  test("the empty placeholder always survives", () => {
    // Auth.js refuses to run credentials-only auth without another provider present.
    expect(kept([])).toEqual(["empty"]);
    expect(kept(["iap"])).toContain("empty");
  });

  test("oidc still works alongside", () => {
    expect(kept(["oidc", "iap"])).toContain("iap");
  });
});
