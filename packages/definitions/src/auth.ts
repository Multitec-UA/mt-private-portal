export const supportedAuthProviders = ["credentials", "oidc", "ldap", "iap"] as const;
export type SupportedAuthProvider = (typeof supportedAuthProviders)[number];
