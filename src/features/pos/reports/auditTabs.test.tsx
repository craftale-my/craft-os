// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AUDIT, DRAWER, EMPTY_AUDIT, LEDGER, Q } from './testReports'

const h = vi.hoisted(() => ({ audit: vi.fn(), drawer: vi.fn(), ledger: vi.fn(), download: vi.fn() }))
vi.mock('./reportsApi', () => ({
  fetchAuditReport: (q: unknown) => h.audit(q),
  fetchDrawerReport: (q: unknown) => h.drawer(q),
  fetchLedgerReport: (q: unknown) => h.ledger(q),
}))
vi.mock('./csv', async (importOriginal) => ({ ...(await importOriginal<typeof import('./csv')>()), downloadCsv: h.download }))

import DiscountsTab from './DiscountsTab'
import DrawerTab from './DrawerTab'
import LedgerTab from './LedgerTab'
import RefundsTab from './RefundsTab'
import VoidsTab from './VoidsTab'
import { billsCsv, linesCsv, paymentsCsv } from './ledgerCsv'

const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const section = (title: string) => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement
const bodyRows = (table: HTMLElement) =>
  [...table.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent ?? ''))

beforeEach(() => {
  h.audit.mockReset().mockResolvedValue(AUDIT)
  h.drawer.mockReset().mockResolvedValue(DRAWER)
  h.ledger.mockReset().mockResolvedValue(LEDGER)
  h.download.mockReset()
})
afterEach(cleanup)

describe('DiscountsTab', () => {
  it('every discount set and cleared, Malaysia time; the totals by kind', async () => {
    render(<DiscountsTab query={Q} />)
    await settle()
    const log = bodyRows(section('Discounts'))
    expect(log).toHaveLength(4)
    expect(log[1]).toEqual(['5 Jan 2026, 11:45', 'Cheras', 'CH-0001', 'Bill', 'Cleared', 'Amount', 'RM 1.00', 'Regular', 'Aina', '—'])
    expect(log[2]).toEqual(['5 Jan 2026, 11:50', 'Cheras', 'CH-0001', 'Cake', 'Set', 'Percent', '10%', 'Regular', 'Aina', 'Ben'])
    expect(bodyRows(section('Discount totals'))).toEqual([
      ['Staff Meal', '0', 'RM 0.00'], ['Item discounts', '1', 'RM 0.80'], ['Bill discounts', '1', 'RM 2.00'],
    ])
  })
  it('the CSV has a Kind and a Value column: ringgit for an amount, a percent number for a percent, no RM', async () => {
    render(<DiscountsTab query={Q} />)
    await settle()
    fireEvent.click(within(section('Discounts')).getByRole('button', { name: 'Download CSV' }))
    const [name, text] = h.download.mock.calls[0] as [string, string]
    expect(name).toBe('discounts_2026-01-05_2026-01-06.csv')
    const lines = text.split('\r\n')
    expect(lines[0]).toBe('\uFEFFTime,Outlet,Bill,On,Action,Kind,Value,Reason,By,Approved by')
    expect(lines[2]).toBe('2026-01-05 11:45,Cheras,CH-0001,Bill,Cleared,Amount,1.00,Regular,Aina,')
    expect(lines[3]).toBe('2026-01-05 11:50,Cheras,CH-0001,Cake,Set,Percent,10,Regular,Aina,Ben')
  })
  it('none in the range: says so', async () => {
    h.audit.mockResolvedValue(EMPTY_AUDIT)
    render(<DiscountsTab query={Q} />)
    await settle()
    expect(within(section('Discounts')).getByText('No discounts in this range.')).toBeTruthy()
  })
})

describe('VoidsTab', () => {
  it('voided items and voided bills', async () => {
    render(<VoidsTab query={Q} />)
    await settle()
    expect(bodyRows(section('Voided items'))[0])
      .toEqual(['5 Jan 2026, 13:00', 'Cheras', 'CH-0002', 'Water', '1', 'RM 2.00', 'Wrong item keyed', 'Aina', 'Ben'])
    expect(bodyRows(section('Voided bills')))
      .toEqual([['6 Jan 2026, 15:00', 'Cheras', 'CH-0008', 'RM 2.00', 'Guest left', 'Aina', 'Ben']])
  })
  it('notes that a voided bill\'s items are also listed under Voided items', async () => {
    render(<VoidsTab query={Q} />)
    await settle()
    expect(screen.getByText('A voided bill\'s items are also listed under Voided items.')).toBeTruthy()
  })
  it('none: says so for each', async () => {
    h.audit.mockResolvedValue(EMPTY_AUDIT)
    render(<VoidsTab query={Q} />)
    await settle()
    expect(within(section('Voided items')).getByText('No voided items in this range.')).toBeTruthy()
    expect(within(section('Voided bills')).getByText('No voided bills in this range.')).toBeTruthy()
  })
})

describe('RefundsTab', () => {
  it('time, bill, method, amount, reason, approved by', async () => {
    render(<RefundsTab query={Q} />)
    await settle()
    expect(bodyRows(section('Refunds'))).toEqual([['6 Jan 2026, 10:30', 'Cheras', 'CH-0003', 'Cash', 'RM 3.00', 'Cold cake', 'Ben']])
  })
  it('none: says so', async () => {
    h.audit.mockResolvedValue(EMPTY_AUDIT)
    render(<RefundsTab query={Q} />)
    await settle()
    expect(screen.getByText('No refunds in this range.')).toBeTruthy()
  })
})

describe('DrawerTab', () => {
  it('one row per shift; a shift still open says so', async () => {
    render(<DrawerTab query={Q} />)
    await settle()
    expect(bodyRows(section('Cash drawer'))).toEqual([
      ['Cheras', '6 Jan 2026, 08:00', '6 Jan 2026, 22:00', 'Aina', 'Aina', 'RM 100.00', 'RM 39.90', 'RM 3.00', 'RM 20.00',
       'RM 5.00', 'RM 151.90', 'RM 151.50', 'RM -0.40', 'Short at close'],
      ['Cheras', '6 Jan 2026, 20:00', 'Still open', 'Aina', '—', 'RM 100.00', 'RM 19.10', 'RM 0.00', 'RM 0.00',
       'RM 0.00', 'RM 119.10', '—', '—', '—'],
    ])
  })
  it('none: says so', async () => {
    h.drawer.mockResolvedValue({ shifts: [] })
    render(<DrawerTab query={Q} />)
    await settle()
    expect(screen.getByText('No shifts in this range.')).toBeTruthy()
  })
})

describe('LedgerTab', () => {
  it('three files for the range, each with its row count', async () => {
    render(<LedgerTab query={Q} />)
    await settle()
    expect(screen.getByText('bills.csv').parentElement?.textContent).toContain('2 rows')
    fireEvent.click(screen.getByRole('button', { name: 'Download lines.csv' }))
    expect(h.download).toHaveBeenLastCalledWith('ledger-lines_2026-01-05_2026-01-06.csv', linesCsv(LEDGER.lines))
    fireEvent.click(screen.getByRole('button', { name: 'Download bills.csv' }))
    expect(h.download).toHaveBeenLastCalledWith('ledger-bills_2026-01-05_2026-01-06.csv', billsCsv(LEDGER.bills))
    fireEvent.click(screen.getByRole('button', { name: 'Download payments.csv' }))
    expect(h.download).toHaveBeenLastCalledWith('ledger-payments_2026-01-05_2026-01-06.csv', paymentsCsv(LEDGER.payments))
  })
  it('92 days are read; more than 92 days say so and make no request', async () => {
    render(<LedgerTab query={{ outlets: ['b1'], from: '2026-01-05', to: '2026-04-06' }} />)         // 92 days
    await settle()
    expect(h.ledger).toHaveBeenCalledTimes(1)
    cleanup()
    h.ledger.mockClear()
    render(<LedgerTab query={{ outlets: ['b1'], from: '2026-01-05', to: '2026-04-07' }} />)         // 93 days
    await settle()
    expect(screen.getByText('Export at most 92 days at a time.')).toBeTruthy()
    expect(h.ledger).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
  })
  it('no paid bills: No sales in this range.', async () => {
    h.ledger.mockResolvedValue({ bills: [], lines: [], payments: [] })
    render(<LedgerTab query={Q} />)
    await settle()
    expect(screen.getByText('No sales in this range.')).toBeTruthy()
  })
})
