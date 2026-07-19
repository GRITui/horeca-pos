"use client";

import { useMemo, useState } from "react";
import type { CatalogProduct } from "./types";

interface ProductPickerProps {
  product: CatalogProduct;
  onCancel: () => void;
  onAdd: (selection: {
    variantId: string | null;
    variantName: string | null;
    addOnIds: string[];
    addOnNames: string[];
    quantity: number;
    unitPrice: number;
  }) => void;
}

/** Modal-style variant / add-on / quantity picker shown when adding a product to the cart. */
export function ProductPicker({ product, onCancel, onAdd }: ProductPickerProps) {
  const [variantId, setVariantId] = useState<string | null>(product.variants[0]?.id ?? null);
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);

  const selectedVariant = product.variants.find((v) => v.id === variantId) ?? null;
  const selectedAddOns = product.addOns.filter((a) => addOnIds.includes(a.id));

  const unitPrice = useMemo(() => {
    const base = product.basePrice + (selectedVariant?.priceDelta ?? 0);
    const addOnsTotal = selectedAddOns.reduce((sum, a) => sum + a.price, 0);
    return base + addOnsTotal;
  }, [product.basePrice, selectedVariant, selectedAddOns]);

  function toggleAddOn(id: string) {
    setAddOnIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-2xl bg-white p-5 sm:rounded-2xl dark:bg-zinc-900">
        <div>
          <h2 className="text-lg font-bold">{product.name}</h2>
          {product.description && (
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{product.description}</p>
          )}
        </div>

        {product.variants.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-semibold">Choose one</legend>
            {product.variants.map((variant) => (
              <label
                key={variant.id}
                className="flex items-center justify-between rounded border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="variant"
                    checked={variantId === variant.id}
                    onChange={() => setVariantId(variant.id)}
                  />
                  {variant.name}
                </span>
                {variant.priceDelta !== 0 && (
                  <span className="text-zinc-500">
                    {variant.priceDelta > 0 ? "+" : ""}
                    {variant.priceDelta.toFixed(2)}
                  </span>
                )}
              </label>
            ))}
          </fieldset>
        )}

        {product.addOns.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-semibold">Add-ons</legend>
            {product.addOns.map((addOn) => (
              <label
                key={addOn.id}
                className="flex items-center justify-between rounded border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={addOnIds.includes(addOn.id)}
                    onChange={() => toggleAddOn(addOn.id)}
                  />
                  {addOn.name}
                </span>
                <span className="text-zinc-500">+{addOn.price.toFixed(2)}</span>
              </label>
            ))}
          </fieldset>
        )}

        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Quantity</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              className="h-8 w-8 rounded-full border border-zinc-300 text-lg dark:border-zinc-700"
              aria-label="Decrease quantity"
            >
              −
            </button>
            <span className="w-6 text-center">{quantity}</span>
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.min(20, q + 1))}
              className="h-8 w-8 rounded-full border border-zinc-300 text-lg dark:border-zinc-700"
              aria-label="Increase quantity"
            >
              +
            </button>
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onAdd({
                variantId,
                variantName: selectedVariant?.name ?? null,
                addOnIds,
                addOnNames: selectedAddOns.map((a) => a.name),
                quantity,
                unitPrice,
              })
            }
            className="flex-1 rounded bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-white dark:text-zinc-900"
          >
            Add · {(unitPrice * quantity).toFixed(2)}
          </button>
        </div>
      </div>
    </div>
  );
}
