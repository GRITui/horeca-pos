import { NextResponse } from "next/server";
import {
  EntitlementError,
  assertFeature,
  hasFeatureAccess,
  type GritRole,
  type GritSession,
  type GritTier,
} from "@grit/passport";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import type { Role, SessionPayload } from "@/lib/auth";

/**
 * Grit Passport bridge — maps this app's legacy JWT session onto the shared
 * `GritSession` contract so `hasFeatureAccess` / `buildAppNav` /
 * `appsForSession` work unchanged:
 *
 *   tenantId -> organizationId   (tenant id equality — see README)
 *   storeId  -> locationId
 *   OWNER -> owner, ADMIN -> manager, STAFF -> staff
 *
 * `tier` and `addons` live on the local `Tenant` row (additive columns) and
 * are resolved per request.
 */

const LEGACY_ROLE_MAP: Record<Role, GritRole> = {
  OWNER: "owner",
  ADMIN: "manager",
  STAFF: "staff",
};

const VALID_TIERS: readonly GritTier[] = ["LITE", "GROWTH", "SCALE"];

export function normalizeTier(tier: string | null | undefined): GritTier {
  return VALID_TIERS.includes(tier as GritTier) ? (tier as GritTier) : "GROWTH";
}

export function toGritSession(
  local: SessionPayload,
  tenant: { tier: string; addons: string[] }
): GritSession {
  return {
    userId: local.sub,
    organizationId: local.tenantId,
    locationId: local.storeId,
    role: LEGACY_ROLE_MAP[local.role],
    email: local.email,
    name: local.name,
    tier: normalizeTier(tenant.tier),
    addons: tenant.addons ?? [],
  };
}

export interface GritContext {
  local: SessionPayload;
  grit: GritSession;
}

/**
 * Reads the local session cookie and resolves the tenant's tier/addons into
 * a `GritSession`. Returns null when unauthenticated. A missing tenant row
 * degrades to GROWTH with no addons (never crashes a page).
 */
export async function getGritContext(): Promise<GritContext | null> {
  const local = await getSession();
  if (!local) return null;
  let tenant: { tier: string; addons: string[] } | null = null;
  try {
    tenant = await db.tenant.findUnique({
      where: { id: local.tenantId },
      select: { tier: true, addons: true },
    });
  } catch (err) {
    console.warn("[passport] tenant tier lookup failed, defaulting to GROWTH:", err);
  }
  return { local, grit: toGritSession(local, tenant ?? { tier: "GROWTH", addons: [] }) };
}

export async function requireGritContext(): Promise<GritContext> {
  const ctx = await getGritContext();
  if (!ctx) throw new Error("UNAUTHENTICATED");
  return ctx;
}

/** Convenience wrapper: `hasFeatureAccess` against a resolved context. */
export function contextHasFeature(ctx: GritContext, feature: string): boolean {
  return hasFeatureAccess(ctx.grit, feature);
}

/**
 * Translates an `EntitlementError` (from `assertFeature`) into the 403 JSON
 * shape upsell UIs key off; returns null for other errors so callers rethrow.
 */
export function entitlementResponse(err: unknown): NextResponse | null {
  if (err instanceof EntitlementError) {
    return NextResponse.json(
      { error: err.message, code: err.code, feature: err.feature, tier: err.tier },
      { status: 403 }
    );
  }
  return null;
}

/**
 * Store-scope gate: operating on (or reading) any NON-default store requires
 * `inventory.multi_location`. GROWTH tenants are thereby restricted to their
 * default store — multiple location tables stay unreadable. Throws
 * `EntitlementError` (403) when not entitled.
 */
export function assertStoreAccess(grit: GritSession, store: { isDefault: boolean }): void {
  if (!store.isDefault) {
    assertFeature(grit, "inventory.multi_location");
  }
}
