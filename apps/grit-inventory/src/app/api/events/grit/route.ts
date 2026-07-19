import { NextRequest, NextResponse } from "next/server";
import { parseGritEvent, type TransactionCompletedEvent } from "@grit/shared-events/contracts";
import { verifyWebhook } from "@grit/shared-events/webhook";
import { db } from "@/lib/db";
import { applyStockMovement } from "@/lib/inventory";
import { publishThresholdBreached } from "@/lib/events";

/**
 * Inbound Grit BizSuite event webhook (HMAC-signed by @grit/shared-events).
 * Excluded from the session-auth proxy gate (src/proxy.ts) — authentication
 * is the HMAC signature, verified against GRIT_EVENT_WEBHOOK_SECRET.
 *
 * Handles `transaction.completed` from grit-pos: decrements stock per sold
 * item (reason `pos_sale`, FIFO-drained, allowed to go negative — the sale
 * already happened) and publishes `inventory.threshold_breached` when a
 * store's stock falls to/below its reorder threshold.
 *
 * Tenancy mapping: the envelope's `organization_id` is resolved by EQUALITY
 * with this app's `Tenant.id` (documented in README). `location_id` is
 * matched against `Store.id`; unknown locations fall back to the tenant's
 * default store. Unknown SKUs are skipped and reported in the response's
 * `warnings` array (still HTTP 200 so the publisher does not retry forever).
 */
export async function POST(request: NextRequest) {
  const secret = process.env.GRIT_EVENT_WEBHOOK_SECRET;
  if (!secret) {
    // Feature inert without configuration — never crash.
    return NextResponse.json({ error: "Event webhook not configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const verified = await verifyWebhook({
    secret,
    rawBody,
    signatureHeader: request.headers.get("x-grit-signature"),
    timestampHeader: request.headers.get("x-grit-timestamp"),
  });
  if (!verified) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const event = parseGritEvent(json);
  if (!event) {
    return NextResponse.json({ error: "Invalid event envelope" }, { status: 400 });
  }

  if (event.event !== "transaction.completed") {
    // Dedupe on event_id: first writer wins, replays are acknowledged as
    // no-ops. No further processing for this event type, so a bare insert is
    // already atomic.
    try {
      await db.processedEvent.create({
        data: { eventId: event.event_id, eventName: event.event },
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        return NextResponse.json({ ok: true, deduped: true });
      }
      throw err;
    }
    // Not a consumer of this event — acknowledge so it isn't redelivered.
    return NextResponse.json({ ok: true, ignored: event.event });
  }

  let result: Awaited<ReturnType<typeof handleTransactionCompleted>>;
  try {
    result = await handleTransactionCompleted(event as TransactionCompletedEvent);
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return NextResponse.json({ ok: true, deduped: true });
    }
    throw err;
  }
  return NextResponse.json(result);
}

function isUniqueViolation(err: unknown): boolean {
  return !!(err && typeof err === "object" && "code" in err && err.code === "P2002");
}

interface StockBreach {
  variantId: string;
  sku: string;
  quantityAvailable: number;
  reorderThreshold: number;
}

async function handleTransactionCompleted(event: TransactionCompletedEvent) {
  const { organization_id } = event;
  const { location_id, items, transaction_id } = event.data;

  // The dedupe marker and every item's stock decrement must commit or fail
  // together: previously the marker was written independently of (and each
  // item decremented in its own separate transaction from) the rest of the
  // processing, so a partial failure left the dedupe row committed with some
  // items unapplied — a retry would then be silently deduped and the
  // remaining items' stock decrements permanently lost. Wrapping the marker
  // insert and the whole item loop in one transaction means a failure rolls
  // back the marker too, so a retry reprocesses cleanly from scratch.
  const { warnings, processed, breaches, storeId } = await db.$transaction(async (tx) => {
    await tx.processedEvent.create({
      data: { eventId: event.event_id, eventName: event.event },
    });

    const warnings: string[] = [];

    // organization_id === Tenant.id (see README).
    const tenant = await tx.tenant.findUnique({ where: { id: organization_id } });
    if (!tenant) {
      warnings.push(`Unknown organization ${organization_id} — event acknowledged, no stock changed`);
      return { ok: true, processed: 0, warnings, breaches: [] as StockBreach[], storeId: null as string | null };
    }

    // grit-pos has no Location model yet, so it deliberately sends
    // location_id = organization_id (the tenant id) as its POS convention for
    // "no specific store". Treat that as first-class and resolve straight to
    // the tenant's default store with no warning — it isn't an unknown id.
    const isPosOrgFallback = location_id === organization_id;

    const store = isPosOrgFallback
      ? await tx.store.findFirst({
          where: { tenantId: tenant.id, isDefault: true },
          orderBy: { createdAt: "asc" },
        })
      : (await tx.store.findFirst({ where: { id: location_id, tenantId: tenant.id } })) ??
        (await tx.store.findFirst({
          where: { tenantId: tenant.id, isDefault: true },
          orderBy: { createdAt: "asc" },
        }));
    if (!store) {
      warnings.push(`Tenant ${tenant.id} has no store — event acknowledged, no stock changed`);
      return { ok: true, processed: 0, warnings, breaches: [] as StockBreach[], storeId: null as string | null };
    }
    if (!isPosOrgFallback && store.id !== location_id) {
      warnings.push(`Unknown location ${location_id} — applied to default store ${store.id}`);
    }

    const breaches: StockBreach[] = [];
    let processed = 0;

    for (const item of items) {
      const variant = await tx.variant.findUnique({
        where: { tenantId_sku: { tenantId: tenant.id, sku: item.sku } },
      });
      if (!variant) {
        warnings.push(`Unknown SKU ${item.sku} — skipped`);
        continue;
      }

      const movement = await applyStockMovement(tx, {
        tenantId: tenant.id,
        storeId: store.id,
        variantId: variant.id,
        delta: -item.quantity,
        reason: "pos_sale",
        allowNegative: true,
        note: `POS transaction ${transaction_id}`,
      });
      processed += 1;

      // Fire only on the transition into breach (previous quantity above the
      // threshold, new quantity at/below it) — not on every sale that keeps the
      // store below an already-breached threshold. `item.quantity` is the exact
      // magnitude of this decrement, so the pre-movement quantity is recoverable
      // without an extra read.
      const previousStoreQuantity = movement.storeQuantity + item.quantity;
      if (
        previousStoreQuantity > movement.reorderThreshold &&
        movement.storeQuantity <= movement.reorderThreshold
      ) {
        breaches.push({
          variantId: variant.id,
          sku: variant.sku,
          quantityAvailable: movement.storeQuantity,
          reorderThreshold: movement.reorderThreshold,
        });
      }
    }

    return { ok: true, processed, warnings, breaches, storeId: store.id };
  });

  // Publish threshold breaches after the decrements committed. Failures are
  // logged inside publishThresholdBreached and never fail the webhook.
  for (const breach of breaches) {
    const variant = await db.variant.findUnique({
      where: { id: breach.variantId },
      include: { product: true },
    });
    if (!variant) continue;
    await publishThresholdBreached(organization_id, {
      location_id: storeId as string,
      sku: breach.sku,
      product_id: variant.productId,
      product_name: variant.product.name,
      quantity_available: breach.quantityAvailable,
      reorder_threshold: breach.reorderThreshold,
      ...(variant.product.supplierName && { supplier_name: variant.product.supplierName }),
    });
  }

  return { ok: true, processed, threshold_breaches: breaches.length, warnings };
}
