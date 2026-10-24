import { renderZReportLines, type ZReport } from '../print/zreport'

/** The Z report on screen: the receipt layout's lines at 48 columns. A printer wraps the same
 *  content at its own width (the iPad print host at TICKET_COLS 42, the Node agent at its .env's). */
export default function ZReportView({ report }: { report: ZReport }) {
  const lines = renderZReportLines({ kind: 'zreport', route: '', reprint: false, report }, 48)
  return (
    <pre aria-label="Z report" className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-white p-3 font-mono text-xs leading-snug">
      {lines.join('\n')}
    </pre>
  )
}
