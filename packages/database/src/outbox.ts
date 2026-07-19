import { neon } from "@neondatabase/serverless";
import type { GritEvent, OutboxStore } from "@grit/shared-events";

/**
 * Neon-backed {@link OutboxStore} for the `@grit/shared-events` event bus,
 * persisting events in the shared `event_outbox` table
 * (see migrations/0002_platform_extensions.sql).
 *
 * Uses the @neondatabase/serverless HTTP driver, so it works in serverless /
 * edge runtimes without connection pooling concerns. Each call is a single
 * stateless query.
 *
 * @param sqlUrl Neon Postgres connection string (typically
 *   `process.env.DATABASE_URL`).
 */
export function createNeonOutboxStore(sqlUrl: string): OutboxStore {
  const sql = neon(sqlUrl);

  return {
    /**
     * Durably record the event before delivery. Idempotent on `event_id`:
     * re-publishing the same event (e.g. a retried request) is a no-op.
     */
    async save(event: GritEvent): Promise<void> {
      await sql`
        INSERT INTO event_outbox (event_id, event_name, organization_id, payload, created_at)
        VALUES (
          ${event.event_id},
          ${event.event},
          ${event.organization_id},
          ${JSON.stringify(event)}::jsonb,
          ${event.timestamp}::timestamp
        )
        ON CONFLICT (event_id) DO NOTHING
      `;
    },

    /** Mark an event as delivered to all subscribers. */
    async markDelivered(eventId: string): Promise<void> {
      await sql`
        UPDATE event_outbox
        SET delivered_at = CURRENT_TIMESTAMP
        WHERE event_id = ${eventId}
      `;
    },

    /**
     * Events not yet fully delivered, oldest first — fed back into
     * `GritEventBus.drainOutbox()` for redelivery. Served by the partial
     * index `event_outbox_undelivered_idx` (delivered_at IS NULL).
     */
    async listUndelivered(limit: number): Promise<GritEvent[]> {
      const rows = await sql`
        SELECT payload
        FROM event_outbox
        WHERE delivered_at IS NULL
        ORDER BY created_at ASC
        LIMIT ${limit}
      `;
      // `payload` stores the full GritEventEnvelope as written by save(),
      // so mapping back is a direct cast of the jsonb column.
      return rows.map((row) => row.payload as GritEvent);
    },
  };
}
