import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

/** `PKG-` + a cuid-ish short random token, e.g. `PKG-A1B2C3D4E5`. */
function generateTrackingRef(): string {
  return `PKG-${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

/**
 * POST /api/orders/[id]/parcel-label — generate an internal parcel label.
 * Requires the order's pack task to exist and be `complete` (409
 * otherwise) — labeling happens only after the second (pack) scan pass
 * confirms contents. No real carrier integration: `trackingRef` is
 * self-generated and printed as a simple barcode on an HTML label (see the
 * admin label page), not a certified shipping label.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const order = await db.order.findFirst({
    where: { id, tenantId: ctx.local.tenantId },
    include: { lines: true, packTask: true },
  });
  if (!order) return apiError("Order not found", 404);
  if (!order.packTask || order.packTask.status !== "complete") {
    return apiError("Order's pack task is not complete yet", 409);
  }

  const itemCount = order.lines.reduce((sum, l) => sum + l.quantity, 0);

  // trackingRef is @unique; a collision is astronomically unlikely (10
  // hex-derived base36 chars) but retry a few times defensively rather than
  // ever surfacing a 500 to the picker.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const label = await db.parcelLabel.create({
        data: {
          tenantId: ctx.local.tenantId,
          orderId: order.id,
          trackingRef: generateTrackingRef(),
          toName: order.customerName,
          toAddress: order.customerAddress,
          itemCount,
          createdById: ctx.local.sub,
        },
      });
      return NextResponse.json({ label }, { status: 201 });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
