import { useState, useEffect, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useCan } from '../../shared/lib/permissions'
import {
  money, qty, formatUnitCost, formatDateTimeMYT, businessDateMYT, currentRecipe, recipeVersionStatus, recipeCost,
  estimatedUnitCost,
} from '../../shared/lib/procurement'
import { useBranchPicker } from './useBranchPicker'
import { RecipeStatusBadge, SemiFinishedBadge } from './badges'
import type { Item, Recipe, ProductionBatch, InventoryValuation } from '../../shared/types'
import { ITEM_DEPARTMENT_LABELS } from '../../shared/types'

const selectCls =
  'w-auto px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

export default function RecipeDetailPage() {
  const { itemId } = useParams<{ itemId: string }>()
  const { can } = useCan()
  const canManage = can('manage_procurement')
  const { branches, branchId, setBranchId, allBranches, branchName } = useBranchPicker()

  const [item, setItem] = useState<Item | null>(null)
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [batches, setBatches] = useState<ProductionBatch[]>([])
  const [stock, setStock] = useState<InventoryValuation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!itemId) return
    let cancelled = false
    async function load() {
      const [itemRes, recipeRes, batchRes] = await Promise.all([
        supabase.from('items').select('*').eq('id', itemId).maybeSingle(),
        supabase
          .from('recipes')
          .select('*, verifier:staff!recipes_verified_by_fkey(id,name), lines:recipe_lines(*, item:items(id,name,base_unit,latest_price,conversion_rate))')
          .eq('item_id', itemId)
          .order('version', { ascending: false }),
        supabase
          .from('production_batches')
          .select('*, creator:staff!production_batches_created_by_fkey(id,name), recipe:recipes(id,version), lines:production_batch_lines(*, item:items(id,name,base_unit))')
          .eq('item_id', itemId)
          .order('created_at', { ascending: false })
          .limit(50),
      ])
      if (cancelled) return
      const err = itemRes.error ?? recipeRes.error ?? batchRes.error
      if (err) setError(err.message)
      setItem(itemRes.data as Item | null)
      setRecipes((recipeRes.data as Recipe[]) ?? [])
      setBatches((batchRes.data as ProductionBatch[]) ?? [])
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [itemId])

  useEffect(() => {
    if (!branchId) { setStock([]); return }
    let cancelled = false
    supabase.from('inventory_valuation').select('*').eq('branch_id', branchId).then(({ data, error: err }) => {
      if (cancelled) return
      if (err) setError(err.message)
      setStock((data as InventoryValuation[]) ?? [])
    })
    return () => { cancelled = true }
  }, [branchId])

  const today = businessDateMYT(new Date())
  const statuses = useMemo(() => recipeVersionStatus(recipes, today), [recipes, today])
  const current = useMemo(() => currentRecipe(recipes, today), [recipes, today])
  // Default to the version in effect, else the newest.
  const shown = recipes.find(r => r.id === selectedId) ?? current ?? recipes[0] ?? null

  const avgCostOf = useMemo(
    () => new Map(stock.map(s => [s.item_id, s.avg_unit_cost == null ? null : Number(s.avg_unit_cost)])),
    [stock],
  )
  const onHand = Number(stock.find(s => s.item_id === itemId)?.balance ?? 0)

  const shownLines = useMemo(() => [...(shown?.lines ?? [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(l => ({
      ...l,
      unitCost: estimatedUnitCost(avgCostOf.get(l.item_id), l.item?.latest_price, l.item?.conversion_rate),
    })), [shown, avgCostOf])
  const cost = recipeCost(shownLines.map(l => ({ qty_base: Number(l.qty_base), unit_cost: l.unitCost })), Number(shown?.yield_qty ?? 0))

  if (loading) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  if (!item) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8">
        <div className="max-w-3xl mx-auto text-center py-16">
          <p className="text-sm text-brown-muted">{error || 'Item not found.'}</p>
          <Link to="/procurement/recipes" className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block">
            ← Back to Recipes
          </Link>
        </div>
      </div>
    )
  }

  const unit = item.base_unit
  const produceLink = `/procurement/recipes/${item.id}/produce${allBranches && branchId ? `?branch=${branchId}` : ''}`

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-4xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link to="/procurement/recipes" className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors">
            ← Recipes
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap mt-1">
            <div>
              <h1 className="text-2xl font-bold text-brown-dark flex items-center gap-2 flex-wrap">
                {item.name}
                {item.category === 'semi_finished' && <SemiFinishedBadge />}
                {current && <RecipeStatusBadge status="current" />}
              </h1>
              <p className="text-sm text-brown-faint mt-0.5">
                {current ? `v${current.version} in effect since ${current.effective_from}` : 'No version in effect today'}
                {item.department && ` · ${ITEM_DEPARTMENT_LABELS[item.department]}`}
                {' · '}
                <Link to={`/procurement/inventory/${item.id}`} className="text-[#C4813A] hover:underline">
                  {qty(onHand)} {unit} on hand
                </Link>
              </p>
            </div>
            <div className="flex gap-2">
              {canManage && (
                <Link
                  to={`/procurement/recipes/new?item=${item.id}`}
                  className="px-4 py-2 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-semibold hover:bg-[#F5EDE0] transition-colors"
                >
                  New version
                </Link>
              )}
              {current && (
                <Link
                  to={produceLink}
                  className="px-4 py-2 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#326642] transition-colors"
                >
                  Produce batch
                </Link>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm font-semibold text-[#9E4A30]">Couldn't load everything.</p>
            <p className="text-xs text-[#9E4A30] mt-0.5">{error}</p>
          </div>
        )}

        {/* Selected version's lines and cost */}
        {shown ? (
          <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-sm font-bold text-brown-dark flex items-center gap-2">
                  Version {shown.version}
                  {statuses.get(shown.id) && <RecipeStatusBadge status={statuses.get(shown.id)!} />}
                </h2>
                <p className="text-xs text-brown-faint">
                  Yield {qty(Number(shown.yield_qty))} {unit} per batch · from {shown.effective_from}
                </p>
              </div>
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
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-left text-xs text-brown-faint border-b border-[#EDE5D8]">
                    <th className="py-2 pr-3 font-semibold">Ingredient</th>
                    <th className="py-2 px-3 font-semibold text-right">Qty</th>
                    <th className="py-2 px-3 font-semibold text-right">Est. Unit Cost</th>
                    <th className="py-2 pl-3 font-semibold text-right">Est. Line Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0E8DC]">
                  {shownLines.map(l => (
                    <tr key={l.id}>
                      <td className="py-2 pr-3 text-brown-dark">{l.item?.name ?? 'Unknown item'}</td>
                      <td className="py-2 px-3 text-right whitespace-nowrap text-brown-dark">
                        {qty(Number(l.qty_base))} {l.item?.base_unit ?? ''}
                      </td>
                      <td className="py-2 px-3 text-right whitespace-nowrap text-xs text-brown-muted">
                        {formatUnitCost(l.unitCost, l.item?.base_unit ?? '')}
                      </td>
                      <td className="py-2 pl-3 text-right whitespace-nowrap text-brown-dark">
                        {l.unitCost != null ? money(Number(l.qty_base) * l.unitCost) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-xl bg-[#FBF6EE] border border-[#EDE5D8] px-4 py-3 text-sm space-y-0.5">
              <p className="text-brown-dark">
                Batch cost <span className="font-bold">{money(cost.total)}</span>
                <span className="text-xs text-brown-faint"> at {branchId ? branchName(branchId) : '—'}</span>
              </p>
              {cost.unitCost != null && (
                <p className="text-xs text-brown-muted">
                  {money(cost.total)} / {qty(Number(shown.yield_qty))} {unit} = RM {cost.unitCost.toFixed(4)} per {unit}
                </p>
              )}
              {cost.missingCost && (
                <p className="text-xs text-[#B46309]">Some ingredients have no cost yet — the estimate is low.</p>
              )}
              <p className="text-[11px] text-brown-faint">
                Estimated from the branch's average cost (catalogue price where it holds none). A run books the
                actual average cost at that moment.
              </p>
            </div>
            {shown.notes && <p className="text-xs text-brown-muted italic">{shown.notes}</p>}
          </section>
        ) : (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-10 text-center">
            <p className="text-sm text-brown-muted">This item has no recipe yet.</p>
            {canManage && (
              <Link to={`/procurement/recipes/new?item=${item.id}`} className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block">
                Create the first version
              </Link>
            )}
          </div>
        )}

        {/* Versions */}
        {recipes.length > 0 && (
          <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
            <h2 className="text-sm font-bold text-brown-dark mb-3">Versions</h2>
            <div className="divide-y divide-[#F0E8DC] border-t border-[#EDE5D8]">
              {recipes.map(r => {
                const status = statuses.get(r.id)
                const isShown = r.id === shown?.id
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    aria-pressed={isShown}
                    className={`w-full flex items-center gap-3 py-3 px-2 text-left flex-wrap transition-colors ${
                      isShown ? 'bg-[#C4813A1A]' : 'hover:bg-[#FBF6EE]'
                    }`}
                  >
                    <span className={`text-sm ${isShown ? 'font-bold text-[#A86C2C]' : 'font-semibold text-brown-dark'}`}>
                      v{r.version}
                    </span>
                    {status && <RecipeStatusBadge status={status} />}
                    <span className="text-xs text-brown-muted">
                      from {r.effective_from} · yield {qty(Number(r.yield_qty))} {unit}
                    </span>
                    <span className="text-xs text-brown-faint ml-auto">
                      {r.verified_at
                        ? `Verified${r.verifier?.name ? ` by ${r.verifier.name}` : ''} ${formatDateTimeMYT(r.verified_at)}`
                        : 'Not verified'}
                      {' · created '}{formatDateTimeMYT(r.created_at)}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {/* Production history */}
        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5">
          <h2 className="text-sm font-bold text-brown-dark mb-3">Production history</h2>
          {batches.length === 0 ? (
            <p className="text-xs text-brown-faint text-center py-6">No batches produced yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead>
                  <tr className="text-left text-xs text-brown-faint border-b border-[#EDE5D8]">
                    <th className="py-2 pr-3 font-semibold">When</th>
                    <th className="py-2 px-3 font-semibold">Branch</th>
                    <th className="py-2 px-3 font-semibold text-right">Batches</th>
                    <th className="py-2 px-3 font-semibold text-right">Output</th>
                    <th className="py-2 px-3 font-semibold text-right">Total Cost</th>
                    <th className="py-2 px-3 font-semibold text-right">Unit Cost</th>
                    <th className="py-2 pl-3 font-semibold">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0E8DC]">
                  {batches.flatMap(b => {
                    const open = expandedBatch === b.id
                    const rows = [
                      <tr
                        key={b.id}
                        onClick={() => setExpandedBatch(open ? null : b.id)}
                        className={`cursor-pointer transition-colors ${open ? 'bg-[#FBF6EE]' : 'hover:bg-[#FBF6EE]'}`}
                        aria-expanded={open}
                      >
                        <td className="py-2 pr-3 whitespace-nowrap text-brown-dark">
                          <span className="text-brown-faint mr-1">{open ? '▾' : '▸'}</span>
                          {formatDateTimeMYT(b.created_at)}
                        </td>
                        <td className="py-2 px-3 text-xs text-brown-muted">{branchName(b.branch_id)}</td>
                        <td className="py-2 px-3 text-right text-brown-dark">{qty(Number(b.batches))}</td>
                        <td className="py-2 px-3 text-right whitespace-nowrap text-brown-dark">
                          {qty(Number(b.output_qty))} {unit}
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap text-brown-dark">{money(Number(b.total_cost))}</td>
                        <td className="py-2 px-3 text-right whitespace-nowrap text-xs text-brown-muted">
                          {formatUnitCost(Number(b.unit_cost), unit)}
                        </td>
                        <td className="py-2 pl-3 text-xs text-brown-muted">{b.creator?.name ?? '—'}</td>
                      </tr>,
                    ]
                    if (open) {
                      rows.push(
                        <tr key={`${b.id}-lines`} className="bg-[#FBF6EE]">
                          <td colSpan={7} className="px-6 pb-3 pt-1">
                            <p className="text-xs text-brown-faint mb-1">
                              Recipe v{b.recipe?.version ?? '?'} · business date {b.business_date}
                              {b.note && <> · <span className="italic">{b.note}</span></>}
                            </p>
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-brown-faint">
                                  <th className="py-1 pr-3 font-semibold">Ingredient</th>
                                  <th className="py-1 px-3 font-semibold text-right">Qty</th>
                                  <th className="py-1 px-3 font-semibold text-right">Unit Cost</th>
                                  <th className="py-1 pl-3 font-semibold text-right">Line Cost</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(b.lines ?? []).map(l => (
                                  <tr key={l.id}>
                                    <td className="py-1 pr-3 text-brown-dark">{l.item?.name ?? 'Unknown item'}</td>
                                    <td className="py-1 px-3 text-right whitespace-nowrap">
                                      {qty(Number(l.qty_base))} {l.item?.base_unit ?? ''}
                                    </td>
                                    <td className="py-1 px-3 text-right whitespace-nowrap text-brown-muted">
                                      {formatUnitCost(Number(l.unit_cost), l.item?.base_unit ?? '')}
                                    </td>
                                    <td className="py-1 pl-3 text-right whitespace-nowrap">{money(Number(l.line_cost))}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>,
                      )
                    }
                    return rows
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
