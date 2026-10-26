/** The checkout sheet follows its bill (pre-pilot hardening §1): what the sheet does with
 *  pos_checkout_state, re-read on every bills event and every 15 s sweep. Pure. */
import type { BillTotals } from './bill'
import { parseCheckoutResult, type CheckoutResult } from './rpcResult'

export type BillStatus = 'open' | 'paid' | 'voided' | 'merged'

/** pos_checkout_state's answer. */
export interface CheckoutState {
  status: BillStatus
  billNo: string
  mergedIntoBillNo: string | null
  totals: BillTotals | null       // open bills only
  result: CheckoutResult | null   // when one of THIS sheet's checkout ids paid the bill
}

export type FollowAction =
  | { kind: 'keep' }
  | { kind: 'paidHere'; result: CheckoutResult }
  | { kind: 'lock'; note: string }
  | { kind: 'reload'; totals: BillTotals; note: string | null }

export const PAID_ELSEWHERE = 'This bill was paid on another iPad — do not charge the card terminal.'
export const VOIDED_ELSEWHERE = 'This bill was voided on another iPad.'
export const mergedElsewhere = (billNo: string | null) => `This bill was merged into ${billNo ?? 'another bill'} on another iPad.`
export const BILL_CHANGED = 'The bill changed on another iPad — check the total.'
/** Pay found the bill changed since the cashier started: Pay cleared what was entered for the old
 *  total (the cash received, the reference), so the notice asks for it again before the second,
 *  deliberate Pay. */
export function billChangedAtPay(method: { kind: string; needsReference: boolean } | null): string {
  const again = method?.kind === 'cash' ? 'enter the cash received again, then tap Pay'
    : method?.needsReference ? 'enter the reference again, then tap Pay'
    : 'then tap Pay again'
  return `The bill changed on another iPad — check the new total, ${again}.`
}

/** shownTotalSen: the total on screen now (null before the first load). */
export function followBill(state: CheckoutState, shownTotalSen: number | null): FollowAction {
  switch (state.status) {
    case 'paid':
      return state.result ? { kind: 'paidHere', result: state.result } : { kind: 'lock', note: PAID_ELSEWHERE }
    case 'voided':
      return { kind: 'lock', note: VOIDED_ELSEWHERE }
    case 'merged':
      return { kind: 'lock', note: mergedElsewhere(state.mergedIntoBillNo) }
    case 'open':
      if (!state.totals) return { kind: 'keep' }
      if (shownTotalSen === null) return { kind: 'reload', totals: state.totals, note: null }
      if (state.totals.totalSen !== shownTotalSen) return { kind: 'reload', totals: state.totals, note: BILL_CHANGED }
      return { kind: 'keep' }
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const STATUSES: readonly string[] = ['open', 'paid', 'voided', 'merged']

/** Throws "Unexpected reply from the server" for anything that is not pos_checkout_state's shape. */
export function parseCheckoutState(data: unknown): CheckoutState {
  if (!isObj(data) || typeof data.status !== 'string' || !STATUSES.includes(data.status) || typeof data.billNo !== 'string'
      || (data.mergedIntoBillNo !== null && typeof data.mergedIntoBillNo !== 'string')
      || (data.totals !== null && !(isObj(data.totals) && typeof data.totals.totalSen === 'number'))) {
    throw new Error('Unexpected reply from the server')
  }
  return {
    status: data.status as BillStatus,
    billNo: data.billNo,
    mergedIntoBillNo: data.mergedIntoBillNo as string | null,
    totals: data.totals as BillTotals | null,
    result: data.result === null ? null : parseCheckoutResult(data.result),
  }
}
