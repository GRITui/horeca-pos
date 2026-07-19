import type { Prisma } from "@/generated/prisma/client";

type TxClient = Prisma.TransactionClient;

export interface FifoConsumptionEntry {
  lotId: string | null;
  quantity: number;
  unitCost: number;
}

export interface FifoConsumptionResult {
  /** Total FIFO cost of the consumed quantity (lots + fallback). */
  costConsumed: number;
  /** Per-lot breakdown, in drain order. `lotId: null` = fallback costing. */
  entries: FifoConsumptionEntry[];
  /** Quantity that had no open lot to drain (costed at the fallback rate). */
  missingLotQuantity: number;
}

/**
 * Drains FIFO cost lots (oldest `receivedAt` first) for a consumption of
 * `quantity` units at (tenant, store, variant), writing one
 * `StockLotConsumption` audit row per drained lot. Must run inside the same
 * `$transaction` as the stock decrement; lot rows are locked with
 * SELECT ... FOR UPDATE so concurrent drains serialize.
 *
 * Missing lots never block the operation: any shortfall is costed at
 * `fallbackUnitCost` (the variant's default unit cost, or 0), logged, and
 * recorded as a `StockLotConsumption` row with `lotId = null` so COGS
 * reporting still accounts for every unit sold.
 */
export async function consumeFifo(
  tx: TxClient,
  params: {
    tenantId: string;
    storeId: string;
    variantId: string;
    /** Positive number of units consumed. */
    quantity: number;
    /** The StockMovement row this consumption belongs to. */
    movementId: string;
    /** Cost applied to units with no open lot (default 0). */
    fallbackUnitCost?: number;
  }
): Promise<FifoConsumptionResult> {
  const { tenantId, storeId, variantId, quantity, movementId } = params;
  const fallbackUnitCost = params.fallbackUnitCost ?? 0;

  const result: FifoConsumptionResult = { costConsumed: 0, entries: [], missingLotQuantity: 0 };
  if (quantity <= 0) return result;

  const lots = await tx.$queryRaw<{ id: string; quantityRemaining: number; unitCost: string }[]>`
    SELECT "id", "quantityRemaining", "unitCost"::text AS "unitCost"
    FROM "StockLot"
    WHERE "tenantId" = ${tenantId}
      AND "storeId" = ${storeId}
      AND "variantId" = ${variantId}
      AND "quantityRemaining" > 0
    ORDER BY "receivedAt" ASC, "id" ASC
    FOR UPDATE
  `;

  let remaining = quantity;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.quantityRemaining, remaining);
    const unitCost = Number(lot.unitCost);
    await tx.stockLot.update({
      where: { id: lot.id },
      data: { quantityRemaining: lot.quantityRemaining - take },
    });
    await tx.stockLotConsumption.create({
      data: {
        tenantId,
        movementId,
        lotId: lot.id,
        variantId,
        storeId,
        quantity: take,
        unitCost,
      },
    });
    result.entries.push({ lotId: lot.id, quantity: take, unitCost });
    result.costConsumed += take * unitCost;
    remaining -= take;
  }

  if (remaining > 0) {
    // Tolerate missing lots: cost the shortfall at the fallback rate and keep
    // going — a sale must never be blocked by incomplete costing data.
    console.warn(
      `[fifo] no open lots for ${remaining}/${quantity} units ` +
        `(tenant=${tenantId} store=${storeId} variant=${variantId}); ` +
        `falling back to unit cost ${fallbackUnitCost}`
    );
    await tx.stockLotConsumption.create({
      data: {
        tenantId,
        movementId,
        lotId: null,
        variantId,
        storeId,
        quantity: remaining,
        unitCost: fallbackUnitCost,
      },
    });
    result.entries.push({ lotId: null, quantity: remaining, unitCost: fallbackUnitCost });
    result.costConsumed += remaining * fallbackUnitCost;
    result.missingLotQuantity = remaining;
  }

  return result;
}

/** Creates a FIFO cost lot for a stock receipt (restock / transfer_in). */
export async function createStockLot(
  tx: TxClient,
  params: {
    tenantId: string;
    storeId: string;
    variantId: string;
    quantity: number;
    unitCost: number;
    receivedAt?: Date;
  }
) {
  return tx.stockLot.create({
    data: {
      tenantId: params.tenantId,
      storeId: params.storeId,
      variantId: params.variantId,
      quantityReceived: params.quantity,
      quantityRemaining: params.quantity,
      unitCost: params.unitCost,
      ...(params.receivedAt && { receivedAt: params.receivedAt }),
    },
  });
}
