import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor, type Column } from './columns'
import { csvFileName } from './csv'
import { rateLabel } from './reportView'
import { fetchSstReport, type ReportQuery, type SstMonth } from './reportsApi'
import { useReport } from './useReport'

interface RateRow {
  label: string
  baseSen: number
  sstSen: number | null
}

const c = columnsFor<RateRow>()
const RATE_COLUMNS = [c.text('Rate', (r) => r.label), c.money('Taxable', (r) => r.baseSen), c.money('SST', (r) => r.sstSen)]

/** One row per month: taxable and SST at every rate seen in the range, then exempt (for SST-02). */
function monthColumns(rates: number[]): Column<SstMonth>[] {
  const m = columnsFor<SstMonth>()
  return [
    m.text('Month', (r) => r.month),
    ...rates.flatMap((bp) => [
      m.money(`Taxable ${rateLabel(bp)}`, (r) => r.rates.find((x) => x.rateBp === bp)?.baseSen ?? 0),
      m.money(`SST ${rateLabel(bp)}`, (r) => r.rates.find((x) => x.rateBp === bp)?.sstSen ?? 0),
    ]),
    m.money('Exempt', (r) => r.exemptSen),
  ]
}

/** Spec §5.7: SST as charged on the bills, per rate and per month; refunds are listed apart. */
export default function SstTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchSstReport, query)
  const file = (name: string) => csvFileName(name, query.from, query.to)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => {
        if (r.rates.length === 0 && r.exemptSen === 0) return <NoSales />
        const rows: RateRow[] = [
          ...r.rates.map((x) => ({ label: `SST ${rateLabel(x.rateBp)}`, baseSen: x.baseSen, sstSen: x.sstSen })),
          { label: 'Exempt (0%)', baseSen: r.exemptSen, sstSen: null },
        ]
        const rates = [...new Set(r.months.flatMap((m) => m.rates.map((x) => x.rateBp)))].sort((x, y) => x - y)
        return (
          <div className="space-y-4">
            <ReportTable title="SST by rate" columns={RATE_COLUMNS} rows={rows} fileName={file('sst-by-rate')} />
            <ReportTable title="SST by month" columns={monthColumns(rates)} rows={r.months} fileName={file('sst-by-month')} />
            {r.rates.length === 0 && r.exemptSen > 0 && (
              <p className="text-sm">This outlet may not be SST registered.</p>
            )}
            <p className="text-xs text-brown-muted">Months follow the calendar date of each bill (Malaysia time).</p>
            <p className="text-xs text-brown-muted">
              SST as charged on the bills. Service charge carries no SST. Refunds are not taken off (see Refunds).
            </p>
          </div>
        )
      }}
    </ReportBody>
  )
}
