import { env } from "../../env";

/**
 * Which Homarr groups an IAP-authenticated member belongs to.
 *
 * The one rule this file exists to keep: **nothing the browser can influence decides
 * admin-ness.** Not a claim in the assertion, not a header, not a field on the user's own
 * profile. The answer comes from configuration this process was started with, so the worst
 * a malicious member can do is be themselves.
 *
 * Today that configuration is an env allowlist, which is what `minecraft-allowlist` already
 * uses and is enough for a junta of a handful of people. The interface is a function of the
 * email precisely so the Workspace Directory API can replace it later — membership of
 * `junta@multitecua.com` *being* the admin list, with nobody editing an env var to add a
 * board editor. See ADR 0002 §2.
 *
 * Note what the returned names must be: Homarr's sign-in event adds the user to groups that
 * **already exist by name** and removes them from the rest. It never creates a group. So a
 * name that does not exist in Homarr is silently nothing, which is the failure mode to watch
 * for when somebody swears they should be an admin.
 */
export const resolveGroupsForEmail = (email: string): string[] => {
  const groups: string[] = [];

  if (env.AUTH_IAP_ADMIN_EMAILS.includes(email.toLowerCase())) {
    groups.push(env.AUTH_IAP_ADMIN_GROUP);
  }

  if (env.AUTH_IAP_MEMBER_GROUP) {
    groups.push(env.AUTH_IAP_MEMBER_GROUP);
  }

  return groups;
};
