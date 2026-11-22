import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useCan } from '../../../shared/lib/permissions'
import { bannerMessages } from './einvoice'
import { fetchDocuments, fetchJobRuns, fetchLargeBills, fetchStoppedAttempts } from './einvoiceApi'

/**
 * The owner's only e-invoice prompt (spec W5.7), on every Craft OS page: a rejected or invalid document,
 * a run stopped after 3 failed attempts, a bill over RM 10,000 waiting for the buyer's details, or (in
 * production only) e-invoicing not set up. Silent when all is well, when the viewer lacks access_settings,
 * and for any read that fails (e.g. before the W5 migration).
 */
export function EinvoiceProblemBanner() {
  const { can } = useCan()
  const { pathname } = useLocation()
  const allowed = can('access_settings')
  const [messages, setMessages] = useState<string[]>([])

  useEffect(() => {
    if (!allowed) return
    let live = true
    const quiet = <T,>(p: Promise<T>, empty: T) => p.catch(() => empty)
    void Promise.all([
      quiet(fetchDocuments(), []), quiet(fetchStoppedAttempts(), []), quiet(fetchLargeBills(), []), quiet(fetchJobRuns(1), []),
    ]).then(([docs, stopped, largeBills, runs]) => {
      if (live) setMessages(bannerMessages({ docs, stopped, largeBills, lastRun: runs[0] ?? null }))
    })
    return () => { live = false }
  }, [allowed])

  if (!allowed || messages.length === 0 || pathname.startsWith('/pos/einvoice')) return null
  return (
    <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
      {messages.join(' ')}{' '}
      <Link to="/pos/einvoice" className="font-semibold underline">Open E-invoice</Link>
    </div>
  )
}
