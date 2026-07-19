import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/api";
import { PaymentMethod } from "@/generated/prisma/client";

const paymentSchema = z.object({
  method: z.enum(Object.values(PaymentMethod) as [string, ...string[]]),
  amount: z.number().positive(),
  reference: z.string().optional(),
});

class OrderNotPendingError extends Error {}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession();
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = paymentSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid payment");
  }

  const order = await db.order.findFirst({
    where: { id, tenantId: session.tenantId },
    include: { lines: true, payments: true },
  });
  if (!order) return apiError("Order not found", 404);
  if (order.status !== "pending") {
    return apiError(`Cannot record payment on a ${order.status} order`, 409);
  }

  const { method, amount, reference } = parsed.data;
  const total = order.lines.reduce((sum, l) => sum + Number(l.unitPrice) * l.quantity, 0);
  const paidSoFar = order.payments
    .filter((p) => p.status === "completed")
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const isFullyPaid = paidSoFar + amount >= total;

  const payment = await db.$transaction(async (tx) => {
    if (isFullyPaid) {
      const updated = await tx.order.updateMany({
        where: { id: order.id, status: "pending" },
        data: { status: "paid" },
      });
      if (updated.count === 0) {
        throw new OrderNotPendingError();
      }
    }
    return tx.payment.create({
      data: {
        orderId: order.id,
        method: method as PaymentMethod,
        status: "completed",
        amount,
        reference,
      },
    });
  }).catch((err) => {
    if (err instanceof OrderNotPendingError) return null;
    throw err;
  });

  if (!payment) {
    return apiError("Cannot record payment on a non-pending order", 409);
  }

  return NextResponse.json({ payment }, { status: 201 });
}
