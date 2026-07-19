import type {
  DiscountPolicyUpdatedData,
  GritEvent,
  GritEventName,
  InventoryThresholdBreachedData,
  InventoryTransferCompletedData,
  PromotionUpdatedData,
} from "@grit/shared-events/contracts";
import { db } from "@/lib/db";

/**
 * Outbound event publishing for grit-inventory, built on @grit/shared-events
 * (HMAC webhooks) + the durable Postgres outbox from @grit/database.
 *
 * NOTE on the `require()` bindings below: the bus module of
 * @grit/shared-events does not typecheck under this app's DOM lib (its
 * `fetch(url, { headers })` call passes an interface where lib.dom wants a
 * `Record<string, string>`), and workspace packages must not be modified by
 * app work. Loading it via `require` keeps `bus.ts` out of this app's TS
 * program while runtime behavior is identical to a static import; the
 * structural types below mirror the package's public API.
 *
 * Degrades gracefully when unconfigured:
 * - No `DATABASE_URL` -> bus runs without an outbox store (best-effort
 *   webhook delivery only).
 * - No `GRIT_EVENT_WEBHOOK_SECRET` / no `GRIT_SUBSCRIBERS_*` URLs -> nothing
 *   is delivered; publishes are inert.
 * - Outbox writes that fail (e.g. non-uuid organization ids against a strict
 *   platform table — see README) are logged and skipped, never thrown.
 */

/** Structural mirror of `OutboxStore` from @grit/shared-events. */
export interface OutboxStoreLike {
  save(event: GritEvent): Promise<void>;
  markDelivered(eventId: string): Promise<void>;
  listUndelivered(limit: number): Promise<GritEvent[]>;
}

/** Structural mirror of `PublishResult` from @grit/shared-events. */
export interface PublishResultLike {
  event_id: string;
  subscribers: number;
  delivered: number;
  failures: Array<{ url: string; error: string }>;
}

/** Structural mirror of the `GritEventBus` public surface. */
export interface GritEventBusLike {
  publish(event: GritEvent): Promise<PublishResultLike>;
  drainOutbox(limit?: number): Promise<PublishResultLike[]>;
}

/* eslint-disable @typescript-eslint/no-require-imports */
const sharedEvents = require("@grit/shared-events") as {
  GritEventBus: new (options?: {
    store?: OutboxStoreLike;
    webhookSecret?: string;
  }) => GritEventBusLike;
  buildEvent: <D>(
    event: GritEventName,
    organizationId: string,
    data: D,
    now?: Date
  ) => GritEvent;
};
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Outbox store backed by this app's own Prisma client (EventOutbox model →
 * event_outbox table, canonical @grit/database shape). Reusing the app's
 * client means one DB driver everywhere — Neon adapter on deploys, the
 * node-postgres fallback in local dev — instead of the package's separate
 * Neon-HTTP store, which can't reach a plain local Postgres.
 */
function prismaOutboxStore(): OutboxStoreLike {
  return {
    async save(event) {
      await db.eventOutbox.upsert({
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
    async markDelivered(eventId) {
      await db.eventOutbox.updateMany({
        where: { eventId },
        data: { deliveredAt: new Date() },
      });
    },
    async listUndelivered(limit) {
      const rows = await db.eventOutbox.findMany({
        where: { deliveredAt: null },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return rows.map((r) => r.payload as unknown as GritEvent);
    },
  };
}

function safeOutboxStore(inner: OutboxStoreLike): OutboxStoreLike {
  return {
    async save(event) {
      try {
        await inner.save(event);
      } catch (err) {
        console.warn(`[events] outbox save failed for ${event.event_id}:`, err);
      }
    },
    async markDelivered(eventId) {
      try {
        await inner.markDelivered(eventId);
      } catch (err) {
        console.warn(`[events] outbox markDelivered failed for ${eventId}:`, err);
      }
    },
    async listUndelivered(limit) {
      try {
        return await inner.listUndelivered(limit);
      } catch (err) {
        console.warn("[events] outbox listUndelivered failed:", err);
        return [];
      }
    },
  };
}

let bus: GritEventBusLike | null = null;

/** Lazily constructed singleton bus — env is only read at first use. */
export function getEventBus(): GritEventBusLike {
  if (!bus) {
    const databaseUrl = process.env.DATABASE_URL;
    bus = new sharedEvents.GritEventBus({
      store: databaseUrl ? safeOutboxStore(prismaOutboxStore()) : undefined,
    });
  }
  return bus;
}

/** Publish, tolerating every failure — event emission must never break the
 * business operation that triggered it. */
export async function publishEventSafe(event: GritEvent): Promise<void> {
  try {
    await getEventBus().publish(event);
  } catch (err) {
    console.warn(`[events] publish failed for ${event.event} (${event.event_id}):`, err);
  }
}

export async function publishThresholdBreached(
  organizationId: string,
  data: InventoryThresholdBreachedData
): Promise<void> {
  await publishEventSafe(
    sharedEvents.buildEvent("inventory.threshold_breached", organizationId, data)
  );
}

export async function publishTransferCompleted(
  organizationId: string,
  data: InventoryTransferCompletedData
): Promise<void> {
  await publishEventSafe(
    sharedEvents.buildEvent("inventory.transfer_completed", organizationId, data)
  );
}

/**
 * Grit BizSuite pivot (promotions module): published on every promotion
 * create/update/deactivate/delete. Grit POS is offline-first and caches the
 * rule set from this event rather than calling this app live at checkout —
 * see the schema comment above the Promotion model and
 * @grit/shared-events/contracts's PromotionUpdatedData docstring.
 */
export async function publishPromotionUpdated(
  organizationId: string,
  data: PromotionUpdatedData
): Promise<void> {
  await publishEventSafe(sharedEvents.buildEvent("promotion.updated", organizationId, data));
}

/**
 * Grit BizSuite pivot (discount resolution policy, BACKLOG.md): published
 * whenever the tenant's `discountStackingPolicy` setting is saved. Tenant-
 * wide, so it's a separate small event rather than folded into
 * `promotion.updated`'s per-rule shape — see DiscountPolicyUpdatedData's
 * docstring in @grit/shared-events/contracts.
 */
export async function publishDiscountPolicyUpdated(
  organizationId: string,
  data: DiscountPolicyUpdatedData
): Promise<void> {
  await publishEventSafe(
    sharedEvents.buildEvent("discount_policy.updated", organizationId, data)
  );
}
