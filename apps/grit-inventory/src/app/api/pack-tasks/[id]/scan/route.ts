import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { entitlementResponse, requireGritContext } from "@/lib/passport";
import { PackSkuNotFoundError, PackTaskNotFoundError, scanPackItem } from "@/lib/packing";

const scanSchema = z.object({ sku: z.string().min(1) });

/** POST /api/pack-tasks/[id]/scan — record one scanned unit by SKU. */
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
    const packTask = await db.$transaction((tx) =>
      scanPackItem(tx, { packTaskId: id, sku: parsed.data.sku, tenantId: ctx.local.tenantId })
    );
    return NextResponse.json({ packTask });
  } catch (err) {
    if (err instanceof PackTaskNotFoundError) return apiError("Pack task not found", 404);
    if (err instanceof PackSkuNotFoundError) return apiError(err.message, 409);
    throw err;
  }
}
