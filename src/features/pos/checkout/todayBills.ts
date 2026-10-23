import { formatSen } from '../order/cart'

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

/** The drawer's note after a refund, from what the SERVER recorded (a resend after a
 *  lost reply answers with the first refund, whatever was typed the second time). */
export function refundDoneNote(r: { amountSen: number; slipQueued: boolean }, billNo: string): string {
  return `Refunded ${formatSen(r.amountSen)} on ${billNo}${r.slipQueued ? '' : ' — no refund slip printed (no receipt printer set)'}`
}

/** One way a refund can go back: a method the bill was paid with, and the most it can take. */
export interface RefundChoice { methodId: string; label: string; maxSen: number }

/** Refunds go back the original route (owner, 2026-10-24): only the methods the bill
 *  was paid with that still have something left, each capped by its own left and by
 *  what is left on the whole bill (an older refund may have gone back another way).
 *  Kept in the order the payments were taken; the first is the default. */
export function refundChoices(
  methods: readonly { methodId: string; methodName: string; leftSen: number }[],
  billLeftSen: number,
): RefundChoice[] {
  return methods
    .map((m) => ({ m, maxSen: Math.max(0, Math.min(m.leftSen, billLeftSen)) }))
    .filter((c) => c.maxSen > 0)
    .map(({ m, maxSen }) => ({ methodId: m.methodId, maxSen, label: `${m.methodName} · up to ${formatSen(maxSen)}` }))
}
