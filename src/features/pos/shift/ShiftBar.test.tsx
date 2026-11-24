// @vitest-environment jsdom
// The shift sheets render into document.body, above the POS app's lock screen: a lock must close them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const fetchShiftStatus = vi.fn()
vi.mock('./shiftApi', () => ({ fetchShiftStatus: () => fetchShiftStatus() }))
vi.mock('./OpenShiftSheet', () => ({ default: () => <div data-testid="open-sheet" /> }))
vi.mock('./CashMoveSheet', () => ({ default: () => <div data-testid="move-sheet" /> }))
vi.mock('./CloseShiftSheet', () => ({ default: () => <div data-testid="close-sheet" /> }))
vi.mock('./ShiftsDrawer', () => ({ default: () => <div data-testid="shifts-drawer" /> }))

import ShiftBar from './ShiftBar'

const open = {
  shift: { id: 's1', openedAt: '2026-10-30T01:00:00Z', openedByName: 'Aina', openingFloatSen: 20000 },
  openBillCount: 0, lastFloatSen: null, now: '2026-10-30T02:00:00Z',
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => { fetchShiftStatus.mockReset().mockResolvedValue(open) })
afterEach(cleanup)

describe('ShiftBar', () => {
  it('a lock closes an open Pay in / out and Close shift sheet', async () => {
    const { rerender } = render(<ShiftBar branchId="b1" refreshKey={0} canSupervise={false} locked={false} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Pay in / out' }))
    expect(screen.getByTestId('move-sheet')).toBeTruthy()
    rerender(<ShiftBar branchId="b1" refreshKey={0} canSupervise={false} locked />)
    expect(screen.queryByTestId('move-sheet')).toBeNull()

    rerender(<ShiftBar branchId="b1" refreshKey={0} canSupervise={false} locked={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close shift' }))
    expect(screen.getByTestId('close-sheet')).toBeTruthy()
    rerender(<ShiftBar branchId="b1" refreshKey={0} canSupervise={false} locked />)
    expect(screen.queryByTestId('close-sheet')).toBeNull()
  })
})
