import { NextResponse } from "next/server";
import { requireTenant } from "@/lib/tenant";
import { errorResponse, HttpError } from "../_lib/http";
import { businessDayRange, formatBusinessDate, parseBusinessDate } from "../_lib/dates";
import { getStripePayoutTotal } from "../_lib/stripePayout";
import {
  computeExpectedTotals,
  findReconciliationForDate,
  serializeReconciliation,
} from "../_lib/queries";

/**
 * GET /api/reconciliation/expected?date=YYYY-MM-DD — a live preview of what
 * closing this business date would record: expected totals per tender type
 * (computed fresh from Payment records, same logic POST /api/reconciliation
 * uses), the Stripe payout cross-check, and whether this date has already
 * been closed. Read-only — never persists anything.
 */
export async function GET(request: Request) {
  try {
    const { tenantId } = await requireTenant();
    const { searchParams } = new URL(request.url);

    let businessDate: Date;
    try {
      businessDate = parseBusinessDate(searchParams.get("date"));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }

    const { start, end } = businessDayRange(businessDate);
    const [expected, stripePayout, existing] = await Promise.all([
      computeExpectedTotals(tenantId, start, end),
      getStripePayoutTotal(tenantId, businessDate),
      findReconciliationForDate(tenantId, businessDate),
    ]);

    return NextResponse.json({
      businessDate: formatBusinessDate(businessDate),
      expected: {
        cash: Number(expected.cash),
        card: Number(expected.card),
        qrPay: Number(expected.qrPay),
        stripe: Number(expected.stripe),
      },
      stripePayout,
      alreadyClosed: existing !== null,
      existingReconciliation: existing ? serializeReconciliation(existing) : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
