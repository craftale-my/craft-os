import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useCan } from '../../shared/lib/permissions'
import { money, qty, formatUnitCost, businessDateMYT, currentRecipe } from '../../shared/lib/procurement'
import { useBranchPicker } from './useBranchPicker'
import type { Item, Recipe, RecipeCostEstimate, InventoryValuation } from '../../shared/types'
import { ITEM_DEPARTMENT_LABELS } from '../../shared/types'

const selectCls =
  'w-auto px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

type RecipeRow = Pick<Recipe, 'id' | 'item_id' | 'version' | 'yield_qty' | 'effective_from' | 'status' | 'verified_at'>

const COLUMNS = ['Item', 'Department', 'Version', 'Yield', 'Batch Cost', 'Unit Cost', 'On Hand', '']
const RIGHT_ALIGNED = new Set(['Yield', 'Batch Cost', 'Unit Cost', 'On Hand'])

export default function RecipesPage() {
  const navigate = useNavigate()
  const { can } = useCan()
  const canManage = can('manage_procurement')
  const { branches, branchId, setBranchId, allBranches, loaded, error: branchError, branchName, staffHasNoBranch } =
    useBranchPicker()

  const [items, setItems] = useState<Item[]>([])
  const [recipes, setRecipes] = useState<RecipeRow[]>([])
  const [estimates, setEstimates] = useState<RecipeCostEstimate[]>([])
  const [stock, setStock] = useState<InventoryValuation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      const [itemRes, recipeRes] = await Promise.all([
        supabase.from('items').select('*').eq('category', 'semi_finished').eq('status', 'active').order('name'),
        supabase.from('recipes').select('id, item_id, version, yield_qty, effective_from, status, verified_at'),
      ])
      const err = itemRes.error ?? recipeRes.error
      if (err) setError(err.message)
      setItems((itemRes.data as Item[]) ?? [])
      setRecipes((recipeRes.data as RecipeRow[]) ?? [])
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    if (!branchId) { setEstimates([]); setStock([]); return }
    let cancelled = false
    async function loadBranch() {
      const [estRes, stockRes] = await Promise.all([
        supabase.from('recipe_cost_estimate').select('*').eq('branch_id', branchId),
        supabase.from('inventory_valuation').select('*').eq('branch_id', branchId),
      ])
      if (cancelled) return
      const err = estRes.error ?? stockRes.error
      if (err) setError(err.message)
      setEstimates((estRes.data as RecipeCostEstimate[]) ?? [])
      setStock((stockRes.data as InventoryValuation[]) ?? [])
    }
    loadBranch()
    return () => { cancelled = true }
  }, [branchId])

  const today = businessDateMYT(new Date())

  const rows = useMemo(() => {
    const byItem = new Map<string, RecipeRow[]>()
    for (const r of recipes) byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), r])
    const estimateOf = new Map(estimates.map(e => [e.recipe_id, e]))
    const onHandOf = new Map(stock.map(s => [s.item_id, Number(s.balance)]))
    return items
      .filter(i => byItem.has(i.id))
      .map(item => {
        const versions = byItem.get(item.id) ?? []
        const current = currentRecipe(versions, today)
        // Nothing in effect yet: point at the earliest version still to start.
        const next = current ? null : versions
          .filter(v => v.status === 'active' && v.verified_at && v.effective_from > today)
          .sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0] ?? null
        return {
          item,
          current,
          next,
          estimate: current ? estimateOf.get(current.id) ?? null : null,
          onHand: onHandOf.get(item.id) ?? 0,
        }
      })
  }, [items, recipes, estimates, stock, today])

  const shownError = error || branchError

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-6xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-brown-dark">Recipes</h1>
            <p className="text-sm text-brown-faint mt-0.5">
              Prep batches made in-house — what goes in, and what a batch costs.
            </p>
          </div>
          {canManage && (
            <Link
              to="/procurement/recipes/new"
              className="px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors"
            >
              + New recipe
            </Link>
          )}
        </div>

        {shownError && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm font-semibold text-[#9E4A30]">Couldn't load everything.</p>
            <p className="text-xs text-[#9E4A30] mt-0.5">{shownError}</p>
          </div>
        )}

        {staffHasNoBranch && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm text-[#9E4A30] font-semibold">Your account has no branch yet</p>
            <p className="text-xs text-[#9E4A30] mt-1">
              Costs and stock are per branch. Ask a manager to set your branch in Staff Management.
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <select
            className={selectCls}
            value={branchId}
            onChange={e => setBranchId(e.target.value)}
            disabled={!allBranches}
            aria-label="Branch"
          >
            {!allBranches && <option value={branchId}>{branchId ? branchName(branchId) : '—'}</option>}
            {allBranches && branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <p className="text-xs text-brown-faint">
            Estimated at this branch's average cost (catalogue price where it holds none).
          </p>
        </div>

        {loading || !loaded ? (
          <p className="text-sm text-brown-faint py-8 text-center">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-10 text-center">
            <p className="text-sm text-brown-muted">No prep-batch recipes yet.</p>
            <p className="text-xs text-brown-faint mt-1">
              {canManage
                ? 'Create one with "+ New recipe" — e.g. frosting or a sponge base made in the kitchen.'
                : 'A manager sets up recipes for semi-finished items like frosting or sponge base.'}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="text-left text-xs text-brown-faint border-b border-[#EDE5D8]">
                  {COLUMNS.map((c, i) => (
                    <th key={i} className={`px-4 py-3 font-semibold ${RIGHT_ALIGNED.has(c) ? 'text-right' : ''}`}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0E8DC]">
                {rows.map(({ item, current, next, estimate, onHand }) => (
                  <tr
                    key={item.id}
                    onClick={() => navigate(`/procurement/recipes/${item.id}`)}
                    className="cursor-pointer hover:bg-[#FBF6EE] transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/procurement/recipes/${item.id}`}
                        onClick={e => e.stopPropagation()}
                        className="font-medium text-brown-dark hover:text-[#C4813A] transition-colors"
                      >
                        {item.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-xs text-brown-muted whitespace-nowrap">
                      {item.department ? ITEM_DEPARTMENT_LABELS[item.department] : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap">
                      {current ? (
                        <span className="text-brown-dark">
                          <span className="font-semibold">v{current.version}</span>
                          <span className="text-brown-faint"> · from {current.effective_from}</span>
                        </span>
                      ) : next ? (
                        <span className="text-[#2E6E9E]">v{next.version} starts {next.effective_from}</span>
                      ) : (
                        <span className="text-brown-faint">None in effect</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-brown-dark">
                      {current ? `${qty(Number(current.yield_qty))} ${item.base_unit}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-brown-dark">
                      {estimate?.batch_cost != null ? money(Number(estimate.batch_cost)) : '—'}
                      {estimate?.missing_cost && (
                        <p className="text-[10px] text-[#B46309]">some ingredients uncosted</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-xs text-brown-muted">
                      {formatUnitCost(estimate?.unit_cost == null ? null : Number(estimate.unit_cost), item.base_unit)}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap text-brown-dark">
                      {qty(onHand)} {item.base_unit}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {current && (
                        <Link
                          to={`/procurement/recipes/${item.id}/produce${allBranches && branchId ? `?branch=${branchId}` : ''}`}
                          onClick={e => e.stopPropagation()}
                          className="px-3 py-1.5 text-xs rounded-lg bg-[#3D7A50] text-white font-semibold hover:bg-[#326642] transition-colors"
                        >
                          Produce
                        </Link>
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
