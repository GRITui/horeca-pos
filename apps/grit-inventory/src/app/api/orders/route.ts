import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiError, requireApiSession } from "@/lib/api";
import { generateOrderNumber } from "@/lib/orders";
import { OrderStatus } from "@/generated/prisma/client";

const ORDER_STATUSES = Object.values(OrderStatus);

const createOrderSchema = z.object({
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  customerAddress: z.string().optional(),
  notes: z.string().optional(),
  lines: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().positive(),
      })
    )
    .min(1, "At least one order line is required"),
});

export async function GET(request: NextRequest) {
  const session = await requireApiSession();
  const statusParam = request.nextUrl.searchParams.get("status");
  const status = ORDER_STATUSES.find((s) => s === statusParam);
  if (statusParam && !status) {
    return apiError(`Invalid status filter: ${statusParam}`);
  }

  const orders = await db.order.findMany({
    where: { tenantId: session.tenantId, ...(status ? { status } : {}) },
    include: { lines: true, delivery: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ orders });
}

const MAX_ORDER_NUMBER_RETRIES = 3;

export async function POST(request: NextRequest) {
  const session = await requireApiSession();
  const body = await request.json().catch(() => null);
  const parsed = createOrderSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid order");
  }
  const { lines, ...customer } = parsed.data;

  const variants = await db.variant.findMany({
    where: { tenantId: session.tenantId, id: { in: lines.map((l) => l.variantId) }, isActive: true },
  });
  const variantById = new Map(variants.map((v) => [v.id, v]));
  for (const line of lines) {
    if (!variantById.has(line.variantId)) {
      return apiError(`Variant ${line.variantId} not found`, 404);
    }
  }

  for (let attempt = 0; attempt < MAX_ORDER_NUMBER_RETRIES; attempt++) {
    try {
      const order = await db.$transaction(async (tx) => {
        const orderNumber = await generateOrderNumber(tx, session.tenantId);
        return tx.order.create({
          data: {
            tenantId: session.tenantId,
            storeId: session.storeId,
            orderNumber,
            status: "pending",
            createdById: session.sub,
            ...customer,
            lines: {
              create: lines.map((line) => {
                const variant = variantById.get(line.variantId)!;
                return {
                  variantId: variant.id,
                  description: `${variant.name} (${variant.sku})`,
                  unitPrice: variant.price,
                  quantity: line.quantity,
                };
              }),
            },
          },
          include: { lines: true },
        });
      });
      return NextResponse.json({ order }, { status: 201 });
    } catch (err: unknown) {
      const isOrderNumberCollision =
        err && typeof err === "object" && "code" in err && err.code === "P2002";
      if (isOrderNumberCollision && attempt < MAX_ORDER_NUMBER_RETRIES - 1) continue;
      throw err;
    }
  }
  throw new Error("Unreachable: order creation loop exited without returning or throwing");
}
