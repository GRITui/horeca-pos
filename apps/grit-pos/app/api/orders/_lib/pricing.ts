import "server-only";

import { Decimal } from "@prisma/client/runtime/client";

// ---------------------------------------------------------------------------
// Money math, kept in Decimal throughout so we never accumulate floating
// point error while pricing an order line or checking whether an order is
// fully paid.
// ---------------------------------------------------------------------------

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

/** unitPrice = product.basePrice + (selected variant's priceDelta, if any). */
export function computeUnitPrice(
  basePrice: Decimal,
  variantDelta: Decimal | null | undefined,
): Decimal {
  return variantDelta ? basePrice.plus(variantDelta) : basePrice;
}

/**
 * lineTotal = quantity * unitPrice + sum(selected add-on prices) * quantity
 * (see the `OrderLine.lineTotal` doc comment in prisma/schema.prisma).
 */
export function computeLineTotal(
  unitPrice: Decimal,
  addOnPrices: Decimal[],
  quantity: number,
): Decimal {
  const addOnSum = addOnPrices.reduce((sum, p) => sum.plus(p), new Decimal(0));
  return unitPrice.plus(addOnSum).times(quantity);
}

export function sumDecimals(values: Decimal[]): Decimal {
  return values.reduce((sum, v) => sum.plus(v), new Decimal(0));
}
