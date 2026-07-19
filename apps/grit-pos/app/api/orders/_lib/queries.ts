import "server-only";

import { Decimal } from "@prisma/client/runtime/client";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import type {
  OrderChannel,
  OrderStatus,
  PaymentStatus,
  TenderType,
} from "@/app/generated/prisma/enums";
import { eventItemSku } from "@/lib/events";
import { evaluatePromotions, normalizeStackingPolicy, type PromotionCartLine } from "@/lib/promotions";
import { sumDecimals } from "./pricing";

// ---------------------------------------------------------------------------
// Shared "fetch an order the way the staff POS needs it" query + DTO shaping,
// used by every route under app/api/orders/**. Keeping the `include` and the
// serialization in one place means the cart UI always sees the same shape
// whether it just created a line, tendered a payment, or re-fetched the
// order fresh.
// ---------------------------------------------------------------------------

export const orderInclude = {
  table: { select: { id: true, label: true } },
  // vatRate feeds the VAT breakdown below (Tenant-level, not hardcoded).
  tenant: { select: { vatRate: true } },
  lines: {
    orderBy: { id: "asc" },
    include: {
      product: { select: { id: true, name: true } },
      // sku feeds transaction.completed event items (lib/events.ts).
      // vatApplicable feeds the VAT breakdown below (per-item exempt flag).
      variant: { select: { id: true, name: true, sku: true, vatApplicable: true } },
      addOns: {
        include: { addOn: { select: { id: true, name: true } } },
      },
    },
  },
  payments: { orderBy: { createdAt: "asc" } },
} as const satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{
  include: typeof orderInclude;
}>;

export async function findOrderForTenant(tenantId: string, orderId: string) {
  return prisma.order.findFirst({
    where: { id: orderId, tenantId },
    include: orderInclude,
  });
}

export async function listOrdersForTenant(tenantId: string, statuses: OrderStatus[]) {
  return prisma.order.findMany({
    where: { tenantId, status: { in: statuses } },
    include: orderInclude,
    orderBy: { createdAt: "desc" },
  });
}

// -- DTO shaping ---------------------------------------------------------

export interface OrderLineAddOnDTO {
  id: string;
  addOnId: string;
  name: string;
  price: number;
}

export interface OrderLineDTO {
  id: string;
  productId: string;
  productName: string;
  variantId: string | null;
  variantName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  addOns: OrderLineAddOnDTO[];
}

export interface PaymentDTO {
  id: string;
  tenderType: TenderType;
  amount: number;
  status: PaymentStatus;
  createdAt: string;
}

export interface DiscountAppliedDTO {
  ruleId: string;
  name: string;
  amount: number;
}

export interface OrderDTO {
  id: string;
  tenantId: string;
  channel: OrderChannel;
  status: OrderStatus;
  tableId: string | null;
  tableLabel: string | null;
  createdAt: string;
  updatedAt: string;
  lines: OrderLineDTO[];
  payments: PaymentDTO[];
  /** Sum of every line's lineTotal. Line pricing itself is never discounted in place (see OrderLine.unitPrice doc comment) — promotions are applied below as a distinct order-total adjustment. */
  subtotal: number;
  /** Tenant's configured VAT rate (percent, e.g. 7 for Thailand's standard rate) at read time — not hardcoded, see Tenant.vatRate. Backs the `vatAmount`/`subtotalExclVat` split below and the receipt's "VAT (n%)" label. */
  vatRate: number;
  /** `subtotal` minus `vatAmount` — the VAT-exclusive portion of every line (VAT-applicable lines: price / (1 + vatRate/100); VAT-exempt lines: their full lineTotal), derived at read time, never stored, same "derived, not stored" treatment as `subtotal`. */
  subtotalExclVat: number;
  /** Total VAT embedded in VAT-applicable lines' `lineTotal` (prices are VAT-inclusive by default, see Variant.vatApplicable). Zero for lines with `vatApplicable: false`. Feeds `transaction.completed`'s `tax_amount` (lib/events.ts). */
  vatAmount: number;
  /** Portion of `subtotal` contributed by VAT-exempt lines (Variant.vatApplicable === false) — itemized separately per Thai tax-invoice (ใบกำกับภาษี) conventions for mixed carts. 0 when the order has no exempt lines. */
  vatExemptSubtotal: number;
  /** Total of every active PromotionRule that matched the order's current lines (lib/promotions.ts), recomputed on every read (not persisted) — same "derived, not stored" treatment as `subtotal`/`paidTotal`. */
  discountTotal: number;
  /** Per-rule breakdown backing `discountTotal`, for display (e.g. "Promotions" row) and audit. */
  discountsApplied: DiscountAppliedDTO[];
  /** Sum of every `succeeded` payment's amount. */
  paidTotal: number;
  /** max(subtotal - discountTotal - paidTotal, 0) — what's still owed. */
  balanceDue: number;
}

/**
 * Fetches the tenant's currently-active PromotionRule cache rows (synced by
 * app/api/events/grit/route.ts) plus its synced discount-stacking policy
 * (Tenant.discountStackingPolicy), and evaluates them against this order's
 * lines. SKUs are resolved the same way the outbound `transaction.completed`
 * event resolves them (lib/events.ts `eventItemSku`) so promotion scoping and
 * event reporting always agree on what a line's SKU is.
 */
export async function computeOrderDiscount(
  tenantId: string,
  lines: OrderWithRelations["lines"],
): Promise<{ totalDiscount: Decimal; applied: DiscountAppliedDTO[] }> {
  if (lines.length === 0) return { totalDiscount: new Decimal(0), applied: [] };

  const rules = await prisma.promotionRule.findMany({ where: { tenantId, isActive: true } });
  if (rules.length === 0) return { totalDiscount: new Decimal(0), applied: [] };

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { discountStackingPolicy: true },
  });

  const cartLines: PromotionCartLine[] = lines.map((line) => ({
    sku: eventItemSku({ productId: line.productId, variantSku: line.variant?.sku ?? null }),
    quantity: line.quantity,
    unitPrice: Number(line.unitPrice),
  }));

  const { totalDiscount, applied } = evaluatePromotions(
    cartLines,
    rules,
    normalizeStackingPolicy(tenant.discountStackingPolicy),
  );
  return { totalDiscount: new Decimal(totalDiscount), applied };
}

/**
 * Splits each line's VAT-inclusive `lineTotal` into excl-VAT + VAT portions
 * using that line's `Variant.vatApplicable` flag (defaulting to `true` — the
 * same standard-rated default as the Variant model — for lines with no
 * variant selected) and the tenant's `vatRate`, then sums across lines. Same
 * "derived, not stored" treatment as `subtotal`/`discountTotal`. Formula
 * (BACKLOG.md "VAT-inclusive pricing"): exclVat = price / (1 + vatRate/100),
 * vat = price - exclVat for VAT-applicable lines; exempt lines pass their
 * full lineTotal through as excl-VAT with 0 VAT.
 */
/** Minimal per-line shape `computeOrderVat` needs — deliberately looser than `OrderWithRelations["lines"]` so call sites with a narrower Prisma `select` (e.g. app/api/stripe/webhook/route.ts) can reuse it without over-fetching. */
export interface VatComputableLine {
  lineTotal: Decimal;
  variant: { vatApplicable: boolean } | null;
}

export function computeOrderVat(
  lines: VatComputableLine[],
  vatRate: Decimal,
): { subtotalExclVat: Decimal; vatAmount: Decimal; vatExemptSubtotal: Decimal } {
  const divisor = new Decimal(1).plus(vatRate.dividedBy(100));

  let subtotalExclVat = new Decimal(0);
  let vatAmount = new Decimal(0);
  let vatExemptSubtotal = new Decimal(0);

  for (const line of lines) {
    const vatApplicable = line.variant?.vatApplicable ?? true;
    if (vatApplicable) {
      const lineExclVat = line.lineTotal.dividedBy(divisor);
      subtotalExclVat = subtotalExclVat.plus(lineExclVat);
      vatAmount = vatAmount.plus(line.lineTotal.minus(lineExclVat));
    } else {
      subtotalExclVat = subtotalExclVat.plus(line.lineTotal);
      vatExemptSubtotal = vatExemptSubtotal.plus(line.lineTotal);
    }
  }

  return { subtotalExclVat, vatAmount, vatExemptSubtotal };
}

export async function serializeOrder(order: OrderWithRelations): Promise<OrderDTO> {
  const lineTotals = order.lines.map((l) => l.lineTotal);
  const subtotal = sumDecimals(lineTotals);
  const paidTotal = sumDecimals(
    order.payments.filter((p) => p.status === "succeeded").map((p) => p.amount),
  );
  const { totalDiscount, applied } = await computeOrderDiscount(order.tenantId, order.lines);
  const balanceDue = clampNonNegative(subtotal.minus(totalDiscount).minus(paidTotal));
  const { subtotalExclVat, vatAmount, vatExemptSubtotal } = computeOrderVat(
    order.lines,
    order.tenant.vatRate,
  );

  return {
    id: order.id,
    tenantId: order.tenantId,
    channel: order.channel,
    status: order.status,
    tableId: order.tableId,
    tableLabel: order.table?.label ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    lines: order.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      productName: line.product.name,
      variantId: line.variantId,
      variantName: line.variant?.name ?? null,
      quantity: line.quantity,
      unitPrice: Number(line.unitPrice),
      lineTotal: Number(line.lineTotal),
      addOns: line.addOns.map((a) => ({
        id: a.id,
        addOnId: a.addOnId,
        name: a.addOn.name,
        price: Number(a.price),
      })),
    })),
    payments: order.payments.map((p) => ({
      id: p.id,
      tenderType: p.tenderType,
      amount: Number(p.amount),
      status: p.status,
      createdAt: p.createdAt.toISOString(),
    })),
    subtotal: Number(subtotal),
    vatRate: Number(order.tenant.vatRate),
    subtotalExclVat: Number(subtotalExclVat),
    vatAmount: Number(vatAmount),
    vatExemptSubtotal: Number(vatExemptSubtotal),
    discountTotal: Number(totalDiscount),
    discountsApplied: applied,
    paidTotal: Number(paidTotal),
    balanceDue: Number(balanceDue),
  };
}

function clampNonNegative(value: Decimal): Decimal {
  return value.isNegative() ? new Decimal(0) : value;
}
