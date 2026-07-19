import { NextResponse } from "next/server";
import { getEventBus } from "@/lib/events";

// GET/POST /api/cron/events-drain
//
// Re-attempts delivery of undelivered rows in the event_outbox (events whose
// webhook fan-out failed at publish time). Secured with a bearer CRON_SECRET,
// mirroring grit-inventory's cron routes — Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET` when the env var is set. GET and POST
// both work so either a cron scheduler or a manual curl can trigger it.

function verifyCronRequest(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function drain(request: Request): Promise<NextResponse> {
  const unauthorized = verifyCronRequest(request);
  if (unauthorized) return unauthorized;

  const bus = getEventBus();
  if (!bus) {
    // No DATABASE_URL — no outbox to drain. Inert, not an error.
    return NextResponse.json({ ok: true, drained: 0, note: "event bus not configured" });
  }

  try {
    const results = await bus.drainOutbox();
    return NextResponse.json({
      ok: true,
      drained: results.length,
      delivered: results.filter((r) => r.failures.length === 0).length,
      failures: results.flatMap((r) =>
        r.failures.map((f) => ({ event_id: r.event_id, url: f.url, error: f.error })),
      ),
    });
  } catch (err) {
    console.error("events-drain failed", err);
    return NextResponse.json({ ok: false, error: "Drain failed" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return drain(request);
}

export async function POST(request: Request) {
  return drain(request);
}
