import type { Prisma, StockTransferStatus } from "@/generated/prisma/client";
import { applyStockMovement } from "@/lib/inventory";

type TxClient = Prisma.TransactionClient;

export class InvalidTransferTransitionError extends Error {}
export class TransferNotFoundError extends Error {}

/** draft -> in_transit -> received, with cancellation from draft/in_transit. */
const ALLOWED_TRANSFER_TRANSITIONS: Record<StockTransferStatus, StockTransferStatus[]> = {
  draft: ["in_transit", "cancelled"],
  in_transit: ["received", "cancelled"],
  received: [],
  cancelled: [],
};

export function canTransitionTransfer(from: StockTransferStatus, to: StockTransferStatus): boolean {
  return ALLOWED_TRANSFER_TRANSITIONS[from].includes(to);
}

export interface TransferTransitionResult {
  transfer: {
    id: string;
    status: StockTransferStatus;
    fromStoreId: string;
    toStoreId: string;
  };
  /** Populated when the transfer reached `received` — for event publishing. */
  receivedItems?: Array<{ sku: string; quantity: number }>;
}

/**
 * Drives one stock-transfer status transition inside `db.$transaction`.
 *
 * - draft -> in_transit: decrements the SOURCE store per item
 *   (`transfer_out`, FIFO-drained); the FIFO cost per unit is captured on
 *   each item so the receipt leg can create correctly costed lots.
 * - in_transit -> received: increments the DESTINATION store per item
 *   (`transfer_in`), creating FIFO lots at the carried unit cost.
 * - in_transit -> cancelled: restores the SOURCE store per item
 *   (`transfer_in` back into the source at the carried cost).
 * - draft -> cancelled: no stock effect.
 */
export async function transitionTransfer(
  tx: TxClient,
  params: { tenantId: string; transferId: string; to: StockTransferStatus; actingUserId?: string }
): Promise<TransferTransitionResult> {
  // Lock the transfer row so concurrent transitions serialize.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "StockTransfer"
    WHERE "id" = ${params.transferId} AND "tenantId" = ${params.tenantId}
    FOR UPDATE
  `;
  if (!locked[0]) throw new TransferNotFoundError(params.transferId);

  const transfer = await tx.stockTransfer.findFirst({
    where: { id: params.transferId, tenantId: params.tenantId },
    include: { items: { include: { variant: true } } },
  });
  if (!transfer) throw new TransferNotFoundError(params.transferId);

  if (!canTransitionTransfer(transfer.status, params.to)) {
    throw new InvalidTransferTransitionError(
      `Cannot move transfer from ${transfer.status} to ${params.to}`
    );
  }

  const now = new Date();
  const result: TransferTransitionResult = {
    transfer: {
      id: transfer.id,
      status: params.to,
      fromStoreId: transfer.fromStoreId,
      toStoreId: transfer.toStoreId,
    },
  };

  if (params.to === "in_transit") {
    for (const item of transfer.items) {
      const movement = await applyStockMovement(tx, {
        tenantId: params.tenantId,
        storeId: transfer.fromStoreId,
        variantId: item.variantId,
        delta: -item.quantity,
        reason: "transfer_out",
        createdById: params.actingUserId,
        note: `Transfer ${transfer.id} dispatched`,
      });
      // Carry the FIFO unit cost of the drained stock to the receipt leg.
      const costConsumed = movement.fifo?.costConsumed ?? 0;
      const unitCost = item.quantity > 0 ? costConsumed / item.quantity : 0;
      await tx.stockTransferItem.update({
        where: { id: item.id },
        data: { unitCost: Math.round(unitCost * 100) / 100 },
      });
    }
    await tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: "in_transit", dispatchedAt: now },
    });
  }

  if (params.to === "received") {
    for (const item of transfer.items) {
      await applyStockMovement(tx, {
        tenantId: params.tenantId,
        storeId: transfer.toStoreId,
        variantId: item.variantId,
        delta: item.quantity,
        reason: "transfer_in",
        createdById: params.actingUserId,
        unitCost: item.unitCost !== null ? Number(item.unitCost) : undefined,
        note: `Transfer ${transfer.id} received`,
      });
    }
    await tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: "received", receivedAt: now },
    });
    result.receivedItems = transfer.items.map((item) => ({
      sku: item.variant.sku,
      quantity: item.quantity,
    }));
  }

  if (params.to === "cancelled") {
    if (transfer.status === "in_transit") {
      // Stock already left the source — put it back.
      for (const item of transfer.items) {
        await applyStockMovement(tx, {
          tenantId: params.tenantId,
          storeId: transfer.fromStoreId,
          variantId: item.variantId,
          delta: item.quantity,
          reason: "transfer_in",
          createdById: params.actingUserId,
          unitCost: item.unitCost !== null ? Number(item.unitCost) : undefined,
          note: `Transfer ${transfer.id} cancelled — stock restored to source`,
        });
      }
    }
    await tx.stockTransfer.update({
      where: { id: transfer.id },
      data: { status: "cancelled", cancelledAt: now },
    });
  }

  return result;
}
