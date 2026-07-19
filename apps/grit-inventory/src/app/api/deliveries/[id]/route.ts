import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/api";
import { canTransitionDelivery } from "@/lib/deliveries";
import { DeliveryStatus } from "@/generated/prisma/client";

const updateDeliverySchema = z.object({
  status: z.enum(Object.values(DeliveryStatus) as [string, ...string[]]).optional(),
  assignedTo: z.string().optional(),
  note: z.string().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession();
  const { id } = await params;

  const delivery = await db.delivery.findFirst({ where: { id, tenantId: session.tenantId } });
  if (!delivery) return apiError("Delivery not found", 404);

  const body = await request.json().catch(() => null);
  const parsed = updateDeliverySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid update");
  }
  const { status, assignedTo, note } = parsed.data;

  if (status && !canTransitionDelivery(delivery.status, status as DeliveryStatus)) {
    return apiError(`Cannot move delivery from ${delivery.status} to ${status}`, 409);
  }

  const updated = await db.$transaction(async (tx) => {
    const result = await tx.delivery.update({
      where: { id },
      data: {
        ...(status && { status: status as DeliveryStatus }),
        ...(assignedTo !== undefined && { assignedTo }),
        ...(note !== undefined && { notes: note }),
      },
    });
    if (status) {
      await tx.deliveryStatusEvent.create({
        data: { deliveryId: id, status: status as DeliveryStatus, note },
      });
    }
    return result;
  });

  return NextResponse.json({ delivery: updated });
}
