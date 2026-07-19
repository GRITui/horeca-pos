import "server-only";

import type { GritSession, GritTier } from "@grit/passport";
import { hasFeatureAccess } from "@grit/passport";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Grit Passport bridge (SSO bridge step).
//
// This app keeps its own working login (horeca_session JWT, lib/auth.ts) —
// Passport is NOT a login replacement here. Instead, the existing session is
// DERIVED into a `GritSession` so shared suite machinery (AppSwitcher nav,
// hasFeatureAccess tier gates) works today:
//
//   tenantId -> organizationId        role -> role (same vocabulary)
//   Tenant.tier / Tenant.addons -> tier / addons (loaded fresh per request,
//   not stamped into a token — this app has no Passport cookie yet)
//
// The full SSO step (minting/verifying the shared `grit_passport` cookie via
// createSessionToken/verifySessionToken) replaces this derivation later.
// ---------------------------------------------------------------------------

const TIERS: readonly GritTier[] = ["LITE", "GROWTH", "SCALE"];

function normalizeTier(tier: string | null | undefined): GritTier {
  return TIERS.includes(tier as GritTier) ? (tier as GritTier) : "LITE";
}

/**
 * Derives the suite-wide `GritSession` from the current horeca staff session
 * plus the tenant's commercial columns. Returns null when not logged in.
 */
export async function getGritSession(): Promise<GritSession | null> {
  const session = await getSession();
  if (!session) return null;

  const tenant = await prisma.tenant.findUnique({
    where: { id: session.tenantId },
    select: { tier: true, addons: true },
  });

  return {
    userId: session.userId,
    organizationId: session.tenantId,
    locationId: null,
    // UserRole in this schema is already the unified owner/manager/staff set.
    role: session.role,
    email: session.email,
    tier: normalizeTier(tenant?.tier),
    addons: tenant?.addons ?? [],
  };
}

/** Convenience gate: is this org entitled to a feature (tier + addons)? */
export function sessionHasFeature(session: GritSession | null, feature: string): boolean {
  return session !== null && hasFeatureAccess(session, feature);
}
