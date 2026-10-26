// src/features/pos/order/billActions.ts
/** The bill actions overlay (spec §3): only what exists for this bill right now, Feedme order. */

export type BillAction = 'send' | 'move' | 'void_bill' | 'close_empty' | 'pax' | 'pause_qr' | 'resume_qr' | 'open_qr'

export const BILL_ACTION_LABEL: Record<BillAction, string> = {
  send: 'Send', move: 'Move', void_bill: 'Void bill', close_empty: 'Close empty bill', pax: 'Pax',
  pause_qr: 'Pause QR', resume_qr: 'Resume QR', open_qr: 'Open for QR',
}

/** Send with drafts; Move with a bill; Void bill when the bill has live items, Close empty bill when
 *  it has none (both only once its items are loaded); on a table: Pax, Pause or Resume QR, and Open
 *  for QR while it has no bill and the branch makes QR wait for an open bill (today's BillPanel). */
export function billActions(p: {
  isTable: boolean; hasBill: boolean; loaded: boolean; liveSentCount: number; draftCount: number
  qrPaused: boolean; qrRequiresOpenBill: boolean
}): BillAction[] {
  const out: BillAction[] = []
  if (p.draftCount > 0) out.push('send')
  if (p.hasBill) out.push('move')
  if (p.hasBill && p.loaded) out.push(p.liveSentCount > 0 ? 'void_bill' : 'close_empty')
  if (p.isTable) {
    out.push('pax', p.qrPaused ? 'resume_qr' : 'pause_qr')
    if (!p.hasBill && p.qrRequiresOpenBill) out.push('open_qr')
  }
  return out
}
