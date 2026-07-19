"use client";

import type { OrderDTO } from "./types";
import { formatMoney } from "./format";

export default function CartPanel({
  order,
  editable,
  busyLineId,
  onIncrement,
  onDecrement,
  onRemove,
}: {
  order: OrderDTO;
  editable: boolean;
  busyLineId: string | null;
  onIncrement: (lineId: string, quantity: number) => void;
  onDecrement: (lineId: string, quantity: number) => void;
  onRemove: (lineId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {order.lines.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No items yet — tap a product to add it.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {order.lines.map((line) => {
            const busy = busyLineId === line.id;
            return (
              <li
                key={line.id}
                className="flex items-start justify-between gap-3 border-b border-zinc-100 pb-3 dark:border-zinc-900"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {line.productName}
                    {line.variantName ? ` — ${line.variantName}` : ""}
                  </p>
                  {line.addOns.length > 0 && (
                    <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                      + {line.addOns.map((a) => a.name).join(", ")}
                    </p>
                  )}
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {formatMoney(line.unitPrice)} each
                  </p>
                </div>

                <div className="flex flex-col items-end gap-2">
                  <span className="text-sm font-semibold tabular-nums">
                    {formatMoney(line.lineTotal)}
                  </span>
                  {editable ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onDecrement(line.id, line.quantity)}
                        className="h-6 w-6 rounded border border-zinc-300 text-sm leading-none disabled:opacity-50 dark:border-zinc-700"
                        aria-label="Decrease quantity"
                      >
                        −
                      </button>
                      <span className="w-4 text-center text-sm tabular-nums">
                        {line.quantity}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onIncrement(line.id, line.quantity)}
                        className="h-6 w-6 rounded border border-zinc-300 text-sm leading-none disabled:opacity-50 dark:border-zinc-700"
                        aria-label="Increase quantity"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRemove(line.id)}
                        className="ml-1 text-xs text-red-600 underline disabled:opacity-50 dark:text-red-400"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      Qty {line.quantity}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
