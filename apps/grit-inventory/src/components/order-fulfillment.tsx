"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useBarcodeScanner } from "@/lib/useBarcodeScanner";

type TaskStatus = "pending" | "in_progress" | "complete";

export type PickItem = {
  id: string;
  sku: string;
  name: string;
  locationCode: string | null;
  quantityRequired: number;
  quantityPicked: number;
};

export type PackItem = {
  id: string;
  sku: string;
  name: string;
  quantityRequired: number;
  quantityPacked: number;
};

export type PickTaskData = { id: string; status: TaskStatus; items: PickItem[] };
export type PackTaskData = { id: string; status: TaskStatus; items: PackItem[] };
export type ParcelLabelData = { id: string; trackingRef: string; printedAt: string | null };

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

/**
 * Scan input for one task: a real keyboard-wedge scanner (via
 * useBarcodeScanner) fires the same handler as the fallback text
 * input+button, so this works both with hardware and for manual testing.
 */
function ScanBox({ onScan, disabled }: { onScan: (sku: string) => void; disabled?: boolean }) {
  const [value, setValue] = useState("");
  useBarcodeScanner({ onScan, enabled: !disabled });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const sku = value.trim();
        if (!sku) return;
        onScan(sku);
        setValue("");
      }}
      className="flex gap-2"
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Scan or type a SKU..."
        disabled={disabled}
        autoComplete="off"
        className="flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
      <button
        type="submit"
        disabled={disabled}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        Scan
      </button>
    </form>
  );
}

function ChecklistTable({
  items,
  progress,
  showLocation,
}: {
  items: (PickItem | PackItem)[];
  progress: (item: PickItem | PackItem) => number;
  showLocation: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-zinc-500">
            <th className="px-3 py-2">SKU</th>
            {showLocation && <th className="px-3 py-2">Location</th>}
            <th className="px-3 py-2 text-right">Progress</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const picked = progress(item);
            const done = picked >= item.quantityRequired;
            return (
              <tr key={item.id} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="px-3 py-2">
                  <div className="font-mono text-xs">{item.sku}</div>
                  <div className="text-zinc-500">{item.name}</div>
                </td>
                {showLocation && (
                  <td className="px-3 py-2 font-mono text-xs">
                    {"locationCode" in item ? item.locationCode ?? "—" : "—"}
                  </td>
                )}
                <td
                  className={`px-3 py-2 text-right font-medium ${
                    done ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-700 dark:text-zinc-300"
                  }`}
                >
                  {picked} / {item.quantityRequired}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Picking -> packing -> label workflow for an order in `fulfilling`. Each
 * successful action calls `router.refresh()`, which re-runs the server
 * component and hands this component fresh task/label props — no local
 * task-state duplication needed.
 */
export function OrderFulfillment({
  orderId,
  pickTask,
  packTask,
  latestLabel,
}: {
  orderId: string;
  pickTask: PickTaskData | null;
  packTask: PackTaskData | null;
  latestLabel: ParcelLabelData | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setLoading(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  const buttonClass =
    "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900";

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600">{error}</p>}

      {!pickTask && (
        <button
          type="button"
          disabled={loading}
          onClick={() => run(() => postJson(`/api/orders/${orderId}/pick-task`))}
          className={buttonClass}
        >
          Start picking
        </button>
      )}

      {pickTask && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Picking</h3>
            <span className="text-xs text-zinc-500">{pickTask.status.replace(/_/g, " ")}</span>
          </div>
          <ChecklistTable items={pickTask.items} progress={(i) => (i as PickItem).quantityPicked} showLocation />
          {pickTask.status !== "complete" && (
            <ScanBox
              disabled={loading}
              onScan={(sku) => run(() => postJson(`/api/pick-tasks/${pickTask.id}/scan`, { sku }))}
            />
          )}
        </div>
      )}

      {pickTask?.status === "complete" && !packTask && (
        <button
          type="button"
          disabled={loading}
          onClick={() => run(() => postJson(`/api/orders/${orderId}/pack-task`))}
          className={buttonClass}
        >
          Start packing
        </button>
      )}

      {packTask && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Packing</h3>
            <span className="text-xs text-zinc-500">{packTask.status.replace(/_/g, " ")}</span>
          </div>
          <ChecklistTable
            items={packTask.items}
            progress={(i) => (i as PackItem).quantityPacked}
            showLocation={false}
          />
          {packTask.status !== "complete" && (
            <ScanBox
              disabled={loading}
              onScan={(sku) => run(() => postJson(`/api/pack-tasks/${packTask.id}/scan`, { sku }))}
            />
          )}
        </div>
      )}

      {packTask?.status === "complete" && !latestLabel && (
        <button
          type="button"
          disabled={loading}
          onClick={() => run(() => postJson(`/api/orders/${orderId}/parcel-label`))}
          className={buttonClass}
        >
          Generate label
        </button>
      )}

      {latestLabel && (
        <div className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <div className="text-sm">
            <div className="font-mono">{latestLabel.trackingRef}</div>
            <div className="text-xs text-zinc-500">{latestLabel.printedAt ? "Printed" : "Not printed yet"}</div>
          </div>
          <Link
            href={`/admin/orders/${orderId}/label/${latestLabel.id}`}
            target="_blank"
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900"
          >
            Print label
          </Link>
        </div>
      )}
    </div>
  );
}
