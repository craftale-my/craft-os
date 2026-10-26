import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money, isReceivable } from '../../shared/lib/procurement'
import { PoStatusBadge } from './PurchaseOrders'
import { OverDeliveredBadge } from './badges'
import type { PurchaseOrder, Receiving } from '../../shared/types'

type ListedPo = PurchaseOrder & { receivings?: Pick<Receiving, 'has_over_delivery'>[] | null }

function hasOverDelivery(o: ListedPo): boolean {
  return (o.receivings ?? []).some(r => r.has_over_delivery)
}

export default function ReceivingListPage() {
  const [pending, setPending] = useState<ListedPo[]>([])
  const [recent, setRecent] = useState<ListedPo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('purchase_orders')
        .select('*, supplier:suppliers(id,name), branch:branches(id,name), receivings(has_over_delivery)')
        .in('status', ['sent', 'received', 'partially_received', 'closed_short'])
        .order('created_at', { ascending: false })
      const all = (data as ListedPo[]) ?? []
      setPending(all.filter(o => isReceivable(o.status)))
      // Finished orders: fully received, or closed short (never receivable again).
      setRecent(all.filter(o => o.status === 'received' || o.status === 'closed_short').slice(0, 10))
      setLoading(false)
    }
    load()
  }, [])

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-4xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Receiving</h1>
          <p className="text-sm text-brown-faint mt-0.5">Check deliveries in against their order.</p>
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
                  {pending.map(o => {
                    const partial = o.status === 'partially_received'
                    return (
                      <div key={o.id} className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex items-center gap-3 flex-wrap">
                        <div className="flex-1 min-w-[180px]">
                          <p className="text-sm font-semibold text-brown-dark flex items-center gap-2 flex-wrap">
                            {o.po_number}
                            {partial && (
                              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#C4813A20] text-[#C4813A]">
                                Partially received
                              </span>
                            )}
                            {hasOverDelivery(o) && <OverDeliveredBadge />}
                          </p>
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
                          {partial ? 'Receive remaining' : 'Receive'}
                        </Link>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            {recent.length > 0 && (
              <section>
                <h2 className="text-sm font-bold text-brown-dark mb-3">Recently Completed</h2>
                <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
                  {recent.map(o => (
                    <div key={o.id} className="flex items-center gap-3 px-4 py-3 flex-wrap">
                      <div className="flex-1 min-w-[180px]">
                        <p className="flex items-center gap-2 flex-wrap">
                          <Link
                            to={`/procurement/orders/${o.id}`}
                            className="text-sm font-medium text-brown-dark hover:text-[#C4813A] transition-colors"
                          >
                            {o.po_number}
                          </Link>
                          {hasOverDelivery(o) && <OverDeliveredBadge />}
                        </p>
                        <p className="text-xs text-brown-faint">
                          {o.supplier?.name ?? '—'} · {o.branch?.name ?? '—'}
                        </p>
                      </div>
                      {o.status === 'closed_short'
                        ? <PoStatusBadge status={o.status} />
                        : <span className="text-xs font-semibold text-[#3D7A50]">✓ Complete</span>}
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
