import type { ReactNode } from "react";
import { cx } from "./cx";

export interface PanelProps {
  /** Optional header title; header row renders only when title or action set. */
  title?: ReactNode;
  /** Muted line under the title. */
  description?: ReactNode;
  /** Right-aligned header slot (buttons, filters). */
  action?: ReactNode;
  /** When false, the body has no padding — useful for flush tables. */
  padded?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Bordered surface card, the standard GRITui content container. Combine with
 * `<Table>` via `padded={false}` for flush data panels.
 */
export function Panel({
  title,
  description,
  action,
  padded = true,
  className,
  children,
}: PanelProps) {
  const hasHeader = title != null || action != null;
  return (
    <section
      className={cx(
        "rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900",
        className,
      )}
    >
      {hasHeader && (
        <header className="flex items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div>
            {title != null && (
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                {title}
              </h2>
            )}
            {description != null && (
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                {description}
              </p>
            )}
          </div>
          {action}
        </header>
      )}
      <div className={cx(padded && "p-5")}>{children}</div>
    </section>
  );
}
