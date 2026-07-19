import { NextResponse } from "next/server";
import { rateLimit, type RateLimitOptions } from "@/lib/rateLimit";
import { withCors, corsPreflightResponse } from "@/lib/cors";

// ---------------------------------------------------------------------------
// Shared helpers for the public (unauthenticated) pickup-link API routes
// under app/api/pickup/**. Every route here is reachable by an anonymous
// customer's phone browser, so every handler must apply rateLimit() + cors()
// — these wrappers make that hard to forget. Mirrors the pattern used by
// app/api/public/table/** (M2/M3) for QR dine-in ordering, kept as its own
// copy here so this milestone doesn't reach into files owned by that work.
// ---------------------------------------------------------------------------

/** Generic, tenant-agnostic message for an invalid/unknown pickup link. */
export const INVALID_PICKUP_LINK_MESSAGE =
  "This pickup link is invalid or no longer active. Please double-check the link.";

export function jsonError(message: string, status: number, init?: ResponseInit) {
  return withCors(NextResponse.json({ error: message }, { ...init, status }));
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return withCors(NextResponse.json(data, init));
}

/** Standard OPTIONS preflight handler — re-export this as `OPTIONS` from each route. */
export function handlePreflight() {
  return corsPreflightResponse();
}

/**
 * Applies the shared sliding-window rate limit to `request`. Returns a ready
 * 429 Response (with CORS + Retry-After headers) if the caller should be
 * rejected, or `null` if the request may proceed.
 */
export function enforceRateLimit(
  request: Request,
  options: RateLimitOptions,
): Response | null {
  const result = rateLimit(request, options);
  if (result.success) return null;

  const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return jsonError("Too many requests. Please slow down and try again shortly.", 429, {
    headers: { "Retry-After": String(retryAfterSeconds) },
  });
}
