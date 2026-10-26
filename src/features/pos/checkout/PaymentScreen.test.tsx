// @vitest-environment jsdom
// The full-screen Payment keeps the Checkout sheet's money logic: these drive it the way a cashier
// does and check what reaches checkout_bill.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({
  fetchCheckoutState: vi.fn(),
  fetchPaymentMethods: vi.fn(),
  checkoutBill: vi.fn(),
  fetchBillItems: vi.fn(),
}))
vi.mock('./checkoutApi', () => ({
  fetchCheckoutState: api.fetchCheckoutState,
  fetchPaymentMethods: api.fetchPaymentMethods,
  checkoutBill: api.checkoutBill,
}))
vi.mock('../order/posApi', () => ({ fetchBillItems: api.fetchBillItems }))

import PaymentScreen from './PaymentScreen'

const totals = {
  subtotalSen: 10066, serviceChargeSen: 0, sstSen: 604, takeawayFeeSen: 0, beforeRoundingSen: 10670,
  roundingSen: 0, totalSen: 10670, sstGroups: [], serviceChargeGroups: [],
}
const bill = { id: 'b1', bill_no: '261026-001', table_id: 't3', order_type: 'dine_in' as const, pax: 2, opened_at: '2026-10-26T02:00:00Z' }
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

function renderScreen(onPaid = vi.fn()) {
  render(<PaymentScreen branchId="br" bill={bill} title="Table T3" refreshKey={0} earlierIds={[]}
    onSendIds={() => {}} onClose={() => {}} onPaid={onPaid} />)
  return onPaid
}

beforeEach(() => {
  api.fetchCheckoutState.mockResolvedValue({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals, result: null })
  api.fetchPaymentMethods.mockResolvedValue([
    { id: 'm-cash', branch_id: 'br', name: 'Cash', kind: 'cash', needs_reference: false, sort_order: 1, is_active: true },
    { id: 'm-visa', branch_id: 'br', name: 'Visa', kind: 'card', needs_reference: true, sort_order: 2, is_active: true },
  ])
  api.fetchBillItems.mockResolvedValue([])
  api.checkoutBill.mockReset()
})
afterEach(cleanup)

describe('PaymentScreen', () => {
  it('cash in one go: the number pad shows the change, Pay sends one payment with the cash received', async () => {
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 4330, receiptQueued: true })
    const onPaid = renderScreen()
    await flush()
    expect(screen.getByText('RM 106.70', { selector: 'div' })).toBeTruthy()
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
    press('Pay RM 106.70')
    expect(screen.getByText('Enter the reference for Visa')).toBeTruthy()
    expect(api.checkoutBill).not.toHaveBeenCalled()
  })

  it('no reply: Try again resends the same payment under the same checkout id', async () => {
    api.checkoutBill.mockRejectedValueOnce(new Error('Failed to fetch'))
    api.checkoutBill.mockResolvedValueOnce({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 0, receiptQueued: true })
    renderScreen()
    await flush()
    press('Pay RM 106.70')
    await flush()
    expect(screen.getByText(/Not sure the payment went through/)).toBeTruthy()
    press('Try again')
    await flush()
    expect(api.checkoutBill).toHaveBeenCalledTimes(2)
    expect(api.checkoutBill.mock.calls[1][1]).toEqual(api.checkoutBill.mock.calls[0][1])
    expect(api.checkoutBill.mock.calls[1][2]).toBe(api.checkoutBill.mock.calls[0][2])
  })

  it('split payment: Pay waits until the payments add up to the total', async () => {
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 0, receiptQueued: true })
    renderScreen()
    await flush()
    press('Split payment')
    press('C'); press('5'); press('0')
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
})
