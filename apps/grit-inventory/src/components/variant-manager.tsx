"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/format";

type Variant = {
  id: string;
  sku: string;
  name: string;
  price: string;
  quantityOnHand: number;
  reorderThreshold: number;
  isActive: boolean;
};

function AdjustStockDialog({ variant, onClose }: { variant: Variant; onClose: () => void }) {
  const router = useRouter();
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsedDelta = Number(delta);
    if (!parsedDelta) {
      setError("Enter a non-zero amount (negative to remove stock)");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/variants/${variant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stockAdjustment: { delta: parsedDelta, note: note || undefined } }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Adjustment failed");
        return;
      }
      router.refresh();
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-900"
      >
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Adjust stock — {variant.sku}
        </h3>
        <p className="mt-1 text-xs text-zinc-500">Current: {variant.quantityOnHand}</p>
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Amount (use negative to remove)
            </label>
            <input
              type="number"
              autoFocus
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Note</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. cycle count correction"
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
          >
            {loading ? "Saving..." : "Apply"}
          </button>
        </div>
      </form>
    </div>
  );
}

function EditVariantDialog({ variant, onClose }: { variant: Variant; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(variant.name);
  const [price, setPrice] = useState(variant.price);
  const [reorderThreshold, setReorderThreshold] = useState(String(variant.reorderThreshold));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/variants/${variant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          price: Number(price || 0),
          reorderThreshold: Number(reorderThreshold || 0),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Update failed");
        return;
      }
      router.refresh();
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-lg dark:bg-zinc-900"
      >
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Edit variant — {variant.sku}
        </h3>
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Name</label>
            <input
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Price</label>
            <input
              required
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Reorder threshold</label>
            <input
              type="number"
              min="0"
              value={reorderThreshold}
              onChange={(e) => setReorderThreshold(e.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </div>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
          >
            {loading ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function VariantTable({ variants }: { variants: Variant[] }) {
  const [adjusting, setAdjusting] = useState<Variant | null>(null);
  const [editing, setEditing] = useState<Variant | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const router = useRouter();

  const inactiveCount = variants.filter((v) => !v.isActive).length;
  const visibleVariants = showInactive ? variants : variants.filter((v) => v.isActive);

  async function handleDeactivate(id: string) {
    if (!confirm("Deactivate this variant?")) return;
    setActionError(null);
    try {
      const res = await fetch(`/api/variants/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? "Failed to deactivate variant");
        return;
      }
      router.refresh();
    } catch {
      setActionError("Failed to deactivate variant");
    }
  }

  async function handleReactivate(id: string) {
    setActionError(null);
    try {
      const res = await fetch(`/api/variants/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? "Failed to reactivate variant");
        return;
      }
      router.refresh();
    } catch {
      setActionError("Failed to reactivate variant");
    }
  }

  return (
    <>
      <div className="flex items-center justify-between px-4 pt-1 pb-2">
        {actionError && <p className="text-sm text-red-600">{actionError}</p>}
        {inactiveCount > 0 && (
          <label className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive ({inactiveCount})
          </label>
        )}
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
            <th className="px-4 py-3 font-medium">SKU</th>
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Price</th>
            <th className="px-4 py-3 font-medium">Stock</th>
            <th className="px-4 py-3 font-medium">Reorder at</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {visibleVariants.map((variant) => {
            const low = variant.quantityOnHand <= variant.reorderThreshold;
            return (
              <tr
                key={variant.id}
                className={`border-b border-zinc-100 last:border-0 dark:border-zinc-800 ${
                  variant.isActive ? "" : "opacity-50"
                }`}
              >
                <td className="px-4 py-3 font-mono text-xs text-zinc-600 dark:text-zinc-400">{variant.sku}</td>
                <td className="px-4 py-3 text-zinc-900 dark:text-zinc-50">
                  {variant.name}
                  {!variant.isActive && (
                    <span className="ml-2 rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      inactive
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{formatCurrency(variant.price)}</td>
                <td className={`px-4 py-3 font-mono ${low ? "text-red-600" : "text-zinc-600 dark:text-zinc-400"}`}>
                  {variant.quantityOnHand}
                </td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{variant.reorderThreshold}</td>
                <td className="px-4 py-3 text-right">
                  {variant.isActive ? (
                    <>
                      <button
                        onClick={() => setEditing(variant)}
                        className="mr-3 text-sm font-medium text-zinc-700 hover:underline dark:text-zinc-300"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setAdjusting(variant)}
                        className="mr-3 text-sm font-medium text-zinc-700 hover:underline dark:text-zinc-300"
                      >
                        Adjust stock
                      </button>
                      <button
                        onClick={() => handleDeactivate(variant.id)}
                        className="text-sm font-medium text-red-600 hover:underline"
                      >
                        Deactivate
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleReactivate(variant.id)}
                      className="text-sm font-medium text-emerald-600 hover:underline"
                    >
                      Reactivate
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {adjusting && <AdjustStockDialog variant={adjusting} onClose={() => setAdjusting(null)} />}
      {editing && <EditVariantDialog variant={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

export function AddVariantForm({ productId }: { productId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("0");
  const [reorderThreshold, setReorderThreshold] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/products/${productId}/variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku,
          name,
          price: Number(price || 0),
          quantityOnHand: Number(quantity || 0),
          reorderThreshold: Number(reorderThreshold || 0),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to add variant");
        return;
      }
      setSku("");
      setName("");
      setPrice("");
      setQuantity("0");
      setReorderThreshold("0");
      setOpen(false);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-4 text-sm font-medium text-zinc-700 hover:underline dark:text-zinc-300"
      >
        + Add variant
      </button>
    );
  }

  const inputClass =
    "rounded-md border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-wrap items-end gap-2">
      <input required placeholder="SKU" value={sku} onChange={(e) => setSku(e.target.value)} className={inputClass} />
      <input required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      <input
        required
        type="number"
        step="0.01"
        min="0"
        placeholder="Price"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        className={`${inputClass} w-24`}
      />
      <input
        type="number"
        min="0"
        placeholder="Qty"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        className={`${inputClass} w-20`}
      />
      <input
        type="number"
        min="0"
        placeholder="Reorder at"
        value={reorderThreshold}
        onChange={(e) => setReorderThreshold(e.target.value)}
        className={`${inputClass} w-24`}
      />
      <button
        type="submit"
        disabled={loading}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {loading ? "Adding..." : "Add"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        Cancel
      </button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}
