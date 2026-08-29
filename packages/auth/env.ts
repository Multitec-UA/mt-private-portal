import { z } from "zod/v4";

import { createBooleanSchema, createDurationSchema, createEnv } from "@homarr/core/infrastructure/env";
import { supportedAuthProviders } from "@homarr/definitions";

const authProvidersSchema = z
  .string()
  .min(1)
  .transform((providers) =>
    providers
      .replaceAll(" ", "")
      .toLowerCase()
      .split(",")
      .filter((provider) => {
        if (supportedAuthProviders.some((supportedProvider) => supportedProvider === provider)) return true;
        else if (!provider)
          console.log("One or more of the entries for AUTH_PROVIDER could not be parsed and/or returned null.");
        else console.log(`The value entered for AUTH_PROVIDER "${provider}" is incorrect.`);
        return false;
      }),
  )
  .default(["credentials"]);

const authProviders = authProvidersSchema.safeParse(process.env.AUTH_PROVIDERS).data ?? [];

export const env = createEnv({
  server: {
    AUTH_LOGOUT_REDIRECT_URL: z.string().url().optional(),
    AUTH_SESSION_EXPIRY_TIME: createDurationSchema("30d"),
    AUTH_PROVIDERS: authProvidersSchema,
    AUTH_COOKIE_PREFIX: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9-_]+$/, "AUTH_COOKIE_PREFIX must only contain letters, numbers, hyphens and underscores")
      .default("homarr"),
    ...(authProviders.includes("oidc")
      ? {
          AUTH_OIDC_ISSUER: z.string().url(),
          AUTH_OIDC_CLIENT_ID: z.string().min(1),
          AUTH_OIDC_CLIENT_SECRET: z.string().min(1),
          AUTH_OIDC_CLIENT_NAME: z.string().min(1).default("OIDC"),
          AUTH_OIDC_AUTO_LOGIN: createBooleanSchema(false),
          AUTH_OIDC_SCOPE_OVERWRITE: z.string().min(1).default("openid email profile groups"),
          AUTH_OIDC_GROUPS_ATTRIBUTE: z.string().default("groups"), // Is used in the signIn event to assign the correct groups, key is from object of decoded id_token
          AUTH_OIDC_GROUPS_LOCAL_MANAGEMENT: createBooleanSchema(false), // When enabled, group memberships of oidc users are managed locally instead of synced from the groups claim
          AUTH_OIDC_NAME_ATTRIBUTE_OVERWRITE: z.string().optional(),
          AUTH_OIDC_FORCE_USERINFO: createBooleanSchema(false),
          AUTH_OIDC_ENABLE_DANGEROUS_ACCOUNT_LINKING: createBooleanSchema(false),
          AUTH_OIDC_ENABLE_DANGEROUS_CREDENTIALS_LINKING: createBooleanSchema(false),
          AUTH_OIDC_TOKEN_ENDPOINT_AUTH_METHOD: z
            .enum(["client_secret_basic", "client_secret_post", "client_secret_jwt", "none"])
            .default("client_secret_basic"),
        }
      : {}),
    ...(authProviders.includes("iap")
      ? {
          // The exact IAP resource string. NO DEFAULT, on purpose: a wrong audience is the
          // one mistake here that fails open in spirit — it would accept assertions minted
          // for a different IAP-protected service. Better to refuse to start.
          // For IAP enabled directly on a Cloud Run service (which is our shape — there is
          // no load balancer) it is:
          //   /projects/<PROJECT_NUMBER>/locations/<REGION>/services/<SERVICE_NAME>
          AUTH_IAP_AUDIENCE: z.string().min(1),
          // Asserted when the assertion carries `hd`, never demanded — a service account's
          // assertion has no `hd` at all. Measured, see docs/multitec/reports/0001.
          AUTH_IAP_HOSTED_DOMAIN: z.string().optional(),
          // Who gets the admin group, and it is NOT a list of addresses.
          //
          // This path is a JSON export of a Google Workspace group's membership, written by
          // a scheduled job and mounted read-only. Sergio's instruction, 2026-08-29: the
          // association already manages who is who in Workspace, and "who can edit the
          // portal" should not be a line in Terraform that somebody has to remember.
          //
          // The portal therefore holds no Workspace credential — a domain-wide-delegated
          // key can impersonate the whole domain and has no business in a web-facing
          // container. Same split as the Minecraft allowlist: one job with the credential,
          // one service reading bytes.
          AUTH_IAP_ADMIN_SOURCE: z.string().min(1).default("/admins/admins.json"),
          // Long enough that a login is not a file read every time, short enough that
          // adding somebody to the Workspace group takes effect while they are still
          // wondering whether it worked.
          AUTH_IAP_ADMIN_CACHE_SECONDS: z.coerce.number().min(0).max(3600).default(60),
          // These must already exist in Homarr — group sync joins existing groups and never
          // creates one, so a name that does not exist is silently nothing.
          AUTH_IAP_ADMIN_GROUP: z.string().min(1).default("admins"),
          AUTH_IAP_MEMBER_GROUP: z.string().optional(),
          // Machine identities allowed to administer the portal, comma-separated, empty by
          // default. Only `*.gserviceaccount.com` addresses are honoured; anything else is
          // dropped and logged, so this cannot be used to walk a human address from another
          // Workspace past AUTH_IAP_HOSTED_DOMAIN. See providers/iap/service-accounts.ts.
          AUTH_IAP_SERVICE_ACCOUNTS: z.string().default(""),
          AUTH_IAP_AUTO_LOGIN: createBooleanSchema(true),
          // An IAP assertion lives ~600s. This is only for clock drift between Google and
          // this container, not a way to accept stale tokens.
          AUTH_IAP_CLOCK_TOLERANCE_SECONDS: z.coerce.number().min(0).max(300).default(30),
        }
      : {}),
    ...(authProviders.includes("ldap")
      ? {
          AUTH_LDAP_URI: z.string().url(),
          AUTH_LDAP_BIND_DN: z.string(),
          AUTH_LDAP_BIND_PASSWORD: z.string(),
          AUTH_LDAP_BASE: z.string(),
          AUTH_LDAP_SEARCH_SCOPE: z.enum(["base", "one", "sub"]).default("base"),
          AUTH_LDAP_USERNAME_ATTRIBUTE: z.string().default("uid"),
          AUTH_LDAP_USER_MAIL_ATTRIBUTE: z.string().default("mail"),
          AUTH_LDAP_USERNAME_FILTER_EXTRA_ARG: z.string().optional(),
          AUTH_LDAP_GROUP_CLASS: z.string().default("groupOfUniqueNames"),
          AUTH_LDAP_GROUP_MEMBER_ATTRIBUTE: z.string().default("member"),
          AUTH_LDAP_GROUP_MEMBER_USER_ATTRIBUTE: z.string().default("dn"),
          AUTH_LDAP_GROUP_FILTER_EXTRA_ARG: z.string().optional(),
        }
      : {}),
  },
  experimental__runtimeEnv: process.env,
});
