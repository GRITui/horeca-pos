#!/usr/bin/env node
/* grit-reports — tests/test-aggregate.mjs
 *
 * Pure-node self test (no install, no test runner dependency — same spirit
 * as packages/passport's own `node --experimental-strip-types --test`
 * suite). Run with: `node tests/test-aggregate.mjs`
 *
 * Covers:
 *   1. lib/passportVerify.js — mints its own HS256 JWTs with node:crypto
 *      (same primitive the module under test uses) and asserts: valid
 *      token accepted, tampered payload rejected, expired token rejected,
 *      missing custom_reporting addon rejected by hasCustomReportingAddon.
 *   2. api/aggregate-margins.js — margin math against a stubbed
 *      global.fetch, covering both the "upstream present" and "upstream
 *      missing" (404) paths.
 *   3. api/aggregate-labor.js — same upstream-present / upstream-missing
 *      coverage for the labor efficiency aggregator.
 */

import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

process.env.GRIT_SESSION_SECRET = "test-secret-do-not-use-in-prod";

const { verifySessionToken, hasCustomReportingAddon } = await import(
  "../lib/passportVerify.js"
);

// -- JWT minting helper (mirrors packages/passport/src/session.ts's
// createSessionToken, but hand-rolled with node:crypto so the test doesn't
// depend on `jose` either) ---------------------------------------------------

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signHs256(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const headerSeg = base64Url(JSON.stringify(header));
  const payloadSeg = base64Url(JSON.stringify(payload));
  const signingInput = `${headerSeg}.${payloadSeg}`;
  const key = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await webcrypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(sig)}`;
}

function basePayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    userId: "user_1",
    organizationId: "org_1",
    role: "owner",
    email: "owner@gritdemo.test",
    tier: "SCALE",
    addons: ["custom_reporting"],
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

// -- 1. passportVerify.js -----------------------------------------------------

test("verifySessionToken accepts a validly signed, unexpired token", async () => {
  const token = await signHs256(basePayload(), process.env.GRIT_SESSION_SECRET);
  const session = await verifySessionToken(token);
  assert.ok(session);
  assert.equal(session.userId, "user_1");
  assert.equal(session.organizationId, "org_1");
  assert.equal(session.tier, "SCALE");
  assert.deepEqual(session.addons, ["custom_reporting"]);
});

test("verifySessionToken rejects a tampered payload", async () => {
  const token = await signHs256(basePayload(), process.env.GRIT_SESSION_SECRET);
  const [headerSeg, payloadSeg, sigSeg] = token.split(".");
  const tamperedPayload = base64Url(
    JSON.stringify(basePayload({ organizationId: "org_ATTACKER" })),
  );
  const tampered = `${headerSeg}.${tamperedPayload}.${sigSeg}`;
  const session = await verifySessionToken(tampered);
  assert.equal(session, null);
});

test("verifySessionToken rejects an expired token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await signHs256(
    basePayload({ iat: now - 7200, exp: now - 3600 }),
    process.env.GRIT_SESSION_SECRET,
  );
  const session = await verifySessionToken(token);
  assert.equal(session, null);
});

test("verifySessionToken rejects a wrong-secret signature", async () => {
  const token = await signHs256(basePayload(), "a-completely-different-secret");
  const session = await verifySessionToken(token);
  assert.equal(session, null);
});

test("verifySessionToken rejects missing/malformed tokens without throwing", async () => {
  assert.equal(await verifySessionToken(null), null);
  assert.equal(await verifySessionToken(undefined), null);
  assert.equal(await verifySessionToken(""), null);
  assert.equal(await verifySessionToken("not-a-jwt"), null);
  assert.equal(await verifySessionToken("a.b"), null);
});

test("hasCustomReportingAddon requires both the addon and GROWTH+ tier", async () => {
  const withAddonScale = await verifySessionToken(
    await signHs256(basePayload({ tier: "SCALE", addons: ["custom_reporting"] }), process.env.GRIT_SESSION_SECRET),
  );
  assert.equal(hasCustomReportingAddon(withAddonScale), true);

  const withAddonGrowth = await verifySessionToken(
    await signHs256(basePayload({ tier: "GROWTH", addons: ["custom_reporting"] }), process.env.GRIT_SESSION_SECRET),
  );
  assert.equal(hasCustomReportingAddon(withAddonGrowth), true);

  const withAddonLite = await verifySessionToken(
    await signHs256(basePayload({ tier: "LITE", addons: ["custom_reporting"] }), process.env.GRIT_SESSION_SECRET),
  );
  assert.equal(hasCustomReportingAddon(withAddonLite), false);

  const missingAddon = await verifySessionToken(
    await signHs256(basePayload({ tier: "SCALE", addons: [] }), process.env.GRIT_SESSION_SECRET),
  );
  assert.equal(hasCustomReportingAddon(missingAddon), false);

  assert.equal(hasCustomReportingAddon(null), false);
});

// -- Request/fetch stubbing helpers ------------------------------------------

function fakeRequest({ url, token }) {
  const headers = new Map();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return {
    method: "GET",
    url,
    headers: {
      get(name) {
        return headers.get(name.toLowerCase()) ?? null;
      },
    },
  };
}

async function withStubbedFetch(impl, run) {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await run();
  } finally {
    global.fetch = original;
  }
}

function jsonFetchResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

// -- 2. api/aggregate-margins.js ---------------------------------------------

test("aggregate-margins: computes margin when both upstreams respond", async () => {
  process.env.GRIT_POS_URL = "https://pos.example.test";
  process.env.GRIT_INVENTORY_URL = "https://inventory.example.test";
  delete process.env.GRIT_SERVICE_TOKEN;

  const { default: handler } = await import("../api/aggregate-margins.js?case=1");

  await withStubbedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/api/reports/revenue")) {
        return jsonFetchResponse({
          total_revenue: 10000,
          count: 42,
          daily: [
            { date: "2026-07-01", revenue: 5000 },
            { date: "2026-07-02", revenue: 5000 },
          ],
        });
      }
      if (u.includes("/api/reports/cogs")) {
        return jsonFetchResponse({
          from: "2026-07-01",
          to: "2026-07-02",
          total_cogs: 4000,
          rows: [{ sku: "SKU1", fifo_cogs: 4000 }],
        });
      }
      throw new Error(`unexpected fetch url: ${u}`);
    },
    async () => {
      const token = await signHs256(basePayload(), process.env.GRIT_SESSION_SECRET);
      const req = fakeRequest({
        url: "https://reports.example.test/api/aggregate-margins?from=2026-07-01&to=2026-07-02",
        token,
      });
      const res = await handler(req);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.revenue.total, 10000);
      assert.equal(body.cogs.total, 4000);
      assert.equal(body.margin.total, 6000);
      assert.equal(body.margin.pct, 60);
      assert.equal(body.upstream.pos, "ok");
      assert.equal(body.upstream.inventory, "ok");
      assert.equal(body.daily.length, 2);
      assert.equal(body.daily[0].cogs, null);
    },
  );
});

test("aggregate-margins: zeroes out and marks upstream missing on 404/network error", async () => {
  process.env.GRIT_POS_URL = "https://pos.example.test";
  process.env.GRIT_INVENTORY_URL = "https://inventory.example.test";

  const { default: handler } = await import("../api/aggregate-margins.js?case=2");

  await withStubbedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/api/reports/revenue")) {
        return jsonFetchResponse({ error: "not found" }, 404);
      }
      if (u.includes("/api/reports/cogs")) {
        throw new Error("network unreachable");
      }
      throw new Error(`unexpected fetch url: ${u}`);
    },
    async () => {
      const token = await signHs256(basePayload(), process.env.GRIT_SESSION_SECRET);
      const req = fakeRequest({
        url: "https://reports.example.test/api/aggregate-margins",
        token,
      });
      const res = await handler(req);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.revenue.total, 0);
      assert.equal(body.cogs.total, 0);
      assert.equal(body.margin.total, 0);
      assert.equal(body.upstream.pos, "missing");
      assert.equal(body.upstream.inventory, "missing");
      assert.deepEqual(body.daily, []);
    },
  );
});

test("aggregate-margins: unconfigured upstream env vars marker + no fetch call", async () => {
  delete process.env.GRIT_POS_URL;
  delete process.env.GRIT_INVENTORY_URL;

  const { default: handler } = await import("../api/aggregate-margins.js?case=3");

  await withStubbedFetch(
    async (url) => {
      throw new Error(`fetch should not be called when unconfigured: ${url}`);
    },
    async () => {
      const token = await signHs256(basePayload(), process.env.GRIT_SESSION_SECRET);
      const req = fakeRequest({
        url: "https://reports.example.test/api/aggregate-margins",
        token,
      });
      const res = await handler(req);
      const body = await res.json();
      assert.equal(body.upstream.pos, "unconfigured");
      assert.equal(body.upstream.inventory, "unconfigured");
    },
  );
});

test("aggregate-margins: 401 without a session, 403 without the addon", async () => {
  process.env.GRIT_POS_URL = "https://pos.example.test";
  process.env.GRIT_INVENTORY_URL = "https://inventory.example.test";
  const { default: handler } = await import("../api/aggregate-margins.js?case=4");

  const noToken = fakeRequest({ url: "https://reports.example.test/api/aggregate-margins" });
  const resNoAuth = await handler(noToken);
  assert.equal(resNoAuth.status, 401);

  const tokenNoAddon = await signHs256(
    basePayload({ addons: [] }),
    process.env.GRIT_SESSION_SECRET,
  );
  const reqNoAddon = fakeRequest({
    url: "https://reports.example.test/api/aggregate-margins",
    token: tokenNoAddon,
  });
  const resNoAddon = await handler(reqNoAddon);
  assert.equal(resNoAddon.status, 403);
  const bodyNoAddon = await resNoAddon.json();
  assert.equal(bodyNoAddon.code, "FEATURE_NOT_ENTITLED");
});

// -- 3. api/aggregate-labor.js ------------------------------------------------

test("aggregate-labor: computes avg completion hours + efficiency ratio", async () => {
  process.env.GRIT_POS_URL = "https://pos.example.test";
  process.env.GRIT_TASKBOARD_URL = "https://taskboard.example.test";

  const { default: handler } = await import("../api/aggregate-labor.js?case=1");

  await withStubbedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/api/reports/revenue")) {
        return jsonFetchResponse({ total_revenue: 1000, count: 20 });
      }
      if (u.includes("/api/ops-tasks")) {
        return jsonFetchResponse([
          { id: "t1", created_at: "2026-07-01T00:00:00Z", completed_at: "2026-07-01T02:00:00Z" },
          { id: "t2", created_at: "2026-07-01T00:00:00Z", completed_at: "2026-07-01T04:00:00Z" },
        ]);
      }
      throw new Error(`unexpected fetch url: ${u}`);
    },
    async () => {
      const token = await signHs256(basePayload(), process.env.GRIT_SESSION_SECRET);
      const req = fakeRequest({
        url: "https://reports.example.test/api/aggregate-labor",
        token,
      });
      const res = await handler(req);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.transactions.count, 20);
      assert.equal(body.tasks.completed_count, 2);
      assert.equal(body.tasks.avg_completion_hours, 3);
      assert.equal(body.efficiency.transactions_per_completed_task, 10);
      assert.equal(body.upstream.pos, "ok");
      assert.equal(body.upstream.taskboard, "ok");
    },
  );
});

test("aggregate-labor: tolerates missing taskboard endpoint (404)", async () => {
  process.env.GRIT_POS_URL = "https://pos.example.test";
  process.env.GRIT_TASKBOARD_URL = "https://taskboard.example.test";

  const { default: handler } = await import("../api/aggregate-labor.js?case=2");

  await withStubbedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("/api/reports/revenue")) {
        return jsonFetchResponse({ total_revenue: 1000, count: 20 });
      }
      if (u.includes("/api/ops-tasks")) {
        return jsonFetchResponse({ error: "not found" }, 404);
      }
      throw new Error(`unexpected fetch url: ${u}`);
    },
    async () => {
      const token = await signHs256(basePayload(), process.env.GRIT_SESSION_SECRET);
      const req = fakeRequest({
        url: "https://reports.example.test/api/aggregate-labor",
        token,
      });
      const res = await handler(req);
      const body = await res.json();
      assert.equal(body.tasks.completed_count, 0);
      assert.equal(body.tasks.avg_completion_hours, null);
      assert.equal(body.efficiency.transactions_per_completed_task, null);
      assert.equal(body.upstream.taskboard, "missing");
    },
  );
});

test("aggregate-labor: 401 without a session", async () => {
  process.env.GRIT_POS_URL = "https://pos.example.test";
  process.env.GRIT_TASKBOARD_URL = "https://taskboard.example.test";
  const { default: handler } = await import("../api/aggregate-labor.js?case=3");
  const req = fakeRequest({ url: "https://reports.example.test/api/aggregate-labor" });
  const res = await handler(req);
  assert.equal(res.status, 401);
});
