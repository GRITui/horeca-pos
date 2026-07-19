import "server-only";

import {
  GritEventBus,
  buildEvent,
  type GritEvent,
  type OutboxStore,
  type TransactionCompletedData,
} from "@grit/shared-events";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Outbound Grit BizSuite events (transaction.completed, pos.velocity_surge).
//
// Everything here is fire-and-forget and lazily configured: checkout must
// NEVER block or fail because event plumbing is missing or down. With no
// GRIT_SUBSCRIBERS_* env vars set, publishing simply records to the outbox
// (if DATABASE_URL is set) and delivers to zero subscribers; with nothing
// configured at all it degrades to a logged no-op.
// ---------------------------------------------------------------------------

let cachedBus: GritEventBus | null | undefined;

/**
 * Lazily builds the shared event bus. The outbox store reuses this app's own
 * DATABASE_URL (the `event_outbox` table ships in this app's migration,
 * mirroring @grit/database). Returns null only when DATABASE_URL is unset —
 * in that case there is nowhere durable to record events, so publishing is
 * skipped entirely rather than crashing.
 */
export function getEventBus(): GritEventBus | null {
  if (cachedBus !== undefined) return cachedBus;
  const databaseUrl = process.env.DATABASE_URL;
  cachedBus = databaseUrl ? new GritEventBus({ store: prismaOutboxStore() }) : null;
  return cachedBus;
}

/**
 * Outbox store backed by this app's own Prisma client (EventOutbox model →
 * event_outbox table, canonical @grit/database shape). One DB driver
 * everywhere: the Neon adapter on deploys, the node-postgres fallback in
 * local dev — instead of the package's separate Neon-HTTP store, which
 * cannot reach a plain local Postgres.
 */
function prismaOutboxStore(): OutboxStore {
  return {
    async save(event: GritEvent) {
      await prisma.eventOutbox.upsert({
        where: { eventId: event.event_id },
        update: {},
        create: {
          eventId: event.event_id,
          eventName: event.event,
          organizationId: event.organization_id,
          payload: event as unknown as object,
          createdAt: new Date(event.timestamp),
        },
      });
    },
    async markDelivered(eventId: string) {
      await prisma.eventOutbox.updateMany({
        where: { eventId },
        data: { deliveredAt: new Date() },
      });
    },
    async listUndelivered(limit: number) {
      const rows = await prisma.eventOutbox.findMany({
        where: { deliveredAt: null },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return rows.map((r) => r.payload as unknown as GritEvent);
    },
  };
}

/** Item shape the publisher needs from an order's lines. */
export interface CompletedOrderLine {
  productId: string;
  variantSku: string | null;
  quantity: number;
  unitPrice: number;
}

/** sku for an event item: the variant's child SKU, else a product fallback. */
export function eventItemSku(line: Pick<CompletedOrderLine, "productId" | "variantSku">): string {
  return line.variantSku ?? `PRD-${line.productId}`;
}

export interface PublishTransactionCompletedInput {
  tenantId: string;
  orderId: string;
  totalAmount: number;
  /**
   * VAT embedded in `totalAmount` (Thailand VAT-inclusive pricing — see
   * BACKLOG.md "VAT-inclusive pricing"), derived from each line's
   * Variant.vatApplicable flag and the tenant's Tenant.vatRate. Callers
   * should compute this the same way `OrderDTO.vatAmount` is derived (see
   * `computeOrderVat` in app/api/orders/_lib/queries.ts) so the event and
   * the receipt always agree.
   */
  taxAmount: number;
  lines: CompletedOrderLine[];
  /** True when the transaction was captured offline and synced later. */
  offlineSynced?: boolean;
}

/**
 * Publishes `transaction.completed` for an order that just became fully
 * paid/closed. Call AFTER the DB transaction has committed (e.g. from
 * `after()` in a route handler) — never awaited on the checkout path, and
 * never throws.
 *
 * Notes (per the platform contract):
 * - `location_id` is the tenant's id for now — this app has no Location
 *   model yet, so the tenant is the location.
 * - `tax_amount` is the VAT embedded in `totalAmount`, computed by the
 *   caller from the order's lines (Variant.vatApplicable) and the tenant's
 *   Tenant.vatRate — see `PublishTransactionCompletedInput.taxAmount`.
 * - Envelope `organization_id` is the raw tenant id (a cuid): the platform
 *   outbox stores `organization_id` as opaque text, and grit-inventory maps
 *   it back to `Tenant.id` by equality, so no id translation is needed.
 */
export async function publishTransactionCompleted(
  input: PublishTransactionCompletedInput,
): Promise<void> {
  try {
    const bus = getEventBus();
    if (!bus) return;

    const data: TransactionCompletedData = {
      transaction_id: input.orderId,
      location_id: input.tenantId,
      total_amount: input.totalAmount,
      tax_amount: input.taxAmount,
      ...(input.offlineSynced ? { offline_synced: true } : {}),
      items: input.lines.map((line) => ({
        sku: eventItemSku(line),
        quantity: line.quantity,
        price: line.unitPrice,
      })),
    };

    await bus.publish(buildEvent("transaction.completed", input.tenantId, data));
  } catch (err) {
    // Fire-and-forget by contract: event delivery must never break checkout.
    console.error("Failed to publish transaction.completed", input.orderId, err);
  }
}
