import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import { qty, isBelowAlert, money } from '../../shared/lib/procurement'
import type { Item, Branch, InventoryBalance } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

interface Row {
  item: Item
  balance: number
  low: boolean
}

export default function InventoryPage() {
  const { staff } = useAuth()
  const { can } = useCan()
  const allBranches = can('all_branches')

  const [items, setItems] = useState<Item[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [balances, setBalances] = useState<InventoryBalance[]>([])
  const [branchFilter, setBranchFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const [itemRes, branchRes, balRes] = await Promise.all([
        supabase.from('items').select('*').eq('status', 'active').order('name'),
        supabase.from('branches').select('*').eq('is_active', true).order('name'),
        supabase.from('inventory_balances').select('*'),
      ])
      setItems((itemRes.data as Item[]) ?? [])
      setBranches((branchRes.data as Branch[]) ?? [])
      setBalances((balRes.data as InventoryBalance[]) ?? [])
      // Supervisors only ever see their own branch, so default the filter to it.
      if (!allBranches && staff?.branch_id) setBranchFilter(staff.branch_id)
      setLoading(false)
    }
    load()
  }, [allBranches, staff?.branch_id])

  /** Low stock first, then alphabetical — the whole point of this screen is
   *  surfacing what needs reordering. */
  const rows: Row[] = useMemo(() => {
    const relevant = branchFilter === 'all'
      ? balances
      : balances.filter(b => b.branch_id === branchFilter)

    const totals = new Map<string, number>()
    for (const b of relevant) {
      totals.set(b.item_id, (totals.get(b.item_id) ?? 0) + Number(b.balance))
    }

    const term = search.trim().toLowerCase()
    return items
      .filter(i => !term || i.name.toLowerCase().includes(term) || (i.name_zh ?? '').toLowerCase().includes(term))
      .map(item => {
        const balance = totals.get(item.id) ?? 0
        return { item, balance, low: isBelowAlert(balance, item.min_stock_alert) }
      })
      .filter(r => !lowOnly || r.low)
      .sort((a, b) => {
        if (a.low !== b.low) return a.low ? -1 : 1
        return a.item.name.localeCompare(b.item.name)
      })
  }, [items, balances, branchFilter, search, lowOnly])

  const lowCount = rows.filter(r => r.low).length

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-5xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Inventory</h1>
          <p className="text-sm text-brown-faint mt-0.5">库存总览 · What's on hand, by branch.</p>
        </div>

        {lowCount > 0 && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm font-semibold text-[#9E4A30]">
              {lowCount} item{lowCount > 1 ? 's' : ''} at or below the alert level
            </p>
            <p className="text-xs text-[#9E4A30] mt-0.5">Listed first below.</p>
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <select
            className={`${inputCls} w-auto`}
            value={branchFilter}
            onChange={e => setBranchFilter(e.target.value)}
            disabled={!allBranches}
          >
            {allBranches && <option value="all">All branches</option>}
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input
            className={`${inputCls} max-w-xs`}
            placeholder="Search item…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <label className="flex items-center gap-2 text-xs text-brown-muted cursor-pointer">
            <input
              type="checkbox"
              checked={lowOnly}
              onChange={e => setLowOnly(e.target.checked)}
              className="accent-[#C4813A]"
            />
            Low stock only
          </label>
        </div>

        {loading ? (
          <p className="text-sm text-brown-faint py-8 text-center">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-10 text-center">
            <p className="text-sm text-brown-muted">
              {items.length === 0 ? 'No active items.' : 'Nothing matches those filters.'}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
            <table className="w-full text-sm min-w-[620px]">
              <thead>
                <tr className="text-left text-xs text-brown-faint border-b border-[#EDE5D8]">
                  <th className="px-4 py-3 font-semibold">Item</th>
                  <th className="px-4 py-3 font-semibold text-right">In Stock</th>
                  <th className="px-4 py-3 font-semibold text-right">Alert Level</th>
                  <th className="px-4 py-3 font-semibold text-right">Stock Value</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E8DC]">
                {rows.map(({ item, balance, low }) => (
                  <tr key={item.id} className={low ? 'bg-[#FCF0EC]' : ''}>
                    <td className="px-4 py-3">
                      <Link
                        to={`/procurement/inventory/${item.id}${branchFilter !== 'all' ? `?branch=${branchFilter}` : ''}`}
                        className="font-medium text-brown-dark hover:text-[#C4813A] transition-colors"
                      >
                        {item.name}
                      </Link>
                      {item.name_zh && <p className="text-xs text-brown-faint">{item.name_zh}</p>}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <span className={low ? 'text-[#9E4A30] font-bold' : 'text-brown-dark font-medium'}>
                        {qty(balance)} {item.base_unit}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-xs text-brown-muted">
                      {item.min_stock_alert > 0 ? `${qty(item.min_stock_alert)} ${item.base_unit}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-xs text-brown-muted">
                      {item.latest_price != null && item.conversion_rate > 0
                        ? money((item.latest_price / item.conversion_rate) * balance)
                        : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {low ? (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[#9E4A3020] text-[#9E4A30] whitespace-nowrap">
                          ⚠ Reorder
                        </span>
                      ) : (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[#EBF5EE] text-[#3D7A50]">
                          OK
                        </span>
                      )}
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
