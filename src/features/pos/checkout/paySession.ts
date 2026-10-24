/** One checkout's payment attempts (pre-pilot hardening §2). Pure.
 *  editing  — lines editable; Pay sends them with checkoutId
 *  paying   — a Pay or Try again is on its way
 *  unsure   — no reply: lines locked; Try again (same lines, same id) or Check bill
 *  checking — Check bill is re-reading the bill
 *  An unsure send may still land on the server, so its id is kept until Check bill finds
 *  the bill open; only then are the lines unlocked with a NEW id — and the old one moves to
 *  earlierIds, because that first attempt can still commit later: the bill is re-read with
 *  every id (checkoutIds), so the sheet shows its own paid result, never "paid on another
 *  iPad". A refusal recorded nothing under the id, so editing goes on with the same one (a
 *  late first attempt that lands meanwhile makes the server refuse other lines under it). */
export type PayPhase = 'editing' | 'paying' | 'unsure' | 'checking'

export interface PaySession {
  phase: PayPhase
  checkoutId: string
  earlierIds: string[]   // ids Check bill replaced, oldest first
}

export type PayEvent =
  | { type: 'send' }                               // Pay (editing) or Try again (unsure)
  | { type: 'refused' }                            // the server answered no
  | { type: 'noReply' }                            // timeout or dropped connection
  | { type: 'check' }                              // Check bill
  | { type: 'checkedOpen'; newCheckoutId: string } // the bill is still open: unlock with a new id
  | { type: 'checkEnded' }                         // Check bill did not find it open (no answer, paid or closed)

export const newPaySession = (checkoutId: string): PaySession => ({ phase: 'editing', checkoutId, earlierIds: [] })

/** An event that does not fit the phase changes nothing (a double tap, a late reply). */
export function nextPay(s: PaySession, e: PayEvent): PaySession {
  switch (e.type) {
    case 'send':
      return s.phase === 'editing' || s.phase === 'unsure' ? { ...s, phase: 'paying' } : s
    case 'refused':
      return s.phase === 'paying' ? { ...s, phase: 'editing' } : s
    case 'noReply':
      return s.phase === 'paying' ? { ...s, phase: 'unsure' } : s
    case 'check':
      return s.phase === 'unsure' ? { ...s, phase: 'checking' } : s
    case 'checkedOpen':
      return s.phase === 'checking' ? { phase: 'editing', checkoutId: e.newCheckoutId, earlierIds: [...s.earlierIds, s.checkoutId] } : s
    case 'checkEnded':
      return s.phase === 'checking' ? { ...s, phase: 'unsure' } : s
  }
}

/** Method buttons, amounts and remove buttons are locked in every phase but editing. */
export const linesLocked = (s: PaySession): boolean => s.phase !== 'editing'

/** Every checkout id this sheet has used, oldest first: pos_checkout_state shows the paid
 *  result when any of them paid the bill. */
export const checkoutIds = (s: PaySession): string[] => [...s.earlierIds, s.checkoutId]

export const UNSURE = 'Not sure the payment went through (no reply). Press Try again — it will not be charged twice — or Check bill.'
export const CHECKED_OPEN = 'The bill is still open — the payment was not recorded. Check the lines and press Pay.'
