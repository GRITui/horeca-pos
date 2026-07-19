import Link from "next/link";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function DeliveriesPage() {
  const session = await requireSession();
  const deliveries = await db.delivery.findMany({
    where: { tenantId: session.tenantId },
    include: { order: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <PageHeader title="Deliveries" description="Manual staff-tracked delivery status." />

      {deliveries.length === 0 ? (
        <EmptyState message="No deliveries yet — deliveries are created automatically when an order is marked fulfilled." />
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="px-4 py-3 font-medium">Address</th>
                <th className="px-4 py-3 font-medium">Assigned to</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/deliveries/${delivery.id}`}
                      className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
                    >
                      #{delivery.order.orderNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{delivery.address ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{delivery.assignedTo ?? "—"}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={delivery.status} />
                  </td>
                  <td className="px-4 py-3 text-zinc-500">{formatDate(delivery.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}
    </div>
  );
}
