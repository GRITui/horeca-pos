import {
  enforceRateLimit,
  handlePreflight,
  INVALID_PICKUP_LINK_MESSAGE,
  jsonError,
  jsonOk,
} from "@/app/api/pickup/_utils";
import { resolveTenantBySlug } from "@/app/api/pickup/_resolve";

// GET /api/pickup/:tenantSlug
// Resolves a standalone pickup link's tenant slug to the tenant name the
// customer-facing app/pickup/[tenantSlug] page needs for its header.
// Unauthenticated by design — no customer login, rate limited + CORS-enabled
// like the QR public routes.

export function OPTIONS() {
  return handlePreflight();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tenantSlug: string }> },
) {
  const limited = enforceRateLimit(request, { limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { tenantSlug } = await params;
  const resolved = await resolveTenantBySlug(tenantSlug);
  if (!resolved) {
    return jsonError(INVALID_PICKUP_LINK_MESSAGE, 404);
  }

  return jsonOk({ tenant: { name: resolved.name, slug: resolved.slug } });
}
