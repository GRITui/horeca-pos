import { prisma } from "@/lib/prisma";
import { resolveTraits } from "@/lib/traits";

// ---------------------------------------------------------------------------
// Shared "resolve a :tenantSlug route param into a live Tenant" helper for
// the app/api/pickup/[tenantSlug]/** routes and the app/pickup/[tenantSlug]
// pages. Pickup links are standalone (not table-scoped) so, unlike the QR
// flow's random per-table token, the identifier is the Tenant's own unique
// `slug` — no schema change needed, it already exists on Tenant.
// ---------------------------------------------------------------------------

export interface ResolvedPickupTenant {
  id: string;
  name: string;
  slug: string;
}

/**
 * Resolves a tenant slug to its Tenant. Returns `null` if the slug is
 * missing or doesn't match any tenant. Callers should turn `null` into a
 * generic 404 without hinting at why.
 *
 * Plugin-trait gate: a tenant with the "hospitality.pickup_links" trait
 * disabled (lib/traits.ts) also resolves to `null`, so every pickup surface
 * (app/pickup/** pages and app/api/pickup/** routes) collapses into the same
 * generic 404 when the trait is off.
 */
export async function resolveTenantBySlug(slug: string): Promise<ResolvedPickupTenant | null> {
  if (!slug) return null;

  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, enabledTraits: true },
  });
  if (!tenant) return null;
  if (!resolveTraits(tenant.enabledTraits).has("hospitality.pickup_links")) {
    return null;
  }
  return { id: tenant.id, name: tenant.name, slug: tenant.slug };
}
