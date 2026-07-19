import { prisma } from "@/lib/prisma";
import {
  enforceRateLimit,
  handlePreflight,
  INVALID_PICKUP_LINK_MESSAGE,
  jsonError,
  jsonOk,
} from "@/app/api/pickup/_utils";
import { resolveTenantBySlug } from "@/app/api/pickup/_resolve";

// GET /api/pickup/:tenantSlug/order/:orderId
//
// Lets the post-checkout success page poll for confirmation. Stripe confirms
// payment asynchronously via app/api/stripe/webhook/route.ts, so right after
// the redirect back from Stripe the order may still be "open" for a few
// seconds until the webhook lands and flips it to "tendered" — the client
// polls this until it does (or gives up).

export function OPTIONS() {
  return handlePreflight();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tenantSlug: string; orderId: string }> },
) {
  const limited = enforceRateLimit(request, { limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { tenantSlug, orderId } = await params;
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) {
    return jsonError(INVALID_PICKUP_LINK_MESSAGE, 404);
  }

  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId: resolved.id, channel: "pickup_link" },
    include: {
      lines: {
        include: { product: true, variant: true, addOns: { include: { addOn: true } } },
      },
      payments: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) {
    return jsonError("Order not found", 404);
  }

  const lines = order.lines.map((line) => ({
    id: line.id,
    productName: line.product.name,
    variantName: line.variant?.name ?? null,
    quantity: line.quantity,
    unitPrice: Number(line.unitPrice),
    addOns: line.addOns.map((a) => ({ name: a.addOn.name, price: Number(a.price) })),
    lineTotal: Number(line.lineTotal),
  }));
  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);

  return jsonOk({
    order: {
      orderId: order.id,
      status: order.status,
      promisedAt: order.promisedAt ? order.promisedAt.toISOString() : null,
      createdAt: order.createdAt.toISOString(),
      lines,
      total,
      paid: order.payments.some((p) => p.status === "succeeded"),
    },
  });
}
