import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { entitlementResponse, requireGritContext } from "@/lib/passport";
import { PickSkuNotFoundError, PickTaskNotFoundError, scanPickItem } from "@/lib/picking";

const scanSchema = z.object({ sku: z.string().min(1) });

/** POST /api/pick-tasks/[id]/scan — record one scanned unit by SKU. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.multi_location");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = scanSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid scan");
  }

  try {
    const pickTask = await db.$transaction((tx) =>
      scanPickItem(tx, { pickTaskId: id, sku: parsed.data.sku, tenantId: ctx.local.tenantId })
    );
    return NextResponse.json({ pickTask });
  } catch (err) {
    if (err instanceof PickTaskNotFoundError) return apiError("Pick task not found", 404);
    if (err instanceof PickSkuNotFoundError) return apiError(err.message, 409);
    throw err;
  }
}
