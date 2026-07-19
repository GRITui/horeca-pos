import "server-only";

import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { PaymentStatus, TenderType } from "@/app/generated/prisma/enums";
import { formatBusinessDate } from "./dates";

// ---------------------------------------------------------------------------
// Shared "compute expected tender totals" + DailyReconciliation DTO shaping
// for app/api/reconciliation/**.
// ---------------------------------------------------------------------------

export interface ExpectedTotals {
  cash: Prisma.Decimal;
  card: Prisma.Decimal;
  qrPay: Prisma.Decimal;
  stripe: Prisma.Decimal;
}

/**
 * Sums every `succeeded` Payment for the tenant whose `createdAt` falls in
 * [start, end), grouped by tenderType. This is the "expected" side of
 * reconciliation — what our own records say was collected — independent of
 * which channel (dine_in/qr/pickup_link) the underlying order came from,
 * since money collected is money collected regardless of how the order was
 * placed.
 */
export async function computeExpectedTotals(
  tenantId: string,
  start: Date,
  end: Date,
): Promise<ExpectedTotals> {
  const grouped = await prisma.payment.groupBy({
    by: ["tenderType"],
    where: {
      status: PaymentStatus.succeeded,
      createdAt: { gte: start, lt: end },
      order: { tenantId },
    },
    _sum: { amount: true },
  });

  const totals: ExpectedTotals = {
    cash: new Prisma.Decimal(0),
    card: new Prisma.Decimal(0),
    qrPay: new Prisma.Decimal(0),
    stripe: new Prisma.Decimal(0),
  };

  for (const row of grouped) {
    const sum = row._sum.amount ? new Prisma.Decimal(row._sum.amount) : new Prisma.Decimal(0);
    switch (row.tenderType) {
      case TenderType.cash:
        totals.cash = sum;
        break;
      case TenderType.card:
        totals.card = sum;
        break;
      case TenderType.qr_pay:
        totals.qrPay = sum;
        break;
      case TenderType.stripe:
        totals.stripe = sum;
        break;
    }
  }

  return totals;
}

const reconciliationInclude = {
  closedByUser: { select: { email: true } },
} as const satisfies Prisma.DailyReconciliationInclude;

export type DailyReconciliationWithUser = Prisma.DailyReconciliationGetPayload<{
  include: typeof reconciliationInclude;
}>;

export async function listReconciliationsForTenant(
  tenantId: string,
): Promise<DailyReconciliationWithUser[]> {
  return prisma.dailyReconciliation.findMany({
    where: { tenantId },
    include: reconciliationInclude,
    orderBy: { businessDate: "desc" },
  });
}

export async function findReconciliationForDate(
  tenantId: string,
  businessDate: Date,
): Promise<DailyReconciliationWithUser | null> {
  return prisma.dailyReconciliation.findUnique({
    where: { tenantId_businessDate: { tenantId, businessDate } },
    include: reconciliationInclude,
  });
}

// -- DTO shaping ---------------------------------------------------------

export interface ReconciliationDTO {
  id: string;
  tenantId: string;
  businessDate: string;
  expectedCashTotal: number;
  countedCashTotal: number;
  /** countedCashTotal - expectedCashTotal (positive = over, negative = short). */
  cashVariance: number;
  cardTotal: number;
  qrPayTotal: number;
  stripeTotal: number;
  notes: string | null;
  closedByUserId: string;
  closedByEmail: string;
  createdAt: string;
}

export function serializeReconciliation(rec: DailyReconciliationWithUser): ReconciliationDTO {
  const expectedCash = new Prisma.Decimal(rec.expectedCashTotal);
  const countedCash = new Prisma.Decimal(rec.countedCashTotal);

  return {
    id: rec.id,
    tenantId: rec.tenantId,
    businessDate: formatBusinessDate(rec.businessDate),
    expectedCashTotal: Number(expectedCash),
    countedCashTotal: Number(countedCash),
    cashVariance: Number(countedCash.minus(expectedCash)),
    cardTotal: Number(rec.cardTotal),
    qrPayTotal: Number(rec.qrPayTotal),
    stripeTotal: Number(rec.stripeTotal),
    notes: rec.notes,
    closedByUserId: rec.closedByUserId,
    closedByEmail: rec.closedByUser.email,
    createdAt: rec.createdAt.toISOString(),
  };
}
