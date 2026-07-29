import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money } from '../../shared/lib/procurement'
import type { PurchaseOrder } from '../../shared/types'

export default function ReceivingListPage() {
  const [pending, setPending] = useState<PurchaseOrder[]>([])
  const [recent, setRecent] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('purchase_orders')
        .select('*, supplier:suppliers(id,name), branch:branches(id,name)')
        .in('status', ['sent', 'received', 'partially_received'])
        .order('created_at', { ascending: false })
      const all = (data as PurchaseOrder[]) ?? []
      setPending(all.filter(o => o.status === 'sent'))
      setRecent(all.filter(o => o.status !== 'sent').slice(0, 10))
      setLoading(false)
    }
    load()
  }, [])

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-4xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Receiving</h1>
          <p className="text-sm text-brown-faint mt-0.5">收货 · Check deliveries in against their order.</p>
        </div>

        {loading ? (
          <p className="text-sm text-brown-faint py-8 text-center">Loading…</p>
        ) : (
          <>
            <section>
              <h2 className="text-sm font-bold text-brown-dark mb-3">
                Awaiting Delivery ({pending.length})
              </h2>
              {pending.length === 0 ? (
                <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-8 text-center">
                  <p className="text-sm text-brown-muted">Nothing waiting to be received.</p>
                  <p className="text-xs text-brown-faint mt-1">
                    Orders show up here once they're marked as sent.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {pending.map(o => (
                    <div key={o.id} className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex items-center gap-3 flex-wrap">
                      <div className="flex-1 min-w-[180px]">
                        <p className="text-sm font-semibold text-brown-dark">{o.po_number}</p>
                        <p className="text-xs text-brown-faint">
                          {o.supplier?.name ?? '—'} · {o.branch?.name ?? '—'} · {money(o.total_amount)}
                        </p>
                      </div>
                      <p className="text-xs text-brown-muted">
                        Sent {o.sent_at
                          ? new Date(o.sent_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
                          : '—'}
                      </p>
                      <Link
                        to={`/procurement/receiving/${o.id}`}
                        className="px-4 py-2 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors flex-shrink-0"
                      >
                        Receive
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {recent.length > 0 && (
              <section>
                <h2 className="text-sm font-bold text-brown-dark mb-3">Recently Received</h2>
                <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
                  {recent.map(o => (
                    <div key={o.id} className="flex items-center gap-3 px-4 py-3 flex-wrap">
                      <div className="flex-1 min-w-[180px]">
                        <Link
                          to={`/procurement/orders/${o.id}`}
                          className="text-sm font-medium text-brown-dark hover:text-[#C4813A] transition-colors"
                        >
                          {o.po_number}
                        </Link>
                        <p className="text-xs text-brown-faint">
                          {o.supplier?.name ?? '—'} · {o.branch?.name ?? '—'}
                        </p>
                      </div>
                      {o.status === 'partially_received' ? (
                        <span className="text-xs font-semibold text-[#C4813A]">⚠ Had shortages</span>
                      ) : (
                        <span className="text-xs font-semibold text-[#3D7A50]">✓ Complete</span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}
