/* Sidekick — lib/cors.js
 *
 * The core-data API (api/clients.js, api/auth-*.js, api/migrate-upload.js)
 * is called cross-origin: GitHub Pages is canonical prod for the app itself
 * (root + the /gym/ mirror, both https://gritui.github.io), while this API
 * only runs on Vercel. Reuses the exact origin allowlist
 * api/line-login-start.js already validates its `returnTo` redirect against
 * — same three deployments, same trust boundary — rather than a wildcard,
 * since these endpoints (unlike the public, unauthenticated booking pilot
 * ones) carry authenticated, tenant-scoped data.
 */
const ALLOWED_ORIGINS = [
  'https://gritui.github.io',
  'https://sidekickz.vercel.app',
];

// Local/dev-only extension, e.g. `http://localhost:8825` while running the
// app against a local dev-server.js mirror of this API — never set in any
// real deployment, so production's allowlist is exactly the two origins
// above regardless of this.
if (process.env.CORS_EXTRA_ORIGIN) ALLOWED_ORIGINS.push(process.env.CORS_EXTRA_ORIGIN);

// Resolves a request's Origin header against the same allowlist CORS uses,
// falling back to the first allowed origin when absent/unrecognized. Shared
// by anything that needs to build a same-origin redirect URL from a
// cross-origin request (e.g. api/billing-checkout.js's Stripe
// success_url/cancel_url) without trusting a client-supplied redirect
// target — same allowlist-not-wildcard trust boundary as CORS itself.
export function resolveOrigin(request) {
  const origin = request.headers.get('origin');
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

// The APP's base URL (origin + path) for a request — NOT the same thing as
// resolveOrigin(): GitHub Pages serves this app from a project path
// (https://gritui.github.io/Sidekickz/), so a redirect built from the bare
// origin lands on gritui.github.io/ — a different site entirely. That's
// exactly what Stripe's success_url/cancel_url/return_url were doing (the
// post-checkout 404 the product re-assessment flagged). APP_ORIGIN is the
// codebase's existing convention for links INTO the app (line-channel
// booking pages, team invite links — see .env.example) and it carries the
// path, so anything not addressed to the Vercel origin itself maps there.
export function appUrl(request) {
  const origin = resolveOrigin(request);
  if (origin === 'https://sidekickz.vercel.app') return origin;
  return process.env.APP_ORIGIN || 'https://gritui.github.io/Sidekickz';
}

export function corsHeaders(request) {
  return {
    'access-control-allow-origin': resolveOrigin(request),
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'vary': 'origin',
  };
}

// Call first in every handler; returns a ready-to-send 204 for an OPTIONS
// preflight, or null for every other method (meaning: keep going).
export function handlePreflight(request) {
  if (request.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
