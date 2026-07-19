import "server-only";

// ---------------------------------------------------------------------------
// "Business date" handling for end-of-day reconciliation.
//
// `DailyReconciliation.businessDate` is a Postgres DATE (no time component,
// see prisma/schema.prisma), addressed everywhere in this feature as a plain
// "YYYY-MM-DD" string. There's no per-tenant timezone/store-hours concept in
// the schema yet, so a "business day" is treated as a UTC calendar day —
// good enough for the MVP, and easy to move to a tenant-local cutover later
// without touching the DailyReconciliation shape itself.
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a "YYYY-MM-DD" string into a Date at UTC midnight. Throws on anything else. */
export function parseBusinessDate(raw: string | null | undefined): Date {
  if (!raw || !ISO_DATE_RE.test(raw)) {
    throw new Error('businessDate must be an ISO date string ("YYYY-MM-DD")');
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error("businessDate is not a valid calendar date");
  }
  return date;
}

/** Renders a stored businessDate (or any Date) back to "YYYY-MM-DD". */
export function formatBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** [start, end) half-open UTC range covering the given business day. */
export function businessDayRange(businessDate: Date): { start: Date; end: Date } {
  const start = businessDate;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}
