import ReportBody from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { fetchAuditReport, type RefundRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const c = columnsFor<RefundRow>()
const COLUMNS = [
  c.time('Time', (r) => r.at), c.text('Outlet', (r) => r.outlet), c.text('Bill', (r) => r.billNo),
  c.text('Method', (r) => r.method), c.money('Amount', (r) => r.amountSen), c.text('Reason', (r) => r.reason),
  c.text('Approved by', (r) => r.approvedBy),
]

/** Spec §5.10: refunds, listed apart — never taken out of sales or SST. */
export default function RefundsTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchAuditReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (
        <div className="space-y-2">
          <ReportTable title="Refunds" columns={COLUMNS} rows={r.refunds} fileName={csvFileName('refunds', query.from, query.to)}
                       empty="No refunds in this range." />
          <p className="text-xs text-brown-muted">Refunds carry an amount and a method only; they are not taken out of sales or SST.</p>
        </div>
      )}
    </ReportBody>
  )
}
