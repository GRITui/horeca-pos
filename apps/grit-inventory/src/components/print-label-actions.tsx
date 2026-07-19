"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Screen-only controls above the label: browser print + "mark as printed". */
export function PrintLabelActions({ labelId, printedAt }: { labelId: string; printedAt: string | null }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localPrintedAt, setLocalPrintedAt] = useState(printedAt);

  async function markPrinted() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/parcel-labels/${labelId}`, { method: "PATCH" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to update");
      setLocalPrintedAt(data.label.printedAt ?? new Date().toISOString());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <span className="text-xs text-zinc-500">{localPrintedAt ? "Printed" : "Not printed yet"}</span>
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        Print
      </button>
      <button
        type="button"
        disabled={loading}
        onClick={markPrinted}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {loading ? "Saving..." : "Mark as printed"}
      </button>
    </div>
  );
}
