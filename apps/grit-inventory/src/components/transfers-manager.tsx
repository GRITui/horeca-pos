"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui";
import { formatDate } from "@/lib/format";

export type TransferStoreOption = { id: string; name: string };
export type TransferVariantOption = { id: string; sku: string; name: string; productName: string };

export type TransferRow = {
  id: string;
  status: string;
  createdAt: string;
  fromStore: { id: string; name: string };
  toStore: { id: string; name: string };
  items: Array<{ id: string; quantity: number; variant: { sku: string; name: string } }>;
};

const inputClass =
  "rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";

const NEXT_ACTIONS: Record<string, Array<{ to: string; label: string; danger?: boolean }>> = {
  draft: [
    { to: "in_transit", label: "Dispatch" },
    { to: "cancelled", label: "Cancel", danger: true },
  ],
  in_transit: [
    { to: "received", label: "Mark received" },
    { to: "cancelled", label: "Cancel (restore source)", danger: true },
  ],
  received: [],
  cancelled: [],
};

function TransferActions({ transfer }: { transfer: TransferRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actions = NEXT_ACTIONS[transfer.status] ?? [];
  if (actions.length === 0) return null;

  async function transition(to: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/transfers/${transfer.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Transition failed");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {actions.map((action) => (
          <button
            key={action.to}
            type="button"
            disabled={busy}
            onClick={() => transition(action.to)}
            className={
              action.danger
                ? "text-sm font-medium text-red-600 hover:underline disabled:opacity-50"
                : "text-sm font-medium text-zinc-900 hover:underline disabled:opacity-50 dark:text-zinc-50"
            }
          >
            {action.label}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

type DraftItem = { variantId: string; quantity: string };

function CreateTransferForm({
  stores,
  variants,
}: {
  stores: TransferStoreOption[];
  variants: TransferVariantOption[];
}) {
  const router = useRouter();
  const [fromStoreId, setFromStoreId] = useState(stores[0]?.id ?? "");
  const [toStoreId, setToStoreId] = useState(stores[1]?.id ?? "");
  const [items, setItems] = useState<DraftItem[]>([
    { variantId: variants[0]?.id ?? "", quantity: "1" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function setItem(index: number, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (fromStoreId === toStoreId) {
      setError("Source and destination stores must differ");
      return;
    }
    const parsedItems = items
      .filter((i) => i.variantId)
      .map((i) => ({ variantId: i.variantId, quantity: Number(i.quantity) }));
    if (parsedItems.length === 0 || parsedItems.some((i) => !Number.isInteger(i.quantity) || i.quantity <= 0)) {
      setError("Every line needs a variant and a positive whole quantity");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromStoreId, toStoreId, items: parsedItems }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not create transfer");
        return;
      }
      setItems([{ variantId: variants[0]?.id ?? "", quantity: "1" }]);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">New transfer order</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">From</label>
          <select
            value={fromStoreId}
            onChange={(e) => setFromStoreId(e.target.value)}
            className={`mt-1 ${inputClass}`}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">To</label>
          <select
            value={toStoreId}
            onChange={(e) => setToStoreId(e.target.value)}
            className={`mt-1 ${inputClass}`}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              value={item.variantId}
              onChange={(e) => setItem(index, { variantId: e.target.value })}
              className={inputClass}
            >
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.productName} — {v.name} ({v.sku})
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              value={item.quantity}
              onChange={(e) => setItem(index, { quantity: e.target.value })}
              className={`w-24 ${inputClass}`}
            />
            {items.length > 1 && (
              <button
                type="button"
                onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                className="text-sm text-zinc-500 hover:underline"
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            setItems((prev) => [...prev, { variantId: variants[0]?.id ?? "", quantity: "1" }])
          }
          className="text-sm font-medium text-zinc-700 hover:underline dark:text-zinc-300"
        >
          + Add line
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy || variants.length === 0 || stores.length < 2}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {busy ? "Creating…" : "Create draft transfer"}
      </button>
      {stores.length < 2 && (
        <p className="text-sm text-zinc-500">Create a second store before raising transfers.</p>
      )}
    </form>
  );
}

export function TransfersManager({
  transfers,
  stores,
  variants,
}: {
  transfers: TransferRow[];
  stores: TransferStoreOption[];
  variants: TransferVariantOption[];
}) {
  return (
    <div className="space-y-4">
      <CreateTransferForm stores={stores} variants={variants} />

      {transfers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No transfer orders yet.
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Route</th>
                <th className="px-4 py-3 font-medium">Items</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {transfers.map((transfer) => (
                <tr
                  key={transfer.id}
                  className="border-b border-zinc-100 align-top last:border-0 dark:border-zinc-800"
                >
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {formatDate(transfer.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-zinc-900 dark:text-zinc-50">
                    {transfer.fromStore.name} → {transfer.toStore.name}
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                    {transfer.items.map((item) => (
                      <div key={item.id}>
                        {item.quantity} × {item.variant.sku}
                      </div>
                    ))}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={transfer.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <TransferActions transfer={transfer} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
