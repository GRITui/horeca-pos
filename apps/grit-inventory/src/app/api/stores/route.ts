import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasFeatureAccess, assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const STORE_TYPES = ["retail", "warehouse", "service_hub", "kitchen"] as const;

const createStoreSchema = z.object({
  name: z.string().min(1),
  type: z.enum(STORE_TYPES).default("retail"),
});

/**
 * GET /api/stores — the tenant's stores. GROWTH tenants (no
 * `inventory.multi_location`) only ever see their default store, so multiple
 * location tables stay unreadable below SCALE.
 */
export async function GET() {
  const ctx = await requireGritContext();
  const multiLocation = hasFeatureAccess(ctx.grit, "inventory.multi_location");
  const stores = await db.store.findMany({
    where: {
      tenantId: ctx.local.tenantId,
      ...(multiLocation ? {} : { isDefault: true }),
    },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true, type: true, isDefault: true, createdAt: true },
  });
  return NextResponse.json({ stores });
}

/** POST /api/stores — create an additional (non-default) store. SCALE only. */
export async function POST(request: NextRequest) {
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
  const parsed = createStoreSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid store");
  }

  const store = await db.store.create({
    data: {
      tenantId: ctx.local.tenantId,
      name: parsed.data.name,
      type: parsed.data.type,
      isDefault: false,
    },
  });
  return NextResponse.json({ store }, { status: 201 });
}
