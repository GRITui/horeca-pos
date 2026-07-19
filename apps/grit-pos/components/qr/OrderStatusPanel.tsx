import type { SubmittedOrder } from "./types";

/** Read-only summary of the table's current (shared) open QR order, shown after a submit. */
export function OrderStatusPanel({ order }: { order: SubmittedOrder }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm dark:border-emerald-800 dark:bg-emerald-950">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-emerald-800 dark:text-emerald-300">
          Sent to the kitchen — table {order.tableLabel}
        </p>
        <span className="rounded-full bg-emerald-200 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-800 dark:text-emerald-100">
          {order.status}
        </span>
      </div>

      <ul className="flex flex-col gap-1">
        {order.lines.map((line) => (
          <li key={line.id} className="flex items-center justify-between gap-2">
            <span>
              {line.quantity}× {line.productName}
              {line.variantName ? ` (${line.variantName})` : ""}
              {line.addOns.length > 0 ? ` + ${line.addOns.map((a) => a.name).join(", ")}` : ""}
            </span>
            <span>{line.lineTotal.toFixed(2)}</span>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between border-t border-emerald-200 pt-2 font-semibold dark:border-emerald-800">
        <span>Order total so far</span>
        <span>{order.total.toFixed(2)}</span>
      </div>
    </div>
  );
}
