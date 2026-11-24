import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { PAYMENT_KIND_LABELS } from './reportView'
import { fetchPaymentsReport, type PaymentRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const c = columnsFor<PaymentRow>()
const COLUMNS = [
  c.text('Method', (r) => r.name), c.text('Kind', (r) => PAYMENT_KIND_LABELS[r.kind] ?? r.kind),
  c.count('Payments', (r) => r.count), c.money('Amount', (r) => r.amountSen), c.count('Refunds', (r) => r.refundCount),
  c.money('Refunded', (r) => r.refundSen), c.money('Net', (r) => r.netSen),
]

/** Spec §5.6: per method; part payments are payments like any other. */
export default function PaymentsTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchPaymentsReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (r.methods.length === 0 ? <NoSales /> : (
        <div className="space-y-2">
          <ReportTable title="Payments" columns={COLUMNS} rows={r.methods} fileName={csvFileName('payments', query.from, query.to)} />
          <p className="text-xs text-brown-muted">The payments of the bills sold in this range; refunds by the day they were made.</p>
        </div>
      ))}
    </ReportBody>
  )
}
