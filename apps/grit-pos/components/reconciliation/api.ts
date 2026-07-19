"use client";

import type { ExpectedTotalsDTO, ReconciliationDTO } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export function getExpectedTotals(businessDate: string): Promise<ExpectedTotalsDTO> {
  return request(`/api/reconciliation/expected?date=${encodeURIComponent(businessDate)}`);
}

export function listReconciliations(): Promise<{ reconciliations: ReconciliationDTO[] }> {
  return request("/api/reconciliation");
}

export function closeReconciliation(input: {
  businessDate: string;
  countedCashTotal: number;
  notes: string;
}): Promise<{ reconciliation: ReconciliationDTO }> {
  return request("/api/reconciliation", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
