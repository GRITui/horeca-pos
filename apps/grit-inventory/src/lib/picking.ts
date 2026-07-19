import type { Prisma } from "@/generated/prisma/client";
import { resolveStore } from "@/lib/stores";

type TxClient = Prisma.TransactionClient;

export class PickOrderNotFoundError extends Error {}
export class OrderNotFulfillingError extends Error {}
export class PickTaskExistsError extends Error {}
export class PickTaskNotFoundError extends Error {}
export class PickSkuNotFoundError extends Error {
  constructor(public readonly sku: string) {
    super(`No pick item matches SKU ${sku}`);
  }
}

/**
 * Creates the pick task for an order already in `fulfilling` — the
 * scanner-driven "go gather these items" step (Grit WMS epic). One per
 * order (1:1, DB-unique on `PickTask.orderId`). Does NOT move stock: the
 * order's lines were already decremented at the fulfilling transition (see
 * `transitionOrder` in lib/orders.ts) — this only tracks the physical
 * gather-and-verify step.
 *
 * Snapshots each line's variant's primary `VariantLocation.code` (if any)
 * onto `PickTaskItem.locationCode` at creation time, so a later edit to the
 * planogram doesn't retroactively change what the picker was shown.
 */
export async function createPickTask(
  tx: TxClient,
  params: { tenantId: string; orderId: string; storeId?: string | null }
) {
  const order = await tx.order.findFirst({
    where: { id: params.orderId, tenantId: params.tenantId },
    include: { lines: true, pickTask: true },
  });
  if (!order) throw new PickOrderNotFoundError(params.orderId);
  if (order.status !== "fulfilling") {
    throw new OrderNotFulfillingError(`Order ${order.orderNumber} is not in fulfilling (status: ${order.status})`);
  }
  if (order.pickTask) {
    throw new PickTaskExistsError(`Order ${order.orderNumber} already has a pick task`);
  }

  // Bundle lines (variantId null) are unsupported until Milestone 2 — same
  // exclusion transitionOrder applies when decrementing stock.
  const lines = order.lines.filter((l) => l.variantId);

  const store = await resolveStore(tx, params.tenantId, params.storeId ?? order.storeId ?? null);

  const locations = lines.length
    ? await tx.variantLocation.findMany({
        where: {
          tenantId: params.tenantId,
          storeId: store.id,
          variantId: { in: lines.map((l) => l.variantId as string) },
          isPrimary: true,
        },
        orderBy: { createdAt: "asc" },
      })
    : [];
  // Not DB-uniqueness-enforced (see schema note on VariantLocation) — the
  // first (oldest) isPrimary row per variant wins, matching the README's
  // documented app-level convention.
  const codeByVariant = new Map<string, string>();
  for (const loc of locations) {
    if (!codeByVariant.has(loc.variantId)) codeByVariant.set(loc.variantId, loc.code);
  }

  return tx.pickTask.create({
    data: {
      tenantId: params.tenantId,
      orderId: order.id,
      storeId: store.id,
      status: "pending",
      items: {
        create: lines.map((l) => ({
          orderLineId: l.id,
          variantId: l.variantId as string,
          locationCode: codeByVariant.get(l.variantId as string) ?? null,
          quantityRequired: l.quantity,
        })),
      },
    },
    include: { items: { include: { variant: { select: { sku: true, name: true } } } } },
  });
}

/**
 * Records one scanned unit against the matching `PickTaskItem` (matched by
 * variant SKU). Increments `quantityPicked` by 1, capped at
 * `quantityRequired` (extra scans of an already-fulfilled line are a no-op
 * beyond re-stamping `scannedAt`). Once every item's `quantityPicked` meets
 * its `quantityRequired`, the task auto-completes.
 */
export async function scanPickItem(
  tx: TxClient,
  params: { pickTaskId: string; sku: string; tenantId: string }
) {
  const task = await tx.pickTask.findFirst({
    where: { id: params.pickTaskId, tenantId: params.tenantId },
    include: { items: { include: { variant: { select: { id: true, sku: true } } } } },
  });
  if (!task) throw new PickTaskNotFoundError(params.pickTaskId);

  const item = task.items.find((i) => i.variant.sku === params.sku);
  if (!item) throw new PickSkuNotFoundError(params.sku);

  const now = new Date();
  await tx.pickTaskItem.update({
    where: { id: item.id },
    data: {
      quantityPicked: Math.min(item.quantityPicked + 1, item.quantityRequired),
      scannedAt: now,
    },
  });

  const refreshedItems = await tx.pickTaskItem.findMany({ where: { pickTaskId: task.id } });
  const allDone = refreshedItems.every((i) => i.quantityPicked >= i.quantityRequired);

  return tx.pickTask.update({
    where: { id: task.id },
    data: {
      status: allDone ? "complete" : "in_progress",
      startedAt: task.startedAt ?? now,
      // Only stamp completedAt the first time all items clear — redundant
      // scans of an already-complete task (capped quantities) must not keep
      // pushing the timestamp forward.
      completedAt: allDone ? task.completedAt ?? now : task.completedAt,
    },
    include: { items: { include: { variant: { select: { sku: true, name: true } } } } },
  });
}
