/**
 * Commercial Core Configurations Matrix — tier and addon feature gating.
 *
 * Tiers gate *what the organization has paid for*; RBAC (src/rbac.ts) gates
 * *who* may use it. `appsForSession` intersects the two.
 *
 *   LITE   → POS only, offline-first. UI panels that touch inventory networks
 *            must be disabled (no inventory features are ever granted).
 *   GROWTH → POS + Inventory with local (single-location) tracking. Reading
 *            multiple location tables (`inventory.multi_location`) and stock
 *            transfers (`inventory.transfers`) remain gated.
 *   SCALE  → the full suite: multi-location, transfers, FIFO costing,
 *            taskboard automation, standard reports.
 *
 * Addons extend a tier. `custom_reporting` grants `reports.custom_builder`
 * (the query-permission pass-through to grit-reports pipelines) and — design
 * decision, see README — also lights up the reports app for GROWTH orgs, so
 * the addon is purchasable below SCALE. On LITE the addon grants nothing:
 * LITE never mounts reports.
 *
 * NOTE: this module is runtime-import-free (type-only imports) so it runs
 * directly under `node --experimental-strip-types` in tests.
 */

import type { GritRole, GritSession, GritTier } from "./session.js";
import type { AppKey } from "./rbac.js";

// -- Tier matrix -------------------------------------------------------------

export interface TierConfig {
  readonly apps: readonly AppKey[];
  readonly features: readonly string[];
}

const LITE_FEATURES = ["pos.checkout", "pos.offline_mode"] as const;

const GROWTH_FEATURES = [...LITE_FEATURES, "inventory.local_tracking"] as const;

const SCALE_FEATURES = [
  ...GROWTH_FEATURES,
  "inventory.multi_location",
  "inventory.transfers",
  "inventory.fifo_costing",
  "taskboard.automation",
  "reports.standard",
] as const;

export const TIER_MATRIX: Record<GritTier, TierConfig> = {
  LITE: {
    apps: ["pos"],
    features: LITE_FEATURES,
  },
  GROWTH: {
    apps: ["pos", "inventory"],
    features: GROWTH_FEATURES,
  },
  SCALE: {
    apps: ["pos", "inventory", "taskboard", "reports"],
    features: SCALE_FEATURES,
  },
};

const TIER_RANK: Record<GritTier, number> = { LITE: 0, GROWTH: 1, SCALE: 2 };

// -- Addons ------------------------------------------------------------------

export interface AddonConfig {
  /** Features the addon grants (only where its apps can actually mount). */
  readonly features: readonly string[];
  /** Apps the addon lights up in addition to the tier's apps. */
  readonly apps: readonly AppKey[];
  /** Minimum tier at which the addon has any effect. */
  readonly minTier: GritTier;
}

export const ADDON_MATRIX: Record<string, AddonConfig> = {
  custom_reporting: {
    features: ["reports.custom_builder"],
    apps: ["reports"],
    minTier: "GROWTH",
  },
};

// -- Entitlement resolution --------------------------------------------------

/** The minimal shape needed for entitlement checks (a `GritSession` fits). */
export interface OrgEntitlements {
  tier: GritTier;
  addons: string[];
}

function activeAddons(org: OrgEntitlements): AddonConfig[] {
  return org.addons
    .map((name) => ADDON_MATRIX[name])
    .filter(
      (addon): addon is AddonConfig =>
        addon !== undefined && TIER_RANK[org.tier] >= TIER_RANK[addon.minTier],
    );
}

/** All apps the organization is commercially entitled to (tier + addons). */
export function appsForOrg(org: OrgEntitlements): AppKey[] {
  const apps = new Set<AppKey>(TIER_MATRIX[org.tier].apps);
  for (const addon of activeAddons(org)) {
    for (const app of addon.apps) apps.add(app);
  }
  return [...apps];
}

/** All features the organization is commercially entitled to (tier + addons). */
export function featuresForOrg(org: OrgEntitlements): string[] {
  const features = new Set<string>(TIER_MATRIX[org.tier].features);
  for (const addon of activeAddons(org)) {
    for (const feature of addon.features) features.add(feature);
  }
  return [...features];
}

/**
 * True when the org's tier + addons grant the feature. Accepts either a full
 * `GritSession` or a bare `{ tier, addons }` (e.g. an org row in an API
 * handler that has no user context).
 */
export function hasFeatureAccess(
  sessionOrOrg: OrgEntitlements,
  feature: string,
): boolean {
  return featuresForOrg(sessionOrOrg).includes(feature);
}

// -- Role ∩ entitlement ------------------------------------------------------

/**
 * MIRROR of `ROLE_APP_ACCESS` in src/rbac.ts — duplicated (not imported) so
 * this module stays runtime-import-free for `node --experimental-strip-types`.
 * The test suite asserts the two stay identical; change both together.
 */
const ROLE_APP_ACCESS_MIRROR: Record<GritRole, readonly AppKey[]> = {
  staff: ["pos", "taskboard"],
  manager: ["pos", "inventory", "taskboard", "reports"],
  owner: ["pos", "inventory", "taskboard", "reports"],
};

/**
 * Apps this user can actually open: the intersection of what the organization
 * pays for (`appsForOrg`) and what the user's role allows (`ROLE_APP_ACCESS`).
 * Drives cross-app navigation (src/nav.ts) and app-level route guards.
 */
export function appsForSession(
  session: Pick<GritSession, "role" | "tier" | "addons">,
): AppKey[] {
  const roleApps = ROLE_APP_ACCESS_MIRROR[session.role];
  return appsForOrg(session).filter((app) => roleApps.includes(app));
}

/** @internal Exported only so tests can assert parity with rbac.ts. */
export const __roleAppAccessMirror = ROLE_APP_ACCESS_MIRROR;

// -- API-middleware guard ----------------------------------------------------

/**
 * Typed error for entitlement failures. API middleware should catch it and
 * translate `status`/`code` into the HTTP response, so upsell UIs can key off
 * `code === "FEATURE_NOT_ENTITLED"`.
 */
export class EntitlementError extends Error {
  readonly name = "EntitlementError";
  readonly status = 403;
  readonly code = "FEATURE_NOT_ENTITLED";
  readonly feature: string;
  readonly tier: GritTier;

  constructor(feature: string, tier: GritTier) {
    super(
      `Feature "${feature}" is not included in the ${tier} tier (or its addons).`,
    );
    this.feature = feature;
    this.tier = tier;
  }
}

/** Throws `EntitlementError` unless the org's tier + addons grant `feature`. */
export function assertFeature(
  sessionOrOrg: OrgEntitlements,
  feature: string,
): void {
  if (!hasFeatureAccess(sessionOrOrg, feature)) {
    throw new EntitlementError(feature, sessionOrOrg.tier);
  }
}
