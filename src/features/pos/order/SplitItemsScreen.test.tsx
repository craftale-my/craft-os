// @vitest-environment jsdom
// The item picker (split spec §3.2): drive it the way a cashier does and check what goes to the server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({
  fetchBillItems: vi.fn(), moveItems: vi.fn(), splitTotals: vi.fn(), moveBill: vi.fn(), mergeBills: vi.fn(),
}))
vi.mock('./posApi', () => ({ fetchBillItems: api.fetchBillItems, moveItems: api.moveItems }))
vi.mock('../checkout/checkoutApi', () => ({ splitTotals: api.splitTotals, moveBill: api.moveBill, mergeBills: api.mergeBills }))

import SplitItemsScreen, { PREVIEW_DEBOUNCE_MS } from './SplitItemsScreen'
import type { BillItemRow, OpenBillRow, TableRow } from './posApi'

const row = (id: string, name: string, qty: number, unit: number): BillItemRow => ({
  id, order_id: 'o1', product_id: `p-${id}`, name_snapshot: name, unit_price_sen: unit, sst_rate_bp: 600, takeaway_fee_sen: 0,
  order_type: 'dine_in', qty, note: null, modifiers_snapshot: [], voided_at: null, catalog_discount_bp: 0, catalog_discount_name: null,
  discount_kind: null, discount_value: null, discount_reason: null,
  orders: { order_no: '261116-009/1', source: 'counter', placed_at: '2026-11-16T04:00:00Z' },
})
const bill: OpenBillRow = {
  id: 'b5', bill_no: '261116-009', table_id: 't5', order_type: 'dine_in', pax: 4, opened_at: '2026-11-16T04:00:00Z',
  discount_kind: null, discount_value: null, discount_reason: null,
}
const table = (id: string, label: string): TableRow => ({ id, label, qr_token: `q-${id}`, qr_paused: false, is_active: true, sort_order: 1, area: null })
const tables = [table('t5', 'T5'), table('t7', 'T7')]
const partTotals = {
  subtotalSen: 2800, serviceChargeSen: 280, sstSen: 168, takeawayFeeSen: 0, beforeRoundingSen: 3248, roundingSen: 2, totalSen: 3250,
  sstGroups: [], serviceChargeGroups: [], grossSen: 2800, catalogDiscountSen: 0, itemDiscountSen: 0, billDiscountSen: 0, lines: [],
}
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const wait = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms) }); await flush() }
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement

type Props = Parameters<typeof SplitItemsScreen>[0]
function renderPicker(over: Partial<Props> = {}) {
  const props: Props = {
    bill, title: 'Table T5', tables, bills: [bill], summaries: new Map([['b5', { billId: 'b5', totalSen: 6265, itemCount: 4 }]]),
    refreshKey: 0, online: true, shiftOpen: true,
    onBack: vi.fn(), onPay: vi.fn(), onPayWhole: vi.fn(), onMoved: vi.fn(), onWholeMoved: vi.fn(), ...over,
  }
  render(<SplitItemsScreen {...props} />)
  return props
}

beforeEach(() => {
  vi.useFakeTimers()
  api.fetchBillItems.mockResolvedValue([row('i1', 'Latte', 3, 1300), row('i2', 'Cake', 1, 1500)])
  api.splitTotals.mockReset().mockResolvedValue(partTotals)
  api.moveItems.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('SplitItemsScreen', () => {
  it('lists the lines: a tick box for one unit, a stepper "k of q" for more; both buttons wait for a pick', async () => {
    renderPicker()
    await flush()
    expect(screen.getByText('Table T5 · Split')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Cake' })).toBeTruthy()
    expect(screen.getByText('0 of 3')).toBeTruthy()
    expect(button('Pay selected').disabled).toBe(true)
    expect(button('Move to table').disabled).toBe(true)
    press('More Latte'); press('More Latte')
    expect(screen.getByText('2 of 3')).toBeTruthy()
    press('Fewer Latte')
    expect(screen.getByText('1 of 3')).toBeTruthy()
  })

  it('asks the server for the part 300 ms after the last change; Pay selected sends the picked units', async () => {
    const p = renderPicker()
    await flush()
    press('More Latte')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cake' }))
    expect(screen.getByLabelText('Selected total').textContent).toBe('…')
    await wait(PREVIEW_DEBOUNCE_MS - 1)
    expect(api.splitTotals).not.toHaveBeenCalled()
    await wait(1)
    expect(api.splitTotals).toHaveBeenCalledTimes(1)
    expect(api.splitTotals).toHaveBeenCalledWith('b5', [{ itemId: 'i1', qty: 1 }, { itemId: 'i2', qty: 1 }])
    expect(screen.getByLabelText('Selected total').textContent).toBe('RM 32.50')
    press('Pay selected')
    expect(p.onPay).toHaveBeenCalledWith([{ itemId: 'i1', qty: 1 }, { itemId: 'i2', qty: 1 }], { i1: 1, i2: 1 })
  })

  it('shows the server\'s refusal and keeps Pay selected off', async () => {
    api.splitTotals.mockRejectedValue(new Error('The bill changed. Check the items again.'))
    renderPicker()
    await flush()
    press('More Latte')
    await wait(PREVIEW_DEBOUNCE_MS)
    expect(screen.getByText('The bill changed. Check the items again.')).toBeTruthy()
    expect(button('Pay selected').disabled).toBe(true)
  })

  it('every unit picked: Pay selected opens the normal Payment, with no preview call', async () => {
    const p = renderPicker()
    await flush()
    press('Select all')
    await wait(PREVIEW_DEBOUNCE_MS)
    expect(api.splitTotals).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Selected total').textContent).toBe('RM 62.65')
    press('Pay selected')
    expect(p.onPayWhole).toHaveBeenCalledTimes(1)
    expect(p.onPay).not.toHaveBeenCalled()
    press('Clear')
    expect(button('Pay selected').disabled).toBe(true)
  })

  it('a bill discount turns Move to table off, with the note', async () => {
    const discounted = { ...bill, discount_kind: 'percent' as const, discount_value: 1000, discount_reason: 'Regular' }
    renderPicker({ bill: discounted, bills: [discounted] })
    await flush()
    press('More Latte')
    expect(button('Move to table').disabled).toBe(true)
    expect(screen.getByText('Remove the bill discount before moving items')).toBeTruthy()
  })

  it('offline: both buttons stay off and say why', async () => {
    renderPicker({ online: false })
    await flush()
    press('More Latte')
    expect(button('Pay selected').disabled).toBe(true)
    expect(button('Move to table').disabled).toBe(true)
    expect(screen.getByText('Split needs a connection')).toBeTruthy()
  })

  it('Move to table moves the picked units and reports "Moved 2 items to T7"', async () => {
    api.moveItems.mockResolvedValue({ targetBillId: 'b7', targetBillNo: '261116-011', movedUnits: 2 })
    const p = renderPicker()
    await flush()
    press('More Latte'); press('More Latte')
    press('Move to table')
    expect(screen.getByText(/a table with a bill takes the items/)).toBeTruthy()
    press(/T7\s*Empty/)
    await flush()
    expect(api.moveItems).toHaveBeenCalledWith('b5', [{ itemId: 'i1', qty: 2 }], 't7')
    expect(p.onMoved).toHaveBeenCalledWith('Moved 2 items to T7')
  })

  it('opens with the selection Payment\'s Cancel kept', async () => {
    renderPicker({ initialPicked: { i1: 2 } })
    await flush()
    expect(screen.getByText('2 of 3')).toBeTruthy()
  })
})
