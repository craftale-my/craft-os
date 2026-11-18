import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { average, hourLabel } from './reportView'
import { fetchSalesReport, type HourlyRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const c = columnsFor<HourlyRow>()
const COLUMNS = [
  c.text('Hour', (r) => hourLabel(r.hour)), c.count('Bills', (r) => r.bills), c.money('Nett sales', (r) => r.nettSen),
  c.money('Average per bill', (r) => average(r.nettSen, r.bills)),
]

/** Spec §5.4: one row per hour 0–23 over the range, by the Malaysia hour a bill was paid. */
export default function HourlyTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchSalesReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (r.current.bills === 0 ? <NoSales /> : (
        <ReportTable title="Hourly sales" columns={COLUMNS} rows={r.hourly} fileName={csvFileName('hourly-sales', query.from, query.to)} />
      ))}
    </ReportBody>
  )
}
