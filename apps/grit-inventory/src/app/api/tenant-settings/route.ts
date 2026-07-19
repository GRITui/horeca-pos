import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";
import { publishDiscountPolicyUpdate } from "@/lib/promotions";

/**
 * Grit BizSuite pivot (discount resolution policy, BACKLOG.md): tenant-wide
 * settings scoped to just `discountStackingPolicy` for now — the promotions
 * admin's "Discount rules" panel reads/writes this. Gated the same way as
 * the rest of the promotions admin (`inventory.multi_location`, SCALE) since
 * this setting only means anything alongside promotion rules; if more
 * tenant-wide settings show up later this can grow into a general
 * tenant-settings resource instead of a single-field one.
 */

const DISCOUNT_STACKING_POLICIES = ["NO_STACKING", "STACK_ALL"] as const;

const updateTenantSettingsSchema = z.object({
  discountStackingPolicy: z.enum(DISCOUNT_STACKING_POLICIES),
});

/** GET /api/tenant-settings — the tenant's current discount-stacking policy. */
export async function GET() {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const tenant = await db.tenant.findUniqueOrThrow({
    where: { id: ctx.local.tenantId },
    select: { discountStackingPolicy: true },
  });
  return NextResponse.json({ discountStackingPolicy: tenant.discountStackingPolicy });
}

/** PATCH /api/tenant-settings — update the discount-stacking policy and
 * publish `discount_policy.updated` so Grit POS picks it up. */
export async function PATCH(request: NextRequest) {
  const ctx = await requireGritContext();
  if (!hasRole(ctx.local.role, "ADMIN")) return apiError("Forbidden", 403);
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const body = await request.json().catch(() => null);
  const parsed = updateTenantSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid settings");
  }

  const tenant = await db.tenant.update({
    where: { id: ctx.local.tenantId },
    data: { discountStackingPolicy: parsed.data.discountStackingPolicy },
    select: { discountStackingPolicy: true },
  });

  await publishDiscountPolicyUpdate(
    ctx.local.tenantId,
    tenant.discountStackingPolicy as "NO_STACKING" | "STACK_ALL"
  );

  return NextResponse.json({ discountStackingPolicy: tenant.discountStackingPolicy });
}
