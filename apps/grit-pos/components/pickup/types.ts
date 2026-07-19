// Shared shapes for the standalone pickup-link ordering UI (components/pickup/**)
// and its server pages (app/pickup/[tenantSlug]/**). Mirrors the JSON shape
// returned by app/api/pickup/[tenantSlug]/catalog and .../checkout and
// .../order/[orderId].

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

/** One configured item sitting in the customer's local (not-yet-checked-out) cart. */
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

export interface PickupOrderLine {
  id: string;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPrice: number;
  addOns: { name: string; price: number }[];
  lineTotal: number;
}

export interface PickupOrderStatus {
  orderId: string;
  status: string;
  promisedAt: string | null;
  createdAt: string;
  lines: PickupOrderLine[];
  total: number;
  paid: boolean;
}
