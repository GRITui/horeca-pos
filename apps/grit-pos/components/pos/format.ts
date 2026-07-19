/** MVP money formatting — the schema doesn't carry a per-tenant currency yet, so this assumes a $-prefixed 2dp display. */
export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
