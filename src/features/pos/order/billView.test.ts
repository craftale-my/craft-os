import { describe, expect, it } from 'vitest'
import { billView, discardQuestion, itemsWord, payGate, sendFirstQuestion } from './billView'
import type { BillingConfig } from '../checkout/checkoutApi'
import { DEFAULT_POS_SETTINGS } from '../checkout/checkoutApi'
import type { PosMenu } from './cart'
import type { BillItemRow } from './posApi'
import type { PadProductInfo } from './padInfo'

const billing: BillingConfig = { settings: { ...DEFAULT_POS_SETTINGS, sstRegistered: true, cashRounding: 'nearest_5_sen' }, rules: [] }
const menu: PosMenu = { categories: [{ name: 'FOOD', products: [{
  id: 'p1', name: 'Nasi Lemak', description: null, soldOut: false,
  variants: [{ id: 'v1', name: 'Regular', priceSen: 500, isBase: true }],
  groups: [{ id: 'g1', name: 'Add-on', min: 0, max: 2, options: [{ id: 'o1', name: 'Egg', priceDeltaSen: 200, isDefault: false, available: true }] }],
}] }] }
const info = new Map<string, PadProductInfo>([['p1', { sstRateBp: 600, takeawayFeeSen: 100, imageUrl: null }]])
const item = (id: string, voided = false): BillItemRow => ({
  id, order_id: 'o-1', product_id: 'p1', name_snapshot: 'Nasi Lemak', unit_price_sen: 1000, sst_rate_bp: 600, takeaway_fee_sen: 0,
  order_type: 'dine_in', qty: 2, note: 'less spicy', modifiers_snapshot: [{ name: 'Egg' }], voided_at: voided ? '2026-10-26T03:00:00Z' : null,
  orders: { order_no: '1', source: 'counter', placed_at: '2026-10-26T02:00:00Z' },
})
const draft = { productId: 'p1', variantId: 'v1', qty: 1, note: null, optionIds: ['o1'] }

describe('billView', () => {
  it('lists sent items with their modifiers and note, and drafts priced from the menu', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1'), item('i2', true)], lines: [draft], menu, info, billing })
    expect(v.sent.map((s) => [s.name, s.qty, s.mods, s.note, s.amountSen, s.voided])).toEqual([
      ['Nasi Lemak', 2, ['Egg'], 'less spicy', 2000, false],
      ['Nasi Lemak', 2, ['Egg'], 'less spicy', 2000, true],
    ])
    expect(v.drafts.map((d) => [d.index, d.name, d.mods, d.unitSen])).toEqual([[0, 'Nasi Lemak', ['Egg'], 700]])
    expect(v.liveSentCount).toBe(2)
    expect(v.draftCount).toBe(1)
  })
  it('counts drafts in the preview with the server\'s rules (dine-in: no packaging fee)', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1')], lines: [draft], menu, info, billing })
    // 20.00 + 7.00 = 27.00, SST 6% 1.62 = 28.62 → 28.60
    expect(v.totalsIncludeDrafts).toBe(true)
    expect([v.totals?.subtotalSen, v.totals?.sstSen, v.totals?.totalSen]).toEqual([2700, 162, 2860])
  })
  it('a takeaway draft carries its packaging fee, taxed at its SST rate', () => {
    const v = billView({ orderType: 'takeaway', tableId: null, items: [], lines: [draft], menu, info, billing })
    // 7.00 + fee 1.00, SST 6% of 8.00 = 0.48 → 8.48 → 8.50
    expect([v.totals?.subtotalSen, v.totals?.takeawayFeeSen, v.totals?.sstSen, v.totals?.totalSen]).toEqual([700, 100, 48, 850])
  })
  it('without a product\'s SST rate the preview leaves every draft out and says so', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1')], lines: [draft], menu, info: new Map(), billing })
    expect(v.totalsIncludeDrafts).toBe(false)
    expect(v.totals?.totalSen).toBe(2120)
  })
  it('a draft the menu no longer has is shown as unavailable and not priced', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [], lines: [{ ...draft, productId: 'gone' }], menu, info, billing })
    expect(v.drafts[0]).toMatchObject({ name: 'Unavailable item', unitSen: null })
    expect(v.totalsIncludeDrafts).toBe(false)
  })
  it('no billing config yet: no totals', () => {
    expect(billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1')], lines: [], menu, info, billing: null }).totals).toBeNull()
  })
})

describe('payGate', () => {
  const base = { shiftOpen: true, draftCount: 0, hasBill: true, liveSentCount: 2 }
  it('no open shift (or not known yet) disables Payment first of all', () => {
    expect(payGate({ ...base, shiftOpen: false })).toBe('no_shift')
    expect(payGate({ ...base, shiftOpen: null, draftCount: 3 })).toBe('no_shift')
  })
  it('drafts are sent first, even on a table with no bill yet', () => {
    expect(payGate({ ...base, draftCount: 1 })).toBe('send_first')
    expect(payGate({ ...base, draftCount: 1, hasBill: false, liveSentCount: 0 })).toBe('send_first')
  })
  it('a bill with nothing live cannot be paid; otherwise it is ready', () => {
    expect(payGate({ ...base, liveSentCount: 0 })).toBe('empty')
    expect(payGate({ ...base, hasBill: false })).toBe('empty')
    expect(payGate(base)).toBe('ready')
  })
})

describe('words', () => {
  it('singular and plural', () => {
    expect(itemsWord(1)).toBe('1 item')
    expect(itemsWord(3)).toBe('3 items')
    expect(sendFirstQuestion(1)).toBe('Send 1 new item first?')
    expect(sendFirstQuestion(4)).toBe('Send 4 new items first?')
    expect(discardQuestion(2)).toBe('Discard 2 unsent items?')
  })
})
