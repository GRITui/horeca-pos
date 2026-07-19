"use client";

import { useMemo, useState } from "react";
import type { CatalogCategoryDTO } from "./types";
import { formatMoney } from "./format";
import { submitQuickSale } from "./api";
import type { QueuedLineInput } from "./offlineQueue";

interface DraftLine extends QueuedLineInput {
  name: string;
  unitPrice: number;
}

/**
 * Offline-first "quick sale": build a simple cash sale entirely client-side
 * (from the catalog already rendered into the dashboard) and submit order +
 * lines + cash tender as ONE idempotent op. Works identically online and
 * offline — when the network is down the op is queued in IndexedDB and
 * replayed by the sync loop (OfflineStatusChip).
 *
 * Deliberately simpler than the full register: no variants/add-ons, cash
 * only. Anything richer goes through the normal order flow.
 */
export default function QuickSalePanel({
  catalog,
  onClose,
  onDone,
}: {
  catalog: CatalogCategoryDTO[];
  onClose: () => void;
  onDone: (result: { queued: boolean }) => void;
}) {
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Quick sale keeps to base-price products (no variant/add-on modals).
  const products = useMemo(
    () => catalog.flatMap((c) => c.products.filter((p) => p.variants.length === 0)),
    [catalog],
  );

  const total = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

  function addProduct(productId: string, name: string, unitPrice: number) {
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === productId);
      if (existing) {
        return prev.map((l) =>
          l.productId === productId ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [...prev, { productId, variantId: null, addOnIds: [], quantity: 1, name, unitPrice }];
    });
  }

  function removeProduct(productId: string) {
    setLines((prev) =>
      prev
        .map((l) => (l.productId === productId ? { ...l, quantity: l.quantity - 1 } : l))
        .filter((l) => l.quantity > 0),
    );
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitQuickSale(
        lines.map(({ productId, variantId, addOnIds, quantity }) => ({
          productId,
          variantId,
          addOnIds,
          quantity,
        })),
        total,
        { queueOffline: true },
      );
      onDone({ queued: result.queued });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record quick sale");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-xl bg-white p-5 sm:rounded-xl dark:bg-zinc-950">
        <div>
          <h3 className="text-lg font-semibold">Quick sale (cash)</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Works offline — the sale is queued and synced automatically.
          </p>
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="grid max-h-[35vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
          {products.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => addProduct(p.id, p.name, p.basePrice)}
              className="flex flex-col items-start gap-0.5 rounded border border-zinc-200 p-2 text-left dark:border-zinc-800"
            >
              <span className="text-sm font-medium">{p.name}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {formatMoney(p.basePrice)}
              </span>
            </button>
          ))}
          {products.length === 0 && (
            <p className="col-span-full text-sm text-zinc-500 dark:text-zinc-400">
              No simple (variant-free) products available for quick sale.
            </p>
          )}
        </div>

        {lines.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800">
            {lines.map((l) => (
              <li key={l.productId} className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {l.quantity} × {l.name}
                </span>
                <span className="tabular-nums">{formatMoney(l.unitPrice * l.quantity)}</span>
                <button
                  type="button"
                  onClick={() => removeProduct(l.productId)}
                  className="text-xs text-red-600 underline dark:text-red-400"
                >
                  −1
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">Cash total</span>
          <span className="text-lg font-semibold tabular-nums">{formatMoney(total)}</span>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || lines.length === 0}
            onClick={handleSubmit}
            className="flex-1 rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
          >
            {submitting ? "Recording…" : "Record cash sale"}
          </button>
        </div>
      </div>
    </div>
  );
}
