import "server-only";

import { buildEvent, type PosVelocitySurgeData } from "@grit/shared-events";
import { prisma } from "@/lib/prisma";
import { OrderStatus } from "@/app/generated/prisma/enums";
import { getEventBus } from "@/lib/events";

// ---------------------------------------------------------------------------
// pos.velocity_surge — after each completed transaction, count the tenant's
// transactions in the trailing GRIT_SURGE_WINDOW_MIN minutes; when the count
// reaches GRIT_SURGE_THRESHOLD and no surge event has already been emitted
// inside the current window, publish pos.velocity_surge (consumed by
// grit-taskboard to open an auxiliary-terminal card).
//
// Like all event plumbing, this is fire-and-forget: call it from `after()`
// once the checkout transaction has committed. It never throws.
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MIN = 10;
const DEFAULT_THRESHOLD = 25;

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function surgeConfig(): { windowMinutes: number; threshold: number } {
  return {
    windowMinutes: envInt("GRIT_SURGE_WINDOW_MIN", DEFAULT_WINDOW_MIN),
    threshold: envInt("GRIT_SURGE_THRESHOLD", DEFAULT_THRESHOLD),
  };
}

/**
 * Checks the tenant's transaction velocity and publishes pos.velocity_surge
 * when the threshold is crossed. "Transaction" = an order that reached
 * `closed` (fully paid) — counted via Order.updatedAt, which is stamped at
 * close time and never changes afterwards (closed orders are immutable).
 *
 * Window dedupe: the outbox itself is the record of emitted events, so a
 * surge is suppressed while any pos.velocity_surge row for this tenant
 * exists with created_at inside the current trailing window.
 */
export async function checkVelocitySurge(tenantId: string): Promise<void> {
  try {
    const bus = getEventBus();
    if (!bus) return;

    const { windowMinutes, threshold } = surgeConfig();
    const windowStart = new Date(Date.now() - windowMinutes * 60_000);

    // Envelope organization_id is the raw tenant id (opaque text in the
    // outbox — see lib/events.ts).
    const organizationId = tenantId;

    // Window dedupe is a check-then-act (count transactions, count
    // already-emitted surge events, then decide to publish), and unlike
    // externalRef/stripePaymentIntentId there's no natural DB column to put
    // a unique constraint on — the window is a sliding range, not a
    // discrete value. A Postgres advisory lock keyed on the tenant id,
    // held for this whole transaction (including the outbox insert, done
    // directly here on the SAME locked connection rather than through
    // bus.publish's own pool connection), serializes concurrent callers for
    // the same tenant so only one can win the "not yet emitted" check per
    // window.
    const built = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`;

      const transactionsInWindow = await tx.order.count({
        where: {
          tenantId,
          status: OrderStatus.closed,
          updatedAt: { gte: windowStart },
        },
      });
      if (transactionsInWindow < threshold) return null;

      const alreadyEmitted = await tx.eventOutbox.count({
        where: {
          eventName: "pos.velocity_surge",
          organizationId,
          createdAt: { gte: windowStart },
        },
      });
      if (alreadyEmitted > 0) return null;

      const data: PosVelocitySurgeData = {
        // No Location model yet — the tenant is the location (see lib/events.ts).
        location_id: tenantId,
        transactions_in_window: transactionsInWindow,
        window_minutes: windowMinutes,
        threshold,
      };
      const event = buildEvent("pos.velocity_surge", organizationId, data);

      // Mirrors lib/events.ts's prismaOutboxStore().save() exactly, but run
      // on the same locked transaction as the checks above.
      await tx.eventOutbox.create({
        data: {
          eventId: event.event_id,
          eventName: event.event,
          organizationId: event.organization_id,
          payload: event as unknown as object,
          createdAt: new Date(event.timestamp),
        },
      });

      return event;
    });

    if (!built) return;

    // Local listeners + webhook delivery, outside the lock. The store.save()
    // inside bus.publish() re-runs against the row already inserted above
    // (it's an upsert with `update: {}`) — a harmless no-op.
    await bus.publish(built);
  } catch (err) {
    // Surge detection must never break checkout.
    console.error("Failed velocity-surge check", tenantId, err);
  }
}
