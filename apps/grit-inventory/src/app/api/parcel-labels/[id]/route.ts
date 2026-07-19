import { NextResponse } from "next/server";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

/** GET /api/parcel-labels/[id] — fetch a label (used by the print page as a refresh check). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const label = await db.parcelLabel.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!label) return apiError("Label not found", 404);
  return NextResponse.json({ label });
}

/** PATCH /api/parcel-labels/[id] — mark the label as printed (idempotent, stamps printedAt once). */
export async function PATCH(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const existing = await db.parcelLabel.findFirst({ where: { id, tenantId: ctx.local.tenantId } });
  if (!existing) return apiError("Label not found", 404);

  const label = await db.parcelLabel.update({
    where: { id: existing.id },
    data: { printedAt: existing.printedAt ?? new Date() },
  });
  return NextResponse.json({ label });
}
