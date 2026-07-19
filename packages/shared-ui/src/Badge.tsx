import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeVariant = "neutral" | "info" | "success" | "warning" | "danger";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  danger: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

/**
 * Common lifecycle statuses used across the suite (POS transactions,
 * inventory orders, deliveries, taskboard cards) mapped to badge variants.
 */
const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  draft: "neutral",
  pending: "warning",
  assigned: "warning",
  open: "info",
  paid: "info",
  in_progress: "info",
  out_for_delivery: "info",
  fulfilling: "info",
  completed: "success",
  fulfilled: "success",
  delivered: "success",
  done: "success",
  active: "success",
  low_stock: "warning",
  cancelled: "neutral",
  inactive: "neutral",
  failed: "danger",
  refunded: "danger",
  voided: "danger",
};

/** Variant for a raw status string; falls back to `neutral` when unknown. */
export function statusVariant(status: string): BadgeVariant {
  return STATUS_VARIANTS[status.toLowerCase()] ?? "neutral";
}

export interface BadgeProps {
  variant?: BadgeVariant;
  /**
   * Raw status string. Picks the variant via `statusVariant` (an explicit
   * `variant` prop wins) and, when no children are given, renders the status
   * with underscores replaced by spaces.
   */
  status?: string;
  className?: string;
  children?: ReactNode;
}

/** Small rounded status pill. Use `status` for suite lifecycle strings. */
export function Badge({ variant, status, className, children }: BadgeProps) {
  const resolved = variant ?? (status ? statusVariant(status) : "neutral");
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        VARIANT_CLASSES[resolved],
        className,
      )}
    >
      {children ?? status?.replace(/_/g, " ")}
    </span>
  );
}
