/** Replies of the protected POS RPCs. A wrong approver PIN is not raised as an
 *  error on the server — the failed-attempt counter must be saved, and a raise
 *  would roll it back — so those functions answer {ok:false, error} instead. */

export interface CheckoutResult {
  billId: string
  billNo: string
  totalSen: number
  changeSen: number
  receiptQueued: boolean
}

/** refund_bill's answer: the amount of THIS refund as recorded on the server (a resend
 *  after a lost reply returns the first one), the bill's refunded total, and whether
 *  a refund slip was queued for the receipt printer. */
export interface RefundResult {
  amountSen: number
  refundedSen: number
  slipQueued: boolean
}

/** A request that got no reply, as postgrest-js reports the browser's network failure
 *  ("${name}: ${message}"): Chrome "TypeError: Failed to fetch", Firefox "TypeError: NetworkError
 *  when attempting to fetch resource.", Safari — every iPad — "TypeError: Load failed", or a
 *  timeout / abort. The request may still have landed, so the sheet keeps its id and a resend is
 *  safe. The one classifier of the POS sheets (checkout, close shift, pay in / pay out); every
 *  refusal of the server has other words. */
export const looksOffline = (m: string) => /load failed|fetch|network|timeout|abort|signal/i.test(m)

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Throws the server's words when the action was refused; returns the reply otherwise. */
export function unwrapAction(data: unknown): Record<string, unknown> {
  if (!isObj(data) || typeof data.ok !== 'boolean') throw new Error('Unexpected reply from the server')
  if (!data.ok) throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Not approved')
  return data
}

export function parseCheckoutResult(data: unknown): CheckoutResult {
  if (!isObj(data) || typeof data.billId !== 'string' || typeof data.billNo !== 'string'
      || typeof data.totalSen !== 'number' || typeof data.changeSen !== 'number' || typeof data.receiptQueued !== 'boolean') {
    throw new Error('Unexpected reply from the server')
  }
  return { billId: data.billId, billNo: data.billNo, totalSen: data.totalSen, changeSen: data.changeSen, receiptQueued: data.receiptQueued }
}

/** Throws the server's words when the refund was refused; returns what was recorded otherwise. */
export function parseRefundResult(data: unknown): RefundResult {
  const r = unwrapAction(data)
  if (typeof r.amountSen !== 'number' || typeof r.refundedSen !== 'number' || typeof r.slipQueued !== 'boolean') {
    throw new Error('Unexpected reply from the server')
  }
  return { amountSen: r.amountSen, refundedSen: r.refundedSen, slipQueued: r.slipQueued }
}
