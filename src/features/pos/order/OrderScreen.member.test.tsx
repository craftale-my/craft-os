// @vitest-environment jsdom
// The member on a bill at the counter, driven through the order screen: bill actions → Member → the dialog,
// and the column line that follows Attach / Remove and never shows another bill's member.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { BillMember } from './billMember'
import type { OpenBillRow, TableRow } from './posApi'

const h = vi.hoisted(() => ({
  fetchBillMember: vi.fn(),
  setBillMember: vi.fn(),
  clearBillMember: vi.fn(),
}))
vi.mock('./billMember', async (orig) => ({
  ...(await orig<typeof import('./billMember')>()),
  fetchBillMember: (id: string) => h.fetchBillMember(id),
  setBillMember: (id: string, p: string) => h.setBillMember(id, p),
  clearBillMember: (id: string) => h.clearBillMember(id),
}))
vi.mock('./posApi', () => ({
  fetchBillItems: vi.fn(async () => []),
  fetchBranchCatalogs: vi.fn(async () => ({ catalogs: [], assignments: [] })),
  fetchMenuPicks: vi.fn(async () => null),
  fetchPadProductInfo: vi.fn(async () => new Map()),
  setSoldOut: vi.fn(), setTablePaused: vi.fn(), clearQrCart: vi.fn(),
}))
vi.mock('./usePadMenu', () => ({ usePadMenu: () => ({ menu: { categories: [] }, error: null, reload: async () => undefined }) }))
vi.mock('./usePadWindows', () => ({ usePadWindows: () => ({ windows: [], now: Date.now(), check: async () => null }) }))
vi.mock('../checkout/checkoutApi', () => ({}))
vi.mock('../checkout/ApprovalDialog', () => ({ default: () => null }))

import OrderScreen from './OrderScreen'

afterEach(cleanup)

const tables: TableRow[] = [
  { id: 't1', label: 'T1', qr_token: 'a', qr_paused: false, is_active: true, sort_order: 1, area: null },
  { id: 't2', label: 'T2', qr_token: 'b', qr_paused: false, is_active: true, sort_order: 2, area: null },
]
const billRow = (id: string, no: string, tableId: string): OpenBillRow => ({
  id, bill_no: no, table_id: tableId, order_type: 'dine_in', pax: 2, opened_at: '2026-11-23T02:00:00Z',
  discount_kind: null, discount_value: null, discount_reason: null,
})
const bills = [billRow('b1', '261123-001', 't1'), billRow('b2', '261123-002', 't2')]
const A: BillMember = { memberId: 'mA', phone: '+60123456789', points: 120, earned: null }
const B: BillMember = { memberId: 'mB', phone: '+601100000301', points: 0, isNew: true }
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() })

const noop = () => {}
function screenFor(tableId: string, refreshKey = 0) {
  return (
    <OrderScreen branchId="br" target={{ kind: 'table', tableId, pax: null }} tables={tables} bills={bills} summaries={new Map()}
      refreshKey={refreshKey} billing={null} shiftOpen lastCatalogs={null} onSplit={noop}
      submit={async () => ({ clientOrderId: 'x', rejectedReason: null }) as never} onCatalogs={noop} onTarget={noop} onBack={noop}
      onSent={noop} onPay={noop} onSendAndPay={async () => {}} onChanged={async () => {}} onDraftCount={noop} onSending={noop} />
  )
}
const column = () => screen.getByRole('region', { name: 'Bill' })
const openMemberAction = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Bill actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /^Member/ }))
}

beforeEach(() => {
  h.fetchBillMember.mockReset().mockResolvedValue(null)
  h.setBillMember.mockReset().mockResolvedValue(B)
  h.clearBillMember.mockReset().mockResolvedValue(undefined)
})

describe('OrderScreen — Member', () => {
  it('bill actions → Member opens the dialog on the bill', async () => {
    render(screenFor('t1'))
    await flush()
    openMemberAction()
    const dialog = screen.getByRole('dialog', { name: 'Member' })
    expect(dialog.textContent).toContain('Bill 261123-001')
    expect(within(dialog).getByLabelText('Phone number')).toBeTruthy()
  })

  it('the column line follows Attach, then Remove', async () => {
    render(screenFor('t1'))
    await flush()
    expect(column().textContent).not.toContain('Member ••')
    openMemberAction()
    fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '011-0000 0301' } })
    h.fetchBillMember.mockResolvedValue(B)
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))
    await flush()
    expect(h.setBillMember).toHaveBeenCalledWith('b1', '+601100000301')
    expect(screen.getByText('New member')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(column().textContent).toContain('Member ••0301')
    openMemberAction()
    h.fetchBillMember.mockResolvedValue(null)
    fireEvent.click(screen.getByRole('button', { name: 'Remove member' }))
    await flush()
    expect(h.clearBillMember).toHaveBeenCalledWith('b1')
    expect(screen.queryByRole('dialog', { name: 'Member' })).toBeNull()
    expect(column().textContent).not.toContain('Member ••')
  })

  it('a bill switch never shows the previous bill\'s member, nor the attach form while unknown', async () => {
    h.fetchBillMember.mockImplementation(async (id: string) => (id === 'b1' ? A : null))
    const { rerender } = render(screenFor('t1'))
    await flush()
    expect(column().textContent).toContain('Member ••6789')
    let release: (m: BillMember | null) => void = () => {}
    h.fetchBillMember.mockImplementation(() => new Promise((r) => { release = r }))
    rerender(screenFor('t2'))
    expect(column().textContent).not.toContain('Member ••6789')
    openMemberAction()
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    expect(screen.queryByLabelText('Phone number')).toBeNull()
    await act(async () => { release(null) })
    await flush()
    expect(screen.getByLabelText('Phone number')).toBeTruthy()
    expect(column().textContent).not.toContain('Member ••')
  })

  it('a failed read: no line, and the dialog offers Retry', async () => {
    h.fetchBillMember.mockRejectedValueOnce(new Error('No reply from the server. Check the internet connection and try again.'))
    render(screenFor('t1'))
    await flush()
    expect(column().textContent).not.toContain('Member ••')
    openMemberAction()
    expect(screen.getByRole('alert').textContent).toBe("Couldn't read the member.")
    h.fetchBillMember.mockResolvedValue(A)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await flush()
    expect(screen.getByTestId('member-summary').textContent).toContain('Member +60 12-345 6789')
    expect(column().textContent).toContain('Member ••6789')
  })
})
