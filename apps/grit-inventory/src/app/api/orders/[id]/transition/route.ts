import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/api";
import { InvalidTransitionError, OrderNotFoundError, transitionOrder } from "@/lib/orders";
import { InsufficientStockError } from "@/lib/inventory";
import { OrderStatus } from "@/generated/prisma/client";

const transitionSchema = z.object({
  to: z.enum(Object.values(OrderStatus) as [string, ...string[]]),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession();
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid transition");
  }

  // Grit WMS epic: an order that has a PackTask (i.e. staff opted it into
  // the picking/packing workflow) must finish packing before it can be
  // marked fulfilled. Orders that never got a PackTask are completely
  // unaffected — this is the only change to this route; transitionOrder's
  // core state machine (lib/orders.ts) is untouched.
  if (parsed.data.to === "fulfilled") {
    const packTask = await db.packTask.findFirst({
      where: { orderId: id, tenantId: session.tenantId },
      select: { status: true },
    });
    if (packTask && packTask.status !== "complete") {
      return apiError("This order's pack task must be complete before it can be marked fulfilled", 409);
    }
  }

  try {
    const order = await db.$transaction((tx) =>
      transitionOrder(tx, {
        tenantId: session.tenantId,
        storeId: session.storeId,
        orderId: id,
        to: parsed.data.to as OrderStatus,
        actingUserId: session.sub,
      })
    );
    return NextResponse.json({ order });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return apiError("Order not found", 404);
    if (err instanceof InvalidTransitionError) return apiError(err.message, 409);
    if (err instanceof InsufficientStockError) {
      return apiError(`Insufficient stock for variant ${err.variantId}`, 409);
    }
    throw err;
  }
}
