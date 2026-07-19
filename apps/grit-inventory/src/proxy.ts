import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { SESSION_COOKIE_NAME } from "@/lib/auth";

// /api/events/grit is the inbound @grit/shared-events webhook: it carries no
// session cookie and authenticates via HMAC signature inside the route
// handler, so it is excluded from the session gate here. Cron routes are
// likewise self-guarded (CRON_SECRET bearer token).
const PUBLIC_API_PREFIXES = ["/api/auth/login", "/api/cron/", "/api/events/grit"];

// /api/reports/cogs additionally accepts service-to-service bearer auth
// (grit-reports' margin aggregator, GRIT_SERVICE_TOKEN) — when a bearer
// header is present the route verifies it itself, so the session gate here
// steps aside. Cookie-only requests to the same path stay session-gated.
const SERVICE_BEARER_API_PREFIXES = ["/api/reports/cogs"];

function isPublicApiRoute(pathname: string) {
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isServiceBearerRoute(pathname: string, request: NextRequest) {
  return (
    SERVICE_BEARER_API_PREFIXES.some((prefix) => pathname.startsWith(prefix)) &&
    request.headers.get("authorization")?.startsWith("Bearer ") === true
  );
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return false;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(secret));
    return true;
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    if (isPublicApiRoute(pathname)) return NextResponse.next();
    if (isServiceBearerRoute(pathname, request)) return NextResponse.next();
    const authed = await hasValidSession(request);
    if (!authed) {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/admin")) {
    const authed = await hasValidSession(request);
    if (!authed) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/:path*"],
};
