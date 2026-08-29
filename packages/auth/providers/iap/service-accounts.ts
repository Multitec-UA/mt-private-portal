import { createLogger } from "@homarr/core/infrastructure/logs";

import { env } from "../../env";

const logger = createLogger({ module: "iapMachines" });

/**
 * The machine identities allowed to administer the portal.
 *
 * **Why this exists.** Sergio, 2026-08-29: *"quiero que obtengas control total de la
 * administración y edición… sin que tenga que yo meterme en la página web"*. Boards,
 * permissions, groups and users are all reachable through Homarr's own tRPC API, and that
 * API accepts a normal session — so the agent needs a way to *hold* one. Everything else
 * about this fork already works that way: the supported interface, never the database.
 *
 * This deliberately supersedes an earlier note in `verify-assertion.ts` which said a
 * service account could not obtain a portal account and that "nothing automated needs one".
 * That was true when it was written and is not true now; the requirement changed, not the
 * reasoning.
 *
 * **Why it is not a hole in the domain check.** Three things narrow it:
 *
 * 1. **Only Google service accounts can ever be listed.** An entry that is not a
 *    `*.gserviceaccount.com` address is dropped and logged, so this can never be used to
 *    smuggle a human address from another Workspace past `AUTH_IAP_HOSTED_DOMAIN` — which
 *    is the precise thing that check exists to stop.
 * 2. **Exact address match**, never a domain or a pattern. Listing one account admits one
 *    account.
 * 3. **IAP still gates the door.** A listed account that is not an IAP member never reaches
 *    this process at all; membership is managed in Terraform
 *    (`settings/multitecweb.yaml`), reviewed like every other change.
 *
 * Empty by default, so a deployment that does not set it behaves exactly as before.
 */

let cached: { raw: string; accounts: Set<string> } | null = null;

/** A Google service account, the only shape this list accepts. */
const isServiceAccountAddress = (email: string) => email.endsWith(".gserviceaccount.com");

const parse = (raw: string): Set<string> => {
  const accounts = new Set<string>();

  for (const entry of raw.split(/[\s,]+/)) {
    const email = entry.trim().toLowerCase();
    if (!email) continue;

    if (!isServiceAccountAddress(email)) {
      // Loud, and dropped rather than honoured. A typo here should not quietly become an
      // authentication bypass for whatever was typed.
      logger.error("Ignoring a non-service-account entry in AUTH_IAP_SERVICE_ACCOUNTS", {
        entry: email,
      });
      continue;
    }

    accounts.add(email);
  }

  return accounts;
};

/**
 * Parsed once per distinct value. Keyed on the raw string rather than a boolean so the
 * tests can change the environment between cases without reaching into module state.
 */
const allowlist = (): Set<string> => {
  const raw = env.AUTH_IAP_SERVICE_ACCOUNTS ?? "";
  if (!cached || cached.raw !== raw) {
    cached = { raw, accounts: parse(raw) };
  }
  return cached.accounts;
};

/**
 * Is this address a configured machine administrator?
 *
 * Callers must pass an address that came out of a **verified** assertion. This answers a
 * question about configuration; it proves nothing on its own.
 */
export const isMachineAdministrator = (email: string): boolean =>
  allowlist().has(email.trim().toLowerCase());

/** Exported for the tests; nothing else should need it. */
export const machineAdministratorsForTests = (): string[] => [...allowlist()];
