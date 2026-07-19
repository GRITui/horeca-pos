import {
  enforceRateLimit,
  handlePreflight,
  INVALID_TABLE_MESSAGE,
  jsonError,
  jsonOk,
} from "@/app/api/public/_utils";
import { resolveTableByToken } from "@/app/api/public/table/_resolve";

// GET /api/public/table/:tableToken
// Resolves a scanned QR token to the (tenant name, table label) pair the
// customer-facing app/t/[tableToken] page needs to render its header.
// Unauthenticated by design — rate limited + CORS-enabled per the M3 spec.

export function OPTIONS() {
  return handlePreflight();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tableToken: string }> },
) {
  const limited = enforceRateLimit(request, { limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { tableToken } = await params;
  const resolved = await resolveTableByToken(tableToken);
  if (!resolved) {
    return jsonError(INVALID_TABLE_MESSAGE, 404);
  }

  return jsonOk({
    table: { label: resolved.label },
    tenant: { name: resolved.tenantName },
  });
}
