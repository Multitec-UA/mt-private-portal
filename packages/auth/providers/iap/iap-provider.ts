import type Credentials from "@auth/core/providers/credentials";

import { createId } from "@homarr/common";
import { createLogger } from "@homarr/core/infrastructure/logs";
import type { Database, InferInsertModel } from "@homarr/db";
import { and, eq } from "@homarr/db";
import { users } from "@homarr/db/schema";

import { resolveGroupsForEmail } from "./resolve-groups";
import { IAP_ASSERTION_HEADER, IAP_EMAIL_HEADER, verifyIapAssertionAsync } from "./verify-assertion";

const logger = createLogger({ module: "iapProvider" });

type CredentialsConfiguration = Parameters<typeof Credentials>[0];

/**
 * Sign in with the identity Google IAP already proved, and no login form.
 *
 * By the time a request reaches this container, IAP has authenticated the person and
 * refused everyone outside `multitecua.com`. Asking them for a second, weaker password
 * afterwards is not extra security — it is another credential store to keep, reset and
 * eventually leak.
 *
 * **Why a credentials-shaped provider and not an OAuth one.** Auth.js hands `authorize()`
 * the request, which is the only hook in the framework that can read a header. An `oauth`
 * provider would redirect the browser to an identity provider we have already been through.
 * The cost of this shape is that Auth.js does not create a database session for it, so
 * `configuration.ts` mints one by hand — which it already did for `credentials` and `ldap`,
 * and which is why adding `"iap"` to that guard is one of the eight upstream touchpoints.
 *
 * Everything security-relevant lives in `verify-assertion.ts` and `resolve-groups.ts`, both
 * of which are pure functions of their inputs and are tested on their own.
 */
export const createIapConfiguration = (db: Database) =>
  ({
    id: "iap",
    type: "credentials",
    name: "Google IAP",
    // The browser posts nothing. Everything this provider needs is on the request, put
    // there by IAP; an empty credentials object is the honest declaration of that.
    credentials: {},
    // eslint-disable-next-line no-restricted-syntax
    async authorize(_credentials, request) {
      const headers = request.headers;
      const identity = await verifyIapAssertionAsync(
        headers.get(IAP_ASSERTION_HEADER),
        headers.get(IAP_EMAIL_HEADER),
      );

      if (!identity) {
        // verifyIapAssertionAsync has already logged which check refused, with no token in
        // it. Returning null rather than throwing keeps Auth.js's generic failure page.
        return null;
      }

      const { email } = identity;

      let user = await db.query.users.findFirst({
        columns: { id: true, name: true, email: true },
        where: and(eq(users.email, email), eq(users.provider, "iap")),
      });

      if (!user) {
        logger.info("First sign-in for an IAP identity, creating the user", { email });

        const insertUser = {
          id: createId(),
          // The local part is what a member recognises in a members list. The full address
          // is on the record either way, and Homarr shows the name.
          name: email.split("@")[0] ?? email,
          email,
          // IAP would not have issued this assertion for an unverified account.
          emailVerified: new Date(),
          image: null,
          provider: "iap",
        } satisfies InferInsertModel<typeof users>;

        await db.insert(users).values(insertUser);
        user = insertUser;
      }

      const groups = resolveGroupsForEmail(email);

      logger.info("IAP sign-in accepted", { email, groups: groups.length });

      return {
        id: user.id,
        name: user.name,
        email,
        // Read by the sign-in event handler in events.ts, which synchronises membership
        // with whatever this returns. That branch was written for LDAP and never made
        // LDAP-specific, so it costs us no upstream change at all.
        groups,
      };
    },
  }) satisfies CredentialsConfiguration;
