import { NextResponse } from "next/server";
import { requireTenantId } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { OrderStatus } from "@/app/generated/prisma/enums";
import { errorResponse, HttpError, readJsonBody } from "../../../_lib/http";
import { findOrderForTenant, serializeOrder } from "../../../_lib/queries";
import { computeLineTotal } from "../../../_lib/pricing";

const MAX_QUANTITY = 50;

async function loadOpenOrderLine(tenantId: string, orderId: string, lineId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId },
    select: { id: true, status: true },
  });
  if (!order) {
    throw new HttpError(404, "Order not found");
  }
  if (order.status !== OrderStatus.open) {
    throw new HttpError(409, `Cannot modify items on an order with status "${order.status}"`);
  }

  const line = await prisma.orderLine.findFirst({
    where: { id: lineId, orderId },
    include: { addOns: true },
  });
  if (!line) {
    throw new HttpError(404, "Order line not found");
  }
  return line;
}

interface UpdateLineBody {
  quantity?: number;
}

/** PATCH /api/orders/[orderId]/lines/[lineId] — change a line's quantity. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ orderId: string; lineId: string }> },
) {
  try {
    const tenantId = await requireTenantId();
    const { orderId, lineId } = await params;
    const body = await readJsonBody<UpdateLineBody>(request);

    if (
      typeof body.quantity !== "number" ||
      !Number.isInteger(body.quantity) ||
      body.quantity < 1 ||
      body.quantity > MAX_QUANTITY
    ) {
      throw new HttpError(400, `quantity must be an integer between 1 and ${MAX_QUANTITY}`);
    }

    const line = await loadOpenOrderLine(tenantId, orderId, lineId);
    const unitPrice = line.unitPrice;
    const lineTotal = computeLineTotal(
      unitPrice,
      line.addOns.map((a) => a.price),
      body.quantity,
    );

    await prisma.orderLine.update({
      where: { id: lineId },
      data: { quantity: body.quantity, lineTotal },
    });

    const updated = await findOrderForTenant(tenantId, orderId);
    if (!updated) throw new HttpError(500, "Failed to reload order after updating line");
    return NextResponse.json({ order: await serializeOrder(updated) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/orders/[orderId]/lines/[lineId] — remove a line from an open order. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ orderId: string; lineId: string }> },
) {
  try {
    const tenantId = await requireTenantId();
    const { orderId, lineId } = await params;

    await loadOpenOrderLine(tenantId, orderId, lineId);
    await prisma.orderLine.delete({ where: { id: lineId } });

    const updated = await findOrderForTenant(tenantId, orderId);
    if (!updated) throw new HttpError(500, "Failed to reload order after removing line");
    return NextResponse.json({ order: await serializeOrder(updated) });
  } catch (err) {
    return errorResponse(err);
  }
}
