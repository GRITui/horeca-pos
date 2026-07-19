// Re-exports of the API's DTO shapes for use by client components. These are
// type-only imports (erased at build time), so pulling them from the route
// handlers' `_lib` modules doesn't pull `server-only` code into the client
// bundle — it just keeps the POS UI and the API speaking the same shape.
export type {
  OrderDTO,
  OrderLineDTO,
  OrderLineAddOnDTO,
  PaymentDTO,
} from "@/app/api/orders/_lib/queries";
export type {
  CatalogCategoryDTO,
  CatalogProductDTO,
  CatalogVariantDTO,
  CatalogAddOnDTO,
} from "@/app/api/catalog/_lib/catalog";

export interface TableOption {
  id: string;
  label: string;
}
