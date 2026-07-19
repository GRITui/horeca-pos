import type { OrderStatus, Prisma } from "@/generated/prisma/client";
import { applyStockMovement } from "@/lib/inventory";

type TxClient = Prisma.TransactionClient;

export class InvalidTransitionError extends Error {}
export class OrderNotFoundError extends Error {}

/** Explicit order status state machine — see handoff Section 3, step 4. */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["fulfilling", "cancelled"],
  fulfilling: ["fulfilled", "cancelled"],
  fulfilled: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Drives one order status transition inside `db.$transaction`.
 * - pending/paid -> fulfilling: atomically decrements stock for every line
 *   (row-locked per variant via `applyStockMovement`) — the same mechanism
 *   Milestone 2 extends per-component for bundle order lines.
 * - fulfilling -> cancelled: reverses the decrement (restock).
 * - * -> fulfilled: opens the Delivery record for manual staff tracking.
 */
export async function transitionOrder(
  tx: TxClient,
  params: { tenantId: string; storeId: string | null; orderId: string; to: OrderStatus; actingUserId: string }
) {
  // Lock the order row first so concurrent transitions on the same order
  // serialize instead of both reading the same stale `from` status and
  // double-applying stock movements (see handoff Section 3, step 4).
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Order"
    WHERE "id" = ${params.orderId} AND "tenantId" = ${params.tenantId}
    FOR UPDATE
  `;
  if (!locked[0]) throw new OrderNotFoundError(params.orderId);

  const order = await tx.order.findFirst({
    where: { id: params.orderId, tenantId: params.tenantId },
    include: { lines: true },
  });
  if (!order) throw new OrderNotFoundError(params.orderId);

  if (!canTransition(order.status, params.to)) {
    throw new InvalidTransitionError(`Cannot move order from ${order.status} to ${params.to}`);
  }

  if (params.to === "fulfilling") {
    for (const line of order.lines) {
      if (!line.variantId) continue; // bundle lines are unsupported until Milestone 2
      await applyStockMovement(tx, {
        tenantId: params.tenantId,
        storeId: params.storeId,
        variantId: line.variantId,
        delta: -line.quantity,
        reason: "order_fulfillment",
        orderLineId: line.id,
        createdById: params.actingUserId,
        note: `Order ${order.orderNumber} fulfillment`,
      });
    }
  }

  if (params.to === "cancelled" && order.status === "fulfilling") {
    for (const line of order.lines) {
      if (!line.variantId) continue;
      // Reverse the FIFO consumption recorded by the original fulfillment
      // movement for this line before restocking. Without this, the
      // consumption rows stay in place and /api/reports/cogs (which sums
      // every StockLotConsumption except transfer_out) keeps counting the
      // cancelled sale's cost as sold, permanently double-counting COGS —
      // the restock below creates a fresh lot for the returned quantity, so
      // deleting these (rather than trying to restore the original lots,
      // which may have been further drained since) keeps total lot quantity
      // consistent with actual stock on hand.
      await tx.stockLotConsumption.deleteMany({
        where: {
          tenantId: params.tenantId,
          movement: { orderLineId: line.id, reason: "order_fulfillment" },
        },
      });
      await applyStockMovement(tx, {
        tenantId: params.tenantId,
        storeId: params.storeId,
        variantId: line.variantId,
        delta: line.quantity,
        reason: "return",
        orderLineId: line.id,
        createdById: params.actingUserId,
        note: `Order ${order.orderNumber} cancelled after fulfillment started`,
      });
    }
  }

  if (params.to === "fulfilled") {
    await tx.delivery.upsert({
      where: { orderId: order.id },
      update: {},
      create: {
        tenantId: params.tenantId,
        storeId: params.storeId,
        orderId: order.id,
        address: order.customerAddress,
        status: "assigned",
        statusHistory: { create: { status: "assigned" } },
      },
    });
  }

  return tx.order.update({ where: { id: order.id }, data: { status: params.to } });
}

/** Sequential, human-readable order numbers, scoped per tenant. */
export async function generateOrderNumber(tx: TxClient, tenantId: string): Promise<string> {
  const count = await tx.order.count({ where: { tenantId } });
  return `ORD-${String(count + 1).padStart(5, "0")}`;
}
