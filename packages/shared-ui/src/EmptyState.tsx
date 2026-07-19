import type { ReactNode } from "react";
import { cx } from "./cx";

export interface EmptyStateProps {
  /** Short bold heading, e.g. "No products yet". */
  title?: ReactNode;
  /** Supporting copy explaining the state or the next step. */
  message: ReactNode;
  /** Call-to-action slot (typically a `<Button>` or link). */
  action?: ReactNode;
  className?: string;
}

/** Dashed-border placeholder for empty lists, tables, and dashboards. */
export function EmptyState({ title, message, action, className }: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700",
        className,
      )}
    >
      <div>
        {title != null && (
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</p>
        )}
        <p className={cx("text-sm text-zinc-500 dark:text-zinc-400", title != null && "mt-1")}>
          {message}
        </p>
      </div>
      {action}
    </div>
  );
}
