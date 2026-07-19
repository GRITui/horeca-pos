"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CatalogCategoryDTO, OrderDTO, TableOption } from "./types";
import { formatMoney } from "./format";
import { createOrder } from "./api";
import QuickSalePanel from "./QuickSalePanel";

const STATUS_LABEL: Record<OrderDTO["status"], string> = {
  open: "Open",
  tendered: "Partially paid",
  closed: "Closed",
  cancelled: "Cancelled",
};

const STATUS_BADGE: Record<OrderDTO["status"], string> = {
  open: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
  tendered: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  closed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  cancelled: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
};

export default function OrderDashboard({
  initialOrders,
  tables,
  tablesEnabled = true,
  offlineEnabled = false,
  catalog = [],
}: {
  initialOrders: OrderDTO[];
  tables: TableOption[];
  /** "hospitality.tables" plugin trait — hides the table picker when off. */
  tablesEnabled?: boolean;
  /** pos.offline_mode entitlement — enables the offline quick-sale flow. */
  offlineEnabled?: boolean;
  /** Catalog for the quick-sale panel (only passed when offline mode is on). */
  catalog?: CatalogCategoryDTO[];
}) {
  const router = useRouter();
  const [selectedTableId, setSelectedTableId] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [showQuickSale, setShowQuickSale] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleNewOrder() {
    setCreating(true);
    setError(null);
    try {
      const { order } = await createOrder(selectedTableId || null);
      router.push(`/pos/${order.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a new order");
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-lg font-semibold">Start a new order</h2>
        <div className="flex flex-wrap items-center gap-3">
          {/* Table picker is a "hospitality.tables" plugin-trait surface. */}
          {tablesEnabled && (
            <select
              value={selectedTableId}
              onChange={(e) => setSelectedTableId(e.target.value)}
              className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">No table (walk-in / counter)</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={handleNewOrder}
            disabled={creating}
            className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
          >
            {creating ? "Starting…" : "New order"}
          </button>
          {offlineEnabled && (
            <button
              onClick={() => {
                setNotice(null);
                setShowQuickSale(true);
              }}
              className="rounded border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700"
            >
              Quick sale
            </button>
          )}
        </div>
        {notice && (
          <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
            {notice}
          </p>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">In-progress orders</h2>
        {initialOrders.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No open orders right now.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {initialOrders.map((order) => (
              <li key={order.id}>
                <button
                  onClick={() => router.push(`/pos/${order.id}`)}
                  className="flex w-full items-center justify-between rounded-lg border border-zinc-200 p-4 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                >
                  <div>
                    <p className="font-medium">
                      {order.tableLabel ?? "Walk-in / counter"}
                    </p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {order.lines.length} item{order.lines.length === 1 ? "" : "s"} ·{" "}
                      {new Date(order.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_BADGE[order.status]}`}
                    >
                      {STATUS_LABEL[order.status]}
                    </span>
                    <span className="font-semibold tabular-nums">
                      {formatMoney(order.subtotal)}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showQuickSale && (
        <QuickSalePanel
          catalog={catalog}
          onClose={() => setShowQuickSale(false)}
          onDone={({ queued }) => {
            setShowQuickSale(false);
            setNotice(
              queued
                ? "Offline — sale queued. It will sync automatically when back online."
                : "Cash sale recorded.",
            );
            if (!queued) router.refresh();
          }}
        />
      )}
    </div>
  );
}
