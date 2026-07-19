/* grit-reports — lib/http.js
 *
 * Small shared helpers for the aggregator endpoints (api/aggregate-margins.js,
 * api/aggregate-labor.js). Plain Fetch API Response objects — same
 * ESM-without-"type":module convention as apps/grit-taskboard/api.
 */

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isValidDateString(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Resolves `from`/`to` query params, defaulting to the last 30 days
 * (inclusive of today) when absent or unparsable. Dates are passed through
 * as given (not reformatted) so upstream services see the same string the
 * caller sent.
 */
export function parseDateRange(searchParams) {
  const now = new Date();
  const defaultTo = now.toISOString().slice(0, 10);
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  return {
    from: isValidDateString(fromParam) ? fromParam : defaultFrom,
    to: isValidDateString(toParam) ? toParam : defaultTo,
  };
}
