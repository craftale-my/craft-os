import ReportBody from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { fetchDrawerReport, type DrawerRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const c = columnsFor<DrawerRow>()
const COLUMNS = [
  c.text('Outlet', (r) => r.outlet), c.time('Opened', (r) => r.openedAt), c.time('Closed', (r) => r.closedAt, 'Still open'),
  c.text('Opened by', (r) => r.openedBy), c.text('Closed by', (r) => r.closedBy), c.money('Float', (r) => r.floatSen),
  c.money('Cash sales', (r) => r.cashSalesSen), c.money('Cash refunds', (r) => r.cashRefundSen), c.money('Pay in', (r) => r.payInSen),
  c.money('Pay out', (r) => r.payOutSen), c.count('No-sale opens', (r) => r.noSaleOpens), c.money('Expected', (r) => r.expectedSen),
  c.money('Counted', (r) => r.countedSen),
  c.money('Variance', (r) => r.varianceSen), c.text('Reason', (r) => r.reason),
]

/** Spec §5.11: one row per shift whose close (or open, for a shift still open) falls in the range. */
export default function DrawerTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchDrawerReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (
        <ReportTable title="Cash drawer" columns={COLUMNS} rows={r.shifts} fileName={csvFileName('cash-drawer', query.from, query.to)}
                     empty="No shifts in this range." />
      )}
    </ReportBody>
  )
}
