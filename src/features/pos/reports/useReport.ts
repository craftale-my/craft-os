// One report tab's read (spec §6 Errors): each tab loads on its own; a reply for an earlier filter is
// dropped (and never drawn, not even for a frame); Retry reads again.
import { useCallback, useEffect, useRef, useState } from 'react'
import { readableError } from '../checkout/rpcResult'
import type { ReportQuery } from './reportsApi'

export type ReportLoad<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }

const LOADING = { status: 'loading' } as const

export function useReport<T>(fetcher: (q: ReportQuery) => Promise<T>, query: ReportQuery): { load: ReportLoad<T>; retry: () => void } {
  const key = `${query.outlets.join(',')}|${query.from}|${query.to}`
  // the result keeps the key it was read for: a result for another key is not the current one
  const [state, setState] = useState<{ key: string; load: ReportLoad<T> }>({ key, load: LOADING })
  const seq = useRef(0)
  const run = useCallback(() => {
    const id = ++seq.current
    setState({ key, load: LOADING })
    fetcher(query).then(
      (data) => { if (id === seq.current) setState({ key, load: { status: 'ready', data } }) },
      (e: unknown) => { if (id === seq.current) setState({ key, load: { status: 'error', message: readableError(e) } }) },
    )
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps -- the query is its key; fetcher is a module function
  useEffect(() => { run() }, [run])
  return { load: state.key === key ? state.load : LOADING, retry: run }
}
