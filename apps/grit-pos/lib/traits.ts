import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Plugin traits — optional capability packs resolved per tenant.
//
// The Grit POS core is channel-agnostic checkout (staff register + orders +
// tenders). Everything hospitality- or retail-specific is an optional trait,
// persisted on Tenant.enabledTraits (string[]). Hospitality traits default ON
// (both in the Prisma schema default and in the migration backfill) so
// existing tenants keep exactly today's behavior; retail traits are opt-in.
//
// Gate at entry points only: pages call notFound(), API routes return their
// existing generic 404, and UI sections simply don't render.
// ---------------------------------------------------------------------------

export const TRAIT_KEYS = [
  /** QR dine-in + table ordering: Table records, /t/[token], table pickers. */
  "hospitality.tables",
  /** Standalone pickup links: /pickup/[tenantSlug] + Stripe checkout flow. */
  "hospitality.pickup_links",
  /** Retail multi-variant matrix: variant sku/attributes + attribute pickers. */
  "retail.variant_matrix",
] as const;

export type TraitKey = (typeof TRAIT_KEYS)[number];

export interface TraitDefinition {
  key: TraitKey;
  label: string;
  description: string;
  /** Enabled for tenants that predate the traits column (and new tenants). */
  defaultEnabled: boolean;
}

export const TRAIT_REGISTRY: Record<TraitKey, TraitDefinition> = {
  "hospitality.tables": {
    key: "hospitality.tables",
    label: "Tables & QR dine-in",
    description:
      "Physical tables, QR tokenized table links (/t/…), table ordering API, and the staff table picker.",
    defaultEnabled: true,
  },
  "hospitality.pickup_links": {
    key: "hospitality.pickup_links",
    label: "Pickup links",
    description:
      "Standalone customer pickup ordering (/pickup/…) with Stripe checkout.",
    defaultEnabled: true,
  },
  "retail.variant_matrix": {
    key: "retail.variant_matrix",
    label: "Retail variant matrix",
    description:
      "Multi-attribute child SKUs (size/color/…) with attribute selectors in the register.",
    defaultEnabled: false,
  },
};

export function isTraitKey(value: string): value is TraitKey {
  return (TRAIT_KEYS as readonly string[]).includes(value);
}

/** Traits enabled when a tenant row carries no explicit list. */
export const DEFAULT_ENABLED_TRAITS: readonly TraitKey[] = TRAIT_KEYS.filter(
  (key) => TRAIT_REGISTRY[key].defaultEnabled,
);

/**
 * Normalizes a raw Tenant.enabledTraits value into a Set of known traits.
 * Unknown strings are ignored (forward compatibility); a null/missing value
 * falls back to the hospitality defaults so pre-pivot rows are unchanged.
 */
export function resolveTraits(enabledTraits: string[] | null | undefined): Set<TraitKey> {
  if (!enabledTraits) return new Set(DEFAULT_ENABLED_TRAITS);
  return new Set(enabledTraits.filter(isTraitKey));
}

/**
 * Loads the enabled trait set for a tenant. Returns the defaults if the
 * tenant doesn't exist (callers gating a surface should already have
 * verified the tenant — this just avoids throwing from a gate).
 */
export async function getEnabledTraits(tenantId: string): Promise<Set<TraitKey>> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { enabledTraits: true },
  });
  if (!tenant) return new Set(DEFAULT_ENABLED_TRAITS);
  return resolveTraits(tenant.enabledTraits);
}

/** Single-trait convenience gate. */
export async function tenantHasTrait(tenantId: string, trait: TraitKey): Promise<boolean> {
  const traits = await getEnabledTraits(tenantId);
  return traits.has(trait);
}
