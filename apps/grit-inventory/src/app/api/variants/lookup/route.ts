import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/api";

/** SKU lookup for the barcode-scanner flow: GET /api/variants/lookup?sku=... */
export async function GET(request: NextRequest) {
  const session = await requireApiSession();
  const sku = request.nextUrl.searchParams.get("sku");
  if (!sku) return apiError("sku query parameter is required");

  const variant = await db.variant.findUnique({
    where: { tenantId_sku: { tenantId: session.tenantId, sku } },
    select: { id: true, sku: true, name: true, productId: true, isActive: true },
  });

  return NextResponse.json({ variant: variant ?? null });
}
