/* grit-reports — api/aggregate-margins.js
 *
 * GET /api/aggregate-margins?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Cross-app margin aggregator: POS revenue minus inventory FIFO COGS over a
 * date range. Pulled over HTTP from the sibling apps' own APIs (never a
 * direct cross-database query — see AGENTS.md) using env-configured service
 * endpoints, forwarding GRIT_SERVICE_TOKEN as a bearer token:
 *
 *   - GRIT_POS_URL       + GET {GRIT_POS_URL}/api/reports/revenue
 *     This endpoint may not exist upstream yet — a 404 or network failure
 *     degrades to a zeroed revenue series with upstream.pos = "missing",
 *     never a crash.
 *   - GRIT_INVENTORY_URL + GET {GRIT_INVENTORY_URL}/api/reports/cogs
 *     This one exists today (apps/grit-inventory/src/app/api/reports/cogs/
 *     route.ts) — response shape: { from, to, total_cogs, rows: [{ sku,
 *     product, variant, units_consumed, fifo_cogs, avg_unit_cost,
 *     fallback_units }], daily: [{ date, cogs }] }. `daily` is a continuous
 *     per-calendar-day series (zero-cogs days included) covering
 *     [from, toExclusive), which is what lets `daily[].cogs`/`margin` below
 *     be populated instead of null.
 *
 * Gated behind the custom_reporting addon (Grit Passport JWT, bearer or
 * `grit_passport` cookie) — see lib/passportVerify.js.
 */

import { sessionFromRequest, hasCustomReportingAddon } from "../lib/passportVerify.js";
import { fetchUpstream } from "../lib/upstreamFetch.js";
import { jsonResponse, parseDateRange } from "../lib/http.js";

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export default async function handler(request) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const session = await sessionFromRequest(request);
  if (!session) {
    return jsonResponse(
      { error: "Missing or invalid Grit Passport session.", code: "UNAUTHORIZED" },
      401,
    );
  }
  if (!hasCustomReportingAddon(session)) {
    return jsonResponse(
      {
        error:
          "The custom_reporting addon is required to use the Grit BizSuite margin aggregator.",
        code: "FEATURE_NOT_ENTITLED",
        feature: "reports.custom_builder",
      },
      403,
    );
  }

  const { searchParams } = new URL(request.url);
  const { from, to } = parseDateRange(searchParams);
  const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const serviceToken = process.env.GRIT_SERVICE_TOKEN;
  // Both grit-pos's /api/reports/revenue and grit-inventory's
  // /api/reports/cogs have no session of their own on the bearer-token
  // (service-to-service) auth path — each scopes strictly off an
  // `organization_id` query param (see route.ts's resolveTenantId /
  // resolveServiceContext respectively). Without it every call 401s and the
  // upstream marker becomes "error" (not "missing"), permanently zeroing
  // that side of the aggregate. See lib/passportVerify.js for where
  // session.organizationId comes from.
  const orgQs = `${qs}&organization_id=${encodeURIComponent(session.organizationId)}`;

  const [posResult, inventoryResult] = await Promise.all([
    fetchUpstream(process.env.GRIT_POS_URL, `/api/reports/revenue?${orgQs}`, { serviceToken }),
    fetchUpstream(process.env.GRIT_INVENTORY_URL, `/api/reports/cogs?${orgQs}&format=json`, {
      serviceToken,
    }),
  ]);

  const revenueBody = posResult.ok ? posResult.body ?? {} : {};
  const revenueTotal = posResult.ok
    ? toNumber(revenueBody.total_revenue ?? revenueBody.revenue ?? revenueBody.total, 0)
    : 0;
  const revenueCount =
    posResult.ok && typeof revenueBody.count === "number" ? revenueBody.count : null;
  const revenueDaily = posResult.ok && Array.isArray(revenueBody.daily) ? revenueBody.daily : [];

  const inventoryBody = inventoryResult.ok ? inventoryResult.body ?? {} : {};
  const cogsTotal = inventoryResult.ok ? toNumber(inventoryBody.total_cogs, 0) : 0;
  const cogsRowsCount =
    inventoryResult.ok && Array.isArray(inventoryBody.rows) ? inventoryBody.rows.length : 0;
  const cogsDaily =
    inventoryResult.ok && Array.isArray(inventoryBody.daily) ? inventoryBody.daily : [];

  const marginTotal = Number((revenueTotal - cogsTotal).toFixed(2));
  const marginPct =
    revenueTotal !== 0 ? Number(((marginTotal / revenueTotal) * 100).toFixed(2)) : null;

  // Merge the two upstream daily series by calendar date. grit-inventory's
  // /api/reports/cogs now returns a continuous per-day series (see
  // route.ts), so cogs/margin are populated whenever that upstream call
  // succeeded; they stay null (never a faked even split) when it didn't.
  const revenueByDate = new Map();
  for (const d of revenueDaily) {
    const date = typeof d?.date === "string" ? d.date : typeof d?.day === "string" ? d.day : null;
    if (date === null) continue;
    revenueByDate.set(date, toNumber(d?.revenue ?? d?.total, 0));
  }
  const cogsByDate = new Map();
  for (const d of cogsDaily) {
    if (typeof d?.date !== "string") continue;
    cogsByDate.set(d.date, toNumber(d?.cogs, 0));
  }
  const allDates = [...new Set([...revenueByDate.keys(), ...cogsByDate.keys()])].sort();
  const daily = allDates.map((date) => {
    const revenue = revenueByDate.has(date) ? revenueByDate.get(date) : 0;
    const cogs = inventoryResult.ok ? cogsByDate.get(date) ?? 0 : null;
    const margin = cogs === null ? null : Number((revenue - cogs).toFixed(2));
    return { date, revenue, cogs, margin };
  });

  return jsonResponse({
    from,
    to,
    revenue: { total: Number(revenueTotal.toFixed(2)), count: revenueCount },
    cogs: { total: Number(cogsTotal.toFixed(2)), rows_count: cogsRowsCount },
    margin: { total: marginTotal, pct: marginPct },
    daily,
    upstream: { pos: posResult.marker, inventory: inventoryResult.marker },
  });
}
