import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const createTransferSchema = z.object({
  fromStoreId: z.string().min(1),
  toStoreId: z.string().min(1),
  note: z.string().optional(),
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().positive(),
      })
    )
    .min(1),
});

/** GET /api/transfers — list the tenant's transfer orders (newest first). */
export async function GET() {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.transfers");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const transfers = await db.stockTransfer.findMany({
    where: { tenantId: ctx.local.tenantId },
    include: {
      items: { include: { variant: { select: { sku: true, name: true } } } },
      fromStore: { select: { id: true, name: true } },
      toStore: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ transfers });
}

/** POST /api/transfers — create a draft transfer order. */
export async function POST(request: NextRequest) {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.transfers");
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const body = await request.json().catch(() => null);
  const parsed = createTransferSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid transfer");
  }
  const { fromStoreId, toStoreId, note, items } = parsed.data;

  if (fromStoreId === toStoreId) {
    return apiError("Source and destination stores must differ");
  }

  const [fromStore, toStore] = await Promise.all([
    db.store.findFirst({ where: { id: fromStoreId, tenantId: ctx.local.tenantId } }),
    db.store.findFirst({ where: { id: toStoreId, tenantId: ctx.local.tenantId } }),
  ]);
  if (!fromStore || !toStore) return apiError("Store not found", 404);

  const variantIds = items.map((i) => i.variantId);
  const variants = await db.variant.findMany({
    where: { id: { in: variantIds }, tenantId: ctx.local.tenantId },
    select: { id: true },
  });
  if (variants.length !== new Set(variantIds).size) {
    return apiError("One or more variants not found", 404);
  }

  const transfer = await db.stockTransfer.create({
    data: {
      tenantId: ctx.local.tenantId,
      fromStoreId,
      toStoreId,
      note,
      createdById: ctx.local.sub,
      items: {
        create: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
      },
    },
    include: { items: true },
  });
  return NextResponse.json({ transfer }, { status: 201 });
}
