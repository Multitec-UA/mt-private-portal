import type { Provider } from "next-auth/providers";

import { env } from "../env";

export const filterProviders = (providers: Exclude<Provider, () => unknown>[]) => {
  // During build this will be undefined, so we default to an empty array
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const authProviders = env.AUTH_PROVIDERS ?? [];

  return providers.filter((provider) => {
    /**
     * `Credentials(config)` does NOT put the config's id on the provider:
     *
     *     export default function Credentials(config) {
     *       return { id: "credentials", name: "Credentials", type: "credentials",
     *                credentials: {}, authorize: () => null, options: config };
     *     }
     *
     * So every credentials-shaped provider looks like `id: "credentials"` here, and the
     * real id — "ldap", "iap" — is one level down in `options`. Auth.js merges it later,
     * which is why `/api/auth/providers` reports the right ids while this filter cannot
     * tell them apart.
     *
     * Two consequences, both observed on the running service:
     *   - `AUTH_PROVIDERS=credentials` registers **ldap as well**, because ldap's provider
     *     also has `id === "credentials"` at this point;
     *   - `AUTH_PROVIDERS=iap` registers **nothing**, because no credentials provider is
     *     admitted unless "credentials" or "ldap" is in the list.
     *
     * The second one makes it impossible to add any new credentials-shaped provider,
     * which is worth sending upstream. Resolving the id first fixes it and leaves the
     * behaviour for `credentials` and `ldap` exactly as it was.
     */
    const providerId = (provider as { options?: { id?: string } }).options?.id ?? provider.id;

    if (providerId === "empty") {
      return true;
    }

    if (
      (providerId === "credentials" || providerId === "ldap") &&
      ["ldap", "credentials"].some((credentialType) => authProviders.includes(credentialType))
    ) {
      return true;
    }

    return authProviders.includes(providerId);
  });
};
