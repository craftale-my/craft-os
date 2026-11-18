import ReportBody from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { DISCOUNT_ACTION_LABELS, discountCsvValue, discountValueText } from './reportView'
import type { Column } from './columns'
import { fetchAuditReport, type DiscountLogRow, type DiscountTotals, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const d = columnsFor<DiscountLogRow>()
// on screen RM 2.00 or 10%; the CSV holds a plain number (ringgit for an amount, the percent for a percent)
const VALUE_COLUMN: Column<DiscountLogRow> = {
  label: 'Value', numeric: true, show: (r) => discountValueText(r.kind, r.value), csv: (r) => discountCsvValue(r.kind, r.value),
}
const LOG_COLUMNS = [
  d.time('Time', (r) => r.at), d.text('Outlet', (r) => r.outlet), d.text('Bill', (r) => r.billNo),
  d.text('On', (r) => r.item ?? 'Bill'), d.text('Action', (r) => DISCOUNT_ACTION_LABELS[r.action] ?? r.action),
  d.text('Kind', (r) => (r.kind === 'amount' ? 'Amount' : r.kind === 'percent' ? 'Percent' : null)), VALUE_COLUMN,
  d.text('Reason', (r) => r.reason),
  d.text('By', (r) => r.by), d.text('Approved by', (r) => r.approvedBy),
]

interface TotalRow {
  label: string
  count: number
  sen: number
}
const t = columnsFor<TotalRow>()
const TOTAL_COLUMNS = [t.text('Kind', (r) => r.label), t.count('Count', (r) => r.count), t.money('Amount', (r) => r.sen)]
const totalRows = (x: DiscountTotals): TotalRow[] => [
  { label: 'Staff Meal', count: x.catalogBills, sen: x.catalogSen },
  { label: 'Item discounts', count: x.itemCount, sen: x.itemSen },
  { label: 'Bill discounts', count: x.billCount, sen: x.billSen },
]

/** Spec §5.8: every discount set and cleared (pos_discount_log), and the discount totals of the bills sold. */
export default function DiscountsTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchAuditReport, query)
  const file = (name: string) => csvFileName(name, query.from, query.to)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (
        <div className="space-y-4">
          <ReportTable title="Discounts" columns={LOG_COLUMNS} rows={r.discounts} fileName={file('discounts')}
                       empty="No discounts in this range." />
          <ReportTable title="Discount totals" columns={TOTAL_COLUMNS} rows={totalRows(r.discountTotals)} fileName={file('discount-totals')} />
          <p className="text-xs text-brown-muted">
            Staff Meal and bill discounts count bills; item discounts count lines. A cleared discount shows what was cleared.
          </p>
        </div>
      )}
    </ReportBody>
  )
}
