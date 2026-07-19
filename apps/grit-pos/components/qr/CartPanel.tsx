"use client";

import type { CartItem } from "./types";

interface CartPanelProps {
  cart: CartItem[];
  onRemove: (key: string) => void;
  onChangeQuantity: (key: string, quantity: number) => void;
  onSubmit: () => void;
  submitting: boolean;
  submitError: string | null;
}

export function CartPanel({
  cart,
  onRemove,
  onChangeQuantity,
  onSubmit,
  submitting,
  submitError,
}: CartPanelProps) {
  const total = cart.reduce((sum, item) => sum + item.lineTotal, 0);

  if (cart.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-zinc-500">
        <p>Your cart is empty.</p>
        <p className="text-sm">Add something from the menu to get started.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <ul className="flex flex-col gap-3">
        {cart.map((item) => (
          <li
            key={item.key}
            className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium">{item.productName}</p>
                {item.variantName && (
                  <p className="text-xs text-zinc-500">{item.variantName}</p>
                )}
                {item.addOnNames.length > 0 && (
                  <p className="text-xs text-zinc-500">+ {item.addOnNames.join(", ")}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(item.key)}
                className="text-xs text-red-600 dark:text-red-400"
              >
                Remove
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onChangeQuantity(item.key, item.quantity - 1)}
                  className="h-7 w-7 rounded-full border border-zinc-300 dark:border-zinc-700"
                  aria-label="Decrease quantity"
                >
                  −
                </button>
                <span className="w-5 text-center text-sm">{item.quantity}</span>
                <button
                  type="button"
                  onClick={() => onChangeQuantity(item.key, item.quantity + 1)}
                  className="h-7 w-7 rounded-full border border-zinc-300 dark:border-zinc-700"
                  aria-label="Increase quantity"
                >
                  +
                </button>
              </div>
              <span className="text-sm font-semibold">{item.lineTotal.toFixed(2)}</span>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <div className="flex items-center justify-between text-lg font-bold">
          <span>Total</span>
          <span>{total.toFixed(2)}</span>
        </div>
        {submitError && <p className="text-sm text-red-600 dark:text-red-400">{submitError}</p>}
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="rounded bg-zinc-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {submitting ? "Sending to kitchen…" : "Send order to kitchen"}
        </button>
      </div>
    </div>
  );
}
