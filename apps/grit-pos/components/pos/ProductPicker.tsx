"use client";

import { useMemo, useState } from "react";
import type { CatalogProductDTO } from "./types";
import { formatMoney } from "./format";
import {
  attributeAxesFromVariants,
  parseAttributes,
  resolveVariantSelection,
  type AttributeSelection,
} from "@/lib/variantMatrix";

export interface ProductPickerSelection {
  productId: string;
  variantId: string | null;
  addOnIds: string[];
  quantity: number;
}

export default function ProductPicker({
  product,
  submitting,
  matrixEnabled = false,
  onCancel,
  onConfirm,
}: {
  product: CatalogProductDTO;
  submitting: boolean;
  /** "retail.variant_matrix" trait — shows attribute selectors when variants carry attributes. */
  matrixEnabled?: boolean;
  onCancel: () => void;
  onConfirm: (selection: ProductPickerSelection) => void;
}) {
  // Retail variant matrix: when enabled and this product's variants carry
  // attribute maps, pick by attribute axes and resolve to the child SKU.
  const axes = useMemo(
    () => (matrixEnabled ? attributeAxesFromVariants(product.variants) : {}),
    [matrixEnabled, product],
  );
  const useMatrix = Object.keys(axes).length > 0;

  const [attributeSelection, setAttributeSelection] = useState<AttributeSelection>(
    () => parseAttributes(product.variants[0]?.attributes) ?? {},
  );
  const [plainVariantId, setPlainVariantId] = useState<string | null>(
    product.variants[0]?.id ?? null,
  );
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);

  const matrixVariant = useMemo(
    () => (useMatrix ? resolveVariantSelection(product.variants, attributeSelection) : null),
    [useMatrix, product, attributeSelection],
  );
  const variantId = useMatrix ? (matrixVariant?.id ?? null) : plainVariantId;
  const unresolvedCombination = useMatrix && matrixVariant === null;

  const unitPrice = useMemo(() => {
    const variant = product.variants.find((v) => v.id === variantId);
    const addOnsTotal = product.addOns
      .filter((a) => addOnIds.includes(a.id))
      .reduce((sum, a) => sum + a.price, 0);
    return product.basePrice + (variant?.priceDelta ?? 0) + addOnsTotal;
  }, [product, variantId, addOnIds]);

  function toggleAddOn(id: string) {
    setAddOnIds((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-xl bg-white p-5 sm:rounded-xl dark:bg-zinc-950">
        <div>
          <h3 className="text-lg font-semibold">{product.name}</h3>
          {product.description && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{product.description}</p>
          )}
        </div>

        {useMatrix && (
          <div className="flex flex-col gap-3">
            {Object.entries(axes).map(([axis, values]) => (
              <fieldset key={axis} className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium capitalize">{axis}</legend>
                <div className="flex flex-wrap gap-2">
                  {values.map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() =>
                        setAttributeSelection((prev) => ({ ...prev, [axis]: value }))
                      }
                      className={`rounded border px-3 py-1.5 text-sm font-medium ${
                        attributeSelection[axis] === value
                          ? "border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900"
                          : "border-zinc-300 dark:border-zinc-700"
                      }`}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {matrixVariant
                ? `SKU: ${matrixVariant.sku ?? matrixVariant.name}`
                : "This combination isn't available."}
            </p>
          </div>
        )}

        {!useMatrix && product.variants.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Size / variant</legend>
            {product.variants.map((v) => (
              <label
                key={v.id}
                className="flex items-center justify-between rounded border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="variant"
                    checked={plainVariantId === v.id}
                    onChange={() => setPlainVariantId(v.id)}
                  />
                  {v.name}
                </span>
                <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
                  {v.priceDelta === 0
                    ? "—"
                    : `${v.priceDelta > 0 ? "+" : ""}${formatMoney(v.priceDelta)}`}
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {product.addOns.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Add-ons</legend>
            {product.addOns.map((a) => (
              <label
                key={a.id}
                className="flex items-center justify-between rounded border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={addOnIds.includes(a.id)}
                    onChange={() => toggleAddOn(a.id)}
                  />
                  {a.name}
                </span>
                <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
                  +{formatMoney(a.price)}
                </span>
              </label>
            ))}
          </fieldset>
        )}

        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Quantity</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              className="h-8 w-8 rounded border border-zinc-300 text-lg leading-none dark:border-zinc-700"
              aria-label="Decrease quantity"
            >
              −
            </button>
            <span className="w-6 text-center tabular-nums">{quantity}</span>
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.min(50, q + 1))}
              className="h-8 w-8 rounded border border-zinc-300 text-lg leading-none dark:border-zinc-700"
              aria-label="Increase quantity"
            >
              +
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">Line total</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatMoney(unitPrice * quantity)}
          </span>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting || unresolvedCombination}
            onClick={() =>
              onConfirm({ productId: product.id, variantId, addOnIds, quantity })
            }
            className="flex-1 rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
          >
            {submitting ? "Adding…" : "Add to order"}
          </button>
        </div>
      </div>
    </div>
  );
}
