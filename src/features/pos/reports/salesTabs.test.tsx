// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { PAYMENTS, PRODUCTS, Q, SALES, SST } from './testReports'

const h = vi.hoisted(() => ({ sales: vi.fn(), products: vi.fn(), payments: vi.fn(), sst: vi.fn(), download: vi.fn() }))
vi.mock('./reportsApi', () => ({
  fetchSalesReport: (q: unknown) => h.sales(q),
  fetchProductsReport: (q: unknown) => h.products(q),
  fetchPaymentsReport: (q: unknown) => h.payments(q),
  fetchSstReport: (q: unknown) => h.sst(q),
}))
vi.mock('./csv', async (importOriginal) => ({ ...(await importOriginal<typeof import('./csv')>()), downloadCsv: h.download }))

import DailyTab from './DailyTab'
import HourlyTab from './HourlyTab'
import PaymentsTab from './PaymentsTab'
import ProductsTab from './ProductsTab'
import SstTab from './SstTab'
import SummaryTab from './SummaryTab'

const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const section = (title: string) => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement
/** The cells of the row of a table whose first cell reads `first`. */
function rowOf(table: HTMLElement, first: string): string[] {
  const td = within(table).getAllByText(first).find((e) => e.tagName === 'TD')
  if (!td) throw new Error(`no row "${first}"`)
  return [...(td.closest('tr') as HTMLElement).querySelectorAll('td')].map((c) => c.textContent ?? '')
}
const headers = (table: HTMLElement) => [...table.querySelectorAll('th')].map((c) => c.textContent)

beforeEach(() => {
  h.sales.mockReset().mockResolvedValue(SALES)
  h.products.mockReset().mockResolvedValue(PRODUCTS)
  h.payments.mockReset().mockResolvedValue(PAYMENTS)
  h.sst.mockReset().mockResolvedValue(SST)
  h.download.mockReset()
})
afterEach(cleanup)

describe('SummaryTab', () => {
  it('Feedme\'s order, then order types and sources', async () => {
    render(<SummaryTab query={Q} />)
    await settle()
    const s = section('Sales summary')
    expect([...s.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')?.textContent)).toEqual([
      'Gross before discounts', 'Staff Meal', 'Item discounts', 'Bill discounts', 'Gross sales', 'Takeaway fee',
      'Service charge', 'SST', 'Rounding', 'Nett sales',
    ])
    expect(rowOf(s, 'Gross before discounts')).toEqual(['Gross before discounts', 'RM 98.40'])
    expect(rowOf(s, 'Item discounts')).toEqual(['Item discounts', '-RM 0.80'])
    expect(rowOf(s, 'Gross sales')).toEqual(['Gross sales', 'RM 95.60'])
    expect(rowOf(s, 'Rounding')).toEqual(['Rounding', 'RM 0.03'])
    expect(rowOf(s, 'Nett sales')).toEqual(['Nett sales', 'RM 102.00'])
    expect(rowOf(section('By order type'), 'Dine-in')).toEqual(['Dine-in', '5', 'RM 71.35'])
    expect(rowOf(section('By source'), 'QR')).toEqual(['QR', '1', 'RM 18.00'])
  })
  it('no bills: No sales in this range.', async () => {
    h.sales.mockResolvedValue({ ...SALES, current: { ...SALES.current, bills: 0 } })
    render(<SummaryTab query={Q} />)
    await settle()
    expect(screen.getByText('No sales in this range.')).toBeTruthy()
  })
})

describe('DailyTab', () => {
  it('one row per outlet and business day; the CSV holds the same in ringgit', async () => {
    render(<DailyTab query={Q} />)
    await settle()
    const s = section('Daily sales')
    expect(headers(s)[4]).toBe('Gross before discounts')
    expect(rowOf(s, 'Cheras')).toEqual(['Cheras', 'Mon 5 Jan 2026', '2', '3', 'RM 40.00', 'RM 2.80', 'RM 0.00', 'RM 0.00',
      'RM 2.26', 'RM 0.04', 'RM 39.50', 'RM 0.00'])
    fireEvent.click(within(s).getByRole('button', { name: 'Download CSV' }))
    expect(h.download).toHaveBeenCalledWith('daily-sales_2026-01-05_2026-01-06.csv',
      '\uFEFFOutlet,Business day,Bills,Pax,Gross before discounts,Discounts,Takeaway fee,Service charge,SST,Rounding,Nett,Refunds\r\n'
      + 'Cheras,2026-01-05,2,3,40.00,2.80,0.00,0.00,2.26,0.04,39.50,0.00\r\n'
      + 'Cheras,2026-01-06,4,4,58.40,0.00,0.00,0.00,4.11,-0.01,62.50,3.00\r\n')
  })
  it('no rows: No sales in this range., and nothing to download', async () => {
    h.sales.mockResolvedValue({ ...SALES, daily: [] })
    render(<DailyTab query={Q} />)
    await settle()
    expect(screen.getByText('No sales in this range.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Download CSV' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('HourlyTab', () => {
  it('24 rows with the average per bill', async () => {
    render(<HourlyTab query={Q} />)
    await settle()
    const s = section('Hourly sales')
    expect(s.querySelectorAll('tbody tr')).toHaveLength(24)
    expect(rowOf(s, '13:00–13:59')).toEqual(['13:00–13:59', '2', 'RM 12.60', 'RM 6.30'])
    expect(rowOf(s, '00:00–00:59')).toEqual(['00:00–00:59', '0', 'RM 0.00', 'RM 0.00'])
  })
})

describe('ProductsTab', () => {
  it('products, add-ons and categories; no category reads as such', async () => {
    render(<ProductsTab query={Q} />)
    await settle()
    expect(rowOf(section('Products'), 'Latte')).toEqual(['Latte', 'Drinks', '5', 'RM 50.00', 'RM 2.00', 'RM 48.00'])
    expect(rowOf(section('Products'), 'Water')).toEqual(['Water', 'No category', '2', 'RM 4.00', 'RM 0.00', 'RM 4.00'])
    expect(rowOf(section('Add-ons'), 'Oat milk')).toEqual(['Oat milk', '2', 'RM 3.00'])
    expect(rowOf(section('Categories'), 'No category')).toEqual(['No category', '2', 'RM 4.00'])
  })
  it('no add-ons: says so', async () => {
    h.products.mockResolvedValue({ ...PRODUCTS, addOns: [] })
    render(<ProductsTab query={Q} />)
    await settle()
    expect(within(section('Add-ons')).getByText('No add-ons in this range.')).toBeTruthy()
  })
})

describe('PaymentsTab', () => {
  it('per method: payments, refunds and net', async () => {
    render(<PaymentsTab query={Q} />)
    await settle()
    const s = section('Payments')
    expect(headers(s)).toEqual(['Method', 'Kind', 'Payments', 'Amount', 'Refunds', 'Refunded', 'Net'])
    expect(rowOf(s, 'Cash')).toEqual(['Cash', 'Cash', '3', 'RM 59.00', '1', 'RM 3.00', 'RM 56.00'])
  })
})

describe('SstTab', () => {
  it('per rate with exempt; per month with a column pair for every rate', async () => {
    render(<SstTab query={Q} />)
    await settle()
    const rates = section('SST by rate')
    expect(rowOf(rates, 'SST 6%')).toEqual(['SST 6%', 'RM 48.00', 'RM 2.88'])
    expect(rowOf(rates, 'Exempt (0%)')).toEqual(['Exempt (0%)', 'RM 4.00', '—'])
    const months = section('SST by month')
    expect(headers(months)).toEqual(['Month', 'Taxable 6%', 'SST 6%', 'Taxable 8%', 'SST 8%', 'Exempt'])
    expect(rowOf(months, '2025-12')).toEqual(['2025-12', 'RM 10.00', 'RM 0.60', 'RM 0.00', 'RM 0.00', 'RM 0.00'])
    expect(rowOf(months, '2026-01')).toEqual(['2026-01', 'RM 38.00', 'RM 2.28', 'RM 43.60', 'RM 3.49', 'RM 4.00'])
  })
  it('notes that months follow the calendar date of each bill; no registration line when there are SST rates', async () => {
    render(<SstTab query={Q} />)
    await settle()
    expect(screen.getByText('Months follow the calendar date of each bill (Malaysia time). The first and last month may be partial: include the day before and after the month for a full return.')).toBeTruthy()
    expect(screen.queryByText('No SST was charged in this range: every sale was at 0% (exempt).')).toBeNull()
  })
  it('sales but no SST rates (all exempt): says no SST was charged, every sale at 0%', async () => {
    h.sst.mockResolvedValue({ rates: [], exemptSen: 400, months: [{ month: '2026-01', rates: [], exemptSen: 400 }] })
    render(<SstTab query={Q} />)
    await settle()
    expect(screen.getByText('No SST was charged in this range: every sale was at 0% (exempt).')).toBeTruthy()
  })
  it('nothing at all: No sales in this range.', async () => {
    h.sst.mockResolvedValue({ rates: [], exemptSen: 0, months: [] })
    render(<SstTab query={Q} />)
    await settle()
    expect(screen.getByText('No sales in this range.')).toBeTruthy()
    expect(screen.queryByText('No SST was charged in this range: every sale was at 0% (exempt).')).toBeNull()
  })
})
