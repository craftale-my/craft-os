// One report tab's read (spec §6 Errors): each tab loads on its own; a reply for an earlier filter is
// dropped; Retry reads again.
import { useCallback, useEffect, useRef, useState } from 'react'
import { readableError } from '../checkout/rpcResult'
import type { ReportQuery } from './reportsApi'

export type ReportLoad<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }

export function useReport<T>(fetcher: (q: ReportQuery) => Promise<T>, query: ReportQuery): { load: ReportLoad<T>; retry: () => void } {
  const [load, setLoad] = useState<ReportLoad<T>>({ status: 'loading' })
  const seq = useRef(0)
  const key = `${query.outlets.join(',')}|${query.from}|${query.to}`
  const run = useCallback(() => {
    const id = ++seq.current
    setLoad({ status: 'loading' })
    fetcher(query).then(
      (data) => { if (id === seq.current) setLoad({ status: 'ready', data }) },
      (e: unknown) => { if (id === seq.current) setLoad({ status: 'error', message: readableError(e) }) },
    )
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps -- the query is its key; fetcher is a module function
  useEffect(() => { run() }, [run])
  return { load, retry: run }
}
