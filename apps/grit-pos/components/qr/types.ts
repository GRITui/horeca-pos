// Shared shapes for the QR table-ordering UI (components/qr/**) and its
// server page (app/t/[tableToken]/page.tsx). Mirrors the JSON shape returned
// by app/api/public/table/[tableToken]/catalog and .../order.

export interface CatalogAddOn {
  id: string;
  name: string;
  price: number;
}

export interface CatalogVariant {
  id: string;
  name: string;
  priceDelta: number;
}

export interface CatalogProduct {
  id: string;
  name: string;
  description: string | null;
  basePrice: number;
  variants: CatalogVariant[];
  addOns: CatalogAddOn[];
}

export interface CatalogCategory {
  id: string;
  name: string;
  products: CatalogProduct[];
}

/** One configured item sitting in the customer's local (not-yet-submitted) cart. */
export interface CartItem {
  key: string;
  productId: string;
  productName: string;
  variantId: string | null;
  variantName: string | null;
  addOnIds: string[];
  addOnNames: string[];
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface SubmittedOrderLine {
  id: string;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPrice: number;
  addOns: { name: string; price: number }[];
  lineTotal: number;
}

export interface SubmittedOrder {
  orderId: string;
  status: string;
  tableLabel: string;
  createdAt: string;
  lines: SubmittedOrderLine[];
  total: number;
}
