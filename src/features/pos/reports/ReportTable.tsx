import { tableCsv, type Column } from './columns'
import { downloadCsv } from './csv'

/** One report table: its title, Download CSV (the same columns, CSV values) and the rows. */
export default function ReportTable<R>({ title, columns, rows, fileName, empty = 'No sales in this range.' }: {
  title: string
  columns: Column<R>[]
  rows: R[]
  fileName: string
  empty?: string
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{title}</h2>
        <button type="button" disabled={rows.length === 0} onClick={() => downloadCsv(fileName, tableCsv(columns, rows))}
                className="text-xs underline disabled:opacity-50">Download CSV</button>
      </div>
      {rows.length === 0 ? <p className="mt-2 text-sm text-brown-muted">{empty}</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-brown-muted">
                {columns.map((c) => <th key={c.label} className={`px-2 py-1 ${c.numeric ? 'text-right' : ''}`}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {columns.map((c) => (
                    <td key={c.label} className={`px-2 py-1 ${c.numeric ? 'text-right tabular-nums' : ''}`}>{c.show(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
