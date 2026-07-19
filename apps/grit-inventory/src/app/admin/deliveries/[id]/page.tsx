import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { DeliveryActions } from "@/components/delivery-actions";

export const dynamic = "force-dynamic";

export default async function DeliveryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;

  const delivery = await db.delivery.findFirst({
    where: { id, tenantId: session.tenantId },
    include: { order: true, statusHistory: { orderBy: { createdAt: "desc" } } },
  });
  if (!delivery) notFound();

  return (
    <div>
      <PageHeader
        title={`Delivery for order #${delivery.order.orderNumber}`}
        action={<StatusBadge status={delivery.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Update status</h2>
            <div className="mt-3">
              <DeliveryActions deliveryId={delivery.id} status={delivery.status} assignedTo={delivery.assignedTo} />
            </div>
          </Card>

          <Card>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">History</h2>
            <ul className="mt-2 space-y-2 text-sm">
              {delivery.statusHistory.map((event) => (
                <li key={event.id} className="flex items-center justify-between border-b border-zinc-100 pb-2 last:border-0 dark:border-zinc-800">
                  <div>
                    <StatusBadge status={event.status} />
                    {event.note && <span className="ml-2 text-zinc-500">{event.note}</span>}
                  </div>
                  <span className="text-xs text-zinc-500">{formatDate(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <Card>
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Order</h2>
          <dl className="mt-2 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            <div>{delivery.order.customerName ?? "—"}</div>
            <div>{delivery.order.customerPhone ?? "—"}</div>
            <div>{delivery.address ?? delivery.order.customerAddress ?? "—"}</div>
          </dl>
          <Link
            href={`/admin/orders/${delivery.order.id}`}
            className="mt-3 inline-block text-sm font-medium text-zinc-700 hover:underline dark:text-zinc-300"
          >
            View order →
          </Link>
        </Card>
      </div>
    </div>
  );
}
