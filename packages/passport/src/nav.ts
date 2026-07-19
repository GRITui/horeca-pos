/**
 * Cross-app navigation for the Grit BizSuite switcher menu.
 *
 * `buildAppNav` always returns all four apps so UIs can render locked entries
 * as disabled/upsell items — check `enabled` before linking. Base URLs come
 * from env (`GRIT_POS_URL`, …) with localhost dev-port defaults.
 */

import type { GritSession } from "./session.js";
import { APP_KEYS, type AppKey } from "./rbac.js";
import { appsForSession } from "./entitlements.js";

const APP_LABELS: Record<AppKey, string> = {
  pos: "Grit POS",
  inventory: "Grit Inventory",
  taskboard: "Grit Taskboard",
  reports: "Grit Reports",
};

const APP_URL_ENV_VARS: Record<AppKey, string> = {
  pos: "GRIT_POS_URL",
  inventory: "GRIT_INVENTORY_URL",
  taskboard: "GRIT_TASKBOARD_URL",
  reports: "GRIT_REPORTS_URL",
};

const DEFAULT_APP_URLS: Record<AppKey, string> = {
  pos: "http://localhost:3000",
  inventory: "http://localhost:3001",
  taskboard: "http://localhost:3002",
  reports: "http://localhost:3003",
};

/** Base URL for an app: `GRIT_<APP>_URL` env var, else the localhost default. */
export function appBaseUrl(appKey: AppKey): string {
  const fromEnv = process.env[APP_URL_ENV_VARS[appKey]];
  return (fromEnv && fromEnv.replace(/\/+$/, "")) || DEFAULT_APP_URLS[appKey];
}

export interface AppNavItem {
  key: AppKey;
  label: string;
  href: string;
  enabled: boolean;
}

/**
 * Navigation entries for the four suite apps, with `enabled` reflecting the
 * intersection of the org's commercial entitlements and the user's role
 * (`appsForSession`). Render disabled entries greyed out / with an upsell.
 */
export function buildAppNav(session: GritSession): AppNavItem[] {
  const enabledApps = new Set(appsForSession(session));
  return APP_KEYS.map((key) => ({
    key,
    label: APP_LABELS[key],
    href: appBaseUrl(key),
    enabled: enabledApps.has(key),
  }));
}
