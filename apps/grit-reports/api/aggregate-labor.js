/* grit-reports — api/aggregate-labor.js
 *
 * GET /api/aggregate-labor?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Cross-app labor-efficiency aggregator: POS transaction volume divided by
 * taskboard checklist completion speed, over a date range. HTTP-only
 * cross-app calls (see AGENTS.md), same env vars as aggregate-margins.js:
 *
 *   - GRIT_POS_URL       + GET {GRIT_POS_URL}/api/reports/revenue
 *     Reuses the revenue endpoint's `count` field for transaction volume
 *     (same "may not exist yet" tolerance as aggregate-margins.js: 404/
 *     network error -> upstream.pos = "missing", zeroed count).
 *   - GRIT_TASKBOARD_URL + GET {GRIT_TASKBOARD_URL}/api/ops-tasks?status=done&since=<from>
 *     &organization_id=<session.organizationId>
 *     This endpoint does not exist in apps/grit-taskboard/api yet (checked
 *     at implementation time), so this codes against the documented shape:
 *     an array of task objects with `created_at`/`completed_at` ISO
 *     timestamps (matching the `task.completed` event's data shape in
 *     packages/shared-events/src/contracts.ts). A 404/network error
 *     degrades to upstream.taskboard = "missing" with zeroed stats.
 *
 * Gated behind the custom_reporting addon — see lib/passportVerify.js.
 */

import { sessionFromRequest, hasCustomReportingAddon } from "../lib/passportVerify.js";
import { fetchUpstream } from "../lib/upstreamFetch.js";
import { jsonResponse, parseDateRange } from "../lib/http.js";

/** Accepts either a bare array or `{ tasks: [...] }` — tolerate either shape. */
function extractTasks(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.tasks)) return body.tasks;
  return [];
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
          "The custom_reporting addon is required to use the Grit BizSuite labor aggregator.",
        code: "FEATURE_NOT_ENTITLED",
        feature: "reports.custom_builder",
      },
      403,
    );
  }

  const { searchParams } = new URL(request.url);
  const { from, to } = parseDateRange(searchParams);
  const serviceToken = process.env.GRIT_SERVICE_TOKEN;

  const [posResult, taskResult] = await Promise.all([
    fetchUpstream(
      process.env.GRIT_POS_URL,
      // grit-pos's bearer-token auth path has no session to scope itself
      // with — it requires `organization_id` explicitly (see route.ts's
      // resolveTenantId). Without it every call 401s and degrades to the
      // "error" marker instead of ever returning data. See
      // aggregate-margins.js for the same fix with fuller rationale.
      `/api/reports/revenue?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
        `&organization_id=${encodeURIComponent(session.organizationId)}`,
      { serviceToken },
    ),
    fetchUpstream(
      process.env.GRIT_TASKBOARD_URL,
      // grit-taskboard's bearer-token auth path has no session to scope
      // itself with — it requires `organization_id` explicitly, same
      // convention as the grit-pos revenue call above.
      `/api/ops-tasks?status=done&since=${encodeURIComponent(from)}` +
        `&organization_id=${encodeURIComponent(session.organizationId)}`,
      { serviceToken },
    ),
  ]);

  const revenueBody = posResult.ok ? posResult.body ?? {} : {};
  const transactionCount =
    posResult.ok && typeof revenueBody.count === "number" ? revenueBody.count : null;

  const tasks = taskResult.ok ? extractTasks(taskResult.body) : [];
  const durationsHours = [];
  for (const task of tasks) {
    const createdAt = typeof task?.created_at === "string" ? Date.parse(task.created_at) : NaN;
    const completedAt =
      typeof task?.completed_at === "string" ? Date.parse(task.completed_at) : NaN;
    if (!Number.isNaN(createdAt) && !Number.isNaN(completedAt) && completedAt >= createdAt) {
      durationsHours.push((completedAt - createdAt) / (1000 * 60 * 60));
    }
  }

  const completedCount = tasks.length;
  const avgCompletionHours =
    durationsHours.length > 0
      ? Number((durationsHours.reduce((sum, h) => sum + h, 0) / durationsHours.length).toFixed(2))
      : null;

  // Efficiency ratio: how many POS transactions were rung up per completed
  // ops task in the window — a rough proxy for staff throughput. Null
  // whenever either side of the ratio isn't computable (upstream missing,
  // or zero completed tasks) rather than dividing by zero / faking a number.
  const efficiencyRatio =
    transactionCount !== null && completedCount > 0
      ? Number((transactionCount / completedCount).toFixed(2))
      : null;

  return jsonResponse({
    from,
    to,
    transactions: { count: transactionCount },
    tasks: { completed_count: completedCount, avg_completion_hours: avgCompletionHours },
    efficiency: {
      transactions_per_completed_task: efficiencyRatio,
      avg_completion_hours: avgCompletionHours,
    },
    upstream: { pos: posResult.marker, taskboard: taskResult.marker },
  });
}
