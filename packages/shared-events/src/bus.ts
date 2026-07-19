import {
  type GritEvent,
  type GritEventName,
  type GritEventEnvelope,
} from "./contracts.js";
import { signWebhook } from "./webhook.js";

/**
 * Grit BizSuite event bus.
 *
 * Publishing an event does two things:
 *  1. Durably records it in the `event_outbox` table (see packages/database)
 *     via the caller-supplied `store` hook — ideally inside the same DB
 *     transaction that committed the business fact.
 *  2. Fans it out to subscriber endpoints as HMAC-signed internal webhooks.
 *     Delivery failures are tolerated: the outbox row keeps `delivered_at`
 *     NULL so a retry drain (`drainOutbox`) can re-attempt later.
 *
 * Subscribers are configured by environment, one URL list per event, e.g.:
 *   GRIT_EVENT_WEBHOOK_SECRET=shared-hmac-secret
 *   GRIT_SUBSCRIBERS_TRANSACTION_COMPLETED=https://inventory.example/api/events/grit
 *   GRIT_SUBSCRIBERS_INVENTORY_THRESHOLD_BREACHED=https://taskboard.example/api/taskboard-webhook
 */

export interface OutboxStore {
  /** Persist the event before any delivery attempt. Must be idempotent on event_id. */
  save(event: GritEvent): Promise<void>;
  /** Mark an event as delivered to all subscribers. */
  markDelivered(eventId: string): Promise<void>;
  /** Events not yet fully delivered, oldest first. */
  listUndelivered(limit: number): Promise<GritEvent[]>;
}

export interface GritEventBusOptions {
  store?: OutboxStore;
  /** Shared HMAC secret for internal webhooks. Defaults to GRIT_EVENT_WEBHOOK_SECRET. */
  webhookSecret?: string;
  /** Override subscriber resolution (defaults to env-based resolution). */
  resolveSubscribers?: (event: GritEventName) => string[];
  fetchImpl?: typeof fetch;
  /** Per-request delivery timeout in ms. */
  timeoutMs?: number;
}

export function envSubscribers(
  event: GritEventName,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const key = `GRIT_SUBSCRIBERS_${event.replace(/[.\-]/g, "_").toUpperCase()}`;
  const raw = env[key];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface PublishResult {
  event_id: string;
  subscribers: number;
  delivered: number;
  failures: Array<{ url: string; error: string }>;
}

export class GritEventBus {
  private readonly store?: OutboxStore;
  private readonly secret: string;
  private readonly resolveSubscribers: (event: GritEventName) => string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly localListeners = new Map<
    GritEventName,
    Array<(event: GritEvent) => Promise<void> | void>
  >();

  constructor(options: GritEventBusOptions = {}) {
    this.store = options.store;
    this.secret = options.webhookSecret ?? process.env.GRIT_EVENT_WEBHOOK_SECRET ?? "";
    this.resolveSubscribers = options.resolveSubscribers ?? envSubscribers;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  /** In-process subscription (same app). Cross-app consumers use webhooks instead. */
  on<N extends GritEventName>(
    event: N,
    listener: (event: Extract<GritEvent, GritEventEnvelope<N, unknown>>) => Promise<void> | void,
  ): void {
    const list = this.localListeners.get(event) ?? [];
    list.push(listener as (event: GritEvent) => Promise<void> | void);
    this.localListeners.set(event, list);
  }

  async publish(event: GritEvent): Promise<PublishResult> {
    await this.store?.save(event);

    for (const listener of this.localListeners.get(event.event) ?? []) {
      try {
        await listener(event);
      } catch {
        // Local listeners must not break publication; webhook retry is the
        // durability mechanism, local listeners are best-effort.
      }
    }

    const result = await this.deliver(event);
    if (result.failures.length === 0) {
      await this.store?.markDelivered(event.event_id);
    }
    return result;
  }

  /** Re-attempt delivery of previously failed events. Call from a cron route. */
  async drainOutbox(limit = 50): Promise<PublishResult[]> {
    if (!this.store) return [];
    const pending = await this.store.listUndelivered(limit);
    const results: PublishResult[] = [];
    for (const event of pending) {
      const result = await this.deliver(event);
      if (result.failures.length === 0) {
        await this.store.markDelivered(event.event_id);
      }
      results.push(result);
    }
    return results;
  }

  private async deliver(event: GritEvent): Promise<PublishResult> {
    const urls = this.resolveSubscribers(event.event);
    const failures: Array<{ url: string; error: string }> = [];
    const body = JSON.stringify(event);

    await Promise.all(
      urls.map(async (url) => {
        try {
          const headers = await signWebhook(this.secret, event.event, body);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          try {
            const res = await this.fetchImpl(url, {
              method: "POST",
              headers,
              body,
              signal: controller.signal,
            });
            if (!res.ok) {
              failures.push({ url, error: `HTTP ${res.status}` });
            }
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          failures.push({ url, error: err instanceof Error ? err.message : String(err) });
        }
      }),
    );

    return {
      event_id: event.event_id,
      subscribers: urls.length,
      delivered: urls.length - failures.length,
      failures,
    };
  }
}

/** Build a fully-populated envelope with a fresh idempotency key. */
export function buildEvent<N extends GritEventName, D>(
  event: N,
  organizationId: string,
  data: D,
  now: Date = new Date(),
): GritEventEnvelope<N, D> {
  return {
    event,
    timestamp: now.toISOString(),
    event_id: `evt_${crypto.randomUUID()}`,
    organization_id: organizationId,
    data,
  };
}
