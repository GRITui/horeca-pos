import "server-only";

import { AuthError, requireAuth, type SessionPayload } from "@/lib/auth";

// ---------------------------------------------------------------------------
// Tenant-scoping helper. Every staff-side Prisma query must filter by
// `tenantId` — centralizing how that id is obtained (from the authenticated
// session, never from client-supplied input) makes it hard to accidentally
// leak data across tenants.
// ---------------------------------------------------------------------------

/**
 * Resolves the current staff session and returns it. Use this at the top of
 * any staff-side route handler / server component so every Prisma call that
 * follows can scope with `where: { tenantId }`.
 *
 * Throws `AuthError` (401) if there is no valid session — callers should let
 * that propagate to a shared error handler, or catch it explicitly.
 */
export async function requireTenant(): Promise<SessionPayload> {
  return requireAuth();
}

/** Convenience shortcut when only the tenantId is needed. */
export async function requireTenantId(): Promise<string> {
  const session = await requireTenant();
  return session.tenantId;
}

export { AuthError };
