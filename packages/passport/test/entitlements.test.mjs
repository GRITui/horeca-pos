// Pure-logic self-test for @grit/passport entitlements + RBAC.
// Run from packages/passport:
//   node --experimental-strip-types --test test/*.test.mjs
// The imported src files are runtime-import-free TypeScript (type-only
// cross-imports), so Node's type stripping can execute them directly.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TIER_MATRIX,
  ADDON_MATRIX,
  hasFeatureAccess,
  featuresForOrg,
  appsForOrg,
  appsForSession,
  assertFeature,
  EntitlementError,
  __roleAppAccessMirror,
} from "../src/entitlements.ts";
import {
  APP_KEYS,
  ROLE_APP_ACCESS,
  roleCanAccessApp,
  hasRole,
  roleAtLeast,
} from "../src/rbac.ts";

const org = (tier, addons = []) => ({ tier, addons });
const session = (tier, role, addons = []) => ({ tier, role, addons });

// -- Tier matrix shape --------------------------------------------------------

test("TIER_MATRIX apps per tier", () => {
  assert.deepEqual(TIER_MATRIX.LITE.apps, ["pos"]);
  assert.deepEqual(TIER_MATRIX.GROWTH.apps, ["pos", "inventory"]);
  assert.deepEqual(TIER_MATRIX.SCALE.apps, [
    "pos",
    "inventory",
    "taskboard",
    "reports",
  ]);
});

// -- LITE ---------------------------------------------------------------------

test("LITE: POS features only, inventory network fully gated", () => {
  const lite = org("LITE");
  assert.equal(hasFeatureAccess(lite, "pos.checkout"), true);
  assert.equal(hasFeatureAccess(lite, "pos.offline_mode"), true);
  for (const gated of [
    "inventory.local_tracking",
    "inventory.multi_location",
    "inventory.transfers",
    "inventory.fifo_costing",
    "taskboard.automation",
    "reports.standard",
    "reports.custom_builder",
  ]) {
    assert.equal(hasFeatureAccess(lite, gated), false, gated);
  }
});

test("LITE: custom_reporting addon grants nothing (reports never mounts)", () => {
  const lite = org("LITE", ["custom_reporting"]);
  assert.deepEqual(appsForOrg(lite), ["pos"]);
  assert.equal(hasFeatureAccess(lite, "reports.custom_builder"), false);
});

// -- GROWTH -------------------------------------------------------------------

test("GROWTH: local tracking yes; multi-location and transfers gated", () => {
  const growth = org("GROWTH");
  assert.equal(hasFeatureAccess(growth, "pos.checkout"), true);
  assert.equal(hasFeatureAccess(growth, "inventory.local_tracking"), true);
  assert.equal(hasFeatureAccess(growth, "inventory.multi_location"), false);
  assert.equal(hasFeatureAccess(growth, "inventory.transfers"), false);
  assert.equal(hasFeatureAccess(growth, "inventory.fifo_costing"), false);
  assert.equal(hasFeatureAccess(growth, "taskboard.automation"), false);
  assert.deepEqual(appsForOrg(growth), ["pos", "inventory"]);
});

test("GROWTH + custom_reporting: reports app lights up, custom_builder granted", () => {
  const growth = org("GROWTH", ["custom_reporting"]);
  assert.equal(hasFeatureAccess(growth, "reports.custom_builder"), true);
  assert.deepEqual(appsForOrg(growth).sort(), ["inventory", "pos", "reports"]);
  // Still no multi-location — addons never unlock tier-gated inventory features.
  assert.equal(hasFeatureAccess(growth, "inventory.multi_location"), false);
});

// -- SCALE --------------------------------------------------------------------

test("SCALE: all core features; custom_builder only via addon", () => {
  const scale = org("SCALE");
  for (const feature of [
    "pos.checkout",
    "pos.offline_mode",
    "inventory.local_tracking",
    "inventory.multi_location",
    "inventory.transfers",
    "inventory.fifo_costing",
    "taskboard.automation",
    "reports.standard",
  ]) {
    assert.equal(hasFeatureAccess(scale, feature), true, feature);
  }
  assert.equal(hasFeatureAccess(scale, "reports.custom_builder"), false);
  assert.equal(
    hasFeatureAccess(org("SCALE", ["custom_reporting"]), "reports.custom_builder"),
    true,
  );
});

test("unknown addons and unknown features are ignored/denied", () => {
  const o = org("SCALE", ["nonexistent_addon"]);
  assert.deepEqual(appsForOrg(o), [...TIER_MATRIX.SCALE.apps]);
  assert.equal(hasFeatureAccess(o, "made.up_feature"), false);
});

// -- appsForSession: role ∩ entitlement ---------------------------------------

test("appsForSession intersects tier apps with role access", () => {
  assert.deepEqual(appsForSession(session("SCALE", "owner")), [
    "pos",
    "inventory",
    "taskboard",
    "reports",
  ]);
  assert.deepEqual(appsForSession(session("SCALE", "manager")), [
    "pos",
    "inventory",
    "taskboard",
    "reports",
  ]);
  assert.deepEqual(appsForSession(session("SCALE", "staff")), [
    "pos",
    "taskboard",
  ]);
  assert.deepEqual(appsForSession(session("GROWTH", "staff")), ["pos"]);
  assert.deepEqual(appsForSession(session("GROWTH", "manager")), [
    "pos",
    "inventory",
  ]);
  assert.deepEqual(appsForSession(session("LITE", "owner")), ["pos"]);
  assert.deepEqual(appsForSession(session("LITE", "staff")), ["pos"]);
});

test("appsForSession: staff never see reports even with custom_reporting", () => {
  assert.deepEqual(
    appsForSession(session("GROWTH", "staff", ["custom_reporting"])),
    ["pos"],
  );
  assert.deepEqual(
    appsForSession(session("GROWTH", "manager", ["custom_reporting"])).sort(),
    ["inventory", "pos", "reports"],
  );
});

// -- RBAC ---------------------------------------------------------------------

test("role hierarchy owner > manager > staff", () => {
  assert.equal(roleAtLeast("owner", "manager"), true);
  assert.equal(roleAtLeast("manager", "owner"), false);
  assert.equal(roleAtLeast("staff", "staff"), true);
  assert.equal(hasRole({ role: "manager" }, "staff"), true);
  assert.equal(hasRole({ role: "staff" }, "manager"), false);
});

test("roleCanAccessApp defaults", () => {
  assert.equal(roleCanAccessApp("staff", "pos"), true);
  assert.equal(roleCanAccessApp("staff", "taskboard"), true);
  assert.equal(roleCanAccessApp("staff", "inventory"), false);
  assert.equal(roleCanAccessApp("staff", "reports"), false);
  for (const app of APP_KEYS) {
    assert.equal(roleCanAccessApp("manager", app), true, app);
    assert.equal(roleCanAccessApp("owner", app), true, app);
  }
});

test("rbac ROLE_APP_ACCESS and entitlements mirror stay in sync", () => {
  assert.deepEqual(__roleAppAccessMirror, ROLE_APP_ACCESS);
});

// -- assertFeature ------------------------------------------------------------

test("assertFeature throws typed EntitlementError", () => {
  assert.doesNotThrow(() => assertFeature(org("GROWTH"), "inventory.local_tracking"));
  try {
    assertFeature(org("GROWTH"), "inventory.transfers");
    assert.fail("expected EntitlementError");
  } catch (err) {
    assert.ok(err instanceof EntitlementError);
    assert.equal(err.status, 403);
    assert.equal(err.code, "FEATURE_NOT_ENTITLED");
    assert.equal(err.feature, "inventory.transfers");
    assert.equal(err.tier, "GROWTH");
    assert.match(err.message, /inventory\.transfers/);
  }
});

// -- featuresForOrg completeness ----------------------------------------------

test("featuresForOrg is cumulative across tiers", () => {
  const lite = new Set(featuresForOrg(org("LITE")));
  const growth = new Set(featuresForOrg(org("GROWTH")));
  const scale = new Set(featuresForOrg(org("SCALE")));
  for (const f of lite) assert.ok(growth.has(f), `GROWTH missing ${f}`);
  for (const f of growth) assert.ok(scale.has(f), `SCALE missing ${f}`);
});

test("ADDON_MATRIX declares custom_reporting for GROWTH and above", () => {
  assert.deepEqual(ADDON_MATRIX.custom_reporting.features, [
    "reports.custom_builder",
  ]);
  assert.equal(ADDON_MATRIX.custom_reporting.minTier, "GROWTH");
});
