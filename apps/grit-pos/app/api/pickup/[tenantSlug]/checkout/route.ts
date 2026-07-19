import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { OrderChannel, OrderStatus } from "@/app/generated/prisma/enums";
import { getStripe } from "@/lib/stripe";
import {
  enforceRateLimit,
  handlePreflight,
  INVALID_PICKUP_LINK_MESSAGE,
  jsonError,
  jsonOk,
} from "@/app/api/pickup/_utils";
import { resolveTenantBySlug } from "@/app/api/pickup/_resolve";

// POST /api/pickup/:tenantSlug/checkout
//
// Validates the submitted cart server-side (never trusting client-supplied
// prices — same approach as the QR order route), opens a new Order in the
// SAME Order/OrderLine model the staff POS and QR flow use (channel:
// "pickup_link", status: "open"), then creates a Stripe Checkout Session for
// it and hands back the hosted checkout URL to redirect the customer to.
//
// The order is confirmed (status -> "tendered", promisedAt set, Payment
// recorded) asynchronously by app/api/stripe/webhook/route.ts once Stripe
// reports the payment as successful — never here, since this response can
// race with (or fire without) the customer actually completing payment.

const MAX_LINES_PER_SUBMIT = 40;
const MAX_QUANTITY_PER_LINE = 20;

// Stripe Checkout Session line items are priced in this currency. No
// per-tenant currency configuration exists yet (see prisma/schema.prisma) —
// tracked as a follow-up, not something to bolt on here.
const CHECKOUT_CURRENCY = "usd";

export function OPTIONS() {
  return handlePreflight();
}

interface CartLineInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
  addOnIds?: string[];
}

function parseCartLines(rawLines: unknown): CartLineInput[] | { error: string } {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return { error: "At least one cart line is required" };
  }
  if (rawLines.length > MAX_LINES_PER_SUBMIT) {
    return { error: `No more than ${MAX_LINES_PER_SUBMIT} lines per submit` };
  }

  const lines: CartLineInput[] = [];
  for (const raw of rawLines) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as Record<string, unknown>).productId !== "string" ||
      typeof (raw as Record<string, unknown>).quantity !== "number"
    ) {
      return { error: "Each line requires productId (string) and quantity (number)" };
    }
    const quantity = (raw as Record<string, unknown>).quantity as number;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_LINE) {
      return { error: `quantity must be an integer between 1 and ${MAX_QUANTITY_PER_LINE}` };
    }
    const variantIdRaw = (raw as Record<string, unknown>).variantId;
    if (variantIdRaw !== undefined && variantIdRaw !== null && typeof variantIdRaw !== "string") {
      return { error: "variantId must be a string when provided" };
    }
    const addOnIdsRaw = (raw as Record<string, unknown>).addOnIds;
    if (addOnIdsRaw !== undefined && !Array.isArray(addOnIdsRaw)) {
      return { error: "addOnIds must be an array when provided" };
    }
    if (addOnIdsRaw && addOnIdsRaw.some((id) => typeof id !== "string")) {
      return { error: "addOnIds must be an array of strings" };
    }

    lines.push({
      productId: (raw as Record<string, unknown>).productId as string,
      variantId: (variantIdRaw as string | null | undefined) ?? null,
      quantity,
      addOnIds: (addOnIdsRaw as string[] | undefined) ?? [],
    });
  }
  return lines;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tenantSlug: string }> },
) {
  const limited = enforceRateLimit(request, { limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const { tenantSlug } = await params;
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) {
    return jsonError(INVALID_PICKUP_LINK_MESSAGE, 404);
  }

  let body: { lines?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const parsedLines = parseCartLines(body.lines);
  if ("error" in parsedLines) {
    return jsonError(parsedLines.error, 400);
  }
  const lines = parsedLines;

  // Look up every referenced product (scoped to this tenant, active only) in
  // one query, then validate every line against it server-side — prices and
  // existence are never trusted from the client.
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, tenantId: resolved.id, isActive: true },
    include: { variants: true, addOns: true },
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  type ValidatedLine = {
    productId: string;
    variantId: string | null;
    quantity: number;
    unitPrice: InstanceType<typeof Prisma.Decimal>;
    lineTotal: InstanceType<typeof Prisma.Decimal>;
    addOns: { addOnId: string; price: InstanceType<typeof Prisma.Decimal> }[];
    checkoutName: string;
  };

  const validatedLines: ValidatedLine[] = [];
  for (const line of lines) {
    const product = productById.get(line.productId);
    if (!product) {
      return jsonError(`Unknown or unavailable product: ${line.productId}`, 400);
    }

    let variant = null;
    if (line.variantId) {
      variant = product.variants.find((v) => v.id === line.variantId) ?? null;
      if (!variant) {
        return jsonError(`Unknown variant for product ${product.name}`, 400);
      }
    }

    const selectedAddOnIds = [...new Set(line.addOnIds)];
    const selectedAddOns = selectedAddOnIds.map((addOnId) => {
      const addOn = product.addOns.find((a) => a.id === addOnId);
      if (!addOn) return null;
      return addOn;
    });
    if (selectedAddOns.some((a) => a === null)) {
      return jsonError(`Unknown add-on for product ${product.name}`, 400);
    }

    const unitPrice = new Prisma.Decimal(product.basePrice).plus(
      variant ? new Prisma.Decimal(variant.priceDelta) : 0,
    );
    const addOnsTotalPerUnit = selectedAddOns.reduce(
      (sum, addOn) => sum.plus(new Prisma.Decimal(addOn!.price)),
      new Prisma.Decimal(0),
    );
    const lineTotal = unitPrice.plus(addOnsTotalPerUnit).times(line.quantity);

    const nameParts = [product.name, variant?.name, ...selectedAddOns.map((a) => a!.name)].filter(
      Boolean,
    );

    validatedLines.push({
      productId: product.id,
      variantId: variant?.id ?? null,
      quantity: line.quantity,
      unitPrice,
      lineTotal,
      addOns: selectedAddOns.map((addOn) => ({
        addOnId: addOn!.id,
        price: new Prisma.Decimal(addOn!.price),
      })),
      checkoutName: nameParts.join(" — "),
    });
  }

  // Create the order (+ lines) up front so it exists even if the customer
  // never completes the Stripe redirect — staff can see/void abandoned
  // pickup orders same as any other open order.
  const orderId = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: { tenantId: resolved.id, channel: OrderChannel.pickup_link, status: OrderStatus.open },
    });

    for (const line of validatedLines) {
      await tx.orderLine.create({
        data: {
          orderId: order.id,
          productId: line.productId,
          variantId: line.variantId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: line.lineTotal,
          addOns: {
            create: line.addOns.map((a) => ({ addOnId: a.addOnId, price: a.price })),
          },
        },
      });
    }

    return order.id;
  });

  const origin = new URL(request.url).origin;

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: validatedLines.map((line) => ({
        quantity: line.quantity,
        price_data: {
          currency: CHECKOUT_CURRENCY,
          product_data: { name: line.checkoutName },
          // Decimal -> integer minor units (cents) for Stripe.
          unit_amount: line.unitPrice.times(100).round().toNumber(),
        },
      })),
      metadata: { orderId, tenantId: resolved.id },
      success_url: `${origin}/pickup/${resolved.slug}/success?orderId=${orderId}`,
      cancel_url: `${origin}/pickup/${resolved.slug}?checkoutCancelled=1`,
    });

    if (!session.url) {
      throw new Error("Stripe did not return a Checkout Session URL");
    }

    return jsonOk({ orderId, checkoutUrl: session.url }, { status: 201 });
  } catch (err) {
    // Don't leave an orphaned, uncheckoutable open order behind if Stripe
    // isn't reachable/configured (e.g. STRIPE_SECRET_KEY unset in this
    // environment) — cancel it so it doesn't show up in the staff POS as a
    // real pending order.
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.cancelled },
    });
    console.error("Failed to create Stripe Checkout Session for pickup order", err);
    return jsonError("Payment processing is currently unavailable. Please try again shortly.", 503);
  }
}
