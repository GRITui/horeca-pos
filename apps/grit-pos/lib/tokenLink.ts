import "server-only";

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { resolveTraits } from "@/lib/traits";

// ---------------------------------------------------------------------------
// Tokenized anonymous access — the mechanism behind QR dine-in table links
// and (later) pickup-order links. Kept generic/minimal on purpose: this
// module only knows how to mint and resolve opaque tokens, not what they
// unlock.
// ---------------------------------------------------------------------------

const TOKEN_BYTES = 24; // 24 random bytes -> 32 url-safe base64 chars

/** Generates a cryptographically random, URL-safe opaque token. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Looks up a Table by its tokenized link. Returns the Table (including its
 * tenantId, so callers can scope subsequent queries) or `null` if the token
 * doesn't match any table — callers should treat that as a generic 404, not
 * leak whether the token was merely malformed vs. genuinely unknown.
 *
 * Plugin-trait gate: when the owning tenant has the "hospitality.tables"
 * trait disabled (lib/traits.ts), the token resolves to `null` too — this is
 * the single choke point through which every QR dine-in surface
 * (app/t/[tableToken] and app/api/public/table/**) resolves a table, so
 * gating here hides the whole feature behind the same generic 404.
 */
export async function verifyTableToken(token: string) {
  if (!token) return null;

  const table = await prisma.table.findUnique({
    where: { token },
    include: { tenant: { select: { enabledTraits: true } } },
  });
  if (!table) return null;
  if (!resolveTraits(table.tenant.enabledTraits).has("hospitality.tables")) {
    return null;
  }

  // Strip the joined tenant so the return keeps the legacy Table shape.
  const { tenant, ...tableOnly } = table;
  void tenant;
  return tableOnly;
}
