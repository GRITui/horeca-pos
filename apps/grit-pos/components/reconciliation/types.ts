export interface ReconciliationDTO {
  id: string;
  tenantId: string;
  businessDate: string;
  expectedCashTotal: number;
  countedCashTotal: number;
  cashVariance: number;
  cardTotal: number;
  qrPayTotal: number;
  stripeTotal: number;
  notes: string | null;
  closedByUserId: string;
  closedByEmail: string;
  createdAt: string;
}

export interface StripePayoutCheck {
  available: false;
  total: null;
  note: string;
}

export interface ExpectedTotalsDTO {
  businessDate: string;
  expected: {
    cash: number;
    card: number;
    qrPay: number;
    stripe: number;
  };
  stripePayout: StripePayoutCheck;
  alreadyClosed: boolean;
  existingReconciliation: ReconciliationDTO | null;
}
