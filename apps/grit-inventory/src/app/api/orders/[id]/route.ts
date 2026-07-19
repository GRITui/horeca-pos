import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/api";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession();
  const { id } = await params;

  const order = await db.order.findFirst({
    where: { id, tenantId: session.tenantId },
    include: {
      lines: { include: { variant: true } },
      payments: { orderBy: { createdAt: "desc" } },
      delivery: { include: { statusHistory: { orderBy: { createdAt: "desc" } } } },
      createdBy: { select: { name: true, email: true } },
    },
  });
  if (!order) return apiError("Order not found", 404);
  return NextResponse.json({ order });
}
