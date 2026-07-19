import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertFeature } from "@grit/passport";
import { db } from "@/lib/db";
import { apiError } from "@/lib/api";
import { InsufficientStockError } from "@/lib/inventory";
import {
  InvalidTransferTransitionError,
  TransferNotFoundError,
  transitionTransfer,
} from "@/lib/transfers";
import { publishTransferCompleted } from "@/lib/events";
import { entitlementResponse, requireGritContext } from "@/lib/passport";

const transitionSchema = z.object({
  to: z.enum(["in_transit", "received", "cancelled"]),
});

/**
 * POST /api/transfers/[id]/transition — advance a transfer order:
 * draft -> in_transit (source store decremented, reason `transfer_out`),
 * in_transit -> received (destination incremented, reason `transfer_in`;
 * publishes `inventory.transfer_completed`), draft|in_transit -> cancelled
 * (an in_transit cancellation restores the source store).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireGritContext();
  try {
    assertFeature(ctx.grit, "inventory.transfers");
  } catch (err) {
    const res = entitlementResponse(err);
    if (res) return res;
    throw err;
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid transition");
  }

  try {
    const result = await db.$transaction((tx) =>
      transitionTransfer(tx, {
        tenantId: ctx.local.tenantId,
        transferId: id,
        to: parsed.data.to,
        actingUserId: ctx.local.sub,
      })
    );

    if (parsed.data.to === "received" && result.receivedItems) {
      // Published after commit; failures are logged, never surfaced.
      await publishTransferCompleted(ctx.local.tenantId, {
        transfer_id: result.transfer.id,
        from_location_id: result.transfer.fromStoreId,
        to_location_id: result.transfer.toStoreId,
        items: result.receivedItems,
      });
    }

    return NextResponse.json({ transfer: result.transfer });
  } catch (err) {
    if (err instanceof TransferNotFoundError) return apiError("Transfer not found", 404);
    if (err instanceof InvalidTransferTransitionError) return apiError(err.message, 409);
    if (err instanceof InsufficientStockError) {
      return apiError("Source store has insufficient stock for this transfer", 409);
    }
    throw err;
  }
}
