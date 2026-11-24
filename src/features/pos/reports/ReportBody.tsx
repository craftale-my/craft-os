import type { ReactNode } from 'react'
import type { ReportLoad } from './useReport'

/** A tab's body: loading, the reason with Retry, or the report. */
export default function ReportBody<T>({ load, retry, children }: {
  load: ReportLoad<T>
  retry: () => void
  children: (data: T) => ReactNode
}) {
  if (load.status === 'loading') return <p className="text-sm text-brown-muted">Loading…</p>
  if (load.status === 'error') {
    return (
      <div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
        Could not load the report: {load.message}
        <button type="button" onClick={retry} className="ml-3 underline">Retry</button>
      </div>
    )
  }
  return <>{children(load.data)}</>
}

export function NoSales() {
  return <p className="text-sm text-brown-muted">No sales in this range.</p>
}
