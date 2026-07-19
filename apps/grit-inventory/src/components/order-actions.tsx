"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type OrderStatus = "pending" | "paid" | "fulfilling" | "fulfilled" | "cancelled";

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

function RecordPaymentForm({ orderId, total }: { orderId: string; total: number }) {
  const router = useRouter();
  const [method, setMethod] = useState("cash");
  const [amount, setAmount] = useState(total.toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await postJson(`/api/orders/${orderId}/payments`, { method, amount: Number(amount) });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Method</label>
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="mt-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="cash">Cash</option>
          <option value="card">Card</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Amount</label>
        <input
          type="number"
          step="0.01"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="mt-1 w-28 rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {loading ? "Recording..." : "Record payment"}
      </button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}

export function OrderActions({ orderId, status, total }: { orderId: string; status: OrderStatus; total: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function transition(to: OrderStatus, confirmMessage?: string) {
    if (confirmMessage && !confirm(confirmMessage)) return;
    setLoading(true);
    setError(null);
    try {
      await postJson(`/api/orders/${orderId}/transition`, { to });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  const buttonClass =
    "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900";
  const dangerClass =
    "rounded-md px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950/40";

  return (
    <div className="space-y-3">
      {status === "pending" && <RecordPaymentForm orderId={orderId} total={total} />}

      <div className="flex flex-wrap gap-2">
        {status === "paid" && (
          <button disabled={loading} onClick={() => transition("fulfilling")} className={buttonClass}>
            Start fulfillment
          </button>
        )}
        {status === "fulfilling" && (
          <button disabled={loading} onClick={() => transition("fulfilled")} className={buttonClass}>
            Mark fulfilled
          </button>
        )}
        {(status === "pending" || status === "paid" || status === "fulfilling") && (
          <button
            disabled={loading}
            onClick={() => transition("cancelled", "Cancel this order? This cannot be undone.")}
            className={dangerClass}
          >
            Cancel order
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
