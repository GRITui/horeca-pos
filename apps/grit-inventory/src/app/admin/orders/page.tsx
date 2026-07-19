import Link from "next/link";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { Card, EmptyState, LinkButton, PageHeader, StatusBadge } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/format";
import { OrderStatus } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const ORDER_STATUSES = Object.values(OrderStatus);

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await requireSession();
  const params = await searchParams;

  const statusParam = typeof params.status === "string" ? params.status : undefined;
  const status = ORDER_STATUSES.find((s) => s === statusParam);
  const q = typeof params.q === "string" ? params.q.trim() : "";
  const pageParam = typeof params.page === "string" ? parseInt(params.page, 10) : 1;
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const where: Prisma.OrderWhereInput = {
    tenantId: session.tenantId,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { orderNumber: { contains: q, mode: "insensitive" } },
            { customerName: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const orders = await db.order.findMany({
    where,
    include: { lines: true },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE + 1,
  });
  const hasNextPage = orders.length > PAGE_SIZE;
  const pageOrders = orders.slice(0, PAGE_SIZE);

  const buildHref = (overrides: { status?: string; q?: string; page?: number }) => {
    const next = new URLSearchParams();
    const nextStatus = overrides.status !== undefined ? overrides.status : (status ?? "");
    const nextQ = overrides.q !== undefined ? overrides.q : q;
    const nextPage = overrides.page !== undefined ? overrides.page : page;
    if (nextStatus) next.set("status", nextStatus);
    if (nextQ) next.set("q", nextQ);
    if (nextPage > 1) next.set("page", String(nextPage));
    const qs = next.toString();
    return qs ? `/admin/orders?${qs}` : "/admin/orders";
  };

  return (
    <div>
      <PageHeader
        title="Orders"
        description="Staff-entered orders and fulfillment status."
        action={<LinkButton href="/admin/orders/new">New order</LinkButton>}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form action="/admin/orders" className="flex items-center gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search order # or customer"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Search
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <Link
            href={buildHref({ status: "", page: 1 })}
            className={`rounded-full px-3 py-1 ${
              !status ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            All
          </Link>
          {ORDER_STATUSES.map((s) => (
            <Link
              key={s}
              href={buildHref({ status: s, page: 1 })}
              className={`rounded-full px-3 py-1 ${
                status === s ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              }`}
            >
              {s.replace(/_/g, " ")}
            </Link>
          ))}
        </div>
      </div>

      {pageOrders.length === 0 ? (
        <EmptyState message={q || status ? "No orders match this filter." : "No orders yet."} />
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="px-4 py-3 font-medium">Customer</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {pageOrders.map((order) => {
                const total = order.lines.reduce((sum, l) => sum + Number(l.unitPrice) * l.quantity, 0);
                return (
                  <tr key={order.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800">
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/orders/${order.id}`}
                        className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
                      >
                        #{order.orderNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{order.customerName ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-zinc-600 dark:text-zinc-400">{formatCurrency(total)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={order.status} />
                    </td>
                    <td className="px-4 py-3 text-zinc-500">{formatDate(order.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </Card>
      )}

      {(page > 1 || hasNextPage) && (
        <div className="mt-4 flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={buildHref({ page: page - 1 })} className="font-medium text-zinc-700 hover:underline dark:text-zinc-300">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-zinc-500">Page {page}</span>
          {hasNextPage ? (
            <Link href={buildHref({ page: page + 1 })} className="font-medium text-zinc-700 hover:underline dark:text-zinc-300">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
