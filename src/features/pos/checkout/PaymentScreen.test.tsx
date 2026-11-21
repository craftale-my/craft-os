// @vitest-environment jsdom
// The full-screen Payment keeps the Checkout sheet's money logic: these drive it the way a cashier
// does and check what reaches checkout_bill.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({
  fetchCheckoutState: vi.fn(),
  fetchPaymentMethods: vi.fn(),
  checkoutBill: vi.fn(),
  checkoutItems: vi.fn(),
  splitTotals: vi.fn(),
  fetchBillItems: vi.fn(),
  partQuote: vi.fn(),
  payBillPart: vi.fn(),
}))
vi.mock('./checkoutApi', () => ({
  fetchCheckoutState: api.fetchCheckoutState,
  fetchPaymentMethods: api.fetchPaymentMethods,
  checkoutBill: api.checkoutBill,
  checkoutItems: api.checkoutItems,
  splitTotals: api.splitTotals,
  partQuote: api.partQuote,
  payBillPart: api.payBillPart,
}))
vi.mock('../order/posApi', () => ({ fetchBillItems: api.fetchBillItems }))

import PaymentScreen from './PaymentScreen'
import { billChangedAtPay } from './follow'
import { CHECKED_OPEN, UNSURE } from './paySession'
import { BILL_CHANGED_ITEMS } from '../order/splitSelection'

const totals = {
  subtotalSen: 10066, serviceChargeSen: 0, sstSen: 604, takeawayFeeSen: 0, beforeRoundingSen: 10670,
  roundingSen: 0, totalSen: 10670, sstGroups: [], serviceChargeGroups: [],
}
const bill = { id: 'b1', bill_no: '261026-001', table_id: 't3', order_type: 'dine_in' as const, pax: 2, opened_at: '2026-10-26T02:00:00Z', discount_kind: null, discount_value: null, discount_reason: null }
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

const screenAt = (refreshKey: number, onPaid: () => void) => (
  <PaymentScreen branchId="br" bill={bill} title="Table T3" refreshKey={refreshKey} earlierIds={[]}
    onSendIds={() => {}} onClose={() => {}} onPaid={onPaid} />
)
function renderScreen(onPaid = vi.fn()) {
  render(screenAt(0, onPaid))
  return onPaid
}
const openWith = (t: typeof totals) =>
  api.fetchCheckoutState.mockResolvedValue({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals: t, result: null })
const changed = { ...totals, subtotalSen: 11321, sstSen: 679, beforeRoundingSen: 12000, totalSen: 12000 }
const cashPayment = (amountSen: number) => [{ methodId: 'm-cash', amountSen, tenderedSen: null, reference: null }]

beforeEach(() => {
  api.fetchCheckoutState.mockResolvedValue({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals, result: null })
  api.fetchPaymentMethods.mockResolvedValue([
    { id: 'm-cash', branch_id: 'br', name: 'Cash', kind: 'cash', needs_reference: false, sort_order: 1, is_active: true },
    { id: 'm-visa', branch_id: 'br', name: 'Visa', kind: 'card', needs_reference: true, sort_order: 2, is_active: true },
  ])
  api.fetchBillItems.mockResolvedValue([])
  api.checkoutBill.mockReset(); api.checkoutItems.mockReset(); api.splitTotals.mockReset()
  api.partQuote.mockReset(); api.payBillPart.mockReset()
})
afterEach(cleanup)

describe('PaymentScreen', () => {
  it('cash in one go: the number pad shows the change, Pay sends one payment with the cash received', async () => {
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 4330, receiptQueued: true })
    const onPaid = renderScreen()
    await flush()
    expect(screen.getByText('RM 106.70', { selector: 'div' })).toBeTruthy()
    press('Cash')
    press('1'); press('5'); press('0')
    expect(screen.getByText('Received RM 150 · Change RM 43.30')).toBeTruthy()
    press('Pay RM 106.70')
    await flush()
    expect(api.checkoutBill).toHaveBeenCalledTimes(1)
    expect(api.checkoutBill.mock.calls[0][1]).toEqual([{ methodId: 'm-cash', amountSen: 10670, tenderedSen: 15000, reference: null }])
    expect(screen.getByText('RM 43.30')).toBeTruthy()
    press('Done')
    expect(onPaid).toHaveBeenCalledTimes(1)
  })

  it('a card asks for its reference on the Card tab', async () => {
    renderScreen()
    await flush()
    fireEvent.click(screen.getByRole('tab', { name: 'Card' }))
    press('Visa')
    press('Pay RM 106.70')
    expect(screen.getByText('Enter the reference for Visa')).toBeTruthy()
    expect(api.checkoutBill).not.toHaveBeenCalled()
  })

  it('no reply: Try again resends the same payment under the same checkout id', async () => {
    api.checkoutBill.mockRejectedValueOnce(new Error('Failed to fetch'))
    api.checkoutBill.mockResolvedValueOnce({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 0, receiptQueued: true })
    renderScreen()
    await flush()
    press('Cash')
    press('Pay RM 106.70')
    await flush()
    expect(screen.getByText(/Not sure the payment went through/)).toBeTruthy()
    press('Try again')
    await flush()
    expect(api.checkoutBill).toHaveBeenCalledTimes(2)
    expect(api.checkoutBill.mock.calls[1][1]).toEqual(api.checkoutBill.mock.calls[0][1])
    expect(api.checkoutBill.mock.calls[1][2]).toBe(api.checkoutBill.mock.calls[0][2])
  })

  it('a bill of RM 0.00 closes with no payment, even with no payment methods at the branch', async () => {
    const zero = { ...totals, subtotalSen: 0, sstSen: 0, beforeRoundingSen: 0, totalSen: 0 }
    api.fetchCheckoutState.mockResolvedValue({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals: zero, result: null })
    api.fetchPaymentMethods.mockResolvedValue([])
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 0, changeSen: 0, receiptQueued: true })
    renderScreen()
    await flush()
    press('Pay RM 0.00')
    await flush()
    expect(screen.queryByText('Choose how the bill is paid')).toBeNull()
    expect(api.checkoutBill).toHaveBeenCalledTimes(1)
    expect(api.checkoutBill.mock.calls[0][1]).toEqual([])
  })

  it('split payment: Pay waits until the payments add up to the total', async () => {
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 0, receiptQueued: true })
    renderScreen()
    await flush()
    press('Split payment')
    press('Cash')
    press('5'); press('0')                                                      // replaces the pre-filled RM 106.70
    press('Add Cash')
    expect((screen.getByRole('button', { name: 'Pay RM 106.70' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('RM 56.70', { selector: 'div' })).toBeTruthy()      // left to pay
    press('Add Cash')                                                           // the rest, prefilled
    press('Pay RM 106.70')
    await flush()
    expect(api.checkoutBill.mock.calls[0][1]).toEqual([
      { methodId: 'm-cash', amountSen: 5000, tenderedSen: null, reference: null },
      { methodId: 'm-cash', amountSen: 5670, tenderedSen: null, reference: null },
    ])
  })

  it('no method is chosen for the cashier: Pay waits for a tap on a method, a tab only shows its methods', async () => {
    renderScreen()
    await flush()
    expect(screen.getByRole('tab', { name: 'Cash', selected: true })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Pay RM 106.70' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Card' }))
    expect(screen.getByRole('button', { name: 'Visa', pressed: false })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Pay RM 106.70' }) as HTMLButtonElement).disabled).toBe(true)
    press('Visa')
    expect((screen.getByRole('button', { name: 'Pay RM 106.70' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('the bill changed on another iPad before Pay: the first Pay only shows it, the second pays the new total', async () => {
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 12000, changeSen: 0, receiptQueued: true })
    const onPaid = vi.fn()
    const { rerender } = render(screenAt(0, onPaid))
    await flush()
    press('Cash')
    openWith(changed)
    rerender(screenAt(1, onPaid))
    await flush()
    press('1'); press('5'); press('0')
    press('Pay RM 120.00')
    await flush()
    expect(api.checkoutBill).not.toHaveBeenCalled()
    expect(screen.getByText('Received exact · Change RM 0.00')).toBeTruthy()      // the cash received was cleared
    expect(screen.getByRole('alert').textContent).toBe(billChangedAtPay({ kind: 'cash', needsReference: false }))
    press('Pay RM 120.00')
    await flush()
    expect(api.checkoutBill).toHaveBeenCalledTimes(1)
    expect(api.checkoutBill.mock.calls[0][1]).toEqual(cashPayment(12000))
  })

  it('a refusal that reloads a changed total: the next Pay only shows the change', async () => {
    api.checkoutBill.mockRejectedValueOnce(new Error('The bill total changed — check the bill'))
    renderScreen()
    await flush()
    press('Cash')
    openWith(changed)
    press('Pay RM 106.70')
    await flush()
    expect(api.checkoutBill).toHaveBeenCalledTimes(1)
    press('Pay RM 120.00')
    await flush()
    expect(api.checkoutBill).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toBe(billChangedAtPay({ kind: 'cash', needsReference: false }))
  })

  it('Check bill finds the bill still open: the next Pay goes under a NEW checkout id', async () => {
    api.checkoutBill.mockRejectedValueOnce(new Error('Failed to fetch'))
    api.checkoutBill.mockResolvedValueOnce({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 0, receiptQueued: true })
    renderScreen()
    await flush()
    press('Cash')
    press('Pay RM 106.70')
    await flush()
    press('Check bill')
    await flush()
    expect(screen.getByText(CHECKED_OPEN)).toBeTruthy()
    press('Pay RM 106.70')
    await flush()
    expect(api.checkoutBill).toHaveBeenCalledTimes(2)
    expect(api.checkoutBill.mock.calls[1][1]).toEqual(cashPayment(10670))
    expect(api.checkoutBill.mock.calls[1][2]).not.toBe(api.checkoutBill.mock.calls[0][2])
  })

  it('a Check bill that gets no reply says so in plain words, never the browser\'s AbortError', async () => {
    api.checkoutBill.mockRejectedValueOnce(new Error('Failed to fetch'))
    renderScreen()
    await flush()
    press('Cash')
    press('Pay RM 106.70')
    await flush()
    api.fetchCheckoutState.mockRejectedValueOnce(new Error('AbortError: signal is aborted without reason'))
    press('Check bill')
    await flush()
    expect(screen.getByText('Could not check the bill: No reply from the server. Check the internet connection and try again.')).toBeTruthy()
    expect(screen.queryByText(/AbortError/)).toBeNull()
  })

  it('split: a cash part records the cash received above its amount, with change', async () => {
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 5000, receiptQueued: true })
    renderScreen()
    await flush()
    press('Split payment')
    press('Cash')
    press('5'); press('0')
    fireEvent.change(screen.getByLabelText('Cash received (RM)'), { target: { value: '100' } })
    press('Add Cash')
    expect(screen.getByText('Cash · received RM 100.00')).toBeTruthy()
    press('Add Cash')
    press('Pay RM 106.70')
    await flush()
    expect(api.checkoutBill.mock.calls[0][1]).toEqual([
      { methodId: 'm-cash', amountSen: 5000, tenderedSen: 10000, reference: null },
      { methodId: 'm-cash', amountSen: 5670, tenderedSen: null, reference: null },
    ])
  })
  it('payment methods that fail to load offer a Retry that loads them again', async () => {
    api.fetchPaymentMethods.mockRejectedValueOnce(new Error('Failed to fetch'))
    renderScreen()
    await flush()
    expect(screen.getByRole('alert').textContent).toContain('Failed to fetch')
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(retry.className).toContain('min-h-11')
    const before = api.fetchPaymentMethods.mock.calls.length
    fireEvent.click(retry)
    await flush()
    expect(api.fetchPaymentMethods.mock.calls.length).toBe(before + 1)
    expect(screen.getByRole('button', { name: 'Cash' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})

describe('PaymentScreen — split by item (split spec §3.3)', () => {
  const itemRow = (id: string, name: string, qty: number, unit: number) => ({
    id, order_id: 'o1', product_id: `p-${id}`, name_snapshot: name, unit_price_sen: unit, sst_rate_bp: 600, takeaway_fee_sen: 0,
    order_type: 'dine_in', qty, note: null, modifiers_snapshot: [], voided_at: null, catalog_discount_bp: 0, catalog_discount_name: null,
    discount_kind: null, discount_value: null, discount_reason: null,
    orders: { order_no: '261116-009/1', source: 'counter', placed_at: '2026-11-16T04:00:00Z' },
  })
  const partTotals = { ...totals, subtotalSen: 2800, serviceChargeSen: 280, sstSen: 168, beforeRoundingSen: 3248, roundingSen: 2, totalSen: 3250 }
  const picked = [{ itemId: 'i1', qty: 1, lineQty: 3 }, { itemId: 'i2', qty: 1, lineQty: 1 }]
  const renderSplit = (onClose = vi.fn(), onPaid = vi.fn()) => {
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={[]} split={{ items: picked }}
      onSendIds={() => {}} onClose={onClose} onPaid={onPaid} />)
    return { onClose, onPaid }
  }
  beforeEach(() => {
    api.fetchBillItems.mockResolvedValue([itemRow('i1', 'Latte', 3, 1300), itemRow('i2', 'Cake', 1, 1500), itemRow('i3', 'Soup', 1, 900)])
    api.splitTotals.mockResolvedValue(partTotals)
  })

  it('shows the split title, only the picked units and the part\'s totals', async () => {
    renderSplit()
    await flush()
    expect(screen.getByText('Table T3 · Split')).toBeTruthy()
    expect(screen.getByText('1 × Latte')).toBeTruthy()
    expect(screen.getByText('1 × Cake')).toBeTruthy()
    expect(screen.queryByText(/Soup/)).toBeNull()
    expect(api.splitTotals).toHaveBeenCalledWith('b1', picked)
    expect(screen.getByRole('button', { name: 'Pay RM 32.50' })).toBeTruthy()
  })

  it('Pay goes through checkout_items with the picked units, never checkout_bill', async () => {
    api.checkoutItems.mockResolvedValue({ billId: 'p1', billNo: '261116-010', totalSen: 3250, changeSen: 0, receiptQueued: true })
    const { onPaid } = renderSplit()
    await flush()
    press('Cash')
    press('Pay RM 32.50')
    await flush()
    expect(api.checkoutBill).not.toHaveBeenCalled()
    expect(api.checkoutItems).toHaveBeenCalledTimes(1)
    expect(api.checkoutItems.mock.calls[0].slice(0, 3)).toEqual(['b1', picked, [{ methodId: 'm-cash', amountSen: 3250, tenderedSen: null, reference: null }]])
    expect(screen.getByText('Bill 261116-010 paid · RM 32.50')).toBeTruthy()
    press('Done')
    expect(onPaid).toHaveBeenCalledTimes(1)
  })

  it('a part of RM 0.00 is paid with no payment ([]), as a whole bill of RM 0.00 is', async () => {
    api.splitTotals.mockResolvedValue({ ...partTotals, subtotalSen: 0, serviceChargeSen: 0, sstSen: 0, beforeRoundingSen: 0, roundingSen: 0, totalSen: 0 })
    api.fetchPaymentMethods.mockResolvedValue([])
    api.checkoutItems.mockResolvedValue({ billId: 'p1', billNo: '261116-010', totalSen: 0, changeSen: 0, receiptQueued: true })
    renderSplit()
    await flush()
    press('Pay RM 0.00')
    await flush()
    expect(screen.queryByText('Choose how the bill is paid')).toBeNull()
    expect(api.checkoutBill).not.toHaveBeenCalled()
    expect(api.checkoutItems).toHaveBeenCalledTimes(1)
    expect(api.checkoutItems.mock.calls[0].slice(0, 3)).toEqual(['b1', picked, []])
  })

  it('Cancel payment goes back (PosTill reopens the picker with the selection kept)', async () => {
    const { onClose } = renderSplit()
    await flush()
    press('Cancel payment')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a selection the server refuses locks the screen with its words', async () => {
    api.splitTotals.mockRejectedValue(new Error(BILL_CHANGED_ITEMS))
    renderSplit()
    await flush()
    expect(screen.getByText(BILL_CHANGED_ITEMS)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0)
  })

  it('no reply: Try again resends checkout_items with the same units, payments and checkout id', async () => {
    api.checkoutItems.mockRejectedValueOnce(new Error('Failed to fetch'))
    api.checkoutItems.mockResolvedValueOnce({ billId: 'p1', billNo: '261116-010', totalSen: 3250, changeSen: 0, receiptQueued: true })
    renderSplit()
    await flush()
    press('Cash')
    press('Pay RM 32.50')
    await flush()
    expect(screen.getByText(UNSURE)).toBeTruthy()
    press('Try again')
    await flush()
    expect(api.checkoutItems).toHaveBeenCalledTimes(2)
    expect(api.checkoutItems.mock.calls[1]).toEqual(api.checkoutItems.mock.calls[0])
    expect(api.checkoutBill).not.toHaveBeenCalled()
    expect(screen.getByText('Bill 261116-010 paid · RM 32.50')).toBeTruthy()
  })

  it('Check bill finds the part unpaid: unlocks with a new id and keeps the PART\'s total, never the table bill\'s', async () => {
    api.checkoutItems.mockRejectedValueOnce(new Error('Failed to fetch'))
    renderSplit()
    await flush()
    press('Cash')
    press('Pay RM 32.50')
    await flush()
    api.fetchCheckoutState.mockReset()
    api.fetchCheckoutState.mockResolvedValueOnce({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals, result: null })
    api.fetchCheckoutState.mockRejectedValue(new Error('Failed to fetch'))   // the follow after Check bill finds no network
    press('Check bill')
    await flush()
    expect(screen.getByText(CHECKED_OPEN)).toBeTruthy()
    expect(screen.queryByText('The bill changed on another iPad — check the total.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Pay RM 32.50' })).toBeTruthy()
    api.checkoutItems.mockResolvedValueOnce({ billId: 'p1', billNo: '261116-010', totalSen: 3250, changeSen: 0, receiptQueued: true })
    press('Cash')
    press('Pay RM 32.50')
    await flush()
    expect(api.checkoutItems).toHaveBeenCalledTimes(2)
    expect(api.checkoutItems.mock.calls[1][3]).not.toBe(api.checkoutItems.mock.calls[0][3])
    expect(api.checkoutItems.mock.calls[1][2]).toEqual([{ methodId: 'm-cash', amountSen: 3250, tenderedSen: null, reference: null }])
  })

  it('Check bill finds the picked units changed: locks with the server\'s words', async () => {
    api.checkoutItems.mockRejectedValueOnce(new Error('Failed to fetch'))
    renderSplit()
    await flush()
    press('Cash')
    press('Pay RM 32.50')
    await flush()
    api.splitTotals.mockRejectedValue(new Error(BILL_CHANGED_ITEMS))
    press('Check bill')
    await flush()
    expect(screen.getByText(BILL_CHANGED_ITEMS)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Pay/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('a paid part clears its checkout ids as soon as its result shows, before Done', async () => {
    api.checkoutItems.mockResolvedValue({ billId: 'p1', billNo: '261116-010', totalSen: 3250, changeSen: 0, receiptQueued: true })
    const onSendIds = vi.fn()
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={[]} split={{ items: picked }}
      onSendIds={onSendIds} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    press('Cash')
    press('Pay RM 32.50')
    await flush()
    expect(screen.getByText('Bill 261116-010 paid · RM 32.50')).toBeTruthy()
    expect(onSendIds.mock.calls[0][0]).toHaveLength(1)
    expect(onSendIds).toHaveBeenLastCalledWith([])
  })

  it('part 1 paid, then the till locks before Done: the next split Payment of the bill starts without part 1\'s id', async () => {
    // PosTill keeps the ids under split:<billId>; an empty list drops the key
    const kept = new Map<string, string[]>()
    const keep = (ids: string[]) => { if (ids.length) kept.set('split:b1', ids); else kept.delete('split:b1') }
    api.checkoutItems.mockResolvedValue({ billId: 'p1', billNo: '261116-010', totalSen: 3250, changeSen: 0, receiptQueued: true })
    const first = render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={kept.get('split:b1') ?? []}
      split={{ items: picked }} onSendIds={keep} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    press('Cash')
    press('Pay RM 32.50')
    await flush()
    const id1 = api.checkoutItems.mock.calls[0][3] as string
    expect(screen.getByText('Bill 261116-010 paid · RM 32.50')).toBeTruthy()
    first.unmount()                                            // the lock sends the till home; Done was never pressed
    expect(kept.has('split:b1')).toBe(false)
    api.fetchCheckoutState.mockClear()
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={kept.get('split:b1') ?? []}
      split={{ items: [{ itemId: 'i3', qty: 1, lineQty: 1 }] }} onSendIds={keep} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    expect(api.fetchCheckoutState).toHaveBeenCalled()
    expect(api.fetchCheckoutState.mock.calls[0][1]).not.toContain(id1)
    expect(screen.queryByText(/paid ·/)).toBeNull()
  })

  it('a part this screen paid shows as paid (the reply was lost), though the table bill is open', async () => {
    api.fetchCheckoutState.mockResolvedValue({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals,
      result: { billId: 'p1', billNo: '261116-010', totalSen: 3250, changeSen: 0, receiptQueued: true } })
    renderSplit()
    await flush()
    expect(screen.getByText('Bill 261116-010 paid · RM 32.50')).toBeTruthy()
  })

  const partResult = { billId: 'p1', billNo: '261116-010', totalSen: 3250, changeSen: 0, receiptQueued: true }
  const openState = { status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals, result: null }
  const EARLIER = 'An earlier Pay selected went through: Bill 261116-010 · RM 32.50'

  it('a lost checkout_items lands between the two reads: the re-read shows it paid, never locks on "The bill changed"', async () => {
    const onSendIds = vi.fn()
    api.splitTotals.mockResolvedValueOnce(partTotals)
    api.checkoutItems.mockRejectedValueOnce(new Error('Failed to fetch'))
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={[]} split={{ items: picked }}
      onSendIds={onSendIds} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    press('Cash')
    // the follow after no reply: the bill still open, then the part commits, so the picked units are gone
    api.fetchCheckoutState.mockResolvedValueOnce(openState)
    api.fetchCheckoutState.mockResolvedValueOnce({ ...openState, result: partResult })
    api.splitTotals.mockRejectedValue(new Error(BILL_CHANGED_ITEMS))
    press('Pay RM 32.50')
    await flush()
    expect(screen.queryByText(BILL_CHANGED_ITEMS)).toBeNull()
    expect(screen.getByText('Bill 261116-010 paid · RM 32.50')).toBeTruthy()
    const reads = api.fetchCheckoutState.mock.calls
    expect(reads[reads.length - 1][1]).toEqual(reads[reads.length - 2][1])   // the same ids
    expect(onSendIds).toHaveBeenLastCalledWith([])
  })

  it('a refused selection with nothing paid on the re-read still locks with the server\'s words', async () => {
    api.fetchCheckoutState.mockClear()
    api.splitTotals.mockRejectedValue(new Error(BILL_CHANGED_ITEMS))
    renderSplit()
    await flush()
    expect(api.fetchCheckoutState).toHaveBeenCalledTimes(2)
    expect(screen.getByText(BILL_CHANGED_ITEMS)).toBeTruthy()
  })

  it('an earlier Pay selected that landed late shows as that, never as this selection paid; its ids are cleared', async () => {
    api.fetchCheckoutState.mockResolvedValue({ ...openState, result: partResult })
    const onSendIds = vi.fn()
    const onPaid = vi.fn()
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={['old-id']}
      split={{ items: [{ itemId: 'i3', qty: 1, lineQty: 1 }] }} onSendIds={onSendIds} onClose={() => {}} onPaid={onPaid} />)
    await flush()
    expect(screen.getByText(EARLIER)).toBeTruthy()
    expect(screen.queryByText(/paid ·/)).toBeNull()
    expect(screen.queryByText('Change')).toBeNull()
    expect(onSendIds).toHaveBeenLastCalledWith([])
    press('Done')
    expect(onPaid).toHaveBeenCalledTimes(1)
  })

  it('the race on a screen opened with an earlier id: the earlier part shows as earlier, not this selection paid', async () => {
    api.fetchCheckoutState.mockResolvedValueOnce(openState)
    api.fetchCheckoutState.mockResolvedValueOnce({ ...openState, result: partResult })
    api.splitTotals.mockRejectedValue(new Error(BILL_CHANGED_ITEMS))
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={['old-id']}
      split={{ items: [{ itemId: 'i3', qty: 1, lineQty: 1 }] }} onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    expect(screen.queryByText(BILL_CHANGED_ITEMS)).toBeNull()
    expect(screen.getByText(EARLIER)).toBeTruthy()
  })

  it('this screen sent too: a result its own ids do not find is the earlier one', async () => {
    api.checkoutItems.mockRejectedValueOnce(new Error('Failed to fetch'))
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={['old-id']}
      split={{ items: picked }} onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    press('Cash')
    api.fetchCheckoutState.mockImplementation(async (_b: string, ids: string[]) =>
      (ids.includes('old-id') ? { ...openState, result: partResult } : openState))
    press('Pay RM 32.50')
    await flush()
    expect(screen.getByText(EARLIER)).toBeTruthy()
    const reads = api.fetchCheckoutState.mock.calls
    expect(reads[reads.length - 1][1]).toEqual([api.checkoutItems.mock.calls[0][3]])
  })

  it('this screen sent too: a result its own ids find is this selection paid', async () => {
    api.checkoutItems.mockRejectedValueOnce(new Error('Failed to fetch'))
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={['old-id']}
      split={{ items: picked }} onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    press('Cash')
    api.fetchCheckoutState.mockResolvedValue({ ...openState, result: partResult })
    press('Pay RM 32.50')
    await flush()
    expect(screen.getByText('Bill 261116-010 paid · RM 32.50')).toBeTruthy()
    expect(screen.queryByText(EARLIER)).toBeNull()
  })

  it('the whole bill: a result found under an earlier id is the bill paid, as before', async () => {
    api.fetchCheckoutState.mockResolvedValue({ status: 'paid', billNo: bill.bill_no, mergedIntoBillNo: null, totals: null,
      result: { billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 0, receiptQueued: true } })
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3" refreshKey={0} earlierIds={['old-id']}
      onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    expect(screen.getByText('Bill 261026-001 paid · RM 106.70')).toBeTruthy()
  })

  it('a takeaway shows its call number big on the change screen, to call the customer (W4)', async () => {
    const ta = { ...bill, table_id: null, order_type: 'takeaway' as const, call_no: 'TA012' }
    api.fetchCheckoutState.mockResolvedValue({ status: 'paid', billNo: bill.bill_no, mergedIntoBillNo: null, totals: null,
      result: { billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 0, receiptQueued: true } })
    render(<PaymentScreen branchId="br" bill={ta} title="TA012 · Takeaway" refreshKey={0} earlierIds={['old-id']}
      onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    expect(screen.getByText('TA012')).toBeTruthy()
  })
})

describe('PaymentScreen — split equally / by amount (split spec §3.5)', () => {
  const t7035 = { ...totals, subtotalSen: 7035, sstSen: 0, beforeRoundingSen: 7035, roundingSen: 0, totalSen: 7035 }
  const openState = (paidSen: number, parts: unknown[]) =>
    ({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals: t7035, result: null, paidSen, parts })
  const quote = (ways: number, sharesPaid: number, paidSen: number, shareSen: number) =>
    ({ totalSen: 7035, paidSen, balanceSen: 7035 - paidSen, partsPaid: sharesPaid, sharesPaid, ways, shareSen })
  const renderParts = (over: { online?: boolean; onSplitByItem?: () => void } = {}) =>
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3" refreshKey={0} earlierIds={[]} online={over.online}
      onSplitByItem={over.onSplitByItem} onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />)

  it('Equally: the share comes from the server; Pay records a part and the screen stays on the bill', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    api.partQuote.mockImplementation(async (_id: string, ways: number) => quote(ways, 0, 0, ways === 2 ? 3515 : 2345))
    renderParts()
    await flush()
    press('Equally')
    await flush()
    expect(api.partQuote).toHaveBeenLastCalledWith('b1', 2)
    expect(screen.getByText('Share 1 of 2 · RM 35.15')).toBeTruthy()
    press('More ways')
    await flush()
    expect(screen.getByText('Split into 3')).toBeTruthy()
    expect(screen.getByText('Share 1 of 3 · RM 23.45')).toBeTruthy()
    api.payBillPart.mockResolvedValue({ partId: 'x1', partNo: 1, ways: 3, amountSen: 2345, paidSen: 2345, balanceSen: 4690, changeSen: 0, receiptQueued: true })
    api.fetchCheckoutState.mockResolvedValue(openState(2345, [{ id: 'x1', partNo: 1, ways: 3, amountSen: 2345, methods: ['Cash'] }]))
    press('Cash')
    press('Pay RM 23.45')
    await flush()
    expect(api.checkoutBill).not.toHaveBeenCalled()
    expect(api.payBillPart).toHaveBeenCalledTimes(1)
    const [billId, partId, amount, ways, payments] = api.payBillPart.mock.calls[0]
    expect([billId, typeof partId, amount, ways, payments]).toEqual(['b1', 'string', 2345, 3, [{ methodId: 'm-cash', amountSen: 2345, tenderedSen: null, reference: null }]])
    expect(screen.getByText('Part 1 paid · RM 23.45 · Change RM 0.00')).toBeTruthy()
    expect(screen.getByText('Paid 1 of 3 · RM 23.45 (Cash)')).toBeTruthy()
    expect(screen.getAllByText('Balance due').length).toBeGreaterThan(0)
    expect(screen.getAllByText('RM 46.90').length).toBeGreaterThan(0)
  })

  it('while the share for a new N is on its way, Pay waits: the old N\'s share is never sent', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    let answer: (q: unknown) => void = () => {}
    api.partQuote.mockResolvedValueOnce(quote(2, 0, 0, 3515))
    api.partQuote.mockImplementationOnce(() => new Promise((r) => { answer = r }))
    renderParts()
    await flush()
    press('Equally')
    await flush()
    press('Cash')
    expect(screen.getByRole('button', { name: 'Pay RM 35.15' })).toBeTruthy()
    press('More ways')
    await flush()
    expect(screen.queryByText('Share 1 of 2 · RM 35.15')).toBeNull()
    const payBtn = screen.getByRole('button', { name: /^Pay/ }) as HTMLButtonElement
    expect(payBtn.disabled).toBe(true)
    fireEvent.click(payBtn)
    await flush()
    expect(api.payBillPart).not.toHaveBeenCalled()
    await act(async () => { answer(quote(3, 0, 0, 2345)) })
    expect(screen.getByText('Share 1 of 3 · RM 23.45')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pay RM 23.45' })).toBeTruthy()
  })

  it('the last share is paid with checkout_bill: exactly the balance', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(4690, [
      { id: 'x1', partNo: 1, ways: 3, amountSen: 2345, methods: ['Cash'] }, { id: 'x2', partNo: 2, ways: 3, amountSen: 2345, methods: ['Card'] }]))
    api.partQuote.mockResolvedValue(quote(3, 2, 4690, 2345))
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 7035, changeSen: 0, receiptQueued: true })
    renderParts()
    await flush()
    // Equally comes back on its own: the bill's equal split has begun
    await flush()
    expect(api.partQuote).toHaveBeenLastCalledWith('b1', 3)
    expect((screen.getByRole('button', { name: 'More ways' }) as HTMLButtonElement).disabled).toBe(true)   // N is fixed
    press('Cash')
    press('Pay RM 23.45')
    await flush()
    expect(api.payBillPart).not.toHaveBeenCalled()
    expect(api.checkoutBill.mock.calls[0][1]).toEqual([{ methodId: 'm-cash', amountSen: 2345, tenderedSen: null, reference: null }])
  })

  it('By amount: the 33% chip is a third of the total, down to 5 sen; more than the balance is refused', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    api.payBillPart.mockResolvedValue({ partId: 'x1', partNo: 1, ways: null, amountSen: 2320, paidSen: 2320, balanceSen: 4715, changeSen: 0, receiptQueued: true })
    renderParts()
    await flush()
    press('By amount')
    press('33%')
    expect((screen.getByLabelText('Amount (RM)') as HTMLInputElement).value).toBe('23.20')
    press('Cash')
    press('Pay RM 23.20')
    await flush()
    expect(api.payBillPart.mock.calls[0].slice(2, 4)).toEqual([2320, null])
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '80' } })
    press('Cash')
    press('Pay RM 80.00')
    expect(screen.getByText('The amount is more than the balance')).toBeTruthy()
    expect(api.payBillPart).toHaveBeenCalledTimes(1)
  })

  it('offline the Split row is off and says why; By item opens the picker', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    api.fetchBillItems.mockResolvedValue([
      { id: 'i1', order_id: 'o1', product_id: 'p1', name_snapshot: 'Latte', unit_price_sen: 1300, sst_rate_bp: 0, takeaway_fee_sen: 0,
        order_type: 'dine_in', qty: 2, note: null, modifiers_snapshot: [], voided_at: null, catalog_discount_bp: 0, catalog_discount_name: null,
        discount_kind: null, discount_value: null, discount_reason: null, orders: { order_no: 'x/1', source: 'counter', placed_at: '2026-11-17T04:00:00Z' } },
    ])
    renderParts({ online: false })
    await flush()
    expect((screen.getByRole('button', { name: 'Equally' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Split needs a connection')).toBeTruthy()
    cleanup()
    const onSplitByItem = vi.fn()
    renderParts({ onSplitByItem })
    await flush()
    press('By item')
    expect(onSplitByItem).toHaveBeenCalledTimes(1)
  })

  it('By item is off once a part is paid; the Split row is not shown in split-by-item mode', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(1000, [{ id: 'x1', partNo: 1, ways: null, amountSen: 1000, methods: ['Card'] }]))
    renderParts({ onSplitByItem: vi.fn() })
    await flush()
    expect((screen.getByRole('button', { name: 'By item' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Paid part 1 · RM 10.00 (Card)')).toBeTruthy()
    cleanup()
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={[]} split={{ items: [{ itemId: 'i1', qty: 1, lineQty: 1 }] }}
      onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    expect(screen.queryByRole('group', { name: 'Split bill' })).toBeNull()
  })
})

describe('PaymentScreen — a part payment that got no reply (the part id is the attempt id)', () => {
  const t7035 = { ...totals, subtotalSen: 7035, sstSen: 0, beforeRoundingSen: 7035, roundingSen: 0, totalSen: 7035 }
  const openState = (paidSen: number, parts: unknown[]) =>
    ({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals: t7035, result: null, paidSen, parts })
  const partReply = (partId: string, partNo: number, amountSen: number, paidSen: number) =>
    ({ partId, partNo, ways: null, amountSen, paidSen, balanceSen: 7035 - paidSen, changeSen: 0, receiptQueued: true })
  const sentId = (n: number) => api.payBillPart.mock.calls[n][1] as string
  const startAmountPart = async (rm: string) => {
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3" refreshKey={0} earlierIds={[]}
      onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    press('By amount')
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: rm } })
    press('Cash')
  }
  beforeEach(() => { api.fetchCheckoutState.mockResolvedValue(openState(0, [])) })

  it('Try again resends the same part: same id, amount, ways and payments; the inputs are locked meanwhile', async () => {
    api.payBillPart.mockRejectedValueOnce(new Error('Failed to fetch'))
    api.payBillPart.mockImplementationOnce(async (_b: string, id: string) => partReply(id, 1, 2000, 2000))
    await startAmountPart('20')
    press('Pay RM 20.00')
    await flush()
    expect(screen.getByText(UNSURE)).toBeTruthy()
    expect((screen.getByLabelText('Amount (RM)') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Equally' }) as HTMLButtonElement).disabled).toBe(true)
    press('Try again')
    await flush()
    expect(api.payBillPart).toHaveBeenCalledTimes(2)
    expect(api.payBillPart.mock.calls[1]).toEqual(api.payBillPart.mock.calls[0])
    expect(api.payBillPart.mock.calls[0].slice(2)).toEqual([2000, null, cashPayment(2000), 0])
    expect(api.checkoutBill).not.toHaveBeenCalled()
    expect(screen.getByText('Part 1 paid · RM 20.00 · Change RM 0.00')).toBeTruthy()
  })

  it('Check bill finds the part recorded: it shows paid, and the next part goes under a NEW id', async () => {
    api.payBillPart.mockRejectedValueOnce(new Error('Failed to fetch'))
    await startAmountPart('20')
    press('Pay RM 20.00')
    await flush()
    api.fetchCheckoutState.mockResolvedValue(openState(2000, [{ id: sentId(0), partNo: 1, ways: null, amountSen: 2000, methods: ['Cash'] }]))
    press('Check bill')
    await flush()
    expect(screen.getByText('Part 1 paid · RM 20.00')).toBeTruthy()
    expect(screen.getByText('Paid part 1 · RM 20.00 (Cash)')).toBeTruthy()
    expect(screen.queryByText(CHECKED_OPEN)).toBeNull()
    expect(screen.queryByText('The bill changed on another iPad — check the total.')).toBeNull()
    api.payBillPart.mockImplementationOnce(async (_b: string, id: string) => partReply(id, 2, 1000, 3000))
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '10' } })
    press('Cash')
    press('Pay RM 10.00')
    await flush()
    expect(api.payBillPart).toHaveBeenCalledTimes(2)
    expect(sentId(1)).not.toBe(sentId(0))
    expect(api.payBillPart.mock.calls[1].slice(2)).toEqual([1000, null, cashPayment(1000), 2000])   // the part that landed is in p_paid_sen
  })

  it('Check bill finds the part not recorded: unlocks with a NEW id for the same part', async () => {
    api.payBillPart.mockRejectedValueOnce(new Error('Failed to fetch'))
    await startAmountPart('20')
    press('Pay RM 20.00')
    await flush()
    press('Check bill')
    await flush()
    expect(screen.getByText(CHECKED_OPEN)).toBeTruthy()
    api.payBillPart.mockImplementationOnce(async (_b: string, id: string) => partReply(id, 1, 2000, 2000))
    press('Cash')
    press('Pay RM 20.00')
    await flush()
    expect(api.payBillPart).toHaveBeenCalledTimes(2)
    expect(sentId(1)).not.toBe(sentId(0))
    expect(api.payBillPart.mock.calls[1].slice(2)).toEqual([2000, null, cashPayment(2000), 0])
  })

  it('the follow after no reply finds the part recorded: it shows paid without Try again', async () => {
    api.payBillPart.mockRejectedValueOnce(new Error('Failed to fetch'))
    api.fetchCheckoutState.mockImplementation(async () => (api.payBillPart.mock.calls.length
      ? openState(2000, [{ id: sentId(0), partNo: 1, ways: null, amountSen: 2000, methods: ['Cash'] }])
      : openState(0, [])))
    await startAmountPart('20')
    press('Pay RM 20.00')
    await flush()
    expect(screen.getByText('Part 1 paid · RM 20.00')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByText(UNSURE)).toBeNull()
    expect(api.payBillPart).toHaveBeenCalledTimes(1)
  })

  it('an amount equal to the balance pays the rest with checkout_bill, not as a part', async () => {
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 7035, changeSen: 0, receiptQueued: true })
    await startAmountPart('70.35')
    press('Pay RM 70.35')
    await flush()
    expect(api.payBillPart).not.toHaveBeenCalled()
    expect(api.checkoutBill.mock.calls[0][1]).toEqual(cashPayment(7035))
  })
})

describe('PaymentScreen — split follow-up fixes (p_paid_sen, the last share, quotes, a balance of 0, offline)', () => {
  const t7035 = { ...totals, subtotalSen: 7035, sstSen: 0, beforeRoundingSen: 7035, roundingSen: 0, totalSen: 7035 }
  const openState = (paidSen: number, parts: unknown[]) =>
    ({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals: t7035, result: null, paidSen, parts })
  const part1 = { id: 'x1', partNo: 1, ways: null, amountSen: 1000, methods: ['Card'] }
  const quote = (ways: number, sharesPaid: number, paidSen: number, shareSen: number) =>
    ({ totalSen: 7035, paidSen, balanceSen: 7035 - paidSen, partsPaid: sharesPaid, sharesPaid, ways, shareSen })
  const partReply = (partId: string, partNo: number, amountSen: number, paidSen: number) =>
    ({ partId, partNo, ways: null, amountSen, paidSen, balanceSen: 7035 - paidSen, changeSen: 0, receiptQueued: true })
  const el = (online = true) => (
    <PaymentScreen branchId="br" bill={bill} title="Table T3" refreshKey={0} earlierIds={[]} online={online}
      onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />
  )
  const payBtn = () => screen.getByRole('button', { name: /^Pay/ }) as HTMLButtonElement

  it('a part sends the paid parts the screen showed (p_paid_sen); Try again resends that same value', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(1000, [part1]))
    api.payBillPart.mockRejectedValueOnce(new Error('Failed to fetch'))
    api.payBillPart.mockImplementationOnce(async (_b: string, id: string) => partReply(id, 2, 2000, 3000))
    render(el())
    await flush()
    press('By amount')
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '20' } })
    press('Cash')
    // another iPad pays a part while this one waits for its reply: the follow shows the new paid parts
    api.fetchCheckoutState.mockResolvedValue(openState(1500, [part1, { id: 'y1', partNo: 2, ways: null, amountSen: 500, methods: ['Cash'] }]))
    press('Pay RM 20.00')
    await flush()
    expect(api.payBillPart.mock.calls[0].slice(2)).toEqual([2000, null, cashPayment(2000), 1000])
    expect(screen.getByText('Paid part 2 · RM 5.00 (Cash)')).toBeTruthy()
    press('Try again')
    await flush()
    expect(api.payBillPart).toHaveBeenCalledTimes(2)
    expect(api.payBillPart.mock.calls[1]).toEqual(api.payBillPart.mock.calls[0])
  })

  it('"The bill changed. Check the split again." shows the server\'s words and follows the bill again', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    api.payBillPart.mockRejectedValueOnce(new Error('The bill changed. Check the split again.'))
    render(el())
    await flush()
    press('By amount')
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '20' } })
    press('Cash')
    api.fetchCheckoutState.mockResolvedValue(openState(1000, [part1]))
    const reads = api.fetchCheckoutState.mock.calls.length
    press('Pay RM 20.00')
    await flush()
    expect(api.payBillPart.mock.calls[0][5]).toBe(0)
    expect(screen.getByText('The bill changed. Check the split again.')).toBeTruthy()
    expect(api.fetchCheckoutState.mock.calls.length).toBeGreaterThan(reads)
    expect(screen.getByText('Paid part 1 · RM 10.00 (Card)')).toBeTruthy()
    expect(screen.getAllByText('RM 60.35').length).toBeGreaterThan(0)       // the new balance
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('Equally: a share at or above the quote\'s balance is the last share — checkout_bill of the balance, not the share', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(4690, [
      { id: 'x1', partNo: 1, ways: 3, amountSen: 2345, methods: ['Cash'] }, { id: 'x2', partNo: 2, ways: 3, amountSen: 2345, methods: ['Card'] }]))
    api.partQuote.mockResolvedValue(quote(3, 2, 4690, 2350))
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 7035, changeSen: 0, receiptQueued: true })
    render(el())
    await flush()
    // Equally comes back on its own: the bill's equal split has begun
    await flush()
    expect(screen.getByText('Share 3 of 3 · RM 23.45')).toBeTruthy()          // the balance, as Pay records it
    press('Cash')
    press('Pay RM 23.45')
    await flush()
    expect(api.payBillPart).not.toHaveBeenCalled()
    expect(api.checkoutBill.mock.calls[0][1]).toEqual(cashPayment(2345))
  })

  it('Equally: the share is a part only while it is below the quote\'s balance', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    api.partQuote.mockResolvedValue(quote(2, 0, 0, 3515))
    api.payBillPart.mockImplementation(async (_b: string, id: string) => ({ ...partReply(id, 1, 3515, 3515), ways: 2 }))
    render(el())
    await flush()
    press('Equally')
    await flush()
    press('Cash')
    press('Pay RM 35.15')
    await flush()
    expect(api.checkoutBill).not.toHaveBeenCalled()
    expect(api.payBillPart.mock.calls[0].slice(2)).toEqual([3515, 2, cashPayment(3515), 0])
  })

  it('a quote that failed offers a Retry that asks again', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    api.partQuote.mockRejectedValueOnce(new Error('Failed to fetch'))
    api.partQuote.mockResolvedValueOnce(quote(2, 0, 0, 3515))
    render(el())
    await flush()
    press('Equally')
    await flush()
    expect(screen.getByText(/Failed to fetch/)).toBeTruthy()
    press('Retry')
    await flush()
    expect(api.partQuote).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/Failed to fetch/)).toBeNull()
    expect(screen.getByText('Share 1 of 2 · RM 35.15')).toBeTruthy()
  })

  it('the parts paid it all (balance RM 0.00): Pay closes the bill with checkout_bill and no payment, in any mode', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(7035, [{ id: 'x1', partNo: 1, ways: null, amountSen: 7035, methods: ['Card'] }]))
    api.partQuote.mockResolvedValue({ ...quote(2, 0, 7035, 0), balanceSen: 0 })
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 7035, changeSen: 0, receiptQueued: true })
    render(el())
    await flush()
    press('Equally')
    await flush()
    press('Pay RM 0.00')
    await flush()
    expect(api.payBillPart).not.toHaveBeenCalled()
    expect(api.checkoutBill).toHaveBeenCalledTimes(1)
    expect(api.checkoutBill.mock.calls[0][1]).toEqual([])
    cleanup()
    api.checkoutBill.mockClear()
    render(el())
    await flush()
    press('By amount')
    press('Pay RM 0.00')
    await flush()
    expect(api.checkoutBill.mock.calls[0][1]).toEqual([])
  })

  it('a share of RM 0.00 against a balance is shown as a problem and Pay is off', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    api.partQuote.mockResolvedValue(quote(2, 0, 0, 0))
    render(el())
    await flush()
    press('Equally')
    await flush()
    press('Cash')
    expect(screen.getByText('The share came back as RM 0.00 — check the bill')).toBeTruthy()
    expect(payBtn().disabled).toBe(true)
    fireEvent.click(payBtn())
    await flush()
    expect(api.payBillPart).not.toHaveBeenCalled()
    expect(api.checkoutBill).not.toHaveBeenCalled()
  })

  it('offline: Pay for a part is off; the whole bill still pays as before', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    const { rerender } = render(el())
    await flush()
    press('By amount')
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '20' } })
    press('Cash')
    rerender(el(false))
    await flush()
    expect(payBtn().disabled).toBe(true)
    fireEvent.click(payBtn())
    await flush()
    expect(api.payBillPart).not.toHaveBeenCalled()
    cleanup()
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 7035, changeSen: 0, receiptQueued: true })
    render(el(false))
    await flush()
    press('Cash')
    expect(payBtn().disabled).toBe(false)
    press('Pay RM 70.35')
    await flush()
    expect(api.checkoutBill.mock.calls[0][1]).toEqual(cashPayment(7035))
  })
})

describe('PaymentScreen — split screen fixes from the 2026-11-17 dev run', () => {
  const t1740 = { ...totals, subtotalSen: 1500, sstSen: 90, serviceChargeSen: 150, beforeRoundingSen: 1740, roundingSen: 0, totalSen: 1740 }
  const openState = (paidSen: number, parts: unknown[]) =>
    ({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals: t1740, result: null, paidSen, parts })

  it('reopened after an equal share was paid: Equally and its N come back without a tap', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(580, [{ id: 'x1', partNo: 1, ways: 3, amountSen: 580, methods: ['Card'] }]))
    api.partQuote.mockResolvedValue({ totalSen: 1740, paidSen: 580, balanceSen: 1160, partsPaid: 1, sharesPaid: 1, ways: 3, shareSen: 580 })
    renderScreen()
    await flush()
    await flush()
    expect(screen.getByRole('button', { name: 'Equally' }).className).toContain('bg-brown-dark')
    expect(screen.getByText('Split into 3')).toBeTruthy()
    expect(screen.getByText('Share 2 of 3 · RM 5.80')).toBeTruthy()
  })

  it('reopened after a by-amount part: no mode is picked for the cashier', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(500, [{ id: 'x1', partNo: 1, ways: null, amountSen: 500, methods: ['Cash'] }]))
    renderScreen()
    await flush()
    expect(screen.getByRole('button', { name: 'Equally' }).className).not.toContain('bg-brown-dark')
    expect(screen.queryByText(/^Split into/)).toBeNull()
  })

  it('Equally turned off after reopening stays off when the same screen reads the bill again', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(580, [{ id: 'x1', partNo: 1, ways: 3, amountSen: 580, methods: ['Card'] }]))
    api.partQuote.mockResolvedValue({ totalSen: 1740, paidSen: 580, balanceSen: 1160, partsPaid: 1, sharesPaid: 1, ways: 3, shareSen: 580 })
    const { rerender } = render(screenAt(0, vi.fn()))
    await flush()
    await flush()
    expect(screen.getByText('Split into 3')).toBeTruthy()
    press('Equally')
    await flush()
    expect(screen.queryByText('Split into 3')).toBeNull()
    api.fetchCheckoutState.mockResolvedValue(openState(580, [{ id: 'x1', partNo: 1, ways: 3, amountSen: 580, methods: ['Card'] }]))
    rerender(screenAt(1, vi.fn()))
    await flush()
    await flush()
    expect(screen.queryByText('Split into 3')).toBeNull()
  })

  it('By amount with no amount typed: Pay is off', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    renderScreen()
    await flush()
    press('By amount')
    const payBtn = screen.getByRole('button', { name: /^Pay RM/ }) as HTMLButtonElement
    expect(payBtn.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '5' } })
    press('Cash')
    expect((screen.getByRole('button', { name: 'Pay RM 5.00' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('split payment: "This payment" shows ringgit and sen, also with the pad cleared', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    renderScreen()
    await flush()
    press('Split payment')
    press('Cash')
    expect(screen.getByText('This payment RM 17.40')).toBeTruthy()
    press('C')
    expect(screen.getByText('This payment RM 0.00')).toBeTruthy()
  })
})
