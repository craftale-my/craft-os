/** Start of today in Malaysia (UTC+8, no daylight saving) as an ISO instant. */
export function mytDayStartIso(nowMs: number): string {
  const h8 = 8 * 3600_000
  const myt = new Date(nowMs + h8)
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), myt.getUTCDate()) - h8).toISOString()
}

/** What can still be refunded on a paid bill. */
export function refundableSen(bill: { status: string; total_sen: number | null; refunded_sen: number }): number {
  if (bill.status !== 'paid' || bill.total_sen === null) return 0
  return Math.max(0, bill.total_sen - bill.refunded_sen)
}

export const STATUS_LABEL: Record<string, string> = { paid: 'Paid', voided: 'Voided', merged: 'Merged' }
