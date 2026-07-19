import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import {
  enforceRateLimit,
  handlePreflight,
  INVALID_TABLE_MESSAGE,
  jsonError,
  jsonOk,
} from "@/app/api/public/_utils";
import { resolveTableByToken } from "@/app/api/public/table/_resolve";

// GET  /api/public/table/:tableToken/order  -> current open QR order for the table (if any)
// POST /api/public/table/:tableToken/order  -> submit cart lines; creates the
//        table's open QR order on first submit, appends OrderLines to it on
//        every later submit from the same table (matches how a shared table
//        keeps ordering more rounds onto one tab).
//
// This deliberately reuses the same Order/OrderLine/OrderLineAddOn models the
// staff POS (M2) reads from — channel is set to "qr" and tableId to the
// token-resolved table, but it is not a parallel order pipeline.

const MAX_LINES_PER_SUBMIT = 40;
const MAX_QUANTITY_PER_LINE = 20;

export function OPTIONS() {
  return handlePreflight();
}

// -- shared line-item shape used by both the request payload and the response --

interface CartLineInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
  addOnIds?: string[];
}

function serializeOrder(
  order: Prisma.OrderGetPayload<{
    include: {
      lines: {
        include: { product: true; variant: true; addOns: { include: { addOn: true } } };
      };
    };
  }>,
  tableLabel: string,
) {
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

  return {
    orderId: order.id,
    status: order.status,
    tableLabel,
    createdAt: order.createdAt,
    lines,
    total,
  };
}

const orderInclude = {
  lines: {
    include: { product: true, variant: true, addOns: { include: { addOn: true } } },
  },
} satisfies Prisma.OrderInclude;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tableToken: string }> },
) {
  const limited = enforceRateLimit(request, { limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { tableToken } = await params;
  const resolved = await resolveTableByToken(tableToken);
  if (!resolved) {
    return jsonError(INVALID_TABLE_MESSAGE, 404);
  }

  const order = await prisma.order.findFirst({
    where: { tenantId: resolved.tenantId, tableId: resolved.id, channel: "qr", status: "open" },
    orderBy: { createdAt: "desc" },
    include: orderInclude,
  });

  if (!order) {
    return jsonOk({ order: null });
  }

  return jsonOk({ order: serializeOrder(order, resolved.label) });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ tableToken: string }> },
) {
  const limited = enforceRateLimit(request, { limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const { tableToken } = await params;
  const resolved = await resolveTableByToken(tableToken);
  if (!resolved) {
    return jsonError(INVALID_TABLE_MESSAGE, 404);
  }

  let body: { lines?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const rawLines = body.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return jsonError("At least one cart line is required", 400);
  }
  if (rawLines.length > MAX_LINES_PER_SUBMIT) {
    return jsonError(`No more than ${MAX_LINES_PER_SUBMIT} lines per submit`, 400);
  }

  const lines: CartLineInput[] = [];
  for (const raw of rawLines) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as Record<string, unknown>).productId !== "string" ||
      typeof (raw as Record<string, unknown>).quantity !== "number"
    ) {
      return jsonError("Each line requires productId (string) and quantity (number)", 400);
    }
    const quantity = (raw as Record<string, unknown>).quantity as number;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_LINE) {
      return jsonError(`quantity must be an integer between 1 and ${MAX_QUANTITY_PER_LINE}`, 400);
    }
    const variantIdRaw = (raw as Record<string, unknown>).variantId;
    if (variantIdRaw !== undefined && variantIdRaw !== null && typeof variantIdRaw !== "string") {
      return jsonError("variantId must be a string when provided", 400);
    }
    const addOnIdsRaw = (raw as Record<string, unknown>).addOnIds;
    if (addOnIdsRaw !== undefined && !Array.isArray(addOnIdsRaw)) {
      return jsonError("addOnIds must be an array when provided", 400);
    }
    if (addOnIdsRaw && addOnIdsRaw.some((id) => typeof id !== "string")) {
      return jsonError("addOnIds must be an array of strings", 400);
    }

    lines.push({
      productId: (raw as Record<string, unknown>).productId as string,
      variantId: (variantIdRaw as string | null | undefined) ?? null,
      quantity,
      addOnIds: (addOnIdsRaw as string[] | undefined) ?? [],
    });
  }

  // Look up every referenced product (scoped to this table's tenant, active
  // only) in one query, then validate every line against it server-side —
  // prices and existence are never trusted from the client.
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, tenantId: resolved.tenantId, isActive: true },
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

    validatedLines.push({
      productId: product.id,
      variantId: variant?.id ?? null,
      quantity: line.quantity,
      unitPrice,
      lineTotal,
      addOns: selectedAddOns.map((addOn) => ({ addOnId: addOn!.id, price: new Prisma.Decimal(addOn!.price) })),
    });
  }

  const orderId = await prisma.$transaction(async (tx) => {
    const existing = await tx.order.findFirst({
      where: { tenantId: resolved.tenantId, tableId: resolved.id, channel: "qr", status: "open" },
      orderBy: { createdAt: "desc" },
    });

    const order =
      existing ??
      (await tx.order.create({
        data: { tenantId: resolved.tenantId, channel: "qr", tableId: resolved.id, status: "open" },
      }));

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

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: orderInclude,
  });

  return jsonOk({ order: serializeOrder(order, resolved.label) }, { status: 201 });
}
