import { NextRequest, NextResponse } from "next/server";
import { assertFeature, type GritSession } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { csvResponse } from "@/lib/csv";
import { daysAgo } from "@/lib/format";
import { entitlementResponse, normalizeTier, requireGritContext } from "@/lib/passport";

/**
 * GET /api/reports/cogs?from&to[&format=csv] — FIFO cost of goods sold per
 * variant, computed from the drained-lot audit records
 * (`StockLotConsumption`). Requires `inventory.fifo_costing` (SCALE).
 *
 * Rows with `lotId = null` are fallback-costed consumption (no open lot at
 * drain time) and are included, reported via `fallback_units`.
 */
/**
 * Service-to-service auth (grit-reports' margin aggregator): a bearer token
 * timing-safe-equal to GRIT_SERVICE_TOKEN, scoped by ?organization_id=
 * (tenant id equality, same convention as grit-pos /api/reports/revenue).
 * With GRIT_SERVICE_TOKEN unset, any bearer header is rejected outright —
 * it never falls through to the cookie-session path.
 */
async function resolveServiceContext(
  request: NextRequest
): Promise<{ tenantId: string; grit: GritSession } | null | "unauthorized"> {
  const authHeader = request.headers.get("authorization");
  if (authHeader === null) return null;
  const serviceToken = process.env.GRIT_SERVICE_TOKEN;
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!serviceToken || !bearer || !timingSafeEqualStr(bearer, serviceToken)) {
    return "unauthorized";
  }
  const tenantId = request.nextUrl.searchParams.get("organization_id");
  if (!tenantId) return "unauthorized";
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { tier: true, addons: true },
  });
  if (!tenant) return "unauthorized";
  return {
    tenantId,
    grit: {
      userId: "service:grit-reports",
      organizationId: tenantId,
      locationId: null,
      role: "owner",
      email: "service@grit.internal",
      tier: normalizeTier(tenant.tier),
      addons: tenant.addons ?? [],
    },
  };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function GET(request: NextRequest) {
  let grit: GritSession;
  let tenantId: string;

  const service = await resolveServiceContext(request);
  if (service === "unauthorized") {
    return apiError("Unauthenticated", 401);
  } else if (service) {
    grit = service.grit;
    tenantId = service.tenantId;
  } else {
    const ctx = await requireGritContext();
    grit = ctx.grit;
    tenantId = ctx.local.tenantId;
  }

  try {
    assertFeature(grit, "inventory.fifo_costing");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { searchParams } = request.nextUrl;
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const from = fromParam ? new Date(fromParam) : daysAgo(30);
  const to = toParam ? new Date(toParam) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return apiError("Invalid from/to date");
  }
  // Half-open [from, to+1day) so a bare "YYYY-MM-DD" `to` (parsed at
  // midnight) still includes consumption recorded later that same day —
  // matches the convention in grit-pos's /api/reports/revenue.
  const toExclusive = toParam
    ? new Date(to.getTime() + 24 * 60 * 60 * 1000)
    : to;

  const consumptions = await db.stockLotConsumption.findMany({
    where: {
      tenantId,
      createdAt: { gte: from, lt: toExclusive },
    },
    include: {
      movement: { select: { reason: true } },
    },
  });

  const variantIds = [...new Set(consumptions.map((c) => c.variantId))];
  const variants = await db.variant.findMany({
    where: { id: { in: variantIds } },
    include: { product: { select: { name: true } } },
  });
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const byVariant = new Map<
    string,
    { units: number; cost: number; fallbackUnits: number }
  >();
  const byDay = new Map<string, number>();
  for (const c of consumptions) {
    // Transfers move cost between stores; they are not cost of goods SOLD.
    if (c.movement.reason === "transfer_out") continue;
    const agg = byVariant.get(c.variantId) ?? { units: 0, cost: 0, fallbackUnits: 0 };
    agg.units += c.quantity;
    agg.cost += c.quantity * Number(c.unitCost);
    if (c.lotId === null) agg.fallbackUnits += c.quantity;
    byVariant.set(c.variantId, agg);

    const dayKey = c.createdAt.toISOString().slice(0, 10);
    byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + c.quantity * Number(c.unitCost));
  }

  // Continuous per-day series covering every calendar day in [from, toExclusive),
  // including zero-cogs days, so grit-reports can chart a trend line.
  const daily: { date: string; cogs: number }[] = [];
  const lastDayMs = toExclusive.getTime() - 1;
  if (lastDayMs >= from.getTime()) {
    const cursor = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())
    );
    const lastDay = new Date(lastDayMs);
    const endCursor = new Date(
      Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate())
    );
    while (cursor.getTime() <= endCursor.getTime()) {
      const dayKey = cursor.toISOString().slice(0, 10);
      daily.push({ date: dayKey, cogs: Number((byDay.get(dayKey) ?? 0).toFixed(2)) });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  const rows = [...byVariant.entries()]
    .map(([variantId, agg]) => {
      const variant = variantById.get(variantId);
      return {
        sku: variant?.sku ?? variantId,
        product: variant?.product.name ?? "(deleted)",
        variant: variant?.name ?? "(deleted)",
        units_consumed: agg.units,
        fifo_cogs: Number(agg.cost.toFixed(2)),
        avg_unit_cost: agg.units > 0 ? Number((agg.cost / agg.units).toFixed(4)) : 0,
        fallback_units: agg.fallbackUnits,
      };
    })
    .sort((a, b) => b.fifo_cogs - a.fifo_cogs);

  if (searchParams.get("format") === "csv") {
    return csvResponse(rows, `fifo-cogs-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv`);
  }

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    total_cogs: Number(rows.reduce((sum, r) => sum + r.fifo_cogs, 0).toFixed(2)),
    rows,
    daily,
  });
}
