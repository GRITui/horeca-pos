import "server-only";

import { NextResponse } from "next/server";
import {
  parseGritEvent,
  type DiscountPolicyUpdatedEvent,
  type PromotionUpdatedEvent,
} from "@grit/shared-events/contracts";
import { verifyWebhook } from "@grit/shared-events/webhook";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Inbound Grit BizSuite event webhook (HMAC-signed by @grit/shared-events).
//
// This app has no middleware/proxy.ts route-protection list to exclude this
// route from — every staff-only route instead calls requireTenantId()
// explicitly at the top of its handler (see lib/tenant.ts). This route
// deliberately does not, the same way app/api/stripe/webhook and
// app/api/pickup/** don't: authentication here IS the HMAC signature,
// verified against GRIT_EVENT_WEBHOOK_SECRET, not a staff session.
//
// Handles `promotion.updated` from grit-inventory: upserts (or deletes, when
// `deleted` or `!is_active`) the local `PromotionRule` cache row that
// lib/promotions.ts evaluates at checkout — including the rule's
// `excluded_promotion_ids`, cached verbatim as `excludedRuleIds`. Also
// handles `discount_policy.updated`: updates the tenant's synced
// `discountStackingPolicy`. grit-pos is offline-first and never calls
// another app live at sale time, so this webhook — syncing both ahead of
// time — is the only way a promotion rule or the stacking policy ever
// reaches the register (see PromotionRule/Tenant's schema.prisma doc
// comments and lib/promotions.ts's resolution step).
//
// Tenancy: the envelope's `organization_id` is used directly as
// `PromotionRule.tenantId` (opaque text, matched by equality) — the same
// convention this app's outbound events use in the other direction (see
// lib/events.ts / lib/velocity.ts doc comments).
//
// Idempotency: no separate dedupe-by-`event_id` table. Both branches below
// (upsert keyed on `id = promotion_id`, delete-if-exists) are naturally
// idempotent — a redelivered/replayed event just re-applies the same end
// state, so there's nothing a dedupe marker would additionally protect here.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
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

  try {
    switch (event.event) {
      case "promotion.updated": {
        const result = await handlePromotionUpdated(event as PromotionUpdatedEvent);
        return NextResponse.json(result);
      }
      case "discount_policy.updated": {
        const result = await handleDiscountPolicyUpdated(event as DiscountPolicyUpdatedEvent);
        return NextResponse.json(result);
      }
      default:
        // Not (yet) a consumer of this event type — acknowledge so the
        // publisher doesn't treat it as a delivery failure and keep retrying.
        return NextResponse.json({ ok: true, ignored: event.event });
    }
  } catch (err) {
    console.error("Failed to process", event.event, event.event_id, err);
    return NextResponse.json({ error: "Internal error handling webhook" }, { status: 500 });
  }
}

async function handlePromotionUpdated(event: PromotionUpdatedEvent) {
  const { organization_id, data } = event;

  if (data.deleted || !data.is_active) {
    // No-op if the row doesn't exist (already removed by an earlier
    // delivery, or was never synced in the first place).
    await prisma.promotionRule.deleteMany({ where: { id: data.promotion_id } });
    return { ok: true, action: "removed" as const, promotion_id: data.promotion_id };
  }

  const shared = {
    tenantId: organization_id,
    name: data.name,
    type: data.type,
    isActive: data.is_active,
    startsAt: data.starts_at ? new Date(data.starts_at) : null,
    endsAt: data.ends_at ? new Date(data.ends_at) : null,
    buyQuantity: data.buy_quantity ?? null,
    payQuantity: data.pay_quantity ?? null,
    minQuantity: data.min_quantity ?? null,
    discountKind: data.discount_kind ?? null,
    discountValue: data.discount_value ?? null,
    bundlePrice: data.bundle_price ?? null,
    items: data.items as unknown as object,
    // Absent/omitted on the wire means "no exclusions" (see
    // PromotionUpdatedData.excluded_promotion_ids's doc comment).
    excludedRuleIds: (data.excluded_promotion_ids ?? []) as unknown as object,
  };

  await prisma.promotionRule.upsert({
    where: { id: data.promotion_id },
    create: { id: data.promotion_id, ...shared },
    update: shared,
  });
  return { ok: true, action: "synced" as const, promotion_id: data.promotion_id };
}

/**
 * Tenant-wide, so unlike `promotion.updated` there's no per-row upsert/delete
 * — just an update of the tenant's own synced setting. `updateMany` (not
 * `update`) so a webhook for a `organization_id` this POS instance has never
 * seen (no matching Tenant row) is a no-op rather than a throw.
 */
async function handleDiscountPolicyUpdated(event: DiscountPolicyUpdatedEvent) {
  const { organization_id, data } = event;

  const result = await prisma.tenant.updateMany({
    where: { id: organization_id },
    data: { discountStackingPolicy: data.policy },
  });
  return {
    ok: true,
    action: result.count > 0 ? ("synced" as const) : ("ignored_unknown_tenant" as const),
    organization_id,
  };
}
