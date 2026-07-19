import { NextResponse } from "next/server";
import { after } from "next/server";
import { Decimal } from "@prisma/client/runtime/client";
import { publishTransactionCompleted } from "@/lib/events";
import { checkVelocitySurge } from "@/lib/velocity";
import { requireTenantId } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { OrderStatus, PaymentStatus, TenderType } from "@/app/generated/prisma/enums";
import { errorResponse, HttpError, readJsonBody } from "../../_lib/http";
import {
  computeOrderDiscount,
  computeOrderVat,
  findOrderForTenant,
  orderInclude,
  serializeOrder,
} from "../../_lib/queries";
import { parseMoneyInput, sumDecimals } from "../../_lib/pricing";

// Stripe is a valid TenderType in the schema (for future online/QR-link
// checkout flows) but isn't a real option at a staff-operated register.
const STAFF_TENDER_TYPES: TenderType[] = [TenderType.cash, TenderType.card, TenderType.qr_pay];

interface TenderBody {
  tenderType?: string;
  amount?: number | string;
}

/**
 * POST /api/orders/[orderId]/tender — records a Payment against the order.
 * Supports split tender: an order stays `tendered` until cumulative
 * successful payments cover the subtotal, at which point it flips to
 * `closed`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const tenantId = await requireTenantId();
    const { orderId } = await params;
    const body = await readJsonBody<TenderBody>(request);

    if (
      !body.tenderType ||
      !STAFF_TENDER_TYPES.includes(body.tenderType as TenderType)
    ) {
      throw new HttpError(
        400,
        `tenderType must be one of: ${STAFF_TENDER_TYPES.join(", ")}`,
      );
    }
    const tenderType = body.tenderType as TenderType;

    let amount;
    try {
      amount = parseMoneyInput(body.amount);
    } catch {
      throw new HttpError(400, "amount must be a positive number");
    }
    if (!amount.isPositive()) {
      throw new HttpError(400, "amount must be greater than zero");
    }

    // Everything below runs inside one transaction that first takes a
    // Postgres row lock on the order. Without this, two concurrent tenders
    // on the same order (a double-clicked "Pay" button, a client retry after
    // a slow response, or a race with an offline-sync replay landing on the
    // same order) could each read the same "not yet fully paid" snapshot,
    // both create a Payment, and both flip the order to `closed` — double-
    // booking the payment and firing `transaction.completed` twice. The lock
    // serializes concurrent writers so the second one observes the first
    // writer's committed payment before deciding whether the order is now
    // fully paid.
    const { isFullyPaid, changeDue, amountDue } = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;

        const order = await tx.order.findFirst({
          where: { id: orderId, tenantId },
          include: orderInclude,
        });
        if (!order) {
          throw new HttpError(404, "Order not found");
        }
        if (order.status !== OrderStatus.open && order.status !== OrderStatus.tendered) {
          throw new HttpError(409, `Cannot tender an order with status "${order.status}"`);
        }
        if (order.lines.length === 0) {
          throw new HttpError(400, "Cannot tender an empty order");
        }

        const subtotal = sumDecimals(order.lines.map((l) => l.lineTotal));
        // Promotions reduce what's actually owed (a distinct order-total
        // adjustment, not a mutation of line pricing — see
        // computeOrderDiscount's doc comment), so "fully paid" must be judged
        // against subtotal minus the current discount, not the raw subtotal.
        const { totalDiscount } = await computeOrderDiscount(tenantId, order.lines);
        const amountDueRaw = subtotal.minus(totalDiscount);
        const amountDue = amountDueRaw.isNegative() ? new Decimal(0) : amountDueRaw;
        const priorPaid = sumDecimals(
          order.payments.filter((p) => p.status === PaymentStatus.succeeded).map((p) => p.amount),
        );
        const totalPaid = priorPaid.plus(amount);
        const isFullyPaid = totalPaid.greaterThanOrEqualTo(amountDue);
        const changeDue = isFullyPaid ? totalPaid.minus(amountDue) : new Decimal(0);

        await tx.payment.create({
          data: {
            orderId,
            tenderType,
            amount,
            status: PaymentStatus.succeeded,
          },
        });
        // Note: `channel` is deliberately left untouched here. Staff can
        // tender any in-progress order regardless of how it originated (a QR
        // dine-in order or an abandoned pickup_link order can both be
        // collected at the register), and forcing channel to "dine_in" on
        // every tender would silently destroy that provenance — which is the
        // only source of truth for channel-based reporting, since QR orders
        // have no other checkout path that could have preserved it.
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: isFullyPaid ? OrderStatus.closed : OrderStatus.tendered,
          },
        });

        return { isFullyPaid, changeDue, amountDue };
      },
    );

    const updated = await findOrderForTenant(tenantId, orderId);
    if (!updated) throw new HttpError(500, "Failed to reload order after tendering");

    // Grit BizSuite events — published fire-and-forget AFTER the response
    // (the tender DB transaction above has committed); event plumbing can
    // never block or fail checkout. `amountDue` (post-discount) is reported
    // as the transaction total, not the raw line subtotal — it's what was
    // actually charged.
    if (isFullyPaid) {
      const { vatAmount } = computeOrderVat(updated.lines, updated.tenant.vatRate);
      after(async () => {
        await publishTransactionCompleted({
          tenantId,
          orderId,
          totalAmount: Number(amountDue),
          taxAmount: Number(vatAmount),
          lines: updated.lines.map((line) => ({
            productId: line.productId,
            variantSku: line.variant?.sku ?? null,
            quantity: line.quantity,
            unitPrice: Number(line.unitPrice),
          })),
        });
        await checkVelocitySurge(tenantId);
      });
    }

    return NextResponse.json({
      order: await serializeOrder(updated),
      changeDue: Number(changeDue),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
