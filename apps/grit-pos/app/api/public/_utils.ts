import { NextResponse } from "next/server";
import { rateLimit, type RateLimitOptions } from "@/lib/rateLimit";
import { withCors, corsPreflightResponse } from "@/lib/cors";

// ---------------------------------------------------------------------------
// Shared helpers for the public (unauthenticated) QR-ordering API routes
// under app/api/public/**. Every route here is reachable by an anonymous
// customer's phone browser, so every handler must apply rateLimit() + cors()
// per the M3 spec — these wrappers make that hard to forget.
// ---------------------------------------------------------------------------

/** Generic, tenant-agnostic 404 message for an invalid/unknown table token. */
export const INVALID_TABLE_MESSAGE =
  "This table link is invalid or no longer active. Please ask staff for a fresh QR code.";

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
