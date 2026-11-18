// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Q, SALES } from './testReports'

const h = vi.hoisted(() => ({ sales: vi.fn() }))
vi.mock('./reportsApi', () => ({ fetchSalesReport: (q: unknown) => h.sales(q) }))

import OverviewTab from './OverviewTab'

const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const card = (label: string) => within(screen.getByRole('listitem', { name: label }))

beforeEach(() => { h.sales.mockReset().mockResolvedValue(SALES) })
afterEach(cleanup)

describe('OverviewTab', () => {
  it('reads the sales of the outlets and business days asked for', async () => {
    render(<OverviewTab query={Q} />)
    await settle()
    expect(h.sales).toHaveBeenCalledWith(Q)
  })

  it('cards with the change against the previous period of the same length', async () => {
    render(<OverviewTab query={Q} />)
    await settle()
    expect(screen.getByText('Change against Sat 3 Jan 2026 – Sun 4 Jan 2026.')).toBeTruthy()
    expect(card('Nett sales').getByText('RM 102.00')).toBeTruthy()
    expect(card('Nett sales').getByText('+862%')).toBeTruthy()
    expect(card('Bills').getByText('6')).toBeTruthy()
    expect(card('Bills').getByText('+500%')).toBeTruthy()
    expect(card('Pax').getByText('+250%')).toBeTruthy()
    expect(card('Average per bill').getByText('RM 17.00')).toBeTruthy()
    expect(card('Average per bill').getByText('+60%')).toBeTruthy()
    expect(card('Average per pax').getByText('RM 14.57')).toBeTruthy()
    expect(card('Average per pax').getByText('+175%')).toBeTruthy()
    expect(card('Discounts').getByText('RM 2.80')).toBeTruthy()
    expect(card('Discounts').getByText('—')).toBeTruthy()
    expect(card('Voids').getByText('RM 4.00')).toBeTruthy()
    expect(card('Refunds').getByText('RM 3.00')).toBeTruthy()
    expect(card('Nett after refunds').getByText('RM 99.00')).toBeTruthy()
    expect(card('Nett after refunds').getByText('+834%')).toBeTruthy()
  })

  it('bars: daily nett sales over every day of the range, hourly over 24 hours', async () => {
    render(<OverviewTab query={Q} />)
    await settle()
    const daily = within(screen.getByRole('list', { name: 'Daily nett sales' })).getAllByRole('listitem')
    expect(daily.map((b) => b.getAttribute('aria-label'))).toEqual(['Mon 5 Jan: RM 39.50', 'Tue 6 Jan: RM 62.50'])
    expect(daily.map((b) => (b.firstElementChild as HTMLElement).style.height)).toEqual(['63.2%', '100%'])
    const hourly = within(screen.getByRole('list', { name: 'Hourly nett sales' })).getAllByRole('listitem')
    expect(hourly).toHaveLength(24)
    expect(hourly[13].getAttribute('aria-label')).toBe('13: RM 12.60')
  })

  it('top 10 products by quantity', async () => {
    render(<OverviewTab query={Q} />)
    await settle()
    const section = screen.getByRole('heading', { name: 'Top 10 products' }).closest('section') as HTMLElement
    expect(within(section).getAllByRole('row').map((r) => r.textContent))
      .toEqual(['ProductQtyValue', 'Latte5RM 50.00', 'Cake3RM 24.00', 'Muffin2RM 20.40', 'Water2RM 4.00'])
  })

  it('no bills: No sales in this range.', async () => {
    h.sales.mockResolvedValue({ ...SALES, current: { ...SALES.current, nettSen: 0, bills: 0, pax: 0 } })
    render(<OverviewTab query={Q} />)
    await settle()
    expect(screen.getByText('No sales in this range.')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Totals' })).toBeNull()
  })

  it('a failed read shows the reason; Retry reads again', async () => {
    h.sales.mockRejectedValueOnce(new Error('You cannot see reports for this outlet.'))
    render(<OverviewTab query={Q} />)
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('Could not load the report: You cannot see reports for this outlet.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(h.sales).toHaveBeenCalledTimes(2)
    expect(card('Nett sales').getByText('RM 102.00')).toBeTruthy()
  })

  it('no reply reads as plain words, never the browser\'s', async () => {
    h.sales.mockRejectedValueOnce(new TypeError('Load failed'))
    render(<OverviewTab query={Q} />)
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('No reply from the server. Check the internet connection and try again.')
  })
})
