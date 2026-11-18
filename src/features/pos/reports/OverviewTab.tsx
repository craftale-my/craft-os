import { formatSen } from '../order/cart'
import Bars from './Bars'
import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { previousRange } from './reportRange'
import { average, changeText, dailySeries, dayShort, rangeText } from './reportView'
import { fetchSalesReport, type ReportQuery, type SalesReport, type TopProduct } from './reportsApi'
import { useReport } from './useReport'

const top = columnsFor<TopProduct>()
const TOP_COLUMNS = [top.text('Product', (r) => r.name), top.count('Qty', (r) => r.qty), top.money('Value', (r) => r.valueSen)]

interface Card {
  label: string
  value: string
  change: string
}

/** Spec §5.1: each card with its change against the previous period of the same length. */
function cards(r: SalesReport): Card[] {
  const cur = r.current
  const prev = r.previous
  const money = (label: string, a: number, b: number): Card => ({ label, value: formatSen(a), change: changeText(a, b) })
  const count = (label: string, a: number, b: number): Card => ({ label, value: String(a), change: changeText(a, b) })
  return [
    money('Nett sales', cur.nettSen, prev.nettSen),
    count('Bills', cur.bills, prev.bills),
    count('Pax', cur.pax, prev.pax),
    money('Average per bill', average(cur.nettSen, cur.bills), average(prev.nettSen, prev.bills)),
    money('Average per pax', average(cur.nettSen, cur.pax), average(prev.nettSen, prev.pax)),
    money('Discounts', cur.discountSen, prev.discountSen),
    money('Voids', cur.voidSen, prev.voidSen),
    money('Refunds', cur.refundSen, prev.refundSen),
    money('Nett after refunds', cur.nettSen - cur.refundSen, prev.nettSen - prev.refundSen),
  ]
}

export default function OverviewTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchSalesReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (r.current.bills === 0 && r.current.refundSen === 0 && r.current.voidSen === 0 ? <NoSales /> : (
        <div className="space-y-4">
          <p className="text-xs text-brown-muted">Change against {rangeText(previousRange(query))}.</p>
          <ul aria-label="Totals" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {cards(r).map((c) => (
              <li key={c.label} aria-label={c.label} className="rounded-xl border border-border bg-card p-3">
                <div className="text-xs text-brown-muted">{c.label}</div>
                <div className="text-lg font-semibold tabular-nums">{c.value}</div>
                <div className="text-xs text-brown-muted">{c.change}</div>
              </li>
            ))}
          </ul>
          <Bars title="Daily nett sales"
                bars={dailySeries(r.daily, query).map((d) => ({ label: dayShort(d.day), valueSen: d.nettSen }))} />
          <Bars title="Hourly nett sales"
                bars={r.hourly.map((x) => ({ label: String(x.hour).padStart(2, '0'), valueSen: x.nettSen }))} />
          <ReportTable title="Top 10 products" columns={TOP_COLUMNS} rows={r.topProducts}
                       fileName={csvFileName('top-products', query.from, query.to)} />
        </div>
      ))}
    </ReportBody>
  )
}
