# @grit/passport

Grit Passport — the shared SSO session contract, RBAC, and commercial-tier
feature gating for all Grit BizSuite apps (grit-pos, grit-inventory,
grit-taskboard, grit-reports). One `grit_passport` cookie, signed with one
shared secret, works across every app.

Ships TypeScript source directly (no build step). Next apps consume it via
`transpilePackages: ["@grit/passport"]`; the plain-JS serverless app verifies
the same JWT with jose (or mirrored code) — see integration notes below.

## Session contract (`src/session.ts`)

The session is an HS256 JWT (jose) in an httpOnly cookie:

- Cookie name: `GRIT_SESSION_COOKIE` = `"grit_passport"`
- TTL: `SESSION_TTL_SECONDS` = 7 days
- Payload: `GritSession`

```ts
interface GritSession {
  userId: string;
  organizationId: string;        // replaces legacy "tenantId"
  locationId?: string | null;    // replaces legacy "storeId"; null = org-wide
  role: "owner" | "manager" | "staff";
  email: string;
  name?: string;
  tier: "LITE" | "GROWTH" | "SCALE";
  addons: string[];              // e.g. ["custom_reporting"]
}
```

Legacy role mapping when migrating existing users: `OWNER → owner`,
`ADMIN → manager`, `STAFF → staff`.

`tier` and `addons` are stamped into the token at login so entitlement checks
are pure functions with no DB round-trip. When an org's plan changes, re-issue
the session token (or accept up to 7 days of staleness).

API (all framework-agnostic — strings in, strings out, no `next/headers`):

| Function | Purpose |
| --- | --- |
| `createSessionToken(session, opts?)` | Sign a `GritSession` into a JWT string (`opts.secret`, `opts.ttlSeconds` overrides) |
| `verifySessionToken(token, opts?)` | Verify + validate; returns `GritSession \| null`, never throws on bad input |
| `sessionCookieHeader(token, opts?)` | `Set-Cookie` value (HttpOnly, SameSite=Lax, Secure by default; optional `domain` for cross-subdomain SSO) |
| `clearSessionCookieHeader(opts?)` | `Set-Cookie` value that logs out |
| `readSessionCookie(cookieHeader)` | Extract the token from a raw `Cookie` header |

## RBAC (`src/rbac.ts`)

Role hierarchy: **owner > manager > staff**.

- `hasRole(session, minRole)` / `roleAtLeast(role, minRole)`
- `APP_KEYS = ["pos", "inventory", "taskboard", "reports"]`
- `roleCanAccessApp(role, appKey)` — role defaults before entitlements:
  staff → pos + taskboard; manager/owner → everything the org's tier entitles.

## Commercial Core Configurations Matrix (`src/entitlements.ts`)

| | LITE | GROWTH | SCALE |
| --- | :---: | :---: | :---: |
| **Apps** | pos | pos, inventory | pos, inventory, taskboard, reports |
| `pos.checkout` | ✅ | ✅ | ✅ |
| `pos.offline_mode` | ✅ | ✅ | ✅ |
| `inventory.local_tracking` | ❌ | ✅ | ✅ |
| `inventory.multi_location` | ❌ | ❌ | ✅ |
| `inventory.transfers` | ❌ | ❌ | ✅ |
| `inventory.fifo_costing` | ❌ | ❌ | ✅ |
| `taskboard.automation` | ❌ | ❌ | ✅ |
| `reports.standard` | ❌ | ❌ | ✅ |
| `reports.custom_builder` | ❌ | addon | addon |

Notes:

- **LITE** is POS-only and offline-first. No inventory feature is ever
  granted, so UI panels touching inventory networks must render disabled.
- **GROWTH** gets `inventory.local_tracking` but is explicitly gated from
  reading multiple location tables (`inventory.multi_location`) and from
  `inventory.transfers`.
- **Addon `custom_reporting`** grants `reports.custom_builder` — the query
  permission pass-through to grit-reports pipelines. *Design decision:* the
  addon also lights up the reports app for **GROWTH** orgs (`minTier:
  "GROWTH"` in `ADDON_MATRIX`), so custom reporting is purchasable below
  SCALE — a single-location café on GROWTH is a realistic reporting customer,
  and the reports app is read-only so it leaks no gated inventory capability.
  On **LITE** the addon grants nothing: LITE never mounts reports, and an
  addon must never smuggle in an app the tier excludes. Addons also never
  unlock tier-gated features (e.g. `inventory.multi_location` stays gated on
  GROWTH regardless of addons).

API:

| Export | Purpose |
| --- | --- |
| `TIER_MATRIX` / `ADDON_MATRIX` | The matrix data (`Record<GritTier, {apps, features}>`, addon configs) |
| `hasFeatureAccess({tier, addons}, feature)` | Boolean gate; accepts a `GritSession` or a bare org shape |
| `featuresForOrg(org)` / `appsForOrg(org)` | Resolved entitlements (tier + addons) |
| `appsForSession(session)` | **Intersection** of org entitlements and role access — what this user can actually open |
| `assertFeature(sessionOrOrg, feature)` | Throws `EntitlementError` when not entitled |
| `EntitlementError` | `status: 403`, `code: "FEATURE_NOT_ENTITLED"`, plus `feature` and `tier` — translate to an HTTP response in API middleware so upsell UIs can key off the code |

## Cross-app navigation (`src/nav.ts`)

`buildAppNav(session)` returns all four apps as
`{ key, label, href, enabled }`. `enabled` reflects `appsForSession`, so
render locked apps greyed out / as upsell entries. `appBaseUrl(appKey)`
resolves each app's base URL from env.

## Environment variables

| Env var | Purpose | Default |
| --- | --- | --- |
| `GRIT_SESSION_SECRET` | HS256 signing secret — **must be identical in every app** for SSO to work (`openssl rand -base64 32`) | — (falls back to `SESSION_SECRET`, then throws) |
| `SESSION_SECRET` | Fallback secret (legacy grit-pos name) | — |
| `GRIT_POS_URL` | grit-pos base URL for nav | `http://localhost:3000` |
| `GRIT_INVENTORY_URL` | grit-inventory base URL for nav | `http://localhost:3001` |
| `GRIT_TASKBOARD_URL` | grit-taskboard base URL for nav | `http://localhost:3002` |
| `GRIT_REPORTS_URL` | grit-reports base URL for nav | `http://localhost:3003` |

For cross-subdomain SSO in production, set the cookie with
`domain: ".your-suite-domain.com"` (see `sessionCookieHeader` options / the
same attribute in `cookies().set`).

## Integration: Next.js 16 apps (grit-pos, grit-inventory)

Add `"@grit/passport"` to `transpilePackages` in `next.config.ts` and depend
on it in the app's `package.json`.

Login route handler:

```ts
// app/api/login/route.ts
import { cookies } from "next/headers";
import {
  createSessionToken, GRIT_SESSION_COOKIE, SESSION_TTL_SECONDS,
} from "@grit/passport";

export async function POST(request: Request) {
  // ...verify credentials, load user + org...
  const token = await createSessionToken({
    userId: user.id, organizationId: org.id, locationId: user.locationId,
    role: user.role, email: user.email, name: user.name,
    tier: org.tier, addons: org.addons,
  });
  (await cookies()).set(GRIT_SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
    // domain: ".your-suite-domain.com",  // for cross-subdomain SSO
  });
  return Response.json({ ok: true });
}
```

Guarding route handlers and Server Components:

```ts
import { cookies } from "next/headers";
import {
  verifySessionToken, GRIT_SESSION_COOKIE, assertFeature, EntitlementError,
} from "@grit/passport";

export async function getSession() {
  const token = (await cookies()).get(GRIT_SESSION_COOKIE)?.value;
  return verifySessionToken(token); // GritSession | null
}

// in a route handler:
const session = await getSession();
if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
try {
  assertFeature(session, "inventory.transfers");
} catch (err) {
  if (err instanceof EntitlementError) {
    return Response.json(
      { error: err.message, code: err.code, feature: err.feature },
      { status: err.status },
    );
  }
  throw err;
}
```

Optimistic redirect in `proxy.ts` (Next 16's proxy file convention — runs on
every matched request; only read the cookie here, no DB):

```ts
// proxy.ts
import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, GRIT_SESSION_COOKIE } from "@grit/passport";

export default async function proxy(req: NextRequest) {
  const token = req.cookies.get(GRIT_SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (!session && req.nextUrl.pathname !== "/login") {
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|.*\\.png$).*)"],
};
```

## Integration: plain-JS serverless functions (grit-taskboard `api/`)

The no-build app can't import TypeScript, but it can depend on `jose` directly
and re-verify the same JWT. The wire contract is: cookie `grit_passport`,
HS256, secret `GRIT_SESSION_SECRET` (fallback `SESSION_SECRET`), payload
fields as in `GritSession` above. Mirror the read path:

```js
// apps/grit-taskboard/lib/passport.js (mirror — keep in sync with this package)
import { jwtVerify } from "jose";

const COOKIE = "grit_passport";
const secret = () =>
  new TextEncoder().encode(
    process.env.GRIT_SESSION_SECRET ?? process.env.SESSION_SECRET,
  );

export async function sessionFromRequest(req) {
  const cookieHeader = req.headers.cookie ?? "";
  const match = cookieHeader
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${COOKIE}=`));
  if (!match) return null;
  try {
    const { payload } = await jwtVerify(match.slice(COOKIE.length + 1), secret(), {
      algorithms: ["HS256"],
    });
    return payload; // { userId, organizationId, role, tier, addons, ... }
  } catch {
    return null;
  }
}
```

Gate taskboard endpoints with the same rules (SCALE mounts taskboard; check
`payload.tier === "SCALE"` or mirror `hasFeatureAccess` for
`taskboard.automation`). If you change the session shape here, update the
mirror in the taskboard app.

grit-reports (static + serverless) does the same for
`reports.custom_builder`: verify the JWT server-side, then
`assertFeature(session, "reports.custom_builder")` before passing queries
through to its pipelines.

## Tests

Pure-logic self-test (no install needed beyond Node 22 — the src modules
under test are runtime-import-free, so Node's type stripping executes them
directly):

```
cd packages/passport
node --experimental-strip-types --test test/*.test.mjs   # or: npm test
```

Implementation note: `session.ts`, `rbac.ts`, and `entitlements.ts` use only
type-only cross-imports (erased at runtime) so they run under
`node --experimental-strip-types`. That forces one deliberate duplication:
`ROLE_APP_ACCESS` (rbac.ts) has a private mirror in entitlements.ts; the test
suite asserts the two stay identical — change both together.
