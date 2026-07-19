/**
 * Role-based access control for Grit BizSuite.
 *
 * Role hierarchy: owner > manager > staff. Roles gate *who* may use an app or
 * action; commercial entitlements (src/entitlements.ts) gate *what the org has
 * paid for*. Both must pass — see `appsForSession` in entitlements.ts.
 *
 * NOTE: this module is runtime-import-free (type-only imports) so it can be
 * executed directly with `node --experimental-strip-types` in tests and
 * mirrored trivially in the no-build plain-JS apps.
 */

import type { GritRole, GritSession } from "./session.js";

// -- App registry ------------------------------------------------------------

export const APP_KEYS = ["pos", "inventory", "taskboard", "reports"] as const;

export type AppKey = (typeof APP_KEYS)[number];

export function isAppKey(value: string): value is AppKey {
  return (APP_KEYS as readonly string[]).includes(value);
}

// -- Role hierarchy ----------------------------------------------------------

const ROLE_RANK: Record<GritRole, number> = {
  staff: 0,
  manager: 1,
  owner: 2,
};

/** True when `role` is at least as privileged as `minRole`. */
export function roleAtLeast(role: GritRole, minRole: GritRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/** Session-level convenience wrapper around `roleAtLeast`. */
export function hasRole(
  session: Pick<GritSession, "role">,
  minRole: GritRole,
): boolean {
  return roleAtLeast(session.role, minRole);
}

// -- Role → app defaults -----------------------------------------------------

/**
 * Which apps each role may open, before commercial entitlements are applied.
 *
 * - staff: operational floor apps only — POS and the taskboard.
 * - manager / owner: everything the organization's tier entitles.
 *
 * KEEP IN SYNC with the private mirror in src/entitlements.ts
 * (`ROLE_APP_ACCESS_MIRROR`) — the entitlements test asserts parity.
 */
export const ROLE_APP_ACCESS: Record<GritRole, readonly AppKey[]> = {
  staff: ["pos", "taskboard"],
  manager: [...APP_KEYS],
  owner: [...APP_KEYS],
};

/** True when the role's defaults allow opening the given app. */
export function roleCanAccessApp(role: GritRole, appKey: AppKey): boolean {
  return ROLE_APP_ACCESS[role].includes(appKey);
}
