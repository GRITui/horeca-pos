import { NextResponse } from "next/server";
import { after } from "next/server";
import { requireTenantId } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import {
  OrderChannel,
  OrderStatus,
  PaymentStatus,
  TenderType,
} from "@/app/generated/prisma/enums";
import { eventItemSku, publishTransactionCompleted, type CompletedOrderLine } from "@/lib/events";
import { checkVelocitySurge } from "@/lib/velocity";
import { errorResponse, HttpError, readJsonBody } from "../_lib/http";
import {
  computeOrderDiscount,
  computeOrderVat,
  findOrderForTenant,
  orderInclude,
  serializeOrder,
  type OrderWithRelations,
} from "../_lib/queries";
import { computeLineTotal, computeUnitPrice, parseMoneyInput, sumDecimals } from "../_lib/pricing";
import { evaluatePromotions, normalizeStackingPolicy, type PromotionCartLine } from "@/lib/promotions";

// POST /api/orders/offline-sync
//
// Idempotent replay target for the staff register's offline queue
// (components/pos/offlineQueue.ts). Applies queued ops IN ORDER; every op
// carries a client-generated `externalRef` (uuid) that is persisted on the
// resulting Payment (unique column), so a redelivered batch can never
// double-book a payment — the duplicate op settles as status "duplicate".
//
// Op kinds:
//  - "tender":     record an offline-captured tender against an existing
//                  open/tendered order.
//  - "quick_sale": full offline sale — create order + lines + cash tender in
//                  one op (channel dine_in, no table).
//
// Per-op outcomes are returned as { externalRef, status, orderId?, error? }
// with status "applied" | "duplicate" | "rejected". The client removes ops
// with ANY of those statuses ("rejected" ops would fail identically forever);
// only a transport-level failure leaves the queue untouched.
//
// Orders completed here publish transaction.completed with
// offline_synced: true — after the response, never blocking it.

const MAX_OPS_PER_SYNC = 100;
const MAX_LINES_PER_SALE = 40;
const MAX_QUANTITY = 50;

const OFFLINE_TENDER_TYPES: TenderType[] = [TenderType.cash, TenderType.card, TenderType.qr_pay];

interface RawLine {
  productId?: unknown;
  variantId?: unknown;
  addOnIds?: unknown;
  quantity?: unknown;
}

interface RawOp {
  kind?: unknown;
  externalRef?: unknown;
  orderId?: unknown;
  tenderType?: unknown;
  amount?: unknown;
  lines?: RawLine[];
}

interface SyncResult {
  externalRef: string;
  status: "applied" | "duplicate" | "rejected";
  orderId?: string;
  error?: string;
}

interface CompletedPublish {
  orderId: string;
  totalAmount: number;
  taxAmount: number;
  lines: CompletedOrderLine[];
}

function rejected(externalRef: string, error: string): SyncResult {
  return { externalRef, status: "rejected", error };
}

/**
 * True for a Postgres unique-constraint violation (P2002) — the outcome of
 * losing the check-then-act race against a concurrent request replaying the
 * same externalRef (see the pre-insert dedupe in POST below). Callers should
 * treat this as "duplicate", not a hard failure.
 */
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Looks up the order a given externalRef's Payment already settled onto. */
async function findDuplicateOrderId(externalRef: string): Promise<string | undefined> {
  const dup = await prisma.payment.findUnique({
    where: { externalRef },
    select: { orderId: true },
  });
  return dup?.orderId;
}

function collectEventLines(order: OrderWithRelations): CompletedOrderLine[] {
  return order.lines.map((line) => ({
    productId: line.productId,
    variantSku: line.variant?.sku ?? null,
    quantity: line.quantity,
    unitPrice: Number(line.unitPrice),
  }));
}

/** Applies one offline-captured tender to an existing order. */
async function applyTenderOp(
  tenantId: string,
  op: RawOp,
  externalRef: string,
  completed: CompletedPublish[],
): Promise<SyncResult> {
  if (typeof op.orderId !== "string" || !op.orderId) {
    return rejected(externalRef, "orderId is required for a tender op");
  }
  if (!OFFLINE_TENDER_TYPES.includes(op.tenderType as TenderType)) {
    return rejected(externalRef, `tenderType must be one of: ${OFFLINE_TENDER_TYPES.join(", ")}`);
  }
  let amount;
  try {
    amount = parseMoneyInput(op.amount);
  } catch {
    return rejected(externalRef, "amount must be a positive number");
  }
  if (!amount.isPositive()) {
    return rejected(externalRef, "amount must be greater than zero");
  }

  const orderId = op.orderId;

  // A Postgres row lock on the order (held for the rest of this function's
  // transaction) is required here, not just the externalRef dedupe above:
  // externalRef only protects against replaying the SAME op twice. It does
  // nothing to stop this op racing a DIFFERENT concurrent writer on the same
  // order — a staff-register tender submitted at the register while this
  // synced batch is in flight, or two overlapping offline-sync requests each
  // carrying a distinct externalRef for the same order. Without the lock,
  // both could read the same "not yet fully paid" snapshot and both flip the
  // order to `closed`, double-booking the payment and firing
  // `transaction.completed` twice for one order.
  let outcome: {
    isFullyPaid: boolean;
    subtotal: ReturnType<typeof sumDecimals>;
    amountDue: ReturnType<typeof sumDecimals>;
    order: OrderWithRelations;
  };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;

      const order = await tx.order.findFirst({
        where: { id: orderId, tenantId },
        include: orderInclude,
      });
      if (!order) throw new HttpError(404, "Order not found");
      if (order.status !== OrderStatus.open && order.status !== OrderStatus.tendered) {
        throw new HttpError(409, `Cannot tender an order with status "${order.status}"`);
      }
      if (order.lines.length === 0) {
        throw new HttpError(400, "Cannot tender an empty order");
      }

      const subtotal = sumDecimals(order.lines.map((l) => l.lineTotal));
      const priorPaid = sumDecimals(
        order.payments.filter((p) => p.status === PaymentStatus.succeeded).map((p) => p.amount),
      );
      // "Fully paid" must be judged against subtotal minus the current
      // promotion discount, not the raw subtotal — same reasoning as
      // tender/route.ts's computeOrderDiscount call. Without this, a synced
      // tender on a discounted order can never close (stuck in `tendered`)
      // and the outbound event below would report the undiscounted total.
      const { totalDiscount } = await computeOrderDiscount(tenantId, order.lines);
      const amountDue = subtotal.minus(totalDiscount);
      const isFullyPaid = priorPaid.plus(amount).greaterThanOrEqualTo(amountDue);

      await tx.payment.create({
        data: {
          orderId: order.id,
          tenderType: op.tenderType as TenderType,
          amount,
          status: PaymentStatus.succeeded,
          externalRef,
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: { status: isFullyPaid ? OrderStatus.closed : OrderStatus.tendered },
      });

      return { isFullyPaid, subtotal, amountDue, order };
    });
  } catch (err) {
    if (err instanceof HttpError) return rejected(externalRef, err.message);
    if (isUniqueConstraintError(err)) {
      return { externalRef, status: "duplicate", orderId: await findDuplicateOrderId(externalRef) };
    }
    throw err;
  }

  if (outcome.isFullyPaid) {
    const { vatAmount } = computeOrderVat(outcome.order.lines, outcome.order.tenant.vatRate);
    completed.push({
      orderId: outcome.order.id,
      totalAmount: Number(outcome.amountDue),
      taxAmount: Number(vatAmount),
      lines: collectEventLines(outcome.order),
    });
  }
  return { externalRef, status: "applied", orderId: outcome.order.id };
}

/** Applies one offline quick sale: order + lines + cash tender atomically. */
async function applyQuickSaleOp(
  tenantId: string,
  op: RawOp,
  externalRef: string,
  completed: CompletedPublish[],
): Promise<SyncResult> {
  if (op.tenderType !== TenderType.cash) {
    return rejected(externalRef, "quick_sale supports cash tender only");
  }
  let amount;
  try {
    amount = parseMoneyInput(op.amount);
  } catch {
    return rejected(externalRef, "amount must be a positive number");
  }
  if (!amount.isPositive()) {
    return rejected(externalRef, "amount must be greater than zero");
  }
  const rawLines = op.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0 || rawLines.length > MAX_LINES_PER_SALE) {
    return rejected(externalRef, `lines must contain 1-${MAX_LINES_PER_SALE} entries`);
  }

  // Validate every line against the live catalog — prices are recomputed
  // server-side (never trusted from the queued payload).
  const preparedLines = [];
  for (const raw of rawLines) {
    if (typeof raw?.productId !== "string" || !raw.productId) {
      return rejected(externalRef, "Each line requires a productId");
    }
    const quantity = typeof raw.quantity === "number" ? raw.quantity : 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return rejected(externalRef, `quantity must be an integer between 1 and ${MAX_QUANTITY}`);
    }
    const addOnIds = Array.isArray(raw.addOnIds)
      ? Array.from(new Set(raw.addOnIds.filter((id): id is string => typeof id === "string")))
      : [];

    const product = await prisma.product.findFirst({
      where: { id: raw.productId, tenantId, isActive: true },
      include: { variants: true, addOns: true },
    });
    if (!product) return rejected(externalRef, "Product not found or inactive");

    let variant = null;
    if (typeof raw.variantId === "string" && raw.variantId) {
      variant = product.variants.find((v) => v.id === raw.variantId) ?? null;
      if (!variant) return rejected(externalRef, "Variant does not belong to this product");
    }
    const selectedAddOns = product.addOns.filter((a) => addOnIds.includes(a.id));
    if (selectedAddOns.length !== addOnIds.length) {
      return rejected(externalRef, "One or more add-ons do not belong to this product");
    }

    const unitPrice = computeUnitPrice(product.basePrice, variant?.priceDelta);
    preparedLines.push({
      productId: product.id,
      variantId: variant?.id ?? null,
      variantSku: variant?.sku ?? null,
      // Defaults to standard-rated (true) for lines with no variant
      // selected, same default as the Variant model itself.
      vatApplicable: variant?.vatApplicable ?? true,
      quantity,
      unitPrice,
      lineTotal: computeLineTotal(unitPrice, selectedAddOns.map((a) => a.price), quantity),
      addOns: selectedAddOns.map((a) => ({ addOnId: a.id, price: a.price })),
    });
  }

  const subtotal = sumDecimals(preparedLines.map((l) => l.lineTotal));
  // Same discount-aware "fully paid" check as applyTenderOp above — a quick
  // sale is a brand-new order, so there's no prior Payment history to read
  // discounts off of, but the tenant's active promotions (resolved against
  // its synced stacking policy, same as the tender path's computeOrderDiscount)
  // still apply. Tenant is fetched once here (vatRate +
  // discountStackingPolicy together) and reused below for the VAT split,
  // instead of the separate vatRate-only lookup this used to do post-creation.
  const quickSaleCartLines: PromotionCartLine[] = preparedLines.map((l) => ({
    sku: eventItemSku({ productId: l.productId, variantSku: l.variantSku }),
    quantity: l.quantity,
    unitPrice: Number(l.unitPrice),
  }));
  const [activeRules, tenant] = await Promise.all([
    prisma.promotionRule.findMany({ where: { tenantId, isActive: true } }),
    prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { vatRate: true, discountStackingPolicy: true },
    }),
  ]);
  const { totalDiscount: quickSaleDiscount } = evaluatePromotions(
    quickSaleCartLines,
    activeRules,
    normalizeStackingPolicy(tenant.discountStackingPolicy),
  );
  const amountDue = subtotal.minus(quickSaleDiscount);
  const isFullyPaid = amount.greaterThanOrEqualTo(amountDue);

  let created: { id: string };
  try {
    created = await prisma.order.create({
      data: {
        tenantId,
        channel: OrderChannel.dine_in,
        status: isFullyPaid ? OrderStatus.closed : OrderStatus.tendered,
        lines: {
          create: preparedLines.map((line) => ({
            productId: line.productId,
            variantId: line.variantId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            addOns: { create: line.addOns },
          })),
        },
        payments: {
          create: {
            tenderType: TenderType.cash,
            amount,
            status: PaymentStatus.succeeded,
            externalRef,
          },
        },
      },
      select: { id: true },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { externalRef, status: "duplicate", orderId: await findDuplicateOrderId(externalRef) };
    }
    throw err;
  }

  if (isFullyPaid) {
    // `tenant` (vatRate + discountStackingPolicy) was already fetched above
    // for the discount resolution — a brand-new order has no
    // OrderWithRelations fetch to read `order.tenant.vatRate` off of, so
    // reuse that lookup instead of a second one here.
    const { vatAmount } = computeOrderVat(
      preparedLines.map((line) => ({
        lineTotal: line.lineTotal,
        variant: { vatApplicable: line.vatApplicable },
      })),
      tenant.vatRate,
    );
    completed.push({
      orderId: created.id,
      totalAmount: Number(amountDue),
      taxAmount: Number(vatAmount),
      lines: preparedLines.map((line) => ({
        productId: line.productId,
        variantSku: line.variantSku,
        quantity: line.quantity,
        unitPrice: Number(line.unitPrice),
      })),
    });
  }
  return { externalRef, status: "applied", orderId: created.id };
}

export async function POST(request: Request) {
  try {
    const tenantId = await requireTenantId();
    const body = await readJsonBody<{ ops?: RawOp[] }>(request);

    if (!Array.isArray(body.ops) || body.ops.length === 0) {
      throw new HttpError(400, "ops must be a non-empty array");
    }
    if (body.ops.length > MAX_OPS_PER_SYNC) {
      throw new HttpError(400, `No more than ${MAX_OPS_PER_SYNC} ops per sync`);
    }

    const results: SyncResult[] = [];
    const completed: CompletedPublish[] = [];

    for (const op of body.ops) {
      const externalRef = typeof op.externalRef === "string" ? op.externalRef.slice(0, 100) : "";
      if (!externalRef) {
        results.push(rejected(String(op.externalRef ?? ""), "externalRef is required"));
        continue;
      }

      // Idempotency: a Payment already carrying this externalRef means the
      // op landed on a previous (possibly partially-acknowledged) sync.
      const existing = await prisma.payment.findUnique({
        where: { externalRef },
        select: { orderId: true },
      });
      if (existing) {
        results.push({ externalRef, status: "duplicate", orderId: existing.orderId });
        continue;
      }

      if (op.kind === "tender") {
        results.push(await applyTenderOp(tenantId, op, externalRef, completed));
      } else if (op.kind === "quick_sale") {
        results.push(await applyQuickSaleOp(tenantId, op, externalRef, completed));
      } else {
        results.push(rejected(externalRef, `Unknown op kind "${String(op.kind)}"`));
      }
    }

    // Fire-and-forget events AFTER the response: orders that became fully
    // paid here were captured offline, so offline_synced is stamped true.
    if (completed.length > 0) {
      after(async () => {
        for (const done of completed) {
          await publishTransactionCompleted({
            tenantId,
            orderId: done.orderId,
            totalAmount: done.totalAmount,
            taxAmount: done.taxAmount,
            lines: done.lines,
            offlineSynced: true,
          });
        }
        await checkVelocitySurge(tenantId);
      });
    }

    // Reload the last touched order so callers that just synced a single op
    // (e.g. online quick sale) can refresh their UI if they want to.
    const lastApplied = [...results].reverse().find((r) => r.status === "applied" && r.orderId);
    const order = lastApplied?.orderId
      ? await findOrderForTenant(tenantId, lastApplied.orderId)
      : null;

    return NextResponse.json({
      results,
      order: order ? await serializeOrder(order) : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
