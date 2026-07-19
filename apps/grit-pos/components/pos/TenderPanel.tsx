"use client";

import { useState } from "react";
import type { OrderDTO } from "./types";
import { formatMoney } from "./format";

type TenderType = "cash" | "card" | "qr_pay";

const TENDER_OPTIONS: { value: TenderType; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "qr_pay", label: "QR pay" },
];

export default function TenderPanel({
  order,
  submitting,
  lastChangeDue,
  onCancel,
  onSubmit,
}: {
  order: OrderDTO;
  submitting: boolean;
  lastChangeDue: number | null;
  onCancel: () => void;
  onSubmit: (input: { tenderType: TenderType; amount: number }) => void;
}) {
  const [tenderType, setTenderType] = useState<TenderType>("cash");
  const [amount, setAmount] = useState(order.balanceDue.toFixed(2));

  const parsedAmount = Number(amount);
  const isValidAmount = Number.isFinite(parsedAmount) && parsedAmount > 0;

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-t-xl bg-white p-5 sm:rounded-xl dark:bg-zinc-950">
        <h3 className="text-lg font-semibold">Tender payment</h3>

        <div className="flex justify-between text-sm">
          <span className="text-zinc-500 dark:text-zinc-400">Order subtotal</span>
          <span className="tabular-nums">{formatMoney(order.subtotal)}</span>
        </div>
        <div className="flex justify-between text-sm text-zinc-500 dark:text-zinc-400">
          <span>Subtotal (excl. VAT)</span>
          <span className="tabular-nums">{formatMoney(order.subtotalExclVat)}</span>
        </div>
        <div className="flex justify-between text-sm text-zinc-500 dark:text-zinc-400">
          <span>VAT ({order.vatRate}%)</span>
          <span className="tabular-nums">{formatMoney(order.vatAmount)}</span>
        </div>
        {order.vatExemptSubtotal > 0 && (
          <div className="flex justify-between text-sm text-zinc-500 dark:text-zinc-400">
            <span>VAT-exempt items</span>
            <span className="tabular-nums">{formatMoney(order.vatExemptSubtotal)}</span>
          </div>
        )}
        {order.discountTotal > 0 && (
          <div className="flex justify-between text-sm text-emerald-700 dark:text-emerald-400">
            <span>Promotions</span>
            <span className="tabular-nums">-{formatMoney(order.discountTotal)}</span>
          </div>
        )}
        {order.paidTotal > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">Already paid</span>
            <span className="tabular-nums">{formatMoney(order.paidTotal)}</span>
          </div>
        )}
        <div className="flex justify-between text-base font-semibold">
          <span>Balance due</span>
          <span className="tabular-nums">{formatMoney(order.balanceDue)}</span>
        </div>

        {lastChangeDue !== null && lastChangeDue > 0 && (
          <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
            Change due from last payment: {formatMoney(lastChangeDue)}
          </p>
        )}

        <fieldset className="flex gap-2">
          <legend className="sr-only">Tender type</legend>
          {TENDER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setTenderType(opt.value)}
              className={`flex-1 rounded border px-3 py-2 text-sm font-medium ${
                tenderType === opt.value
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900"
                  : "border-zinc-300 dark:border-zinc-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </fieldset>

        <label className="flex flex-col gap-1 text-sm">
          Amount tendered
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="rounded border border-zinc-300 px-3 py-2 text-lg dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Close
          </button>
          <button
            type="button"
            disabled={submitting || !isValidAmount}
            onClick={() => onSubmit({ tenderType, amount: parsedAmount })}
            className="flex-1 rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
          >
            {submitting ? "Processing…" : "Record payment"}
          </button>
        </div>
      </div>
    </div>
  );
}
