import { useState, useEffect } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { qty, money, isBelowAlert } from '../../shared/lib/procurement'
import type { Item, Branch, InventoryTransaction, InventoryBalance } from '../../shared/types'
import { TRANSACTION_TYPE_LABELS } from '../../shared/types'

export default function InventoryDetailPage() {
  const { itemId } = useParams<{ itemId: string }>()
  const [params] = useSearchParams()
  const branchParam = params.get('branch')

  const [item, setItem] = useState<Item | null>(null)
  const [branches, setBranches] = useState<Branch[]>([])
  const [balances, setBalances] = useState<InventoryBalance[]>([])
  const [txns, setTxns] = useState<InventoryTransaction[]>([])
  const [branchFilter, setBranchFilter] = useState<string>(branchParam ?? 'all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!itemId) return
    let cancelled = false

    async function load() {
      const [itemRes, branchRes, balRes, txnRes] = await Promise.all([
        supabase.from('items').select('*').eq('id', itemId).maybeSingle(),
        supabase.from('branches').select('*').eq('is_active', true).order('name'),
        supabase.from('inventory_balances').select('*').eq('item_id', itemId),
        supabase
          .from('inventory_transactions')
          .select('*, creator:staff!inventory_transactions_created_by_fkey(id,name)')
          .eq('item_id', itemId)
          .order('created_at', { ascending: false })
          .limit(100),
      ])
      if (cancelled) return
      setItem(itemRes.data as Item | null)
      setBranches((branchRes.data as Branch[]) ?? [])
      setBalances((balRes.data as InventoryBalance[]) ?? [])
      setTxns((txnRes.data as InventoryTransaction[]) ?? [])
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [itemId])

  if (loading) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  if (!item) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8">
        <div className="max-w-3xl mx-auto text-center py-16">
          <p className="text-sm text-brown-muted">Item not found.</p>
          <Link to="/procurement/inventory" className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block">
            ← Back to Inventory
          </Link>
        </div>
      </div>
    )
  }

  const branchName = (id: string) => branches.find(b => b.id === id)?.name ?? 'Unknown branch'
  const visibleTxns = branchFilter === 'all' ? txns : txns.filter(t => t.branch_id === branchFilter)
  const shownBalance = branchFilter === 'all'
    ? balances.reduce((s, b) => s + Number(b.balance), 0)
    : Number(balances.find(b => b.branch_id === branchFilter)?.balance ?? 0)
  const low = isBelowAlert(shownBalance, item.min_stock_alert)

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/inventory" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Inventory
          </Link>
          <h1 className="text-2xl font-bold text-brown-dark mt-1">{item.name}</h1>
          {item.name_zh && <p className="text-sm text-brown-muted">{item.name_zh}</p>}
        </div>

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs text-brown-faint mb-1">
                {branchFilter === 'all' ? 'All branches' : branchName(branchFilter)}
              </p>
              <div className="flex items-baseline gap-2">
                <span className={`text-3xl font-bold ${low ? 'text-[#9E4A30]' : 'text-brown-dark'}`}>
                  {qty(shownBalance)}
                </span>
                <span className="text-sm text-brown-muted">{item.base_unit}</span>
              </div>
              {low && (
                <p className="text-xs text-[#9E4A30] font-semibold mt-1">
                  ⚠ At or below the {qty(item.min_stock_alert)} {item.base_unit} alert level
                </p>
              )}
            </div>
            <select
              className="px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
              value={branchFilter}
              onChange={e => setBranchFilter(e.target.value)}
            >
              <option value="all">All branches</option>
              {balances.map(b => (
                <option key={b.branch_id} value={b.branch_id}>{branchName(b.branch_id)}</option>
              ))}
            </select>
          </div>
        </section>

        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
          <h2 className="text-sm font-bold text-brown-dark mb-3">Stock Movements</h2>
          {visibleTxns.length === 0 ? (
            <p className="text-xs text-brown-faint text-center py-6">
              No movements recorded{branchFilter !== 'all' ? ' for this branch' : ''} yet.
            </p>
          ) : (
            <div className="divide-y divide-[#F0E8DC] border-t border-[#EDE5D8]">
              {visibleTxns.map(t => (
                <div key={t.id} className="flex items-center gap-3 py-3 flex-wrap">
                  <div className="flex-1 min-w-[160px]">
                    <p className="text-sm font-medium text-brown-dark">
                      {TRANSACTION_TYPE_LABELS[t.transaction_type]}
                      {t.reference_type && (
                        <span className="text-xs text-brown-faint font-normal ml-2">
                          from {t.reference_type}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-brown-faint">
                      {new Date(t.created_at).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                      })}
                      {' · '}{branchName(t.branch_id)}
                      {t.creator?.name && ` · ${t.creator.name}`}
                    </p>
                    {t.notes && <p className="text-xs text-brown-muted italic mt-0.5">{t.notes}</p>}
                  </div>
                  <span className={`text-sm font-bold whitespace-nowrap ${
                    Number(t.quantity) >= 0 ? 'text-[#3D7A50]' : 'text-[#9E4A30]'
                  }`}>
                    {Number(t.quantity) >= 0 ? '+' : ''}{qty(Number(t.quantity))} {item.base_unit}
                  </span>
                </div>
              ))}
            </div>
          )}
          {item.latest_price != null && item.conversion_rate > 0 && (
            <p className="text-xs text-brown-faint mt-3 pt-3 border-t border-[#EDE5D8]">
              Valued at {money((item.latest_price / item.conversion_rate) * shownBalance)} using the latest price
              ({money(item.latest_price)} / {item.purchase_unit}).
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
