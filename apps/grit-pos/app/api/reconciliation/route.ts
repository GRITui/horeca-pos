import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { requireTenant } from "@/lib/tenant";
import { errorResponse, HttpError, readJsonBody } from "./_lib/http";
import { businessDayRange, formatBusinessDate, parseBusinessDate } from "./_lib/dates";
import { parseMoneyInput } from "./_lib/money";
import {
  computeExpectedTotals,
  findReconciliationForDate,
  listReconciliationsForTenant,
  serializeReconciliation,
} from "./_lib/queries";

const MAX_NOTES_LENGTH = 2000;

/** GET /api/reconciliation — history of past DailyReconciliation closes for this tenant, newest first. */
export async function GET() {
  try {
    const { tenantId } = await requireTenant();
    const records = await listReconciliationsForTenant(tenantId);
    return NextResponse.json({ reconciliations: records.map(serializeReconciliation) });
  } catch (err) {
    return errorResponse(err);
  }
}

interface CloseReconciliationBody {
  businessDate?: string;
  countedCashTotal?: number | string;
  notes?: string;
}

/**
 * POST /api/reconciliation — closes the till for a business date: computes
 * "expected" totals per tender type server-side from the tenant's own
 * Payment records (never trusted from the client), pairs them with the
 * staff-entered physical cash count, and persists one auditable,
 * never-overwritten DailyReconciliation row.
 *
 * Fails with 409 if this tenant+businessDate has already been closed —
 * closing is a one-time event per business day, not an editable draft.
 */
export async function POST(request: Request) {
  try {
    const session = await requireTenant();
    const tenantId = session.tenantId;
    const body = await readJsonBody<CloseReconciliationBody>(request);

    let businessDate: Date;
    try {
      businessDate = parseBusinessDate(body.businessDate);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }

    let countedCashTotal;
    try {
      countedCashTotal = parseMoneyInput(body.countedCashTotal);
    } catch {
      throw new HttpError(400, "countedCashTotal must be a numeric amount");
    }
    if (countedCashTotal.isNegative()) {
      throw new HttpError(400, "countedCashTotal cannot be negative");
    }

    const notes =
      typeof body.notes === "string" && body.notes.trim().length > 0
        ? body.notes.trim().slice(0, MAX_NOTES_LENGTH)
        : null;

    const existing = await findReconciliationForDate(tenantId, businessDate);
    if (existing) {
      throw new HttpError(
        409,
        `Business date ${formatBusinessDate(businessDate)} has already been closed`,
      );
    }

    const { start, end } = businessDayRange(businessDate);
    const expected = await computeExpectedTotals(tenantId, start, end);

    const created = await prisma.dailyReconciliation.create({
      data: {
        tenantId,
        businessDate,
        expectedCashTotal: expected.cash,
        countedCashTotal,
        cardTotal: expected.card,
        qrPayTotal: expected.qrPay,
        stripeTotal: expected.stripe,
        notes,
        closedByUserId: session.userId,
      },
      include: { closedByUser: { select: { email: true } } },
    });

    return NextResponse.json(
      { reconciliation: serializeReconciliation(created) },
      { status: 201 },
    );
  } catch (err) {
    // Race guard: two concurrent closes for the same tenant+businessDate.
    // The findReconciliationForDate check above handles the common case;
    // this catches the narrow window between that check and the insert.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "This business date has already been closed" },
        { status: 409 },
      );
    }
    return errorResponse(err);
  }
}
