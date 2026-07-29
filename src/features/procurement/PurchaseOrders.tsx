import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money } from '../../shared/lib/procurement'
import type { PurchaseOrder, PoStatus } from '../../shared/types'
import { PO_STATUS_LABELS, PO_STATUS_COLORS } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

const FILTERS: { key: PoStatus | 'all'; label: string }[] = [
  { key: 'all',                label: 'All' },
  { key: 'draft',              label: 'Draft' },
  { key: 'sent',               label: 'Sent' },
  { key: 'partially_received', label: 'Partial' },
  { key: 'received',           label: 'Received' },
  { key: 'cancelled',          label: 'Cancelled' },
]

export function PoStatusBadge({ status }: { status: PoStatus }) {
  const color = PO_STATUS_COLORS[status]
  return (
    <span
      className="text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}20`, color }}
    >
      {PO_STATUS_LABELS[status]}
    </span>
  )
}

export default function PurchaseOrdersPage() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<PoStatus | 'all'>('all')
  const [search, setSearch] = useState('')

  async function load() {
    const { data } = await supabase
      .from('purchase_orders')
      .select('*, supplier:suppliers(id,name), branch:branches(id,name)')
      .order('created_at', { ascending: false })
    setOrders((data as PurchaseOrder[]) ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const term = search.trim().toLowerCase()
  const visible = orders
    .filter(o => filter === 'all' || o.status === filter)
    .filter(o => !term
      || o.po_number.toLowerCase().includes(term)
      || (o.supplier?.name ?? '').toLowerCase().includes(term))

  const counts = orders.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-6xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-brown-dark">Purchase Orders</h1>
            <p className="text-sm text-brown-faint mt-0.5">采购单 · Orders raised with suppliers.</p>
          </div>
          <Link
            to="/procurement/orders/new"
            className="px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors"
          >
            + New Purchase Order
          </Link>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-1.5 flex-wrap">
            {FILTERS.map(f => {
              const active = filter === f.key
              const count = f.key === 'all' ? orders.length : (counts[f.key] ?? 0)
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-[#8B6344] text-white'
                      : 'border border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0]'
                  }`}
                >
                  {f.label} {count > 0 && <span className={active ? 'opacity-80' : 'text-brown-faint'}>({count})</span>}
                </button>
              )
            })}
          </div>
          <input
            className={`${inputCls} max-w-[220px]`}
            placeholder="Search PO no. or supplier…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <p className="text-sm text-brown-faint py-8 text-center">Loading…</p>
        ) : visible.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-10 text-center">
            <p className="text-sm text-brown-muted">
              {orders.length === 0 ? 'No purchase orders yet.' : 'No orders match those filters.'}
            </p>
            {orders.length === 0 && (
              <p className="text-xs text-brown-faint mt-1">Raise one to start tracking what you've ordered.</p>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
            <table className="w-full text-sm min-w-[680px]">
              <thead>
                <tr className="text-left text-xs text-brown-faint border-b border-[#EDE5D8]">
                  <th className="px-4 py-3 font-semibold">PO Number</th>
                  <th className="px-4 py-3 font-semibold">Supplier</th>
                  <th className="px-4 py-3 font-semibold">Branch</th>
                  <th className="px-4 py-3 font-semibold text-right">Amount</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E8DC]">
                {visible.map(o => (
                  <tr key={o.id} className="hover:bg-[#FBF6EE] transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        to={`/procurement/orders/${o.id}`}
                        className="font-medium text-brown-dark hover:text-[#C4813A] transition-colors whitespace-nowrap"
                      >
                        {o.po_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-brown-muted">{o.supplier?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-brown-muted">{o.branch?.name ?? '—'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-brown-dark">{money(o.total_amount)}</td>
                    <td className="px-4 py-3"><PoStatusBadge status={o.status} /></td>
                    <td className="px-4 py-3 text-xs text-brown-muted whitespace-nowrap">
                      {new Date(o.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
