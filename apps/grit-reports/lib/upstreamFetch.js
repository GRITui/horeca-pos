/* grit-reports — lib/upstreamFetch.js
 *
 * Cross-app aggregation is HTTP-only — grit-reports never touches another
 * app's database (see AGENTS.md: "never through direct cross-app database
 * queries"). Every upstream call funnels through here so all three call
 * sites (POS revenue x2, inventory COGS, taskboard ops-tasks) degrade the
 * same way:
 *
 *   - env var for the base URL unset  -> marker "unconfigured" (feature is
 *     just inert, no crash — required by the "standalone app" constraint)
 *   - upstream 404 (endpoint not built yet, e.g. grit-pos revenue report)
 *     or a network failure/timeout -> marker "missing"
 *   - any other non-2xx               -> marker "error"
 *   - 2xx with a JSON body            -> marker "ok"
 *
 * Callers zero out the numbers for any non-"ok" marker and surface the
 * marker in the response's `upstream` block so the dashboard can render a
 * "not connected" chip per upstream instead of guessing from empty data.
 */

const DEFAULT_TIMEOUT_MS = 8000;

export async function fetchUpstream(baseUrl, path, options = {}) {
  const { serviceToken, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (!baseUrl) {
    return { configured: false, ok: false, status: null, marker: "unconfigured", body: null, error: null };
  }

  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const headers = {};
  if (serviceToken) headers.authorization = `Bearer ${serviceToken}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 404) {
      return { configured: true, ok: false, status: 404, marker: "missing", body: null, error: null };
    }
    if (!res.ok) {
      return {
        configured: true,
        ok: false,
        status: res.status,
        marker: "error",
        body: null,
        error: `upstream responded ${res.status}`,
      };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { configured: true, ok: false, status: res.status, marker: "error", body: null, error: "invalid JSON body" };
    }
    return { configured: true, ok: true, status: res.status, marker: "ok", body, error: null };
  } catch (err) {
    // Network error, DNS failure, timeout/abort — all treated as "missing"
    // per spec, same as a 404: the upstream feature simply isn't there yet.
    return {
      configured: true,
      ok: false,
      status: null,
      marker: "missing",
      body: null,
      error: err && err.message ? err.message : "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}
