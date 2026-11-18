import ReportBody from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { fetchSalesReport, type DailyRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const c = columnsFor<DailyRow>()
const COLUMNS = [
  c.text('Outlet', (r) => r.outlet), c.day('Business day', (r) => r.day), c.count('Bills', (r) => r.bills),
  c.count('Pax', (r) => r.pax), c.money('Gross before discounts', (r) => r.grossSen), c.money('Discounts', (r) => r.discountSen),
  c.money('Takeaway fee', (r) => r.takeawayFeeSen), c.money('Service charge', (r) => r.serviceChargeSen),
  c.money('SST', (r) => r.sstSen), c.money('Rounding', (r) => r.roundingSen), c.money('Nett', (r) => r.nettSen),
  c.money('Refunds', (r) => r.refundSen),
]

/** Spec §5.3: one row per outlet per business day. Gross is before discounts; refunds are not taken off. */
export default function DailyTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchSalesReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => <ReportTable title="Daily sales" columns={COLUMNS} rows={r.daily} fileName={csvFileName('daily-sales', query.from, query.to)} />}
    </ReportBody>
  )
}
