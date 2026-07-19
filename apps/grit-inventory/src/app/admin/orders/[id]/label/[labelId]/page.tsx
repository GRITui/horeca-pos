import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { PrintLabelActions } from "@/components/print-label-actions";

export const dynamic = "force-dynamic";

/**
 * Decorative bars derived deterministically from the tracking ref's
 * character codes. This is an internal MVP label (no real carrier
 * integration — see schema note on ParcelLabel), not a certified/scannable
 * shipping barcode; it just needs to *look* like one on the printed slip.
 */
function Barcode({ value }: { value: string }) {
  const bars = value.split("").map((ch, i) => ({
    key: `${ch}-${i}`,
    width: 2 + (ch.charCodeAt(0) % 4), // 2-5px
  }));
  return (
    <div className="flex h-16 items-stretch gap-[2px] bg-white p-2" aria-hidden="true">
      {bars.map((bar) => (
        <div key={bar.key} style={{ width: bar.width }} className="h-full bg-black" />
      ))}
    </div>
  );
}

export default async function ParcelLabelPage({
  params,
}: {
  params: Promise<{ id: string; labelId: string }>;
}) {
  const session = await requireSession();
  const { id, labelId } = await params;

  const label = await db.parcelLabel.findFirst({
    where: { id: labelId, orderId: id, tenantId: session.tenantId },
    include: { order: { select: { orderNumber: true } } },
  });
  if (!label) notFound();

  return (
    <div className="mx-auto max-w-md">
      {/* 4x6 label sizing on print; screen view keeps normal admin chrome. */}
      <style>{`
        @media print {
          @page { size: 4in 6in; margin: 0.15in; }
          body * { visibility: hidden; }
          #parcel-label, #parcel-label * { visibility: visible; }
          #parcel-label {
            position: absolute;
            top: 0;
            left: 0;
            width: 4in;
            border: none !important;
            box-shadow: none !important;
          }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <a href={`/admin/orders/${id}`} className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
          &larr; Back to order
        </a>
        <PrintLabelActions labelId={label.id} printedAt={label.printedAt?.toISOString() ?? null} />
      </div>

      <div
        id="parcel-label"
        className="rounded-lg border-2 border-dashed border-zinc-400 bg-white p-6 text-black dark:border-zinc-600"
      >
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Order #{label.order.orderNumber}
        </div>

        <div className="mt-4">
          <div className="text-xs uppercase text-zinc-500">Ship to</div>
          <div className="text-lg font-semibold">{label.toName ?? "—"}</div>
          <div className="whitespace-pre-line text-sm">{label.toAddress ?? "—"}</div>
        </div>

        <div className="mt-6 border-t border-zinc-300 pt-4">
          <div className="text-xs uppercase text-zinc-500">Items</div>
          <div className="text-2xl font-bold">{label.itemCount}</div>
        </div>

        <div className="mt-6">
          <Barcode value={label.trackingRef} />
          <div className="mt-2 text-center font-mono text-2xl font-bold tracking-widest">
            {label.trackingRef}
          </div>
        </div>
      </div>
    </div>
  );
}
