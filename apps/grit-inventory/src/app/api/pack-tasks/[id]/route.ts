import { NextResponse } from "next/server";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

/** GET /api/pack-tasks/[id] — fetch a pack task with its items. */
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
  const packTask = await db.packTask.findFirst({
    where: { id, tenantId: ctx.local.tenantId },
    include: {
      items: { include: { variant: { select: { sku: true, name: true } } } },
    },
  });
  if (!packTask) return apiError("Pack task not found", 404);

  return NextResponse.json({ packTask });
}
