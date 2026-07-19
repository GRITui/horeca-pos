"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency } from "@/lib/format";

export type PromotionType = "buy_x_pay_y" | "buy_x_get_discount" | "bundle_deal";

export type PromotionScopeVariant = {
  id: string;
  variantId: string;
  requiredQuantity: number;
  sku: string;
  name: string;
};

export type PromotionScopeGroup = {
  id: string;
  subGroupId: string;
  name: string;
  groupName: string;
};

export type PromotionRow = {
  id: string;
  name: string;
  type: PromotionType;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
  buyQuantity: number | null;
  payQuantity: number | null;
  minQuantity: number | null;
  discountKind: "percent" | "fixed_amount" | null;
  discountValue: string | null;
  bundlePrice: string | null;
  scopeVariants: PromotionScopeVariant[];
  scopeGroups: PromotionScopeGroup[];
  /** Discount resolution policy (BACKLOG.md), layer 2: other promotion ids
   * this rule must never co-apply with on the same order. */
  excludedPromotionIds: string[];
};

/** Tenant-wide per-line discount resolution policy (BACKLOG.md, layer 1). */
export type DiscountStackingPolicy = "NO_STACKING" | "STACK_ALL";

export type VariantOption = { id: string; sku: string; name: string; productName: string };
export type SubGroupOption = { id: string; name: string; groupName: string };

type VariantScopeEntry = { variantId: string; requiredQuantity: number };

const inputClass =
  "rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950";

const smallButtonClass =
  "rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

const TYPE_LABELS: Record<PromotionType, string> = {
  buy_x_pay_y: "Buy X Pay Y",
  buy_x_get_discount: "Quantity discount",
  bundle_deal: "Bundle deal",
};

const TYPE_STYLES: Record<PromotionType, string> = {
  buy_x_pay_y: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  buy_x_get_discount: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  bundle_deal: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
};

/** Human-readable one-liner per type — client-side mirror of
 * `promotionSummary` in src/lib/promotions.ts (kept separate: that module
 * imports the Prisma client, which must never end up in the client
 * bundle). */
function summarize(p: PromotionRow): string {
  switch (p.type) {
    case "buy_x_pay_y":
      return `Buy ${p.buyQuantity} pay for ${p.payQuantity}`;
    case "buy_x_get_discount": {
      const value = Number(p.discountValue ?? 0);
      const discount = p.discountKind === "percent" ? `${value}% off` : `${formatCurrency(value)} off`;
      return `Buy ${p.minQuantity}+ get ${discount}`;
    }
    case "bundle_deal": {
      const totalQty = p.scopeVariants.reduce((sum, v) => sum + v.requiredQuantity, 0);
      return `Bundle: ${formatCurrency(Number(p.bundlePrice ?? 0))} for ${totalQty} item${totalQty === 1 ? "" : "s"}`;
    }
    default:
      return p.type;
  }
}

/** Builds the same wire shape the create/edit form submits, from a row
 * already on the page — used by the quick activate/deactivate toggle so it
 * doesn't need to re-derive form state. */
function promotionToPayload(p: PromotionRow, overrides: { isActive?: boolean } = {}) {
  const base = {
    name: p.name,
    type: p.type,
    isActive: overrides.isActive ?? p.isActive,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
  };
  const variantIds: VariantScopeEntry[] = p.scopeVariants.map((v) => ({
    variantId: v.variantId,
    requiredQuantity: v.requiredQuantity,
  }));
  const excludedPromotionIds = p.excludedPromotionIds;
  if (p.type === "buy_x_pay_y") {
    return {
      ...base,
      buyQuantity: p.buyQuantity,
      payQuantity: p.payQuantity,
      variantIds,
      subGroupIds: p.scopeGroups.map((g) => g.subGroupId),
      excludedPromotionIds,
    };
  }
  if (p.type === "buy_x_get_discount") {
    return {
      ...base,
      minQuantity: p.minQuantity,
      discountKind: p.discountKind,
      discountValue: p.discountValue ? Number(p.discountValue) : 0,
      variantIds,
      subGroupIds: p.scopeGroups.map((g) => g.subGroupId),
      excludedPromotionIds,
    };
  }
  return {
    ...base,
    bundlePrice: p.bundlePrice ? Number(p.bundlePrice) : 0,
    variantIds,
    excludedPromotionIds,
  };
}

async function readJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Search-and-add variant scope picker. Client-side substring match over
 * SKU/name/product name, same pattern as the Locations admin's assign
 * form. When `showQuantity` is set (bundle_deal), each selected variant
 * gets an editable required-quantity input. */
function VariantScopePicker({
  variants,
  selected,
  onChange,
  showQuantity,
}: {
  variants: VariantOption[];
  selected: VariantScopeEntry[];
  onChange: (next: VariantScopeEntry[]) => void;
  showQuantity: boolean;
}) {
  const [query, setQuery] = useState("");
  const selectedIds = new Set(selected.map((s) => s.variantId));
  const byId = new Map(variants.map((v) => [v.id, v]));

  const q = query.trim().toLowerCase();
  const results = q
    ? variants
        .filter(
          (v) =>
            v.sku.toLowerCase().includes(q) ||
            v.name.toLowerCase().includes(q) ||
            v.productName.toLowerCase().includes(q)
        )
        .slice(0, 20)
    : [];

  function add(variantId: string) {
    if (selectedIds.has(variantId)) return;
    onChange([...selected, { variantId, requiredQuantity: 1 }]);
  }
  function remove(variantId: string) {
    onChange(selected.filter((s) => s.variantId !== variantId));
  }
  function setQty(variantId: string, qty: number) {
    onChange(selected.map((s) => (s.variantId === variantId ? { ...s, requiredQuantity: qty } : s)));
  }

  return (
    <div className="space-y-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search variants by SKU or name…"
        className={`w-full ${inputClass}`}
      />
      {q && (
        <>
          {results.length === 0 ? (
            <p className="text-xs text-zinc-500">No matching variants.</p>
          ) : (
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-zinc-200 p-1 dark:border-zinc-800">
              {results.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    disabled={selectedIds.has(v.id)}
                    onClick={() => add(v.id)}
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-zinc-50 disabled:opacity-40 dark:hover:bg-zinc-800"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-mono text-xs text-zinc-500">{v.sku}</span> — {v.name}{" "}
                      <span className="text-zinc-400">({v.productName})</span>
                    </span>
                    <span className="shrink-0 text-xs text-zinc-500">
                      {selectedIds.has(v.id) ? "Added" : "Add"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {selected.length > 0 && (
        <ul className="space-y-1">
          {selected.map((s) => {
            const v = byId.get(s.variantId);
            return (
              <li
                key={s.variantId}
                className="flex items-center justify-between gap-2 rounded border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-950/50"
              >
                <span className="min-w-0 truncate">
                  <span className="font-mono text-xs text-zinc-500">{v?.sku ?? s.variantId}</span> —{" "}
                  {v?.name ?? "Unknown variant"}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  {showQuantity && (
                    <input
                      type="number"
                      min={1}
                      value={s.requiredQuantity}
                      onChange={(e) => setQty(s.variantId, Math.max(1, Number(e.target.value) || 1))}
                      className={`w-16 py-1 ${inputClass}`}
                      aria-label={`Required quantity for ${v?.sku ?? s.variantId}`}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => remove(s.variantId)}
                    className="text-xs font-medium text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Sub-group scope multi-select — buy_x_pay_y / buy_x_get_discount only
 * (bundle_deal always scopes by explicit variant members, per the schema
 * design). */
function SubGroupScopePicker({
  subGroups,
  selected,
  onChange,
}: {
  subGroups: SubGroupOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  }
  if (subGroups.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        No item sub-groups yet — create one under Groups to scope a rule by category.
      </p>
    );
  }
  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
      {subGroups.map((sg) => (
        <li key={sg.id}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(sg.id)} onChange={() => toggle(sg.id)} />
            <span>
              {sg.groupName} / {sg.name}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/** Discount resolution policy (BACKLOG.md), layer 2 — pairwise exclusion
 * multi-select: "This promotion cannot combine with: [other promotions]".
 * Independent of the tenant-wide stacking policy and enforced at
 * cart-evaluation time regardless of it. Lists every other active
 * promotion (the current one, if editing, is excluded from its own list —
 * a rule cannot exclude itself). */
function ExclusionPicker({
  options,
  selected,
  onChange,
}: {
  options: Array<{ id: string; name: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  }
  if (options.length === 0) {
    return <p className="text-xs text-zinc-500">No other active promotions to exclude yet.</p>;
  }
  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
      {options.map((opt) => (
        <li key={opt.id}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(opt.id)} onChange={() => toggle(opt.id)} />
            <span>{opt.name}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function toDateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

/** Create/edit form — shared by both flows (edit seeds every field from
 * `initial`). Submits a full-replace payload matching the API's
 * discriminated-union schema (`createPromotionSchema` in
 * api/promotions/route.ts). */
function PromotionForm({
  initial,
  variants,
  subGroups,
  allPromotions,
  onCancel,
  onSaved,
}: {
  initial: PromotionRow | null;
  variants: VariantOption[];
  subGroups: SubGroupOption[];
  /** Every other active promotion, for the "cannot combine with" picker
   * (the current one, if editing, is filtered out by the caller). */
  allPromotions: Array<{ id: string; name: string }>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<PromotionType>(initial?.type ?? "buy_x_pay_y");
  const [name, setName] = useState(initial?.name ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [startsAt, setStartsAt] = useState(toDateInputValue(initial?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toDateInputValue(initial?.endsAt ?? null));

  const [buyQuantity, setBuyQuantity] = useState(String(initial?.buyQuantity ?? 3));
  const [payQuantity, setPayQuantity] = useState(String(initial?.payQuantity ?? 2));

  const [minQuantity, setMinQuantity] = useState(String(initial?.minQuantity ?? 5));
  const [discountKind, setDiscountKind] = useState<"percent" | "fixed_amount">(
    initial?.discountKind ?? "percent"
  );
  const [discountValue, setDiscountValue] = useState(initial?.discountValue ?? "10");

  const [bundlePrice, setBundlePrice] = useState(initial?.bundlePrice ?? "");

  const [variantScope, setVariantScope] = useState<VariantScopeEntry[]>(
    initial?.scopeVariants.map((v) => ({ variantId: v.variantId, requiredQuantity: v.requiredQuantity })) ?? []
  );
  const [subGroupIds, setSubGroupIds] = useState<string[]>(
    initial?.scopeGroups.map((g) => g.subGroupId) ?? []
  );
  const [excludedPromotionIds, setExcludedPromotionIds] = useState<string[]>(
    initial?.excludedPromotionIds ?? []
  );

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    const base = {
      name: name.trim(),
      type,
      isActive,
      startsAt: startsAt ? new Date(`${startsAt}T00:00:00.000Z`).toISOString() : null,
      endsAt: endsAt ? new Date(`${endsAt}T00:00:00.000Z`).toISOString() : null,
    };

    let payload: Record<string, unknown>;
    if (type === "buy_x_pay_y") {
      payload = {
        ...base,
        buyQuantity: Number(buyQuantity),
        payQuantity: Number(payQuantity),
        variantIds: variantScope.map((v) => ({ ...v, requiredQuantity: 1 })),
        subGroupIds,
        excludedPromotionIds,
      };
    } else if (type === "buy_x_get_discount") {
      payload = {
        ...base,
        minQuantity: Number(minQuantity),
        discountKind,
        discountValue: Number(discountValue),
        variantIds: variantScope.map((v) => ({ ...v, requiredQuantity: 1 })),
        subGroupIds,
        excludedPromotionIds,
      };
    } else {
      payload = {
        ...base,
        bundlePrice: Number(bundlePrice),
        variantIds: variantScope,
        excludedPromotionIds,
      };
    }

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(initial ? `/api/promotions/${initial.id}` : "/api/promotions", {
        method: initial ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Could not save promotion");
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Summer 3-for-2"
            className={`mt-1 w-full ${inputClass}`}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as PromotionType)}
            className={`mt-1 w-full ${inputClass}`}
          >
            <option value="buy_x_pay_y">Buy X Pay Y</option>
            <option value="buy_x_get_discount">Buy X get a discount</option>
            <option value="bundle_deal">Bundle deal</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Starts (optional)
          </label>
          <input
            type="date"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className={`mt-1 w-full ${inputClass}`}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Ends (optional)
          </label>
          <input
            type="date"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            className={`mt-1 w-full ${inputClass}`}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>

      {type === "buy_x_pay_y" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Buy quantity
            </label>
            <input
              type="number"
              min={1}
              value={buyQuantity}
              onChange={(e) => setBuyQuantity(e.target.value)}
              className={`mt-1 w-full ${inputClass}`}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Pay quantity
            </label>
            <input
              type="number"
              min={1}
              value={payQuantity}
              onChange={(e) => setPayQuantity(e.target.value)}
              className={`mt-1 w-full ${inputClass}`}
            />
          </div>
        </div>
      )}

      {type === "buy_x_get_discount" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Min quantity
            </label>
            <input
              type="number"
              min={1}
              value={minQuantity}
              onChange={(e) => setMinQuantity(e.target.value)}
              className={`mt-1 w-full ${inputClass}`}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Discount kind
            </label>
            <select
              value={discountKind}
              onChange={(e) => setDiscountKind(e.target.value as "percent" | "fixed_amount")}
              className={`mt-1 w-full ${inputClass}`}
            >
              <option value="percent">Percent off</option>
              <option value="fixed_amount">Fixed amount off</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {discountKind === "percent" ? "Percent (0–100)" : "Amount off"}
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              className={`mt-1 w-full ${inputClass}`}
            />
          </div>
        </div>
      )}

      {type === "bundle_deal" && (
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Bundle price (total)
          </label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={bundlePrice}
            onChange={(e) => setBundlePrice(e.target.value)}
            className={`mt-1 w-full max-w-xs ${inputClass}`}
          />
        </div>
      )}

      {type === "bundle_deal" ? (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Bundle members (SKU + required quantity)
          </h4>
          <div className="mt-2">
            <VariantScopePicker
              variants={variants}
              selected={variantScope}
              onChange={setVariantScope}
              showQuantity
            />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Scope — specific variants and/or item sub-groups
          </h4>
          <div>
            <p className="mb-1 text-xs text-zinc-500">Variants</p>
            <VariantScopePicker
              variants={variants}
              selected={variantScope}
              onChange={setVariantScope}
              showQuantity={false}
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-zinc-500">Item sub-groups</p>
            <SubGroupScopePicker subGroups={subGroups} selected={subGroupIds} onChange={setSubGroupIds} />
          </div>
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          This promotion cannot combine with
        </h4>
        <p className="mb-1 mt-1 text-xs text-zinc-500">
          Order-level exclusion — checked at checkout regardless of the tenant&apos;s discount stacking
          policy below (e.g. a storewide clearance rule that should never combine with a new-customer
          discount, even on unrelated products).
        </p>
        <ExclusionPicker
          options={allPromotions}
          selected={excludedPromotionIds}
          onChange={setExcludedPromotionIds}
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {busy ? "Saving…" : initial ? "Save changes" : "Create promotion"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function PromotionRowItem({
  promo,
  variants,
  subGroups,
  allPromotions,
  editing,
  onEdit,
  onCancelEdit,
  onChanged,
}: {
  promo: PromotionRow;
  variants: VariantOption[];
  subGroups: SubGroupOption[];
  allPromotions: Array<{ id: string; name: string }>;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleActive() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/promotions/${promo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(promotionToPayload(promo, { isActive: !promo.isActive })),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Could not update promotion");
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${promo.name}"? This can't be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/promotions/${promo.id}`, { method: "DELETE" });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Could not delete promotion");
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <PromotionForm
        initial={promo}
        variants={variants}
        subGroups={subGroups}
        allPromotions={allPromotions}
        onCancel={onCancelEdit}
        onSaved={onChanged}
      />
    );
  }

  const scopeSummary =
    promo.scopeVariants.length === 0 && promo.scopeGroups.length === 0
      ? "No scope set yet"
      : [
          promo.scopeVariants.length > 0
            ? `${promo.scopeVariants.length} variant${promo.scopeVariants.length === 1 ? "" : "s"}`
            : null,
          promo.scopeGroups.length > 0
            ? `${promo.scopeGroups.length} sub-group${promo.scopeGroups.length === 1 ? "" : "s"}`
            : null,
        ]
          .filter(Boolean)
          .join(", ");

  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-900 dark:text-zinc-50">{promo.name}</span>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TYPE_STYLES[promo.type]}`}
            >
              {TYPE_LABELS[promo.type]}
            </span>
            {!promo.isActive && (
              <span className="inline-flex items-center rounded-full bg-zinc-200 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                Inactive
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">{summarize(promo)}</p>
          <p className="mt-1 text-xs text-zinc-500">{scopeSummary}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={onEdit} className={smallButtonClass}>
            Edit
          </button>
          <button type="button" disabled={busy} onClick={toggleActive} className={smallButtonClass}>
            {promo.isActive ? "Deactivate" : "Activate"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={remove}
            className="rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:hover:bg-red-950/40"
          >
            Delete
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </li>
  );
}

/** Discount resolution policy (BACKLOG.md), layer 1 — tenant-wide per-line
 * resolution policy. Saved independently of any single promotion, via
 * `/api/tenant-settings` (scoped to just this field). */
function DiscountPolicyPanel({ policy }: { policy: DiscountStackingPolicy }) {
  const router = useRouter();
  const [value, setValue] = useState<DiscountStackingPolicy>(policy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function select(next: DiscountStackingPolicy) {
    setValue(next);
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tenant-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discountStackingPolicy: value }),
      });
      const data = await readJson(res);
      if (!res.ok) {
        setError(data?.error ?? "Could not save discount rules");
        return;
      }
      setSaved(true);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Discount rules</h3>
      <p className="mt-1 text-xs text-zinc-500">
        How overlapping promotions resolve on the same cart line, tenant-wide. Per-promotion
        &quot;cannot combine with&quot; exclusions (set on each promotion below) always apply on top of
        this, regardless of which option is selected.
      </p>
      <div className="mt-3 space-y-2">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="discountStackingPolicy"
            checked={value === "NO_STACKING"}
            onChange={() => select("NO_STACKING")}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium text-zinc-900 dark:text-zinc-50">No stacking (recommended)</span>
            <br />
            <span className="text-zinc-500">
              For any cart line, only the single best-discount rule applies.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="discountStackingPolicy"
            checked={value === "STACK_ALL"}
            onChange={() => select("STACK_ALL")}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium text-zinc-900 dark:text-zinc-50">Stack all matching rules</span>
            <br />
            <span className="text-zinc-500">
              Every matching rule applies to a line — only choose this once you&apos;ve verified your
              rules don&apos;t unintentionally overlap.
            </span>
          </span>
        </label>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" disabled={busy} onClick={save} className={smallButtonClass}>
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-emerald-600">Saved</span>}
      </div>
    </div>
  );
}

export function PromotionsManager({
  discountStackingPolicy,
  promotions,
  variants,
  subGroups,
}: {
  discountStackingPolicy: DiscountStackingPolicy;
  promotions: PromotionRow[];
  variants: VariantOption[];
  subGroups: SubGroupOption[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function handleChanged() {
    setCreating(false);
    setEditingId(null);
    router.refresh();
  }

  // "This promotion cannot combine with" only ever offers other active
  // promotions — an inactive rule can never co-apply with anything, so
  // excluding it from the picker options avoids a confusing no-op choice.
  const activePromotionOptions = promotions
    .filter((p) => p.isActive)
    .map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="space-y-4">
      <DiscountPolicyPanel policy={discountStackingPolicy} />

      {creating ? (
        <PromotionForm
          initial={null}
          variants={variants}
          subGroups={subGroups}
          allPromotions={activePromotionOptions}
          onCancel={() => setCreating(false)}
          onSaved={handleChanged}
        />
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900"
        >
          + New promotion
        </button>
      )}

      {promotions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No promotions yet.
        </div>
      ) : (
        <ul className="space-y-3">
          {promotions.map((promo) => (
            <PromotionRowItem
              key={promo.id}
              promo={promo}
              variants={variants}
              subGroups={subGroups}
              allPromotions={activePromotionOptions.filter((opt) => opt.id !== promo.id)}
              editing={editingId === promo.id}
              onEdit={() => setEditingId(promo.id)}
              onCancelEdit={() => setEditingId(null)}
              onChanged={handleChanged}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
