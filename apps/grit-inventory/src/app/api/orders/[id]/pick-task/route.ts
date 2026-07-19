import { NextResponse } from "next/server";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { entitlementResponse, requireGritContext } from "@/lib/passport";
import {
  OrderNotFulfillingError,
  PickOrderNotFoundError,
  PickTaskExistsError,
  createPickTask,
} from "@/lib/picking";

/**
 * POST /api/orders/[id]/pick-task — start the scanner-driven picking step
 * for an order in `fulfilling`. SCALE (`inventory.multi_location`), same as
 * the rest of the WMS epic. No ADMIN-role gate: like the order transition
 * route this operates on an order mid-fulfillment and any signed-in staff
 * member running the register/warehouse floor should be able to trigger it.
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
    const pickTask = await db.$transaction((tx) =>
      createPickTask(tx, { tenantId: ctx.local.tenantId, orderId: id, storeId: ctx.local.storeId })
    );
    return NextResponse.json({ pickTask }, { status: 201 });
  } catch (err) {
    if (err instanceof PickOrderNotFoundError) return apiError("Order not found", 404);
    if (err instanceof OrderNotFulfillingError) return apiError(err.message, 409);
    if (err instanceof PickTaskExistsError) return apiError(err.message, 409);
    throw err;
  }
}
