# @grit/shared-events

Inter-app event layer for Grit BizSuite. Apps never query each other's tables —
they publish and consume the events defined in `src/contracts.ts`, delivered as
HMAC-signed internal webhooks with a durable Postgres outbox for retries.

## Event catalogue

| Event | Producer | Consumers |
| --- | --- | --- |
| `transaction.completed` | grit-pos | grit-inventory (stock decrement), grit-reports |
| `inventory.threshold_breached` | grit-inventory | grit-taskboard (restock card) |
| `inventory.transfer_completed` | grit-inventory | grit-reports |
| `pos.velocity_surge` | grit-pos | grit-taskboard (open auxiliary terminal card) |
| `task.completed` | grit-taskboard | grit-reports (labor efficiency) |
| `promotion.updated` | grit-inventory | grit-pos (checkout pricing cache — POS is offline-first and never calls another app live at sale time, so this event is the only way a rule reaches the register) |

## Wire format

```
POST <subscriber endpoint>
content-type: application/json
x-grit-event: transaction.completed
x-grit-timestamp: 1784367000
x-grit-signature: v1=<hex hmac-sha256 of "<timestamp>.<raw body>">
```

Body is a `GritEventEnvelope`: `{ event, timestamp, event_id, organization_id, data }`.
Consumers must dedupe on `event_id` and reject stale/unsigned payloads
(`verifyWebhook`, 5-minute tolerance). The taskboard app is a no-build plain-JS
app and mirrors this verification in `apps/grit-taskboard/lib/gritEvents.js` —
if you change the wire format, change it in both places.

## Configuration

| Env var | Purpose |
| --- | --- |
| `GRIT_EVENT_WEBHOOK_SECRET` | Shared HMAC secret for all internal webhooks |
| `GRIT_SUBSCRIBERS_<EVENT_NAME>` | Comma-separated subscriber URLs, e.g. `GRIT_SUBSCRIBERS_TRANSACTION_COMPLETED` |

## Usage

```ts
import { GritEventBus, buildEvent } from "@grit/shared-events";

const bus = new GritEventBus({ store: pgOutboxStore });
await bus.publish(
  buildEvent("transaction.completed", orgId, {
    transaction_id, location_id, total_amount, tax_amount, items,
  }),
);
```

The outbox table lives in `packages/database/migrations` (`event_outbox`).
Expose a cron route that calls `bus.drainOutbox()` to re-deliver failures.
