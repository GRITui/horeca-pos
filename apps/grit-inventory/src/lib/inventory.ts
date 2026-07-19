import type { Prisma, StockMovementReason } from "@/generated/prisma/client";
import { consumeFifo, createStockLot, type FifoConsumptionResult } from "@/lib/fifo";
import { resolveStore } from "@/lib/stores";

/** Prisma transaction client — accepts either `db` or a `$transaction` callback's `tx`. */
type TxClient = Prisma.TransactionClient;

export class InsufficientStockError extends Error {
  constructor(public readonly variantId: string) {
    super(`Insufficient stock for variant ${variantId}`);
  }
}

/**
 * Row-locks the variant (SELECT ... FOR UPDATE) so concurrent order entry and
 * stock adjustments serialize instead of racing on the same row. Taking this
 * lock FIRST (before any StoreStock row) also serializes lazy StoreStock
 * creation, so per-store rows can never be double-created.
 */
async function lockVariantForUpdate(tx: TxClient, tenantId: string, variantId: string) {
  const rows = await tx.$queryRaw<
    { id: string; quantityOnHand: number; reorderThreshold: number; unitCost: string | null }[]
  >`
    SELECT "id", "quantityOnHand", "reorderThreshold", "unitCost"::text AS "unitCost"
    FROM "Variant"
    WHERE "id" = ${variantId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** Locks (or lazily creates) the StoreStock row for (tenant, store, variant).
 * Caller must already hold the variant row lock. */
async function lockStoreStockForUpdate(
  tx: TxClient,
  params: {
    tenantId: string;
    storeId: string;
    storeIsDefault: boolean;
    variantId: string;
    variantQuantityOnHand: number;
    variantReorderThreshold: number;
  }
) {
  const rows = await tx.$queryRaw<{ id: string; quantityOnHand: number; reorderThreshold: number }[]>`
    SELECT "id", "quantityOnHand", "reorderThreshold" FROM "StoreStock"
    WHERE "tenantId" = ${params.tenantId}
      AND "storeId" = ${params.storeId}
      AND "variantId" = ${params.variantId}
    FOR UPDATE
  `;
  if (rows[0]) return rows[0];

  // Lazy creation (safe under the variant lock). If NO StoreStock row exists
  // yet for this variant anywhere and the target is the tenant's default
  // store, seed it from the M1 aggregate on the variant so pre-pivot data
  // (or rows created outside the migration backfill) self-heals; otherwise
  // start at zero.
  const anyRows = await tx.storeStock.count({
    where: { tenantId: params.tenantId, variantId: params.variantId },
  });
  const seedQuantity =
    anyRows === 0 && params.storeIsDefault ? params.variantQuantityOnHand : 0;
  const created = await tx.storeStock.create({
    data: {
      tenantId: params.tenantId,
      storeId: params.storeId,
      variantId: params.variantId,
      quantityOnHand: seedQuantity,
      reorderThreshold: params.variantReorderThreshold,
    },
  });
  return {
    id: created.id,
    quantityOnHand: created.quantityOnHand,
    reorderThreshold: created.reorderThreshold,
  };
}

export interface StockMovementResult {
  /** Tenant-wide aggregate (Variant.quantityOnHand) after the movement. */
  variantQuantity: number;
  /** Store-level quantity (StoreStock.quantityOnHand) after the movement. */
  storeQuantity: number;
  /** The store the movement was applied to (default store when unspecified). */
  storeId: string;
  /** The store-level reorder threshold, for threshold-breach checks. */
  reorderThreshold: number;
  /** The audit StockMovement row id. */
  movementId: string;
  /** FIFO drain breakdown for consuming (negative-delta) movements. */
  fifo?: FifoConsumptionResult;
}

/**
 * Applies a signed quantity change to a variant at a specific store and
 * writes the paired audit `StockMovement` row atomically. Must be called
 * inside `db.$transaction`.
 *
 * Multi-location semantics (Grit pivot):
 * - `storeId` targets a store's `StoreStock` row (row-locked); omitted/null
 *   falls back to the tenant's default store — preserving M1 call sites.
 * - `Variant.quantityOnHand` is maintained as the sum of all stores so
 *   existing single-store screens keep working.
 * - Positive deltas create a FIFO `StockLot` (cost = `unitCost` param, else
 *   the variant's default `unitCost`, else 0).
 * - Negative deltas drain lots oldest-first (`consumeFifo`) in the same
 *   transaction; missing lots fall back to the variant cost and never block.
 *
 * Throws `InsufficientStockError` if the store-level quantity would go
 * negative, unless `allowNegative` is set (used for POS sale ingestion — the
 * sale already happened in the real world, so the ledger records it even
 * when tracking has drifted).
 */
export async function applyStockMovement(
  tx: TxClient,
  params: {
    tenantId: string;
    storeId?: string | null;
    variantId: string;
    delta: number;
    reason: StockMovementReason;
    orderLineId?: string;
    bundleId?: string;
    note?: string;
    createdById?: string;
    /** Unit cost for the FIFO lot created by a positive delta. */
    unitCost?: number;
    /** Permit the store-level quantity to go negative (POS sale ingestion). */
    allowNegative?: boolean;
  }
): Promise<StockMovementResult> {
  const locked = await lockVariantForUpdate(tx, params.tenantId, params.variantId);
  if (!locked) {
    throw new Error(`Variant ${params.variantId} not found for tenant ${params.tenantId}`);
  }

  const store = await resolveStore(tx, params.tenantId, params.storeId);
  const storeStock = await lockStoreStockForUpdate(tx, {
    tenantId: params.tenantId,
    storeId: store.id,
    storeIsDefault: store.isDefault,
    variantId: params.variantId,
    variantQuantityOnHand: locked.quantityOnHand,
    variantReorderThreshold: locked.reorderThreshold,
  });

  const newStoreQuantity = storeStock.quantityOnHand + params.delta;
  if (newStoreQuantity < 0 && !params.allowNegative) {
    throw new InsufficientStockError(params.variantId);
  }

  await tx.storeStock.update({
    where: { id: storeStock.id },
    data: { quantityOnHand: newStoreQuantity },
  });

  // Maintain the tenant-wide aggregate as the sum of stores.
  const aggregate = await tx.storeStock.aggregate({
    where: { tenantId: params.tenantId, variantId: params.variantId },
    _sum: { quantityOnHand: true },
  });
  const newVariantQuantity = aggregate._sum.quantityOnHand ?? newStoreQuantity;
  await tx.variant.update({
    where: { id: params.variantId },
    data: { quantityOnHand: newVariantQuantity },
  });

  const movement = await tx.stockMovement.create({
    data: {
      tenantId: params.tenantId,
      storeId: store.id,
      variantId: params.variantId,
      delta: params.delta,
      reason: params.reason,
      orderLineId: params.orderLineId,
      bundleId: params.bundleId,
      note: params.note,
      createdById: params.createdById,
    },
  });

  const fallbackUnitCost = locked.unitCost !== null ? Number(locked.unitCost) : 0;
  let fifo: FifoConsumptionResult | undefined;
  if (params.delta > 0) {
    await createStockLot(tx, {
      tenantId: params.tenantId,
      storeId: store.id,
      variantId: params.variantId,
      quantity: params.delta,
      unitCost: params.unitCost ?? fallbackUnitCost,
    });
  } else if (params.delta < 0) {
    fifo = await consumeFifo(tx, {
      tenantId: params.tenantId,
      storeId: store.id,
      variantId: params.variantId,
      quantity: -params.delta,
      movementId: movement.id,
      fallbackUnitCost: params.unitCost ?? fallbackUnitCost,
    });
  }

  return {
    variantQuantity: newVariantQuantity,
    storeQuantity: newStoreQuantity,
    storeId: store.id,
    reorderThreshold: storeStock.reorderThreshold,
    movementId: movement.id,
    fifo,
  };
}
