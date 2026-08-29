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
          // Who gets the admin group. Server-side only: nothing in the request participates.
          AUTH_IAP_ADMIN_EMAILS: z
            .string()
            .default("")
            .transform((value) =>
              value
                .split(",")
                .map((entry) => entry.trim().toLowerCase())
                .filter(Boolean),
            ),
          // These must already exist in Homarr — group sync joins existing groups and never
          // creates one, so a name that does not exist is silently nothing.
          AUTH_IAP_ADMIN_GROUP: z.string().min(1).default("admins"),
          AUTH_IAP_MEMBER_GROUP: z.string().optional(),
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
