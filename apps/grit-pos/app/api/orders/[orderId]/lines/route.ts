import { NextResponse } from "next/server";
import { requireTenantId } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { OrderStatus } from "@/app/generated/prisma/enums";
import { errorResponse, HttpError, readJsonBody } from "../../_lib/http";
import { findOrderForTenant, serializeOrder } from "../../_lib/queries";
import { computeLineTotal, computeUnitPrice } from "../../_lib/pricing";

interface AddLineBody {
  productId?: string;
  variantId?: string | null;
  addOnIds?: string[];
  quantity?: number;
}

const MAX_QUANTITY = 50;

/** POST /api/orders/[orderId]/lines — add a product (+variant +add-ons) to an open order. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const tenantId = await requireTenantId();
    const { orderId } = await params;
    const body = await readJsonBody<AddLineBody>(request);

    if (!body.productId || typeof body.productId !== "string") {
      throw new HttpError(400, "productId is required");
    }
    const quantity = body.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      throw new HttpError(400, `quantity must be an integer between 1 and ${MAX_QUANTITY}`);
    }
    const addOnIds = Array.from(new Set(body.addOnIds ?? []));

    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: { id: true, status: true },
    });
    if (!order) {
      throw new HttpError(404, "Order not found");
    }
    if (order.status !== OrderStatus.open) {
      throw new HttpError(409, `Cannot add items to an order with status "${order.status}"`);
    }

    const product = await prisma.product.findFirst({
      where: { id: body.productId, tenantId, isActive: true },
      include: { variants: true, addOns: true },
    });
    if (!product) {
      throw new HttpError(400, "Product not found or inactive");
    }

    let variant: (typeof product.variants)[number] | null = null;
    if (body.variantId) {
      variant = product.variants.find((v) => v.id === body.variantId) ?? null;
      if (!variant) {
        throw new HttpError(400, "Variant does not belong to this product");
      }
    }

    const selectedAddOns = product.addOns.filter((a) => addOnIds.includes(a.id));
    if (selectedAddOns.length !== addOnIds.length) {
      throw new HttpError(400, "One or more add-ons do not belong to this product");
    }

    const unitPrice = computeUnitPrice(product.basePrice, variant?.priceDelta);
    const lineTotal = computeLineTotal(
      unitPrice,
      selectedAddOns.map((a) => a.price),
      quantity,
    );

    await prisma.orderLine.create({
      data: {
        orderId,
        productId: product.id,
        variantId: variant?.id ?? null,
        quantity,
        unitPrice,
        lineTotal,
        addOns: {
          create: selectedAddOns.map((a) => ({ addOnId: a.id, price: a.price })),
        },
      },
    });

    const updated = await findOrderForTenant(tenantId, orderId);
    if (!updated) {
      throw new HttpError(500, "Failed to reload order after adding line");
    }
    return NextResponse.json({ order: await serializeOrder(updated) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
