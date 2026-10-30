// src/features/pos/order/billView.ts
/** The order screen's bill column (spec §2): the sent items from the server, the drafts (the
 *  cart) under them, and the instant totals preview. The server's totals stay the truth: the
 *  Payment screen shows pos_checkout_state's numbers, the tiles pos_open_bill_summaries'. */
import { computeBill, discountOffSen, lineDiscounts, type BillLineInput, type BillTotals } from '../checkout/bill'
import type { BillingConfig } from '../checkout/checkoutApi'
import { catalogTag, discountLabel, lineDiscountRows, storedDiscount, type DiscountRow, type StoredDiscount } from '../checkout/discounts'
import type { OrderType } from '../offline/orderQueue'
import { findProduct, lineLabel, linePriceSen, type OrderLine, type PosMenu } from './cart'
import type { PadProductInfo } from './padInfo'
import type { BillItemRow } from './posApi'

export interface SentRow {
  item: BillItemRow; qty: number; name: string; mods: string[]; note: string | null; amountSen: number; voided: boolean
  discountRows: DiscountRow[]   // its catalog and item discounts, as they come off now
  afterCatalogSen: number       // what an item discount applies to
}
export interface DraftRow {
  index: number                 // position in the cart
  line: OrderLine
  qty: number
  name: string                  // 'Unavailable item' when the menu does not have it
  mods: string[]
  note: string | null
  unitSen: number | null        // null = not priced (unavailable)
}
export interface BillView {
  sent: SentRow[]
  drafts: DraftRow[]
  liveSentCount: number         // qty of sent items not voided
  draftCount: number            // qty of all draft lines
  totals: BillTotals | null     // null until the branch's billing config is loaded
  totalsIncludeDrafts: boolean  // false when a draft could not be priced (then only sent items count)
  sentSubtotalSen: number          // sent live lines after catalog and item discounts: what a bill discount applies to
  billDiscount: DiscountRow | null // its label (with reason) and what it takes off now
  catalogTag: string | null        // "Staff Meal 50%" when an item has a catalog discount
}
export interface BillViewInput {
  orderType: OrderType
  tableId: string | null
  items: BillItemRow[]
  lines: OrderLine[]
  menu: PosMenu | null
  info: ReadonlyMap<string, PadProductInfo>
  billing: BillingConfig | null
  billDiscount?: StoredDiscount | null  // the open bill's discount
  draftCatalogDiscountBp?: number       // the discount of the catalog the drafts are ordered from
}

export function billView(i: BillViewInput): BillView {
  const sent: SentRow[] = i.items.map((it) => {
    const d = lineDiscounts({ unitPriceSen: it.unit_price_sen, qty: it.qty, catalogDiscountBp: it.catalog_discount_bp, discount: storedDiscount(it) })
    return {
      item: it, qty: it.qty, name: it.name_snapshot, mods: it.modifiers_snapshot.map((m) => m.name), note: it.note,
      amountSen: d.grossSen, voided: it.voided_at !== null,
      discountRows: it.voided_at === null ? lineDiscountRows(it, d) : [],
      afterCatalogSen: d.grossSen - d.catalogDiscountSen,
    }
  })
  const drafts: DraftRow[] = i.lines.map((line, index) => {
    const p = i.menu ? findProduct(i.menu, line.productId) : undefined
    if (!p) return { index, line, qty: line.qty, name: 'Unavailable item', mods: [], note: line.note, unitSen: null }
    const { name, mods } = lineLabel(p, line)
    return { index, line, qty: line.qty, name, mods, note: line.note, unitSen: linePriceSen(p, line) }
  })
  // in order item id order, as pos_bill_totals sends them: a bill discount's leftover sen lands on the same line
  const sentLines: BillLineInput[] = [...i.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((it) => ({
    id: it.id, productId: it.product_id, unitPriceSen: it.unit_price_sen, qty: it.qty, sstRateBp: it.sst_rate_bp,
    takeawayFeeSen: it.takeaway_fee_sen, voided: it.voided_at !== null, orderType: it.order_type,
    catalogDiscountBp: it.catalog_discount_bp, discount: storedDiscount(it),
  }))
  // a draft counts like pos_insert_order will snapshot it: its price, its product's SST rate, the
  // packaging fee on a takeaway order only, and its catalog's discount
  const draftLines: BillLineInput[] = drafts.flatMap((d) => {
    const info = i.info.get(d.line.productId)
    if (d.unitSen === null || !info) return []
    return [{ productId: d.line.productId, unitPriceSen: d.unitSen, qty: d.qty, sstRateBp: info.sstRateBp,
              takeawayFeeSen: i.orderType === 'takeaway' ? info.takeawayFeeSen : 0, voided: false, orderType: i.orderType,
              catalogDiscountBp: i.draftCatalogDiscountBp ?? 0 }]
  })
  const totalsIncludeDrafts = draftLines.length === drafts.length
  const bd = i.billDiscount ?? null
  const totals = i.billing ? computeBill({
    orderType: i.orderType, tableId: i.tableId,
    sstRegistered: i.billing.settings.sstRegistered, cashRounding: i.billing.settings.cashRounding, rules: i.billing.rules,
    lines: totalsIncludeDrafts ? [...sentLines, ...draftLines] : sentLines,
    billDiscount: bd,
  }) : null
  const sentSubtotalSen = sent.filter((s) => !s.voided)
    .reduce((n, s) => n + s.afterCatalogSen - discountOffSen(storedDiscount(s.item), s.afterCatalogSen), 0)
  return {
    sent, drafts, totals, totalsIncludeDrafts, sentSubtotalSen,
    billDiscount: bd ? { label: discountLabel(bd, true), amountSen: totals?.billDiscountSen ?? discountOffSen(bd, sentSubtotalSen) } : null,
    catalogTag: catalogTag(i.items),
    liveSentCount: sent.filter((s) => !s.voided).reduce((n, s) => n + s.qty, 0),
    draftCount: i.lines.reduce((n, l) => n + l.qty, 0),
  }
}

/** What the Payment button does (spec §2 rules), in this order: no open shift → disabled; drafts →
 *  ask "Send n new items first?"; nothing live on the bill → disabled; else open Payment. A shift
 *  that is not known yet counts as not open (nothing that moves money is offered then). */
export type PayGate = 'no_shift' | 'send_first' | 'empty' | 'ready'
export function payGate(p: { shiftOpen: boolean | null; draftCount: number; hasBill: boolean; liveSentCount: number }): PayGate {
  if (p.shiftOpen !== true) return 'no_shift'
  if (p.draftCount > 0) return 'send_first'
  if (!p.hasBill || p.liveSentCount === 0) return 'empty'
  return 'ready'
}

export const NO_SHIFT_PAY = 'Open a shift to take payment'
export const itemsWord = (n: number): string => `${n} item${n === 1 ? '' : 's'}`
export const sendFirstQuestion = (n: number): string => `Send ${n} new item${n === 1 ? '' : 's'} first?`
export const discardQuestion = (n: number): string => `Discard ${n} unsent item${n === 1 ? '' : 's'}?`
/** Said in a merge's confirm when the order screen has drafts: the merged-away screen loses them. */
export const draftsDiscarded = (n: number): string => `${n} unsent item${n === 1 ? '' : 's'} will be discarded.`
/** Send & pay found the order still in this iPad's queue (offline): no bill to pay yet. */
export const QUEUED_NOT_SENT = 'The order is saved on this iPad and will send when the network is back. Take payment once it has arrived.'
