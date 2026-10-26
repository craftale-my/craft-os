import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import { qty, money, buildStockRows, formatUnitCost } from '../../shared/lib/procurement'
import type { StockDepartmentFilter } from '../../shared/lib/procurement'
import type { Item, Branch, InventoryValuation } from '../../shared/types'
import { ITEM_DEPARTMENTS, ITEM_DEPARTMENT_LABELS } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const selectCls = inputCls.replace('w-full ', 'w-auto ')

function pillCls(active: boolean) {
  return `px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap border transition-colors ${
    active
      ? 'bg-[#C4813A] border-[#C4813A] text-white'
      : 'bg-white border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0]'
  }`
}

const COLUMNS = ['Item', 'Department', 'On Hand', 'Min Alert', 'Latest Price', 'Avg Cost', 'Stock Value', 'Status']
const RIGHT_ALIGNED = new Set(['On Hand', 'Min Alert', 'Latest Price', 'Avg Cost', 'Stock Value'])

export default function InventoryPage() {
  const { staff } = useAuth()
  const { can } = useCan()
  const allBranches = can('all_branches')

  const [items, setItems] = useState<Item[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [balances, setBalances] = useState<InventoryValuation[]>([])
  const [branchFilter, setBranchFilter] = useState<string>('all')
  const [department, setDepartment] = useState<StockDepartmentFilter>('all')
  const [search, setSearch] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      const [itemRes, branchRes, balRes] = await Promise.all([
        supabase.from('items').select('*').eq('status', 'active').order('name'),
        supabase.from('branches').select('*').eq('is_active', true).order('name'),
        supabase.from('inventory_valuation').select('*'),
      ])
      const err = itemRes.error ?? branchRes.error ?? balRes.error
      if (err) setError(err.message)
      setItems((itemRes.data as Item[]) ?? [])
      setBranches((branchRes.data as Branch[]) ?? [])
      setBalances((balRes.data as InventoryValuation[]) ?? [])
      setLoading(false)
    }
    load()
  }, [])

  // Supervisors are locked to their own branch; RLS only returns their rows anyway.
  const branchId = allBranches ? branchFilter : (staff?.branch_id ?? 'all')
  const branchOptions = allBranches ? branches : branches.filter(b => b.id === staff?.branch_id)

  const hasUnassigned = items.some(i => i.department == null)
  const departmentOptions: { value: StockDepartmentFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    ...ITEM_DEPARTMENTS.map(d => ({ value: d, label: ITEM_DEPARTMENT_LABELS[d] })),
    ...(hasUnassigned ? [{ value: 'unassigned' as const, label: 'Unassigned' }] : []),
  ]

  const rows = useMemo(() => {
    const all = buildStockRows({ items, balances, branchId, department, search })
    return lowOnly ? all.filter(r => r.low) : all
  }, [items, balances, branchId, department, search, lowOnly])

  const lowCount = rows.filter(r => r.low).length
  const totalValue = rows.reduce((sum, r) => sum + (r.value ?? 0), 0)

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-6xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Stock on Hand</h1>
          <p className="text-sm text-brown-faint mt-0.5">What's on hand at each branch, by department.</p>
        </div>

        {error && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm font-semibold text-[#9E4A30]">Couldn't load stock.</p>
            <p className="text-xs text-[#9E4A30] mt-0.5">{error}</p>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <select
              className={selectCls}
              value={branchId}
              onChange={e => setBranchFilter(e.target.value)}
              disabled={!allBranches}
              aria-label="Branch"
            >
              {(allBranches || branchId === 'all') && <option value="all">All branches</option>}
              {branchOptions.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
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

          <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Department">
            {departmentOptions.map(o => (
              <button
                key={o.value}
                type="button"
                onClick={() => setDepartment(o.value)}
                className={pillCls(department === o.value)}
                aria-pressed={department === o.value}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]" aria-busy="true">
            <p className="sr-only">Loading stock…</p>
            {[0, 1, 2, 3, 4].map(i => (
              <div key={i} className="px-4 py-4 flex items-center gap-4 animate-pulse">
                <div className="h-3 rounded bg-[#EDE5D8] w-1/3" />
                <div className="h-3 rounded bg-[#EDE5D8] w-1/6 ml-auto" />
                <div className="h-3 rounded bg-[#EDE5D8] w-1/6" />
              </div>
            ))}
          </div>
        ) : error ? null : items.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-10 text-center">
            <p className="text-sm text-brown-muted">No items yet. Add items under Procurement → Items.</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-10 text-center">
            <p className="text-sm text-brown-muted">No items match these filters.</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-brown-muted">
              {rows.length} item{rows.length === 1 ? '' : 's'}
              {' · '}
              <span className={lowCount > 0 ? 'text-[#9E4A30] font-semibold' : ''}>{lowCount} low</span>
              {' · '}
              Total value <span className="font-semibold text-brown-dark">{money(totalValue)}</span>
            </p>
            <p className="text-xs text-brown-faint -mt-4">
              Stock value uses the cost stamped on each receipt (moving average).
            </p>

            <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
              <table className="w-full text-sm min-w-[860px]">
                <thead>
                  <tr className="text-left text-xs text-brown-faint border-b border-[#EDE5D8]">
                    {COLUMNS.map(c => (
                      <th key={c} className={`px-4 py-3 font-semibold ${RIGHT_ALIGNED.has(c) ? 'text-right' : ''}`}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0E8DC]">
                  {rows.map(({ item, balance, low, value, avgCost }) => (
                    <tr key={item.id} className={low ? 'bg-[#FCF0EC]' : ''}>
                      <td className="px-4 py-3">
                        <Link
                          to={`/procurement/inventory/${item.id}${branchId !== 'all' ? `?branch=${branchId}` : ''}`}
                          className="font-medium text-brown-dark hover:text-[#C4813A] transition-colors"
                        >
                          {item.name}
                        </Link>
                        {item.name_zh && <p className="text-xs text-brown-faint">{item.name_zh}</p>}
                      </td>
                      <td className="px-4 py-3 text-xs text-brown-muted whitespace-nowrap">
                        {item.department ? ITEM_DEPARTMENT_LABELS[item.department] : '—'}
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
                        {item.latest_price != null
                          ? `${money(Number(item.latest_price))} / ${item.purchase_unit}`
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-xs text-brown-muted">
                        {formatUnitCost(avgCost, item.base_unit)}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-xs text-brown-muted">
                        {value != null ? money(value) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {low ? (
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-[#9E4A3020] text-[#9E4A30]">
                            Low
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
          </>
        )}
      </div>
    </div>
  )
}
