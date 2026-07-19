"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/components/pos/format";
import { closeReconciliation, getExpectedTotals, listReconciliations } from "./api";
import type { ExpectedTotalsDTO, ReconciliationDTO } from "./types";

function todayBusinessDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function ReconciliationApp({
  initialHistory,
}: {
  initialHistory: ReconciliationDTO[];
}) {
  const [businessDate, setBusinessDate] = useState(todayBusinessDate);
  const [preview, setPreview] = useState<ExpectedTotalsDTO | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [countedCashTotal, setCountedCashTotal] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [history, setHistory] = useState<ReconciliationDTO[]>(initialHistory);

  useEffect(() => {
    let cancelled = false;
    // Reset UI state to "loading" for the newly-selected businessDate before
    // kicking off the fetch below — not derived from other React state, so
    // this can't be hoisted into render.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting loading/error/preview state for the new businessDate before fetching
    setLoadingPreview(true);
    setPreviewError(null);
    setPreview(null);
    getExpectedTotals(businessDate)
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        setCountedCashTotal(data.expected.cash.toFixed(2));
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(err instanceof Error ? err.message : "Could not load expected totals");
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessDate]);

  async function refreshHistory() {
    try {
      const { reconciliations } = await listReconciliations();
      setHistory(reconciliations);
    } catch {
      // Non-fatal — the just-closed record is already shown via optimistic
      // update below, and the user can reload the page to re-sync.
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);

    const parsedCounted = Number(countedCashTotal);
    if (!Number.isFinite(parsedCounted) || parsedCounted < 0) {
      setSubmitError("Counted cash total must be a non-negative number");
      return;
    }

    setSubmitting(true);
    try {
      const { reconciliation } = await closeReconciliation({
        businessDate,
        countedCashTotal: parsedCounted,
        notes,
      });
      setHistory((prev) => [reconciliation, ...prev.filter((r) => r.id !== reconciliation.id)]);
      setNotes("");
      await refreshHistory();
      // Re-fetch the preview so the form flips into "already closed" state.
      const refreshed = await getExpectedTotals(businessDate).catch(() => null);
      if (refreshed) setPreview(refreshed);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not close the till");
    } finally {
      setSubmitting(false);
    }
  }

  const alreadyClosed = preview?.alreadyClosed ?? false;
  const variance =
    preview && countedCashTotal !== ""
      ? Number(countedCashTotal) - preview.expected.cash
      : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <section className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold">End-of-day reconciliation</h2>
          <label className="flex flex-col gap-1 text-sm">
            Business date
            <input
              type="date"
              value={businessDate}
              max={todayBusinessDate()}
              onChange={(e) => setBusinessDate(e.target.value)}
              className="rounded border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        </div>

        {loadingPreview && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading expected totals…</p>
        )}
        {previewError && (
          <p className="text-sm text-red-600 dark:text-red-400">{previewError}</p>
        )}

        {preview && !loadingPreview && (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Cash</dt>
                <dd className="font-semibold tabular-nums">{formatMoney(preview.expected.cash)}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Card</dt>
                <dd className="font-semibold tabular-nums">{formatMoney(preview.expected.card)}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">QR pay</dt>
                <dd className="font-semibold tabular-nums">{formatMoney(preview.expected.qrPay)}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Stripe</dt>
                <dd className="font-semibold tabular-nums">{formatMoney(preview.expected.stripe)}</dd>
              </div>
            </dl>

            <div className="rounded border border-dashed border-zinc-300 p-3 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              <p className="font-medium text-zinc-600 dark:text-zinc-300">
                Stripe payout cross-check: unavailable
              </p>
              <p className="mt-1">{preview.stripePayout.note}</p>
            </div>

            {alreadyClosed && preview.existingReconciliation ? (
              <div className="rounded bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                <p className="font-medium">
                  {businessDate} is already closed — counted{" "}
                  {formatMoney(preview.existingReconciliation.countedCashTotal)} in cash by{" "}
                  {preview.existingReconciliation.closedByEmail} on{" "}
                  {new Date(preview.existingReconciliation.createdAt).toLocaleString()}.
                </p>
                {preview.existingReconciliation.notes && (
                  <p className="mt-1 text-emerald-700 dark:text-emerald-400">
                    Notes: {preview.existingReconciliation.notes}
                  </p>
                )}
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                <label className="flex flex-col gap-1 text-sm">
                  Counted cash drawer total
                  <input
                    required
                    type="number"
                    step="0.01"
                    min="0"
                    value={countedCashTotal}
                    onChange={(e) => setCountedCashTotal(e.target.value)}
                    className="rounded border border-zinc-300 px-3 py-2 text-lg dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>

                {variance !== null && Math.abs(variance) > 0.005 && (
                  <p
                    className={`text-sm ${
                      variance < 0
                        ? "text-red-600 dark:text-red-400"
                        : "text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {variance < 0
                      ? `Short by ${formatMoney(Math.abs(variance))} vs. expected cash`
                      : `Over by ${formatMoney(variance)} vs. expected cash`}
                  </p>
                )}

                <label className="flex flex-col gap-1 text-sm">
                  Notes (optional)
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    placeholder="Explain any variance, till issues, etc."
                    className="rounded border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>

                {submitError && (
                  <p className="text-sm text-red-600 dark:text-red-400">{submitError}</p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="self-start rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
                >
                  {submitting ? "Closing till…" : "Close till for this date"}
                </button>
              </form>
            )}
          </>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Reconciliation history</h2>
        {history.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No till closes recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Cash (expected / counted)</th>
                  <th className="px-3 py-2">Variance</th>
                  <th className="px-3 py-2">Card</th>
                  <th className="px-3 py-2">QR pay</th>
                  <th className="px-3 py-2">Stripe</th>
                  <th className="px-3 py-2">Closed by</th>
                </tr>
              </thead>
              <tbody>
                {history.map((rec) => (
                  <tr key={rec.id} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="px-3 py-2 font-medium">{rec.businessDate}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {formatMoney(rec.expectedCashTotal)} / {formatMoney(rec.countedCashTotal)}
                    </td>
                    <td
                      className={`px-3 py-2 tabular-nums ${
                        Math.abs(rec.cashVariance) <= 0.005
                          ? "text-zinc-500 dark:text-zinc-400"
                          : rec.cashVariance < 0
                            ? "text-red-600 dark:text-red-400"
                            : "text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {rec.cashVariance > 0 ? "+" : ""}
                      {formatMoney(rec.cashVariance)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{formatMoney(rec.cardTotal)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatMoney(rec.qrPayTotal)}</td>
                    <td className="px-3 py-2 tabular-nums">{formatMoney(rec.stripeTotal)}</td>
                    <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{rec.closedByEmail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
