import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useCan } from '../../../shared/lib/permissions'
import { readableError } from '../checkout/rpcResult'
import type { Outlet } from '../outlets/outlet'
import { fetchMyOutlets } from '../outlets/outletsApi'
import FilterBar from './FilterBar'
import DailyTab from './DailyTab'
import DiscountsTab from './DiscountsTab'
import DrawerTab from './DrawerTab'
import HourlyTab from './HourlyTab'
import LedgerTab from './LedgerTab'
import OverviewTab from './OverviewTab'
import PaymentsTab from './PaymentsTab'
import ProductsTab from './ProductsTab'
import RefundsTab from './RefundsTab'
import SstTab from './SstTab'
import SummaryTab from './SummaryTab'
import VoidsTab from './VoidsTab'
import { TABS, filterParams, readFilter, type ReportFilter, type ReportTab } from './reportRange'
import type { ReportQuery } from './reportsApi'

const tabClass = (on: boolean) => `rounded px-3 py-1 text-sm ${on ? 'bg-brown-btn text-white' : 'border border-border bg-card'}`

/** POS → Reports (spec §2): sales, payments, SST and the cash drawer of the caller's outlets. */
export default function ReportsPage() {
  const { can } = useCan()
  const isHq = can('all_branches')
  const [params, setParams] = useSearchParams()
  const [outlets, setOutlets] = useState<Outlet[] | null>(null)        // null while loading
  const [error, setError] = useState<string | null>(null)
  const loadOutlets = useCallback(() => {
    setError(null)
    fetchMyOutlets().then(setOutlets, (e: unknown) => setError(readableError(e)))
  }, [])
  useEffect(() => { loadOutlets() }, [loadOutlets])

  let body: ReactNode
  if (error) {
    body = (
      <div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
        Could not load your outlets: {error}
        <button type="button" onClick={loadOutlets} className="ml-3 underline">Retry</button>
      </div>
    )
  } else if (!outlets) {
    body = <p className="text-sm text-brown-muted">Loading…</p>
  } else if (outlets.length === 0) {
    body = <p className="text-sm text-brown-muted">You have no outlets to report on.</p>
  } else {
    const now = new Date()                                            // read each time, so Today follows the clock
    const filter = readFilter(params, outlets, isHq, now)
    const change = (f: ReportFilter) => setParams(filterParams(f), { replace: true })
    const query: ReportQuery = { outlets: filter.outlets, from: filter.from, to: filter.to }
    body = (
      <>
        <FilterBar outlets={outlets} filter={filter} now={now} onChange={change} />
        <div role="tablist" aria-label="Reports" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={filter.tab === t.id}
                    onClick={() => change({ ...filter, tab: t.id })} className={tabClass(filter.tab === t.id)}>{t.label}</button>
          ))}
        </div>
        <div role="tabpanel" aria-label={TABS.find((t) => t.id === filter.tab)?.label}>
          <TabBody tab={filter.tab} query={query} />
        </div>
      </>
    )
  }
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Reports</h1>
      {body}
    </div>
  )
}

function TabBody({ tab, query }: { tab: ReportTab; query: ReportQuery }) {
  switch (tab) {
    case 'overview': return <OverviewTab query={query} />
    case 'summary': return <SummaryTab query={query} />
    case 'daily': return <DailyTab query={query} />
    case 'hourly': return <HourlyTab query={query} />
    case 'products': return <ProductsTab query={query} />
    case 'payments': return <PaymentsTab query={query} />
    case 'sst': return <SstTab query={query} />
    case 'discounts': return <DiscountsTab query={query} />
    case 'voids': return <VoidsTab query={query} />
    case 'refunds': return <RefundsTab query={query} />
    case 'drawer': return <DrawerTab query={query} />
    case 'ledger': return <LedgerTab query={query} />
  }
}
