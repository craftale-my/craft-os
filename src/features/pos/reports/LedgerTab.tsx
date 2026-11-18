import ReportBody, { NoSales } from './ReportBody'
import { csvFileName, downloadCsv } from './csv'
import { billsCsv, linesCsv, paymentsCsv } from './ledgerCsv'
import { fetchLedgerReport, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

/** Spec §5.12: bills.csv, lines.csv and payments.csv for the range. */
export default function LedgerTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchLedgerReport, query)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => {
        if (r.bills.length === 0) return <NoSales />
        const files = [
          { name: 'bills.csv', rows: r.bills.length, save: () => downloadCsv(csvFileName('bills', query.from, query.to), billsCsv(r.bills)) },
          { name: 'lines.csv', rows: r.lines.length, save: () => downloadCsv(csvFileName('lines', query.from, query.to), linesCsv(r.lines)) },
          { name: 'payments.csv', rows: r.payments.length,
            save: () => downloadCsv(csvFileName('payments', query.from, query.to), paymentsCsv(r.payments)) },
        ]
        return (
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="font-semibold">Ledger export</h2>
            <p className="text-xs text-brown-muted">
              For the accountant: one row per paid bill, per line (with its share of the bill's SST) and per payment.
              Refunds are in the Refunds tab.
            </p>
            <ul className="mt-3 space-y-2 text-sm">
              {files.map((f) => (
                <li key={f.name} className="flex items-center gap-3">
                  <span className="w-28 font-mono">{f.name}</span>
                  <span className="text-brown-muted">{f.rows} rows</span>
                  <button type="button" onClick={f.save} className="text-xs underline">Download {f.name}</button>
                </li>
              ))}
            </ul>
          </section>
        )
      }}
    </ReportBody>
  )
}
