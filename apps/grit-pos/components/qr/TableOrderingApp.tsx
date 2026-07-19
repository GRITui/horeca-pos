"use client";

import { useEffect, useState } from "react";
import { CartPanel } from "./CartPanel";
import { OrderStatusPanel } from "./OrderStatusPanel";
import { ProductPicker } from "./ProductPicker";
import type { CartItem, CatalogCategory, CatalogProduct, SubmittedOrder } from "./types";

interface TableOrderingAppProps {
  tableToken: string;
  tenantName: string;
  tableLabel: string;
  catalog: CatalogCategory[];
}

type View = "menu" | "cart";

function cartStorageKey(tableToken: string) {
  return `horeca-qr-cart:${tableToken}`;
}

export function TableOrderingApp({
  tableToken,
  tenantName,
  tableLabel,
  catalog,
}: TableOrderingAppProps) {
  const [view, setView] = useState<View>("menu");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [pickerProduct, setPickerProduct] = useState<CatalogProduct | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [currentOrder, setCurrentOrder] = useState<SubmittedOrder | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Restore an in-progress (not-yet-submitted) local cart on refresh, and
  // check whether this table already has an open QR order (e.g. someone
  // else at the table ordered a first round already).
  useEffect(() => {
    // One-time restore of the local, not-yet-submitted cart from
    // sessionStorage on mount — genuinely synchronizing from an external
    // system, not derived from other React state.
    try {
      const raw = sessionStorage.getItem(cartStorageKey(tableToken));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initial sync from sessionStorage on mount
      if (raw) setCart(JSON.parse(raw));
    } catch {
      // ignore malformed/blocked storage
    }
    setHydrated(true);

    fetch(`/api/public/table/${tableToken}/order`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.order) setCurrentOrder(data.order);
      })
      .catch(() => {
        // best-effort — the ordering flow still works without this
      });
  }, [tableToken]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(cartStorageKey(tableToken), JSON.stringify(cart));
    } catch {
      // ignore
    }
  }, [cart, hydrated, tableToken]);

  function addToCart(
    product: CatalogProduct,
    selection: {
      variantId: string | null;
      variantName: string | null;
      addOnIds: string[];
      addOnNames: string[];
      quantity: number;
      unitPrice: number;
    },
  ) {
    const item: CartItem = {
      key: `${product.id}-${selection.variantId ?? "novariant"}-${selection.addOnIds
        .slice()
        .sort()
        .join(",")}-${Date.now()}`,
      productId: product.id,
      productName: product.name,
      variantId: selection.variantId,
      variantName: selection.variantName,
      addOnIds: selection.addOnIds,
      addOnNames: selection.addOnNames,
      quantity: selection.quantity,
      unitPrice: selection.unitPrice,
      lineTotal: selection.unitPrice * selection.quantity,
    };
    setCart((prev) => [...prev, item]);
    setPickerProduct(null);
    setView("cart");
  }

  function removeFromCart(key: string) {
    setCart((prev) => prev.filter((item) => item.key !== key));
  }

  function changeQuantity(key: string, quantity: number) {
    if (quantity < 1) {
      removeFromCart(key);
      return;
    }
    setCart((prev) =>
      prev.map((item) =>
        item.key === key ? { ...item, quantity, lineTotal: item.unitPrice * quantity } : item,
      ),
    );
  }

  async function submitCart() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/public/table/${tableToken}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: cart.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
            addOnIds: item.addOnIds,
          })),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(data.error ?? "Couldn't send your order. Please try again.");
        return;
      }

      setCurrentOrder(data.order);
      setCart([]);
      setView("menu");
    } catch {
      setSubmitError("Something went wrong. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex flex-col gap-1 border-b border-zinc-200 p-4 dark:border-zinc-800">
        <h1 className="text-lg font-bold">{tenantName}</h1>
        <p className="text-sm text-zinc-500">Table {tableLabel}</p>
      </header>

      <div className="flex border-b border-zinc-200 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => setView("menu")}
          className={`flex-1 px-4 py-3 text-sm font-medium ${
            view === "menu" ? "border-b-2 border-zinc-900 dark:border-white" : "text-zinc-500"
          }`}
        >
          Menu
        </button>
        <button
          type="button"
          onClick={() => setView("cart")}
          className={`flex-1 px-4 py-3 text-sm font-medium ${
            view === "cart" ? "border-b-2 border-zinc-900 dark:border-white" : "text-zinc-500"
          }`}
        >
          Cart{cartCount > 0 ? ` (${cartCount})` : ""}
        </button>
      </div>

      {currentOrder && view === "menu" && (
        <div className="p-4">
          <OrderStatusPanel order={currentOrder} />
        </div>
      )}

      {view === "menu" ? (
        <div className="flex flex-1 flex-col gap-6 p-4">
          {catalog.length === 0 && (
            <p className="text-center text-sm text-zinc-500">The menu isn&apos;t available right now.</p>
          )}
          {catalog.map((category) => (
            <section key={category.id} className="flex flex-col gap-3">
              <h2 className="text-base font-bold">{category.name}</h2>
              <ul className="flex flex-col gap-2">
                {category.products.map((product) => (
                  <li key={product.id}>
                    <button
                      type="button"
                      onClick={() => setPickerProduct(product)}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 text-left dark:border-zinc-800"
                    >
                      <span>
                        <span className="block font-medium">{product.name}</span>
                        {product.description && (
                          <span className="block text-xs text-zinc-500">{product.description}</span>
                        )}
                      </span>
                      <span className="whitespace-nowrap text-sm font-semibold">
                        {product.basePrice.toFixed(2)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <CartPanel
          cart={cart}
          onRemove={removeFromCart}
          onChangeQuantity={changeQuantity}
          onSubmit={submitCart}
          submitting={submitting}
          submitError={submitError}
        />
      )}

      {pickerProduct && (
        <ProductPicker
          product={pickerProduct}
          onCancel={() => setPickerProduct(null)}
          onAdd={(selection) => addToCart(pickerProduct, selection)}
        />
      )}
    </main>
  );
}
