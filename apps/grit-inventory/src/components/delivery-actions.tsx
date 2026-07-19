"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type DeliveryStatus = "assigned" | "out_for_delivery" | "delivered" | "failed";

const NEXT_STATUS: Partial<Record<DeliveryStatus, { to: DeliveryStatus; label: string }[]>> = {
  assigned: [{ to: "out_for_delivery", label: "Mark out for delivery" }],
  out_for_delivery: [
    { to: "delivered", label: "Mark delivered" },
    { to: "failed", label: "Mark failed" },
  ],
  failed: [{ to: "out_for_delivery", label: "Retry delivery" }],
};

export function DeliveryActions({
  deliveryId,
  status,
  assignedTo,
}: {
  deliveryId: string;
  status: DeliveryStatus;
  assignedTo: string | null;
}) {
  const router = useRouter();
  const [assignee, setAssignee] = useState(assignedTo ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function updateStatus(to: DeliveryStatus) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/deliveries/${deliveryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: to, note: note || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to update");
      setNote("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  async function saveAssignee() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/deliveries/${deliveryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedTo: assignee }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to update");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  const actions = NEXT_STATUS[status] ?? [];
  const inputClass =
    "rounded-md border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Assigned to</label>
          <input value={assignee} onChange={(e) => setAssignee(e.target.value)} className={`${inputClass} mt-1`} />
        </div>
        <button
          onClick={saveAssignee}
          disabled={loading}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Save
        </button>
      </div>

      {actions.length > 0 && (
        <div className="space-y-2">
          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400">Note (optional)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={`${inputClass} mt-1 w-full`} />
          </div>
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <button
                key={action.to}
                disabled={loading}
                onClick={() => updateStatus(action.to)}
                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
