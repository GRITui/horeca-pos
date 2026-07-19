import { verifyTableToken } from "@/lib/tokenLink";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Shared "resolve a :tableToken route param into a live Table + Tenant"
// helper for the app/api/public/table/[tableToken]/** routes. Centralized so
// every route treats an invalid/unknown token identically (generic not-found,
// no distinguishing info leaked about other tenants/tables).
// ---------------------------------------------------------------------------

export interface ResolvedTable {
  id: string;
  tenantId: string;
  label: string;
  tenantName: string;
}

/**
 * Resolves a table token to its Table + Tenant. Returns `null` if the token
 * is missing, malformed, or doesn't match any table — or if the table's
 * tenant has since been removed. Callers should turn `null` into a generic
 * 404 without hinting at which case it was.
 */
export async function resolveTableByToken(token: string): Promise<ResolvedTable | null> {
  const table = await verifyTableToken(token);
  if (!table) return null;

  const tenant = await prisma.tenant.findUnique({
    where: { id: table.tenantId },
    select: { name: true },
  });
  if (!tenant) return null;

  return {
    id: table.id,
    tenantId: table.tenantId,
    label: table.label,
    tenantName: tenant.name,
  };
}
