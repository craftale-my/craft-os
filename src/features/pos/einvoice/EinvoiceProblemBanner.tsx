import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useCan } from '../../../shared/lib/permissions'
import { openProblems } from './einvoice'
import { fetchDocuments } from './einvoiceApi'

/**
 * The owner's only e-invoice prompt: shown on every Craft OS page while LHDN has
 * rejected something nobody has re-sent. Silent when all is well, when the viewer
 * lacks access_settings, or when the e-invoice tables are not on this database yet.
 */
export function EinvoiceProblemBanner() {
  const { can } = useCan()
  const { pathname } = useLocation()
  const allowed = can('access_settings')
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!allowed) return
    let live = true
    fetchDocuments()
      .then((docs) => { if (live) setCount(openProblems(docs).length) })
      .catch(() => { /* no e-invoice tables here (e.g. before the migration) — stay quiet */ })
    return () => { live = false }
  }, [allowed])

  if (!allowed || count === 0 || pathname.startsWith('/pos/einvoice')) return null
  return (
    <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
      LHDN did not accept {count === 1 ? 'an e-invoice' : `${count} e-invoices`}.{' '}
      <Link to="/pos/einvoice" className="font-semibold underline">Open E-invoice</Link>
    </div>
  )
}
