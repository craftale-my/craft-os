import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor, type Column } from './columns'
import { csvFileName, ringgit } from './csv'
import { ORDER_TYPE_LABELS, SOURCE_LABELS, signedSen } from './reportView'
import { fetchSalesReport, type OrderTypeRow, type ReportQuery, type SalesSummary, type SourceRow } from './reportsApi'
import { useReport } from './useReport'

interface Line {
  label: string
  sen: number
}

/** Feedme's order (spec §5.2): gross before discounts → discounts → gross sales → charges → nett. */
function summaryLines(s: SalesSummary): Line[] {
  return [
    { label: 'Gross before discounts', sen: s.beforeDiscountsSen },
    { label: 'Staff Meal', sen: -s.catalogDiscountSen },
    { label: 'Item discounts', sen: -s.itemDiscountSen },
    { label: 'Bill discounts', sen: -s.billDiscountSen },
    { label: 'Gross sales', sen: s.grossSen },
    { label: 'Takeaway fee', sen: s.takeawayFeeSen },
    { label: 'Service charge', sen: s.serviceChargeSen },
    { label: 'SST', sen: s.sstSen },
    { label: 'Rounding', sen: s.roundingSen },
    { label: 'Nett sales', sen: s.nettSen },
  ]
}

const l = columnsFor<Line>()
// on screen the minus comes before RM (-RM 0.80); the CSV holds -0.80
const AMOUNT_COLUMN: Column<Line> = { label: 'Amount', numeric: true, show: (r) => signedSen(r.sen), csv: (r) => ringgit(r.sen) }
const LINE_COLUMNS = [l.text('Item', (r) => r.label), AMOUNT_COLUMN]
const t = columnsFor<OrderTypeRow>()
const TYPE_COLUMNS = [
  t.text('Order type', (r) => ORDER_TYPE_LABELS[r.orderType] ?? r.orderType), t.count('Bills', (r) => r.bills),
  t.money('Nett sales', (r) => r.nettSen),
]
const s = columnsFor<SourceRow>()
const SOURCE_COLUMNS = [
  s.text('Source', (r) => SOURCE_LABELS[r.source] ?? r.source), s.count('Orders', (r) => r.orders),
  s.money('Item value', (r) => r.itemSen),
]

export default function SummaryTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchSalesReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (r.current.bills === 0 ? <NoSales /> : (
        <div className="space-y-4">
          <ReportTable title="Sales summary" columns={LINE_COLUMNS} rows={summaryLines(r.summary)}
                       fileName={csvFileName('sales-summary', query.from, query.to)} />
          <ReportTable title="By order type" columns={TYPE_COLUMNS} rows={r.orderTypes}
                       fileName={csvFileName('order-types', query.from, query.to)} />
          <ReportTable title="By source" columns={SOURCE_COLUMNS} rows={r.sources}
                       fileName={csvFileName('sources', query.from, query.to)} />
          <p className="text-xs text-brown-muted">Refunds are listed in the Refunds tab and are not taken off these sales.</p>
        </div>
      ))}
    </ReportBody>
  )
}
