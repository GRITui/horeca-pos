import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { PaymentStatus } from "@/app/generated/prisma/enums";
import { getSession } from "@/lib/auth";
import { errorResponse, HttpError } from "../_lib/http";

// GET /api/reports/revenue?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Cross-app revenue feed. The primary consumer is grit-reports' margin
// aggregator (apps/grit-reports/api/aggregate-margins.js), which calls this
// endpoint server-to-server and parses `revenueBody.revenue`,
// `revenueBody.count`, and `revenueBody.daily[].{date,revenue}` — the
// response shape below matches that read exactly (see the aggregator source
// for the parsing, read-only from this app).
//
// Computed from `succeeded` Payments (by `createdAt`) joined to the tenant's
// Orders, mirroring app/api/reconciliation/_lib/queries.ts's
// computeExpectedTotals — "money collected" is defined the same way
// everywhere in this app: a succeeded Payment row, independent of channel.
//
// Auth — EITHER of:
//   - An existing staff session (horeca_session cookie), scoped to that
//     staff member's own tenant, same as every other app/api/** route
//     (see lib/tenant.ts's requireTenant/requireTenantId pattern).
//   - A service-to-service bearer token: `Authorization: Bearer
//     $GRIT_SERVICE_TOKEN`, for grit-reports' aggregator (which has no staff
//     session of its own). This path is only reachable when GRIT_SERVICE_TOKEN
//     is set — with it unset, ANY bearer header is rejected outright (401),
//     it never silently falls through to the cookie-session check. When the
//     bearer path authenticates, tenant scope comes from the required
//     `?organization_id=<tenant id>` query param, since a bearer caller
//     carries no session to scope itself with.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a "YYYY-MM-DD" string into a Date at UTC midnight. Throws on anything else. */
function parseDateParam(raw: string | null, paramName: string): Date {
  if (!raw || !ISO_DATE_RE.test(raw)) {
    throw new HttpError(400, `${paramName} must be an ISO date string ("YYYY-MM-DD")`);
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${paramName} is not a valid calendar date`);
  }
  return date;
}

/** Renders a Date back to "YYYY-MM-DD" (UTC calendar day). */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolves the tenant to scope this request to, or `null` if neither auth
 * path is satisfied. Never throws — callers turn `null` into a plain 401.
 */
async function resolveTenantId(request: Request): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== null) {
    const serviceToken = process.env.GRIT_SERVICE_TOKEN;
    if (!serviceToken || authHeader !== `Bearer ${serviceToken}`) {
      // A bearer header was sent but didn't match a configured service
      // token (or none is configured at all) — fail closed. Do NOT fall
      // through to the cookie-session check below: a service caller has no
      // session cookie, so falling through would just fail differently, and
      // silently accepting an unconfigured/mismatched bearer would defeat
      // the "unset => disabled" requirement.
      return null;
    }
    const { searchParams } = new URL(request.url);
    const organizationId = searchParams.get("organization_id");
    return organizationId && organizationId.length > 0 ? organizationId : null;
  }

  const session = await getSession();
  return session ? session.tenantId : null;
}

export async function GET(request: Request) {
  try {
    const tenantId = await resolveTenantId(request);
    if (!tenantId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const from = parseDateParam(searchParams.get("from"), "from");
    // Half-open [from, to+1day) range covering `to` as a full inclusive
    // calendar day, same convention as businessDayRange() in
    // app/api/reconciliation/_lib/dates.ts.
    const toParam = parseDateParam(searchParams.get("to"), "to");
    const toExclusive = new Date(toParam.getTime() + 24 * 60 * 60 * 1000);
    if (from > toParam) {
      throw new HttpError(400, "from must not be after to");
    }

    const payments = await prisma.payment.findMany({
      where: {
        status: PaymentStatus.succeeded,
        createdAt: { gte: from, lt: toExclusive },
        order: { tenantId },
      },
      select: { amount: true, createdAt: true },
    });

    const revenue = payments.reduce(
      (sum, p) => sum.plus(p.amount),
      new Prisma.Decimal(0),
    );

    const dailyTotals = new Map<string, { revenue: Prisma.Decimal; count: number }>();
    for (const payment of payments) {
      const day = formatDate(payment.createdAt);
      const bucket = dailyTotals.get(day) ?? { revenue: new Prisma.Decimal(0), count: 0 };
      bucket.revenue = bucket.revenue.plus(payment.amount);
      bucket.count += 1;
      dailyTotals.set(day, bucket);
    }

    const daily = [...dailyTotals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, bucket]) => ({
        date,
        revenue: Number(bucket.revenue.toFixed(2)),
        count: bucket.count,
      }));

    return NextResponse.json({
      from: formatDate(from),
      to: formatDate(toParam),
      revenue: Number(revenue.toFixed(2)),
      tax: 0,
      count: payments.length,
      daily,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
