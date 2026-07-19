import { NextResponse } from "next/server";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { entitlementResponse, requireGritContext } from "@/lib/passport";
import {
  PackOrderNotFoundError,
  PackTaskExistsError,
  PickTaskNotCompleteError,
  createPackTask,
} from "@/lib/packing";

/**
 * POST /api/orders/[id]/pack-task — start the packing step, sourced from the
 * order's already-`complete` pick task. 409 if there is no complete pick
 * task yet, or a pack task already exists.
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

  try {
    const packTask = await db.$transaction((tx) => createPackTask(tx, { tenantId: ctx.local.tenantId, orderId: id }));
    return NextResponse.json({ packTask }, { status: 201 });
  } catch (err) {
    if (err instanceof PackOrderNotFoundError) return apiError("Order not found", 404);
    if (err instanceof PickTaskNotCompleteError) return apiError(err.message, 409);
    if (err instanceof PackTaskExistsError) return apiError(err.message, 409);
    throw err;
  }
}
