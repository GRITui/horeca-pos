/**
 * Grit BizSuite inter-app event contracts.
 *
 * Every cross-app integration MUST go through these payloads (delivered as
 * HMAC-signed internal webhooks or via the outbox bus). Direct cross-database
 * queries between apps are forbidden by the platform architecture.
 */

export const EVENT_NAMES = [
  "transaction.completed",
  "inventory.threshold_breached",
  "inventory.transfer_completed",
  "pos.velocity_surge",
  "task.completed",
  "promotion.updated",
  "discount_policy.updated",
] as const;

export type GritEventName = (typeof EVENT_NAMES)[number];

/** Common envelope every event is wrapped in. */
export interface GritEventEnvelope<
  N extends GritEventName = GritEventName,
  D = unknown,
> {
  event: N;
  /** ISO-8601 UTC timestamp of when the source system committed the fact. */
  timestamp: string;
  /** Idempotency key — consumers must dedupe on this. */
  event_id: string;
  /** Organization scope; consumers must never join data across organizations. */
  organization_id: string;
  data: D;
}

/** Emitted by Grit POS after a sale is committed (online or synced from the offline queue). */
export interface TransactionCompletedData {
  transaction_id: string;
  location_id: string;
  total_amount: number;
  tax_amount: number;
  /** True when the transaction was captured offline and synced later. */
  offline_synced?: boolean;
  items: Array<{
    sku: string;
    quantity: number;
    price: number;
  }>;
}
export type TransactionCompletedEvent = GritEventEnvelope<
  "transaction.completed",
  TransactionCompletedData
>;

/** Emitted by Grit Inventory when available stock drops below the reorder point. */
export interface InventoryThresholdBreachedData {
  location_id: string;
  sku: string;
  product_id: string;
  product_name: string;
  quantity_available: number;
  reorder_threshold: number;
  /** Preferred supplier, when configured, so Taskboard can render actionable cards. */
  supplier_name?: string;
}
export type InventoryThresholdBreachedEvent = GritEventEnvelope<
  "inventory.threshold_breached",
  InventoryThresholdBreachedData
>;

/** Emitted by Grit Inventory when an internal stock transfer order is received at destination. */
export interface InventoryTransferCompletedData {
  transfer_id: string;
  from_location_id: string;
  to_location_id: string;
  items: Array<{ sku: string; quantity: number }>;
}
export type InventoryTransferCompletedEvent = GritEventEnvelope<
  "inventory.transfer_completed",
  InventoryTransferCompletedData
>;

/** Emitted by Grit POS when transaction velocity at a location exceeds the surge threshold. */
export interface PosVelocitySurgeData {
  location_id: string;
  /** Transactions observed in the measurement window. */
  transactions_in_window: number;
  window_minutes: number;
  threshold: number;
}
export type PosVelocitySurgeEvent = GritEventEnvelope<
  "pos.velocity_surge",
  PosVelocitySurgeData
>;

/** Emitted by Grit Taskboard when a card reaches `done` (feeds labor-efficiency reporting). */
export interface TaskCompletedData {
  task_id: string;
  location_id: string;
  title: string;
  triggered_by: "system_inventory" | "system_pos" | "manual";
  assigned_shift: string | null;
  created_at: string;
  completed_at: string;
}
export type TaskCompletedEvent = GritEventEnvelope<
  "task.completed",
  TaskCompletedData
>;

/**
 * Emitted by Grit Inventory whenever a pricing/promotion rule is created,
 * edited, deactivated, or deleted. Grit POS is offline-first and never calls
 * another app live at checkout time, so this is the only way a promotion
 * ever reaches the register: POS caches the current rule set locally
 * (upserted/removed by this event) and evaluates it against cart lines
 * itself. `deleted: true` means "remove this rule from the cache" — the rest
 * of the fields are still populated for logging/audit but should not be
 * treated as the current state of a deleted rule.
 */
export interface PromotionUpdatedData {
  promotion_id: string;
  name: string;
  type: "buy_x_pay_y" | "buy_x_get_discount" | "bundle_deal";
  is_active: boolean;
  deleted: boolean;
  starts_at: string | null;
  ends_at: string | null;
  /** buy_x_pay_y */
  buy_quantity?: number;
  pay_quantity?: number;
  /** buy_x_get_discount */
  min_quantity?: number;
  discount_kind?: "percent" | "fixed_amount";
  discount_value?: number;
  /** bundle_deal */
  bundle_price?: number;
  /** The SKUs this rule applies to (buy_x_pay_y/buy_x_get_discount scope, or
   * the bundle's member SKUs for bundle_deal). Always resolved to SKUs, not
   * internal variant ids — SKU is the only join key POS and Inventory share. */
  items: Array<{ sku: string; required_quantity: number }>;
  /** Other promotion_ids this rule must never co-apply with on the same
   * order (see discount_policy.updated below for the tenant-wide stacking
   * policy — this is the separate, always-on per-order exclusion layer).
   * Absent/omitted is equivalent to an empty list. */
  excluded_promotion_ids?: string[];
}
export type PromotionUpdatedEvent = GritEventEnvelope<
  "promotion.updated",
  PromotionUpdatedData
>;

/**
 * Emitted by Grit Inventory whenever a tenant's discount-stacking policy
 * setting changes. Tenant-wide, so it doesn't fit `promotion.updated`'s
 * per-rule shape — a separate small event instead. Grit POS caches the
 * current policy locally (same offline-first reasoning as promotion.updated)
 * and applies it as a resolution step in lib/promotions.ts before summing a
 * cart's discount: NO_STACKING keeps only the single best-discount rule per
 * line, STACK_ALL applies every matching rule (today's behavior).
 */
export interface DiscountPolicyUpdatedData {
  policy: "NO_STACKING" | "STACK_ALL";
}
export type DiscountPolicyUpdatedEvent = GritEventEnvelope<
  "discount_policy.updated",
  DiscountPolicyUpdatedData
>;

export type GritEvent =
  | TransactionCompletedEvent
  | InventoryThresholdBreachedEvent
  | InventoryTransferCompletedEvent
  | PosVelocitySurgeEvent
  | TaskCompletedEvent
  | PromotionUpdatedEvent
  | DiscountPolicyUpdatedEvent;

/* ------------------------------------------------------------------ */
/* Runtime validation (dependency-free so no-build JS apps can mirror it) */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const DATA_VALIDATORS: Record<GritEventName, (d: unknown) => boolean> = {
  "transaction.completed": (d) =>
    isRecord(d) &&
    isNonEmptyString(d.transaction_id) &&
    isNonEmptyString(d.location_id) &&
    isFiniteNumber(d.total_amount) &&
    isFiniteNumber(d.tax_amount) &&
    Array.isArray(d.items) &&
    d.items.every(
      (i) =>
        isRecord(i) &&
        isNonEmptyString(i.sku) &&
        isFiniteNumber(i.quantity) &&
        i.quantity > 0 &&
        isFiniteNumber(i.price),
    ),
  "inventory.threshold_breached": (d) =>
    isRecord(d) &&
    isNonEmptyString(d.location_id) &&
    isNonEmptyString(d.sku) &&
    isNonEmptyString(d.product_id) &&
    isNonEmptyString(d.product_name) &&
    isFiniteNumber(d.quantity_available) &&
    isFiniteNumber(d.reorder_threshold),
  "inventory.transfer_completed": (d) =>
    isRecord(d) &&
    isNonEmptyString(d.transfer_id) &&
    isNonEmptyString(d.from_location_id) &&
    isNonEmptyString(d.to_location_id) &&
    Array.isArray(d.items) &&
    d.items.every(
      (i) => isRecord(i) && isNonEmptyString(i.sku) && isFiniteNumber(i.quantity),
    ),
  "pos.velocity_surge": (d) =>
    isRecord(d) &&
    isNonEmptyString(d.location_id) &&
    isFiniteNumber(d.transactions_in_window) &&
    isFiniteNumber(d.window_minutes) &&
    isFiniteNumber(d.threshold),
  "task.completed": (d) =>
    isRecord(d) &&
    isNonEmptyString(d.task_id) &&
    isNonEmptyString(d.location_id) &&
    isNonEmptyString(d.title) &&
    isNonEmptyString(d.created_at) &&
    isNonEmptyString(d.completed_at),
  "promotion.updated": (d) =>
    isRecord(d) &&
    isNonEmptyString(d.promotion_id) &&
    isNonEmptyString(d.name) &&
    typeof d.type === "string" &&
    ["buy_x_pay_y", "buy_x_get_discount", "bundle_deal"].includes(d.type) &&
    typeof d.is_active === "boolean" &&
    typeof d.deleted === "boolean" &&
    Array.isArray(d.items) &&
    d.items.every(
      (i) =>
        isRecord(i) &&
        isNonEmptyString(i.sku) &&
        isFiniteNumber(i.required_quantity) &&
        i.required_quantity > 0,
    ) &&
    (d.excluded_promotion_ids === undefined ||
      (Array.isArray(d.excluded_promotion_ids) &&
        d.excluded_promotion_ids.every((id) => isNonEmptyString(id)))),
  "discount_policy.updated": (d) =>
    isRecord(d) &&
    typeof d.policy === "string" &&
    ["NO_STACKING", "STACK_ALL"].includes(d.policy),
};

export function isGritEventName(v: unknown): v is GritEventName {
  return typeof v === "string" && (EVENT_NAMES as readonly string[]).includes(v);
}

/** Validate an unknown JSON value into a typed event envelope, or return null. */
export function parseGritEvent(value: unknown): GritEvent | null {
  if (!isRecord(value)) return null;
  const { event, timestamp, event_id, organization_id, data } = value;
  if (!isGritEventName(event)) return null;
  if (!isNonEmptyString(timestamp) || Number.isNaN(Date.parse(timestamp))) return null;
  if (!isNonEmptyString(event_id) || !isNonEmptyString(organization_id)) return null;
  if (!DATA_VALIDATORS[event](data)) return null;
  return value as unknown as GritEvent;
}
