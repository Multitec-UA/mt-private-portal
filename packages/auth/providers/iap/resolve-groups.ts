import { readFile } from "node:fs/promises";

import { createLogger } from "@homarr/core/infrastructure/logs";

import { env } from "../../env";
import { isMachineAdministrator } from "./service-accounts";

const logger = createLogger({ module: "iapGroups" });

/**
 * Which Homarr groups an IAP-authenticated member belongs to.
 *
 * The one rule this file exists to keep: **nothing the browser can influence decides
 * admin-ness.** Not a claim in the assertion, not a header, not a field on the user's own
 * profile. The answer comes from a file this process reads off disk.
 *
 * That file is the membership of a **Google Workspace group** — `homarr-admin@multitecua.com`
 * — exported by a scheduled job and mounted read-only. Sergio asked for it that way on
 * 2026-08-29, and he is right: an env list of addresses means "who can edit the portal" is
 * maintained in Terraform, by whoever remembers, in a place nobody looks. A Workspace group
 * is where the association already manages who is who, and adding somebody to it is
 * something a junta member can do without touching infrastructure.
 *
 * Why a mounted file rather than an API call at login: the portal then holds no Workspace
 * credential at all. A domain-wide-delegated key can impersonate users across the domain,
 * and it has no business living in a web-facing container. The same split the Minecraft
 * allowlist already uses — one job with the credential, one service that just reads bytes.
 *
 * **It fails closed.** If the file is missing, unreadable or malformed, nobody is an admin.
 * The failure is loud in the logs and it self-heals: once the file is readable, the next
 * sign-in grants the group again, because Homarr re-synchronises membership on every login.
 */

interface AdminSource {
  /** Lower-cased member addresses of the admin group. */
  members?: string[];
  /** When the sync job wrote it, for the log line that tells you it has gone stale. */
  syncedAt?: string;
}

interface CacheEntry {
  members: Set<string>;
  readAt: number;
}

let cache: CacheEntry | null = null;

/** Exported for the tests; nothing else should need it. */
export const resetAdminCacheForTests = () => {
  cache = null;
};

const readAdminsAsync = async (): Promise<Set<string>> => {
  const ttlMs = env.AUTH_IAP_ADMIN_CACHE_SECONDS * 1000;
  if (cache && Date.now() - cache.readAt < ttlMs) {
    return cache.members;
  }

  try {
    const raw = await readFile(env.AUTH_IAP_ADMIN_SOURCE, "utf8");
    const parsed = JSON.parse(raw) as AdminSource;
    const members = new Set(
      (parsed.members ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    );

    if (members.size === 0) {
      // Not fatal — a group can legitimately be empty — but it is worth saying out loud,
      // because "nobody is an admin" is indistinguishable from a broken sync at the moment
      // somebody is trying to administer the portal.
      logger.warn("The admin group export lists no members", {
        source: env.AUTH_IAP_ADMIN_SOURCE,
        syncedAt: parsed.syncedAt,
      });
    }

    cache = { members, readAt: Date.now() };
    return members;
  } catch (error) {
    logger.error("Could not read the admin group export — granting nobody admin", {
      source: env.AUTH_IAP_ADMIN_SOURCE,
      detail: error instanceof Error ? error.message : "unknown",
    });
    // Deliberately not cached: a transient read failure should not lock admins out for the
    // whole TTL, and the next sign-in retries.
    return new Set();
  }
};

export const resolveGroupsForEmailAsync = async (email: string): Promise<string[]> => {
  const groups: string[] = [];

  /**
   * A configured machine administrator is an admin without consulting the export, and
   * deliberately so: the export is a mounted file that can be absent, stale or empty, and
   * the agent's whole purpose is to still be able to fix the portal when something like
   * that has gone wrong. It is also not in the export by construction — the sync job drops
   * `.gserviceaccount.com` members, because a service account is not a person who
   * administers the association.
   */
  if (isMachineAdministrator(email)) {
    logger.info("Granting admin to a configured machine administrator", { email });
    return [env.AUTH_IAP_ADMIN_GROUP];
  }

  const admins = await readAdminsAsync();
  if (admins.has(email.toLowerCase())) {
    groups.push(env.AUTH_IAP_ADMIN_GROUP);
  }

  if (env.AUTH_IAP_MEMBER_GROUP) {
    groups.push(env.AUTH_IAP_MEMBER_GROUP);
  }

  return groups;
};
