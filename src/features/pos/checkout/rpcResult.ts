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
