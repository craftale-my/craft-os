import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { PriceHistoryChart } from '../../shared/components/PriceHistoryChart'
import { money, qty, isBelowAlert, toPurchaseUnits } from '../../shared/lib/procurement'
import type { Item, ItemPriceHistory, InventoryBalance, Branch } from '../../shared/types'
import { ITEM_CATEGORY_LABELS } from '../../shared/types'

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
      <h2 className="text-sm font-bold text-brown-dark mb-3">{title}</h2>
      {children}
    </section>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-brown-faint">{label}</p>
      <p className="text-sm text-brown-dark font-medium mt-0.5">{value}</p>
    </div>
  )
}

export default function ItemDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [item, setItem] = useState<Item | null>(null)
  const [history, setHistory] = useState<ItemPriceHistory[]>([])
  const [balances, setBalances] = useState<InventoryBalance[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!id) return
    let cancelled = false

    async function load() {
      const [itemRes, histRes, balRes, branchRes] = await Promise.all([
        supabase.from('items').select('*, supplier:suppliers(id,name,phone,whatsapp)').eq('id', id).maybeSingle(),
        supabase.from('item_price_history').select('*').eq('item_id', id).order('recorded_at'),
        supabase.from('inventory_balances').select('*').eq('item_id', id),
        supabase.from('branches').select('*').eq('is_active', true).order('name'),
      ])
      if (cancelled) return
      if (!itemRes.data) { setNotFound(true); setLoading(false); return }
      setItem(itemRes.data as Item)
      setHistory((histRes.data as ItemPriceHistory[]) ?? [])
      setBalances((balRes.data as InventoryBalance[]) ?? [])
      setBranches((branchRes.data as Branch[]) ?? [])
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [id])

  if (loading) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  if (notFound || !item) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8">
        <div className="max-w-3xl mx-auto text-center py-16">
          <p className="text-sm text-brown-muted">Item not found.</p>
          <Link to="/procurement/items" className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block">
            ← Back to Items
          </Link>
        </div>
      </div>
    )
  }

  const branchName = (bid: string) => branches.find(b => b.id === bid)?.name ?? 'Unknown branch'
  const total = balances.reduce((sum, b) => sum + Number(b.balance), 0)
  const lowOverall = isBelowAlert(total, item.min_stock_alert)

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/items" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Items
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap mt-1">
            <div>
              <h1 className="text-2xl font-bold text-brown-dark">{item.name}</h1>
              {item.name_zh && <p className="text-sm text-brown-muted">{item.name_zh}</p>}
            </div>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              item.status === 'active' ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#F0E8DC] text-brown-faint'
            }`}>
              {item.status === 'active' ? 'Active' : 'Inactive'}
            </span>
          </div>
        </div>

        <Card title="Details">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Field label="Category" value={ITEM_CATEGORY_LABELS[item.category]} />
            <Field label="Supplier" value={item.supplier?.name ?? '—'} />
            <Field label="Latest Price" value={
              item.latest_price == null ? '—' : `${money(item.latest_price)} / ${item.purchase_unit}`
            } />
            <Field label="Conversion" value={`1 ${item.purchase_unit} = ${qty(item.conversion_rate)} ${item.base_unit}`} />
            <Field label="Low Stock Alert" value={
              item.min_stock_alert > 0 ? `${qty(item.min_stock_alert)} ${item.base_unit}` : 'Not set'
            } />
            <Field label="Unit Cost" value={
              item.latest_price == null
                ? '—'
                : `${money(item.latest_price / item.conversion_rate)} / ${item.base_unit}`
            } />
          </div>
        </Card>

        <Card title="Price History">
          {history.length === 0 ? (
            <p className="text-xs text-brown-faint text-center py-6">
              No prices recorded yet. Prices are captured automatically when goods are received.
            </p>
          ) : (
            <>
              <PriceHistoryChart history={history} unit={item.purchase_unit} />
              <div className="mt-4 divide-y divide-[#F0E8DC] border-t border-[#EDE5D8]">
                {[...history].reverse().slice(0, 8).map(h => (
                  <div key={h.id} className="flex items-center justify-between py-2 text-xs">
                    <span className="text-brown-muted">
                      {new Date(h.recorded_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                      <span className="text-brown-faint ml-2">
                        {h.source === 'receiving' ? 'from delivery' : 'manual'}
                      </span>
                    </span>
                    <span className="font-semibold text-brown-dark">{money(h.price)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card title="Stock by Branch">
          <div className="flex items-baseline gap-2 mb-3">
            <span className={`text-2xl font-bold ${lowOverall ? 'text-[#9E4A30]' : 'text-brown-dark'}`}>
              {qty(total)}
            </span>
            <span className="text-sm text-brown-muted">{item.base_unit} total</span>
            {item.conversion_rate > 0 && (
              <span className="text-xs text-brown-faint">
                ≈ {qty(Number(toPurchaseUnits(total, item.conversion_rate).toFixed(2)))} {item.purchase_unit}
              </span>
            )}
          </div>
          {balances.length === 0 ? (
            <p className="text-xs text-brown-faint">No stock movements yet.</p>
          ) : (
            <div className="divide-y divide-[#F0E8DC] border-t border-[#EDE5D8]">
              {balances.map(b => {
                const low = isBelowAlert(Number(b.balance), item.min_stock_alert)
                return (
                  <div key={b.branch_id} className="flex items-center justify-between py-2.5">
                    <Link
                      to={`/procurement/inventory/${item.id}?branch=${b.branch_id}`}
                      className="text-sm text-brown-dark hover:text-[#C4813A] transition-colors"
                    >
                      {branchName(b.branch_id)}
                    </Link>
                    <span className={`text-sm font-semibold ${low ? 'text-[#9E4A30]' : 'text-brown-dark'}`}>
                      {qty(Number(b.balance))} {item.base_unit}
                      {low && <span className="text-[10px] ml-2">⚠ low</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
