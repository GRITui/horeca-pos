import { NextResponse } from "next/server";
import { requireTenantId } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { OrderChannel, OrderStatus } from "@/app/generated/prisma/enums";
import { errorResponse, HttpError, readJsonBody } from "./_lib/http";
import { findOrderForTenant, listOrdersForTenant, serializeOrder } from "./_lib/queries";

const ALL_STATUSES = Object.values(OrderStatus);

function parseStatusFilter(searchParams: URLSearchParams): OrderStatus[] {
  const raw = searchParams.get("status");
  if (!raw) return [OrderStatus.open, OrderStatus.tendered];

  const requested = raw.split(",").map((s) => s.trim());
  const invalid = requested.filter((s) => !ALL_STATUSES.includes(s as OrderStatus));
  if (invalid.length > 0) {
    throw new HttpError(400, `Invalid status filter: ${invalid.join(", ")}`);
  }
  return requested as OrderStatus[];
}

/** GET /api/orders?status=open,tendered — list the tenant's orders (defaults to in-progress ones). */
export async function GET(request: Request) {
  try {
    const tenantId = await requireTenantId();
    const { searchParams } = new URL(request.url);
    const statuses = parseStatusFilter(searchParams);

    const orders = await listOrdersForTenant(tenantId, statuses);
    return NextResponse.json({ orders: await Promise.all(orders.map(serializeOrder)) });
  } catch (err) {
    return errorResponse(err);
  }
}

interface CreateOrderBody {
  tableId?: string | null;
}

/** POST /api/orders — opens a new dine-in order, optionally seated at a table. */
export async function POST(request: Request) {
  try {
    const tenantId = await requireTenantId();
    const body = await readJsonBody<CreateOrderBody>(request);

    let tableId: string | null = null;
    if (body.tableId) {
      const table = await prisma.table.findFirst({
        where: { id: body.tableId, tenantId },
        select: { id: true },
      });
      if (!table) {
        throw new HttpError(400, "Table not found");
      }
      tableId = table.id;
    }

    const created = await prisma.order.create({
      data: {
        tenantId,
        channel: OrderChannel.dine_in,
        status: OrderStatus.open,
        tableId,
      },
      select: { id: true },
    });

    const order = await findOrderForTenant(tenantId, created.id);
    if (!order) {
      // Should be unreachable — we just created it under the same tenantId.
      throw new HttpError(500, "Failed to load newly created order");
    }

    return NextResponse.json({ order: await serializeOrder(order) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
