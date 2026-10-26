import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useCan } from '../../shared/lib/permissions'
import {
  money, qty, formatUnitCost, businessDateMYT, currentRecipe, recipeCost, estimatedUnitCost, validateRecipeDraft,
} from '../../shared/lib/procurement'
import { useBranchPicker } from './useBranchPicker'
import type {
  Item, ItemDepartment, Recipe, RecipeLine, RecipeLineInput, InventoryValuation,
} from '../../shared/types'
import { ITEM_DEPARTMENTS, ITEM_DEPARTMENT_LABELS } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

/** Base units a prep batch can be tracked in. */
const OUTPUT_BASE_UNITS = ['g', 'ml', 'pcs']

function pillCls(active: boolean) {
  return `px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap border transition-colors ${
    active
      ? 'bg-[#C4813A] border-[#C4813A] text-white'
      : 'bg-white border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0]'
  }`
}

interface DraftLine {
  key: string
  item_id: string
  qty: string
}

function blankLine(): DraftLine {
  return { key: crypto.randomUUID(), item_id: '', qty: '' }
}

type VersionRow = Pick<Recipe, 'id' | 'item_id' | 'version' | 'yield_qty' | 'effective_from' | 'status' | 'verified_at' | 'notes'>
  & { lines: Pick<RecipeLine, 'item_id' | 'qty_base' | 'sort_order'>[] }

/**
 * New recipe, or (with ?item=<id>) a new version of an existing one,
 * prefilled from the version in effect today.
 */
export default function RecipeNewPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const versionOf = params.get('item')
  const { can } = useCan()
  const canManage = can('manage_procurement')
  const { branchId, branchName, loaded: branchLoaded } = useBranchPicker()

  const [items, setItems] = useState<Item[]>([])
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [withRecipe, setWithRecipe] = useState<Set<string>>(new Set())
  const [stock, setStock] = useState<InventoryValuation[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Output item: an existing semi-finished item, or a new one created on save.
  const [mode, setMode] = useState<'existing' | 'create'>('existing')
  const [existingItemId, setExistingItemId] = useState('')
  const [newItem, setNewItem] = useState({ name: '', base_unit: 'g', department: '' as ItemDepartment | '', min_stock_alert: '0' })
  // Set once the new item is inserted, so a failed save never inserts it twice.
  const [createdItem, setCreatedItem] = useState<Item | null>(null)

  const today = businessDateMYT(new Date())
  const [yieldQty, setYieldQty] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(versionOf ? '' : today)
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([blankLine()])
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!canManage) { setLoading(false); return }
    let cancelled = false
    async function load() {
      const [itemRes, recipeRes] = await Promise.all([
        supabase.from('items').select('*').eq('status', 'active').order('name'),
        versionOf
          ? supabase
              .from('recipes')
              .select('id, item_id, version, yield_qty, effective_from, status, verified_at, notes, lines:recipe_lines(item_id, qty_base, sort_order)')
              .eq('item_id', versionOf)
          : supabase.from('recipes').select('item_id'),
      ])
      if (cancelled) return
      const err = itemRes.error ?? recipeRes.error
      if (err) setLoadError(err.message)
      setItems((itemRes.data as Item[]) ?? [])
      if (versionOf) {
        const rows = (recipeRes.data as unknown as VersionRow[]) ?? []
        setVersions(rows)
        // Prefill from the version in effect, else the newest one.
        const base = currentRecipe(rows, businessDateMYT(new Date()))
          ?? [...rows].sort((a, b) => b.version - a.version)[0]
        if (base) {
          setYieldQty(String(Number(base.yield_qty)))
          const sorted = [...base.lines].sort((a, b) => a.sort_order - b.sort_order)
          if (sorted.length > 0) {
            setLines(sorted.map(l => ({ key: crypto.randomUUID(), item_id: l.item_id, qty: String(Number(l.qty_base)) })))
          }
        }
      } else {
        setWithRecipe(new Set(((recipeRes.data as { item_id: string }[]) ?? []).map(r => r.item_id)))
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [canManage, versionOf])

  useEffect(() => {
    if (!branchId) { setStock([]); return }
    let cancelled = false
    supabase.from('inventory_valuation').select('*').eq('branch_id', branchId).then(({ data }) => {
      if (!cancelled) setStock((data as InventoryValuation[]) ?? [])
    })
    return () => { cancelled = true }
  }, [branchId])

  const itemById = useMemo(() => new Map(items.map(i => [i.id, i])), [items])
  const avgCostOf = useMemo(
    () => new Map(stock.map(s => [s.item_id, s.avg_unit_cost == null ? null : Number(s.avg_unit_cost)])),
    [stock],
  )

  const candidates = items.filter(i => i.category === 'semi_finished' && !withRecipe.has(i.id))
  const outputItem: Item | null = versionOf
    ? itemById.get(versionOf) ?? null
    : mode === 'existing' ? itemById.get(existingItemId) ?? null : createdItem
  const outputUnit = outputItem?.base_unit ?? (mode === 'create' ? newItem.base_unit : '')
  const outputName = outputItem?.name ?? (mode === 'create' ? newItem.name.trim() : '')
  // A not-yet-created item can't clash with an ingredient, so any non-empty id will do.
  const outputId = outputItem?.id ?? (mode === 'create' && !versionOf ? 'new-item' : null)

  const ingredientOptions = items.filter(i => i.id !== outputItem?.id)

  function unitCostOf(itemId: string): number | null {
    const it = itemById.get(itemId)
    if (!it) return null
    return estimatedUnitCost(avgCostOf.get(itemId), it.latest_price, it.conversion_rate)
  }

  const parsedLines = lines.map(l => ({
    item_id: l.item_id || null,
    qty_base: l.qty.trim() === '' ? NaN : Number(l.qty),
    name: itemById.get(l.item_id)?.name,
  }))
  const yieldNum = yieldQty.trim() === '' ? NaN : Number(yieldQty)
  const cost = recipeCost(
    parsedLines.filter(l => l.item_id && l.qty_base > 0).map(l => ({ qty_base: l.qty_base, unit_cost: unitCostOf(l.item_id!) })),
    yieldNum > 0 ? yieldNum : 0,
  )

  const clashDates = new Set(versions.filter(v => v.status === 'active').map(v => v.effective_from))
  const validation = (() => {
    if (!versionOf && mode === 'create' && !createdItem) {
      if (!newItem.name.trim()) return 'Name the new semi-finished item'
      if (!newItem.base_unit) return 'Pick a base unit for the new item'
      if (newItem.min_stock_alert !== '' && !(Number(newItem.min_stock_alert) >= 0)) {
        return 'Low stock alert must be zero or more'
      }
    }
    const err = validateRecipeDraft({ yieldQty: yieldNum, effectiveFrom, lines: parsedLines, outputItemId: outputId })
    if (err) return err
    if (clashDates.has(effectiveFrom)) return `A version of this recipe already starts on ${effectiveFrom}`
    return null
  })()

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)))
  }

  async function submit() {
    setAttempted(true)
    setError('')
    if (validation) return
    setSubmitting(true)

    let output = outputItem
    if (!output) {
      const { data, error: insErr } = await supabase
        .from('items')
        .insert({
          name: newItem.name.trim(),
          category: 'semi_finished',
          department: newItem.department || null,
          supplier_id: null,
          purchase_unit: newItem.base_unit,
          base_unit: newItem.base_unit,
          conversion_rate: 1,
          latest_price: null,
          min_stock_alert: newItem.min_stock_alert === '' ? 0 : Number(newItem.min_stock_alert),
          status: 'active',
        })
        .select()
        .single()
      if (insErr || !data) {
        setSubmitting(false)
        setError(insErr?.message ?? 'Could not create the item')
        return
      }
      output = data as Item
      setCreatedItem(output)
      setItems(is => [...is, output!])
    }

    const payload: RecipeLineInput[] = parsedLines.map(l => ({ item_id: l.item_id!, qty_base: l.qty_base }))
    const { error: rpcErr } = await supabase.rpc('save_recipe_version', {
      p_item_id: output.id,
      p_yield_qty: yieldNum,
      p_effective_from: effectiveFrom,
      p_lines: payload,
      p_notes: notes.trim() || null,
    })
    setSubmitting(false)
    // Verbatim; a just-created item shows as "(created)" above, so a retry reuses it.
    if (rpcErr) { setError(rpcErr.message); return }
    navigate(`/procurement/recipes/${output.id}`)
  }

  if (!canManage) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8">
        <div className="max-w-3xl mx-auto text-center py-16">
          <p className="text-sm text-brown-muted">Only managers can create or change recipes.</p>
          <p className="text-xs text-brown-faint mt-1">You can still produce batches from an existing recipe.</p>
          <Link to="/procurement/recipes" className="text-sm text-[#C4813A] font-semibold hover:underline mt-3 inline-block">
            ← Back to Recipes
          </Link>
        </div>
      </div>
    )
  }

  if (loading || !branchLoaded) {
    return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  }

  if (versionOf && !outputItem) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8">
        <div className="max-w-3xl mx-auto text-center py-16">
          <p className="text-sm text-brown-muted">Item not found or inactive.</p>
          <Link to="/procurement/recipes" className="text-sm text-[#C4813A] font-semibold hover:underline mt-2 inline-block">
            ← Back to Recipes
          </Link>
        </div>
      </div>
    )
  }

  const showValidation = attempted && validation

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-5">
        <div>
          <Link
            to={versionOf ? `/procurement/recipes/${versionOf}` : '/procurement/recipes'}
            className="text-xs text-brown-faint hover:text-[#C4813A] transition-colors"
          >
            ← {versionOf ? outputItem?.name : 'Recipes'}
          </Link>
          <h1 className="text-2xl font-bold text-brown-dark mt-1">
            {versionOf ? `New version of ${outputItem?.name}` : 'New recipe'}
          </h1>
          <p className="text-sm text-brown-faint mt-0.5">
            {versionOf
              ? 'Prefilled from the version in effect. It takes over from its effective-from date; older versions stay for history.'
              : 'A prep batch made in-house from other items, e.g. frosting or a sponge base.'}
          </p>
        </div>

        {loadError && (
          <div className="bg-[#FCF0EC] border border-[#C0624A40] rounded-xl px-4 py-3">
            <p className="text-sm font-semibold text-[#9E4A30]">Couldn't load everything.</p>
            <p className="text-xs text-[#9E4A30] mt-0.5">{loadError}</p>
          </div>
        )}

        {/* Output item */}
        {!versionOf && (
          <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-sm font-bold text-brown-dark">What it makes</h2>
              {!createdItem && (
                <div className="flex gap-2" role="group" aria-label="Output item">
                  <button type="button" className={pillCls(mode === 'existing')} onClick={() => setMode('existing')}>
                    Existing item
                  </button>
                  <button type="button" className={pillCls(mode === 'create')} onClick={() => setMode('create')}>
                    New item
                  </button>
                </div>
              )}
            </div>

            {createdItem ? (
              <p className="text-sm text-brown-dark">
                <span className="font-semibold">{createdItem.name}</span>
                <span className="text-brown-faint"> · tracked in {createdItem.base_unit} (created)</span>
              </p>
            ) : mode === 'existing' ? (
              <div>
                <label htmlFor="recipe-output" className={labelCls}>Semi-finished item</label>
                <select
                  id="recipe-output"
                  className={inputCls}
                  value={existingItemId}
                  onChange={e => setExistingItemId(e.target.value)}
                >
                  <option value="">Pick an item…</option>
                  {candidates.map(i => <option key={i.id} value={i.id}>{i.name} ({i.base_unit})</option>)}
                </select>
                {candidates.length === 0 && (
                  <p className="text-xs text-brown-faint mt-1">
                    Every semi-finished item already has a recipe — create a new item instead.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label htmlFor="new-item-name" className={labelCls}>Name *</label>
                  <input
                    id="new-item-name"
                    className={inputCls}
                    value={newItem.name}
                    onChange={e => setNewItem(f => ({ ...f, name: e.target.value }))}
                    placeholder="Cream Cheese Frosting"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label htmlFor="new-item-unit" className={labelCls}>Base unit *</label>
                    <select
                      id="new-item-unit"
                      className={inputCls}
                      value={newItem.base_unit}
                      onChange={e => setNewItem(f => ({ ...f, base_unit: e.target.value }))}
                    >
                      {OUTPUT_BASE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="new-item-dept" className={labelCls}>Department</label>
                    <select
                      id="new-item-dept"
                      className={inputCls}
                      value={newItem.department}
                      onChange={e => setNewItem(f => ({ ...f, department: e.target.value as ItemDepartment | '' }))}
                    >
                      <option value="">Unassigned</option>
                      {ITEM_DEPARTMENTS.map(d => <option key={d} value={d}>{ITEM_DEPARTMENT_LABELS[d]}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="new-item-alert" className={labelCls}>Low stock alert ({newItem.base_unit})</label>
                    <input
                      id="new-item-alert"
                      type="number" step="any" min="0"
                      className={inputCls}
                      value={newItem.min_stock_alert}
                      onChange={e => setNewItem(f => ({ ...f, min_stock_alert: e.target.value }))}
                    />
                  </div>
                </div>
                <p className="text-xs text-brown-faint">
                  Created as a Semi-finished item when you save the recipe.
                </p>
              </div>
            )}
          </section>
        )}

        {/* Recipe */}
        <section className="bg-white rounded-xl border border-[#E8DDD0] p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="recipe-yield" className={labelCls}>Yield per batch *</label>
              <div className="flex items-center gap-2">
                <input
                  id="recipe-yield"
                  type="number" step="any" min="0" inputMode="decimal"
                  className={inputCls}
                  value={yieldQty}
                  onChange={e => setYieldQty(e.target.value)}
                  placeholder="1000"
                />
                <span className="text-sm text-brown-muted">{outputUnit}</span>
              </div>
            </div>
            <div>
              <label htmlFor="recipe-from" className={labelCls}>Effective from *</label>
              <input
                id="recipe-from"
                type="date"
                className={inputCls}
                value={effectiveFrom}
                onChange={e => setEffectiveFrom(e.target.value)}
              />
              {versionOf && clashDates.size > 0 && (
                <p className="text-xs text-brown-faint mt-1">
                  Taken: {[...clashDates].sort().join(', ')}. Today's business date is {today}.
                </p>
              )}
            </div>
          </div>

          <div>
            <label htmlFor="recipe-notes" className={labelCls}>Notes (optional)</label>
            <textarea
              id="recipe-notes"
              rows={2}
              className={`${inputCls} resize-none`}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Beat butter first; chill 30 min before use"
            />
          </div>

          <div>
            <p className={labelCls}>Ingredients (per batch, in each ingredient's base unit)</p>
            <div className="space-y-2">
              {lines.map((l, idx) => {
                const ing = itemById.get(l.item_id)
                const unitCost = l.item_id ? unitCostOf(l.item_id) : null
                const q = Number(l.qty)
                return (
                  <div key={l.key} className="flex items-center gap-2 flex-wrap rounded-lg border border-[#EDE5D8] p-2">
                    <select
                      aria-label={`Ingredient ${idx + 1}`}
                      className={`${inputCls} flex-1 min-w-[180px]`}
                      value={l.item_id}
                      onChange={e => updateLine(l.key, { item_id: e.target.value })}
                    >
                      <option value="">Pick an ingredient…</option>
                      {ingredientOptions.map(i => <option key={i.id} value={i.id}>{i.name} ({i.base_unit})</option>)}
                    </select>
                    <div className="flex items-center gap-1.5">
                      <input
                        aria-label={`Quantity ${idx + 1}`}
                        type="number" step="any" min="0" inputMode="decimal"
                        className={`${inputCls} w-28`}
                        value={l.qty}
                        onChange={e => updateLine(l.key, { qty: e.target.value })}
                        placeholder="0"
                      />
                      <span className="text-sm text-brown-muted w-8">{ing?.base_unit ?? ''}</span>
                    </div>
                    <div className="text-right text-xs text-brown-muted w-36">
                      <p>{ing ? formatUnitCost(unitCost, ing.base_unit) : '—'}</p>
                      <p className="font-semibold text-brown-dark">
                        {unitCost != null && q > 0 ? money(q * unitCost) : '—'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}
                      disabled={lines.length === 1}
                      className="px-2 py-1 text-xs rounded-lg border border-[#D4C5B0] text-brown-medium hover:bg-[#F5EDE0] disabled:opacity-40"
                      aria-label={`Remove ingredient ${idx + 1}`}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
            <button
              type="button"
              onClick={() => setLines(ls => [...ls, blankLine()])}
              className="mt-2 px-3 py-1.5 text-xs rounded-lg border border-[#D4C5B0] text-brown-medium font-semibold hover:bg-[#F5EDE0] transition-colors"
            >
              + Add ingredient
            </button>
          </div>

          <div className="rounded-xl bg-[#FBF6EE] border border-[#EDE5D8] px-4 py-3 text-sm space-y-0.5">
            <p className="text-xs text-brown-faint">
              Estimate at {branchId ? branchName(branchId) : 'your branch'} (average cost, else catalogue price)
            </p>
            <p className="text-brown-dark">
              Batch cost <span className="font-bold">{money(cost.total)}</span>
            </p>
            {yieldNum > 0 && cost.unitCost != null && (
              <p className="text-xs text-brown-muted">
                {money(cost.total)} / {qty(yieldNum)} {outputUnit} = {formatUnitCost(cost.unitCost, outputUnit || 'unit')}
                {outputName && ` of ${outputName}`}
              </p>
            )}
            {cost.missingCost && (
              <p className="text-xs text-[#B46309]">Some ingredients have no cost yet — the estimate is low.</p>
            )}
          </div>

          <div className="border-t border-[#EDE5D8] pt-4 space-y-3">
            {showValidation && <p className="text-sm font-semibold text-[#9E4A30]">{validation}</p>}
            {error && (
              <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">{error}</p>
            )}
            <button
              onClick={submit}
              disabled={submitting}
              className="w-full py-3 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-50"
            >
              {submitting ? 'Saving…' : versionOf ? 'Save new version' : 'Save recipe'}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
