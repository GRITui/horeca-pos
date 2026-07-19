import "server-only";

import { Decimal } from "@prisma/client/runtime/client";

// Local copy of the same "coerce client input into a Decimal" helper used by
// app/api/orders/_lib/pricing.ts — duplicated rather than imported so this
// feature stays self-contained (see _lib/http.ts for the same rationale).

/** Coerces a client-supplied value (string | number) into a Decimal, throwing on garbage input. */
export function parseMoneyInput(value: unknown): Decimal {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    throw new Error("Expected a numeric amount");
  }
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) {
    throw new Error("Amount must be a finite number");
  }
  return decimal;
}
