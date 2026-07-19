"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/format";

type VariantOption = {
  id: string;
  sku: string;
  name: string;
  productName: string;
  price: string;
  quantityOnHand: number;
};

type Line = { variantId: string; quantity: number };

export function NewOrderForm({ variants }: { variants: VariantOption[] }) {
  const router = useRouter();
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [selectedVariantId, setSelectedVariantId] = useState(variants[0]?.id ?? "");
  const [selectedQuantity, setSelectedQuantity] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const variantById = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants]);

  function addLine() {
    if (!selectedVariantId) return;
    const quantity = Number(selectedQuantity);
    if (!quantity || quantity <= 0) return;
    setLines((prev) => {
      const existing = prev.find((l) => l.variantId === selectedVariantId);
      if (existing) {
        return prev.map((l) => (l.variantId === selectedVariantId ? { ...l, quantity: l.quantity + quantity } : l));
      }
      return [...prev, { variantId: selectedVariantId, quantity }];
    });
    setSelectedQuantity("1");
  }

  function removeLine(variantId: string) {
    setLines((prev) => prev.filter((l) => l.variantId !== variantId));
  }

  const total = lines.reduce((sum, l) => {
    const variant = variantById.get(l.variantId);
    return sum + (variant ? Number(variant.price) * l.quantity : 0);
  }, 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (lines.length === 0) {
      setError("Add at least one order line");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: customerName || undefined,
          customerPhone: customerPhone || undefined,
          customerAddress: customerAddress || undefined,
          notes: notes || undefined,
          lines,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to create order");
        return;
      }
      router.push(`/admin/orders/${data.order.id}`);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";
  const labelClass = "block text-sm font-medium text-zinc-700 dark:text-zinc-300";

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Customer name</label>
          <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Phone</label>
          <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} className={inputClass} />
        </div>
        <div className="col-span-2">
          <label className={labelClass}>Delivery address</label>
          <input value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} className={inputClass} />
        </div>
        <div className="col-span-2">
          <label className={labelClass}>Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} />
        </div>
      </div>

      <fieldset className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <legend className="px-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">Order lines</legend>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1">
            <label className={labelClass}>Variant</label>
            <select
              value={selectedVariantId}
              onChange={(e) => setSelectedVariantId(e.target.value)}
              className={inputClass}
            >
              {variants.map((v) => (
                <option key={v.id} value={v.id} disabled={v.quantityOnHand <= 0}>
                  {v.productName} — {v.name} ({v.sku}) · {v.quantityOnHand} in stock
                </option>
              ))}
            </select>
          </div>
          <div className="w-24">
            <label className={labelClass}>Qty</label>
            <input
              type="number"
              min="1"
              value={selectedQuantity}
              onChange={(e) => setSelectedQuantity(e.target.value)}
              className={inputClass}
            />
          </div>
          <button
            type="button"
            onClick={addLine}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900"
          >
            Add
          </button>
        </div>

        {lines.length > 0 && (
          <table className="mt-4 w-full text-sm">
            <tbody>
              {lines.map((line) => {
                const variant = variantById.get(line.variantId);
                if (!variant) return null;
                return (
                  <tr key={line.variantId} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="py-2">
                      {variant.productName} — {variant.name}
                    </td>
                    <td className="py-2 text-zinc-500">x{line.quantity}</td>
                    <td className="py-2 text-right font-mono">{formatCurrency(Number(variant.price) * line.quantity)}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeLine(line.variantId)}
                        className="text-xs font-medium text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-zinc-200 font-medium dark:border-zinc-700">
                <td className="py-2" colSpan={2}>
                  Total
                </td>
                <td className="py-2 text-right font-mono">{formatCurrency(total)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </fieldset>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {loading ? "Creating..." : "Create order"}
      </button>
    </form>
  );
}
