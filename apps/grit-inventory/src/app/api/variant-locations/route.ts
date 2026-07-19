import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { hasRole } from "@/lib/auth";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const createVariantLocationSchema = z.object({
  storeId: z.string().min(1),
  variantId: z.string().min(1),
  code: z.string().min(1),
  zone: z.string().optional(),
  notes: z.string().optional(),
  // Mirrors the schema default (`VariantLocation.isPrimary @default(true)`):
  // the first slot assigned to a variant is primary unless told otherwise.
  isPrimary: z.boolean().default(true),
});

/**
 * GET /api/variant-locations?storeId=&variantId=&sku= — planogram slots for
 * the tenant, optionally filtered by store, variant id, or (barcode-scanner
 * friendly) exact SKU. SCALE only — same location-table visibility gate as
 * `/api/stores` and `/api/transfers`.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const storeId = request.nextUrl.searchParams.get("storeId") ?? undefined;
  const variantId = request.nextUrl.searchParams.get("variantId") ?? undefined;
  const sku = request.nextUrl.searchParams.get("sku") ?? undefined;

  const locations = await db.variantLocation.findMany({
    where: {
      tenantId: ctx.local.tenantId,
      ...(storeId ? { storeId } : {}),
      ...(variantId ? { variantId } : {}),
      ...(sku ? { variant: { sku } } : {}),
    },
    include: {
      variant: { select: { id: true, sku: true, name: true, product: { select: { name: true } } } },
      store: { select: { id: true, name: true } },
    },
    orderBy: [{ isPrimary: "desc" }, { code: "asc" }],
  });

  return NextResponse.json({ locations });
}

/**
 * POST /api/variant-locations — assign a (store, variant) to a planogram
 * slot. `isPrimary=true` is app-level-exclusive: the schema has no partial
 * unique index (documented in README), so we flip any existing primary row
 * for the same (storeId, variantId) to false in the same transaction.
 */
export async function POST(request: NextRequest) {
  const ctx = await requireGritContext();
  const session = ctx.local;
  if (!hasRole(session.role, "ADMIN")) return apiError("Forbidden", 403);
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const body = await request.json().catch(() => null);
  const parsed = createVariantLocationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid location");
  }
  const { storeId, variantId, code, zone, notes, isPrimary } = parsed.data;

  const [store, variant] = await Promise.all([
    db.store.findFirst({ where: { id: storeId, tenantId: session.tenantId } }),
    db.variant.findFirst({ where: { id: variantId, tenantId: session.tenantId } }),
  ]);
  if (!store) return apiError("Store not found", 404);
  if (!variant) return apiError("Variant not found", 404);

  const location = await db.$transaction(async (tx) => {
    if (isPrimary) {
      await tx.variantLocation.updateMany({
        where: { tenantId: session.tenantId, storeId, variantId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    return tx.variantLocation.create({
      data: {
        tenantId: session.tenantId,
        storeId,
        variantId,
        code,
        zone,
        notes,
        isPrimary,
      },
      include: {
        variant: { select: { id: true, sku: true, name: true, product: { select: { name: true } } } },
        store: { select: { id: true, name: true } },
      },
    });
  });

  return NextResponse.json({ location }, { status: 201 });
}
