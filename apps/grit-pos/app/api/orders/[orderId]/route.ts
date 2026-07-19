import { NextResponse } from "next/server";
import { requireTenantId } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { OrderStatus } from "@/app/generated/prisma/enums";
import { errorResponse, HttpError, readJsonBody } from "../_lib/http";
import { findOrderForTenant, serializeOrder } from "../_lib/queries";

/** GET /api/orders/[orderId] — full order detail (lines, add-ons, payments, totals). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const tenantId = await requireTenantId();
    const { orderId } = await params;

    const order = await findOrderForTenant(tenantId, orderId);
    if (!order) {
      throw new HttpError(404, "Order not found");
    }
    return NextResponse.json({ order: await serializeOrder(order) });
  } catch (err) {
    return errorResponse(err);
  }
}

interface UpdateOrderBody {
  /** Only supported transition for M2: cancel an order that hasn't started tendering. */
  status?: "cancelled";
}

/** PATCH /api/orders/[orderId] — currently only supports cancelling an open order. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const tenantId = await requireTenantId();
    const { orderId } = await params;
    const body = await readJsonBody<UpdateOrderBody>(request);

    if (body.status !== "cancelled") {
      throw new HttpError(
        400,
        'Unsupported update — only { "status": "cancelled" } is supported here',
      );
    }

    const existing = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw new HttpError(404, "Order not found");
    }
    if (existing.status !== OrderStatus.open) {
      throw new HttpError(
        409,
        `Cannot cancel an order once tendering has started (status: ${existing.status})`,
      );
    }

    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.cancelled },
    });

    const order = await findOrderForTenant(tenantId, orderId);
    return NextResponse.json({ order: order ? await serializeOrder(order) : null });
  } catch (err) {
    return errorResponse(err);
  }
}
