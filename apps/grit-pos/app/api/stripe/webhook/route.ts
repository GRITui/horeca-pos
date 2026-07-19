import { NextResponse } from "next/server";
import { after } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
import { OrderStatus, PaymentStatus, TenderType } from "@/app/generated/prisma/enums";
import { verifyStripeWebhook } from "@/lib/stripe";
import { rateLimit } from "@/lib/rateLimit";
import { publishTransactionCompleted } from "@/lib/events";
import { checkVelocitySurge } from "@/lib/velocity";
import { computeOrderVat } from "@/app/api/orders/_lib/queries";

// POST /api/stripe/webhook
//
// Confirms pickup-link orders once Stripe reports a Checkout Session as
// paid. The signature is verified via verifyStripeWebhook() BEFORE the raw
// body is ever parsed/trusted as JSON — see lib/stripe.ts. This endpoint is
// called server-to-server by Stripe (not a customer's browser), so unlike
// app/api/pickup/** it intentionally does not apply cors() — CORS is a
// browser-enforced mechanism and Stripe's webhook delivery never sends an
// Origin header or preflight request, so it would be a no-op here. A
// generous IP-independent-ish rate limit is still applied defensively.

// How far out from payment confirmation to promise a pickup order is ready.
const PICKUP_PREP_TIME_MINUTES = 20;

function computePromisedAt(): Date {
  return new Date(Date.now() + PICKUP_PREP_TIME_MINUTES * 60_000);
}

/** Confirms the Order backing a paid Checkout Session (idempotent on retries). */
async function confirmPickupOrder(session: Stripe.Checkout.Session) {
  const orderId = session.metadata?.orderId;
  if (!orderId) {
    console.error("Stripe checkout.session has no metadata.orderId; ignoring", session.id);
    return;
  }

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  if (!paymentIntentId) {
    console.error("Stripe checkout.session has no payment_intent; ignoring", session.id);
    return;
  }

  const amount = new Prisma.Decimal((session.amount_total ?? 0) / 100);

  // Idempotency: Stripe may redeliver the same event (or send both
  // checkout.session.completed and .async_payment_succeeded for the same
  // payment) — never double-record the payment or re-derive promisedAt.
  //
  // stripePaymentIntentId has no DB-level unique constraint (unlike
  // externalRef on the offline-sync path), so a plain check-then-act here
  // would race: two concurrent deliveries for the same payment intent could
  // both pass the "not found" check before either insert commits. A
  // Postgres advisory lock keyed on the payment intent id — held for the
  // rest of this transaction — serializes concurrent deliveries so the
  // second one's re-check inside the lock reliably observes the first's
  // committed Payment and skips creating a duplicate.
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${paymentIntentId})::bigint)`;

    const existingPayment = await tx.payment.findFirst({
      where: { stripePaymentIntentId: paymentIntentId },
      select: { id: true },
    });
    if (existingPayment) return { duplicate: true } as const;

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) {
      console.error("Stripe checkout.session references unknown order", orderId);
      return { duplicate: true } as const;
    }

    // Only advance a still-open order — don't clobber an order a staff
    // member already cancelled/closed out in the meantime.
    if (order.status === OrderStatus.open) {
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.tendered, promisedAt: computePromisedAt() },
      });
    }

    await tx.payment.create({
      data: {
        orderId: order.id,
        tenderType: TenderType.stripe,
        amount,
        status: PaymentStatus.succeeded,
        stripePaymentIntentId: paymentIntentId,
      },
    });

    return { duplicate: false } as const;
  });

  // A duplicate delivery (or a reference to an order that no longer exists)
  // already had its transaction.completed published by the delivery that
  // first recorded the payment — never re-derive/re-publish here.
  if (outcome.duplicate) return;

  // Grit BizSuite events — the payment transaction above has committed, so
  // fire transaction.completed AFTER the webhook response when this payment
  // made the order fully paid. Fire-and-forget: event plumbing must never
  // fail Stripe confirmation (a 500 here would trigger Stripe redelivery).
  const paid = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      tenant: { select: { vatRate: true } },
      lines: { include: { variant: { select: { sku: true, vatApplicable: true } } } },
      payments: { where: { status: PaymentStatus.succeeded }, select: { amount: true } },
    },
  });
  if (!paid || paid.lines.length === 0) return;

  const subtotal = paid.lines.reduce((sum, l) => sum.plus(l.lineTotal), new Prisma.Decimal(0));
  const paidTotal = paid.payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
  if (!paidTotal.greaterThanOrEqualTo(subtotal)) return;

  const { vatAmount } = computeOrderVat(paid.lines, paid.tenant.vatRate);

  after(async () => {
    await publishTransactionCompleted({
      tenantId: paid.tenantId,
      orderId: paid.id,
      totalAmount: Number(subtotal),
      taxAmount: Number(vatAmount),
      lines: paid.lines.map((line) => ({
        productId: line.productId,
        variantSku: line.variant?.sku ?? null,
        quantity: line.quantity,
        unitPrice: Number(line.unitPrice),
      })),
    });
    await checkVelocitySurge(paid.tenantId);
  });
}

/** Cancels a still-open pickup order whose checkout never completed. */
async function cancelAbandonedPickupOrder(session: Stripe.Checkout.Session) {
  const orderId = session.metadata?.orderId;
  if (!orderId) return;

  await prisma.order.updateMany({
    where: { id: orderId, status: OrderStatus.open },
    data: { status: OrderStatus.cancelled },
  });
}

export async function POST(request: Request) {
  // Defensive rate limit — Stripe's own retry policy is well-behaved, but
  // this keeps a misbehaving/forged flood of requests from hammering the DB.
  const limitResult = rateLimit(request, { limit: 120, windowMs: 60_000 });
  if (!limitResult.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe-Signature header" }, { status: 400 });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set; refusing to process webhook");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // Raw body text is required for signature verification — must not be
  // JSON-parsed (and therefore re-serialized/mutated) before this point.
  const payload = await request.text();

  const verified = await verifyStripeWebhook(payload, signature, secret);
  if (!verified) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Only safe to parse/trust the payload as a Stripe event once its
  // signature has been verified above.
  let event: Stripe.Event;
  try {
    event = JSON.parse(payload) as Stripe.Event;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // For redirect-based payment methods this already reflects the
        // final state; for delayed/async methods payment_status stays
        // "unpaid" here and is confirmed later via async_payment_succeeded.
        if (session.payment_status === "paid") {
          await confirmPickupOrder(session);
        }
        break;
      }
      case "checkout.session.async_payment_succeeded": {
        await confirmPickupOrder(event.data.object as Stripe.Checkout.Session);
        break;
      }
      case "checkout.session.expired":
      case "checkout.session.async_payment_failed": {
        await cancelAbandonedPickupOrder(event.data.object as Stripe.Checkout.Session);
        break;
      }
      default:
        // Ignore everything else — this endpoint only cares about pickup
        // Checkout Session outcomes.
        break;
    }
  } catch (err) {
    console.error("Error handling Stripe webhook event", event.type, err);
    return NextResponse.json({ error: "Internal error handling webhook" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
