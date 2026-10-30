/** Reason templates for voids, refunds and discounts (Feedme's "Reason template").
 *  Same rule as pos_check_reason in SQL, with the same words. */

export type ReasonAction = 'void_item' | 'void_bill' | 'refund' | 'discount'

export interface ReasonTemplate {
  reasons: string[]
  compulsory: boolean
  allowOther: boolean
}

/** No template saved for the action: a reason is required, any wording. */
export const DEFAULT_TEMPLATE: ReasonTemplate = { reasons: [], compulsory: true, allowOther: true }

export function reasonProblem(t: ReasonTemplate, reason: string): string | null {
  const r = reason.trim()
  if (!r) return t.compulsory ? 'Choose a reason' : null
  if (!t.allowOther && !t.reasons.includes(r)) return 'Choose one of the listed reasons'
  if (r.length > 200) return 'Reason is too long'
  return null
}

export const ACTION_TITLES: Record<ReasonAction, string> = {
  void_item: 'Void item',
  void_bill: 'Void bill',
  refund: 'Refund',
  discount: 'Discount',
}
