import { cx } from "./cx";

/**
 * Structural mirror of `AppNavItem` from `@grit/passport` (`buildAppNav`).
 * Redeclared here so this package stays dependency-free — pass the passport
 * output straight in, it is assignment-compatible.
 */
export interface AppSwitcherItem {
  key: string;
  label: string;
  href: string;
  enabled: boolean;
}

export interface AppSwitcherProps {
  /** Items from `buildAppNav(session)` — all suite apps, locked or not. */
  items: ReadonlyArray<AppSwitcherItem>;
  /** `key` of the app currently being viewed; highlighted and not linked. */
  currentApp?: string;
  /** Accessible name for the nav landmark. */
  label?: string;
  className?: string;
}

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="h-3 w-3 shrink-0"
    >
      <path d="M8 1.5A3.5 3.5 0 0 0 4.5 5v1.5H4A1.5 1.5 0 0 0 2.5 8v5A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V8A1.5 1.5 0 0 0 12 6.5h-.5V5A3.5 3.5 0 0 0 8 1.5ZM6 5a2 2 0 1 1 4 0v1.5H6V5Z" />
    </svg>
  );
}

/**
 * Presentational cross-app navigation strip for the Grit BizSuite. Renders
 * plain `<a>` tags (targets are separate deployments, so client-side routing
 * does not apply). Disabled items render visibly locked instead of hidden so
 * users can see what their plan does not include.
 */
export function AppSwitcher({
  items,
  currentApp,
  label = "Grit BizSuite apps",
  className,
}: AppSwitcherProps) {
  return (
    <nav aria-label={label} className={className}>
      <ul className="flex items-center gap-1 overflow-x-auto">
        {items.map((item) => {
          const isCurrent = item.key === currentApp;
          const base =
            "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium";

          if (!item.enabled) {
            return (
              <li key={item.key}>
                <span
                  aria-disabled="true"
                  title="Not included in your plan"
                  className={cx(
                    base,
                    "cursor-not-allowed text-zinc-400 dark:text-zinc-600",
                  )}
                >
                  <LockIcon />
                  {item.label}
                </span>
              </li>
            );
          }

          return (
            <li key={item.key}>
              <a
                href={item.href}
                aria-current={isCurrent ? "page" : undefined}
                className={cx(
                  base,
                  isCurrent
                    ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
                )}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
