// src/features/pos/order/billActions.ts
/** The bill actions overlay (spec §3) and what a tapped sent item offers: only what exists for this
 *  bill right now, Feedme order. */
import { SPLIT_ACTION_LABEL, SPLIT_OFFLINE, canSplit } from './splitSelection'

export type BillAction = 'send' | 'move' | 'split' | 'discount_bill' | 'edit_bill_discount' | 'remove_bill_discount'
  | 'void_bill' | 'close_empty' | 'pax' | 'pause_qr' | 'resume_qr' | 'open_qr'

export const BILL_ACTION_LABEL: Record<BillAction, string> = {
  send: 'Send', move: 'Move', split: SPLIT_ACTION_LABEL, discount_bill: 'Discount bill', edit_bill_discount: 'Edit discount',
  remove_bill_discount: 'Remove discount', void_bill: 'Void bill', close_empty: 'Close empty bill', pax: 'Pax',
  pause_qr: 'Pause QR', resume_qr: 'Resume QR', open_qr: 'Open for QR',
}

/** Send with drafts; Move with a bill; once its items are loaded: Split / Move items once loaded with
 *  two live units or more (split spec §3.1), Discount bill when it has live items
 *  (Edit and Remove discount when it has one), then Void bill when it has live items, Close empty
 *  bill when it has none; on a table: Pax, Pause or Resume QR, and Open for QR while it has no bill
 *  and the branch makes QR wait for an open bill (today's BillPanel). */
export function billActions(p: {
  isTable: boolean; hasBill: boolean; loaded: boolean; liveSentCount: number; draftCount: number
  qrPaused: boolean; qrRequiresOpenBill: boolean; billDiscount: boolean
}): BillAction[] {
  const out: BillAction[] = []
  if (p.draftCount > 0) out.push('send')
  if (p.hasBill) out.push('move')
  if (p.hasBill && p.loaded) {
    if (canSplit(p.liveSentCount)) out.push('split')
    if (p.billDiscount) out.push('edit_bill_discount', 'remove_bill_discount')
    else if (p.liveSentCount > 0) out.push('discount_bill')
    out.push(p.liveSentCount > 0 ? 'void_bill' : 'close_empty')
  }
  if (p.isTable) {
    out.push('pax', p.qrPaused ? 'resume_qr' : 'pause_qr')
    if (!p.hasBill && p.qrRequiresOpenBill) out.push('open_qr')
  }
  return out
}

/** pos_no_parts' words (split spec §3.5): what the server answers while a bill has a part paid. */
export const PART_PAID_FIRST = 'This bill has a part payment. Pay the rest first.'

/** The bill actions shown off, each with why: offline, Split / Move items needs a connection; a bill with a
 *  part paid (split spec §3.5) refuses a split, setting or editing its discount and voiding it, so those
 *  are off with the server's words. Move and Remove discount stay (the server allows them). */
export function billActionNotes(p: { online: boolean; partPaid: boolean }): Partial<Record<BillAction, string>> {
  if (p.partPaid) return { split: PART_PAID_FIRST, discount_bill: PART_PAID_FIRST, edit_bill_discount: PART_PAID_FIRST, void_bill: PART_PAID_FIRST }
  return p.online ? {} : { split: SPLIT_OFFLINE }
}

export type ItemAction = 'discount_item' | 'edit_item_discount' | 'remove_item_discount' | 'void_item'

export const ITEM_ACTION_LABEL: Record<ItemAction, string> = {
  discount_item: 'Discount item', edit_item_discount: 'Edit discount', remove_item_discount: 'Remove discount', void_item: 'Void item',
}

/** A tapped sent item: Discount item (Edit and Remove discount when it has one), then Void item. */
export function itemActions(p: { discounted: boolean }): ItemAction[] {
  return p.discounted ? ['edit_item_discount', 'remove_item_discount', 'void_item'] : ['discount_item', 'void_item']
}

/** A tapped item of a bill with a part paid: discounting it (set or edit) and voiding it are off with the
 *  server's words; Remove discount stays. */
export function itemActionNotes(p: { partPaid: boolean }): Partial<Record<ItemAction, string>> {
  return p.partPaid ? { discount_item: PART_PAID_FIRST, edit_item_discount: PART_PAID_FIRST, void_item: PART_PAID_FIRST } : {}
}
