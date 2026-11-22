import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money } from '../../shared/lib/procurement'
import { costStatus, formatBp } from '../../shared/lib/menuCosting'
import type { MenuVariantCost, CostStatus } from '../../shared/types'
import { COST_STATUS_LABELS } from '../../shared/types'

const STATUS_CLS: Record<CostStatus, string> = {
  no_recipe:    'bg-[#F3EEE6] text-brown-muted',
  missing_cost: 'bg-[#FDF0DC] text-[#B46309]',
  no_price:     'bg-[#F3EEE6] text-brown-muted',
  over_target:  'bg-[#FBE4E1] text-red-700',
  ok:           'bg-[#E6F2E3] text-green-700',
}
type Filter = 'all' | CostStatus

const num = (v: unknown): number | null => (v == null ? null : Number(v))

/** PostgREST may return bigint/numeric as strings. */
function normalise(r: MenuVariantCost): MenuVariantCost {
  return {
    ...r,
    price_sen: Number(r.price_sen),
    line_count: Number(r.line_count),
    missing_cost_items: Number(r.missing_cost_items),
    cost_rm: num(r.cost_rm),
    food_cost_bp: num(r.food_cost_bp),
    target_food_cost_bp: num(r.target_food_cost_bp),
  }
}

function statusOf(r: MenuVariantCost): CostStatus {
  return costStatus({
    lineCount: r.line_count, missing: r.missing_cost_items, priceSen: r.price_sen,
    foodCostBp: r.food_cost_bp, targetBp: r.target_food_cost_bp,
  })
}

export default function MenuCostingPage() {
  const [rows, setRows] = useState<MenuVariantCost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sortWorst, setSortWorst] = useState(false)
  const [search, setSearch] = useState('')
  const busy = useRef(false)
  const reqId = useRef(0)

  const load = useCallback(async () => {
    const id = ++reqId.current
    try {
      const { data, error: err } = await supabase
        .from('menu_variant_costs').select('*').eq('is_active', true)
      if (id !== reqId.current) return
      // On error keep the rows already on screen rather than wiping the list.
      if (err) { setError(err.message); return }
      setRows(((data as MenuVariantCost[]) ?? []).map(normalise))
      setError('')
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : 'Could not load menu costs. Check your connection and try again.')
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [])
  useEffect(() => { load(); return () => { reqId.current++ } }, [load])

  async function editTarget(categoryId: string, name: string, current: number | null) {
    if (busy.current) return
    const input = window.prompt(`Target food cost % for ${name} (blank = none)`, current == null ? '' : String(current / 100))
    if (input === null) return
    const trimmed = input.trim()
    const pct = trimmed === '' ? null : Number(trimmed)
    if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) { setError('Enter a percentage between 0 and 100.'); return }
    busy.current = true
    let err: { message: string } | null
    try {
      ;({ error: err } = await supabase.rpc('set_category_target', {
        p_category_id: categoryId, p_target_bp: pct === null ? null : Math.round(pct * 100),
      }))
    } catch (e) {
      err = { message: e instanceof Error ? e.message : 'Could not save the target. Check your connection and try again.' }
    } finally {
      busy.current = false
    }
    if (err) { setError(err.message); return }
    setError('')
    load()
  }

  const counts = useMemo(() => {
    const c: Record<CostStatus, number> = { no_recipe: 0, missing_cost: 0, no_price: 0, over_target: 0, ok: 0 }
    rows.forEach(r => { c[statusOf(r)] += 1 })
    return c
  }, [rows])

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const shown = rows.filter(r =>
      (filter === 'all' || statusOf(r) === filter)
      && (!q || r.product_name.toLowerCase().includes(q) || r.variant_name.toLowerCase().includes(q)))
    const byCat = new Map<string, { id: string | null; name: string; target: number | null; rows: MenuVariantCost[] }>()
    for (const r of shown) {
      const key = r.category_id ?? 'none'
      if (!byCat.has(key)) byCat.set(key, { id: r.category_id, name: r.category_name ?? 'No category', target: r.target_food_cost_bp, rows: [] })
      byCat.get(key)!.rows.push(r)
    }
    const list = [...byCat.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const g of list) {
      g.rows.sort(sortWorst
        ? (a, b) => (b.food_cost_bp ?? -1) - (a.food_cost_bp ?? -1)
            || a.product_name.localeCompare(b.product_name) || a.variant_name.localeCompare(b.variant_name)
        : (a, b) => a.product_name.localeCompare(b.product_name) || a.variant_name.localeCompare(b.variant_name))
    }
    return list
  }, [rows, filter, search, sortWorst])

  const pill = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap border ${active ? 'bg-[#C4813A] border-[#C4813A] text-white' : 'bg-white border-[#D4C5B0] text-brown-medium'}`

  return (
    <div className="min-h-screen bg-cream-light px-4 py-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <div>
          <h1 className="text-xl font-bold text-brown-dark">Menu Costing</h1>
          <p className="text-xs text-brown-faint mt-0.5">Ingredient cost and food cost % per menu size, from the latest purchase prices. Prices exclude SST.</p>
        </div>
        <input
          className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark"
          placeholder="Search menu" value={search} onChange={e => setSearch(e.target.value)}
        />
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4">
          <button type="button" className={pill(filter === 'all')} onClick={() => setFilter('all')}>All · {rows.length}</button>
          {(['over_target', 'missing_cost', 'no_recipe', 'no_price', 'ok'] as const).map(s => (
            <button key={s} type="button" className={pill(filter === s)} onClick={() => setFilter(s)}>
              {COST_STATUS_LABELS[s]} · {counts[s]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-brown-muted">
          <input type="checkbox" checked={sortWorst} onChange={e => setSortWorst(e.target.checked)} />
          Highest food cost first
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        {loading ? <p className="text-sm text-brown-faint">Loading…</p> : groups.length === 0 ? (
          <p className="text-sm text-brown-faint">Nothing matches.</p>
        ) : groups.map(g => (
          <section key={g.id ?? 'none'} className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-brown-dark">{g.name}</h2>
              {g.id && (
                <button type="button" className="text-xs font-semibold text-[#C4813A]" onClick={() => editTarget(g.id!, g.name, g.target)}>
                  {g.target == null ? 'Set target' : `Target ${formatBp(g.target)}`}
                </button>
              )}
            </div>
            <ul className="space-y-2">
              {g.rows.map(r => {
                const s = statusOf(r)
                return (
                  <li key={r.variant_id}>
                    <Link to={`/procurement/menu-costing/${r.variant_id}`}
                      className="flex items-center justify-between gap-3 bg-white rounded-xl border border-[#E8DDD0] px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-brown-dark truncate">{r.product_name}</p>
                        <p className="text-xs text-brown-faint">
                          {r.variant_name} · {money(r.price_sen / 100)} · cost {r.cost_rm == null ? '—' : money(r.cost_rm)}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-base font-bold ${s === 'over_target' ? 'text-red-700' : 'text-brown-dark'}`}>{formatBp(r.food_cost_bp)}</p>
                        <span className={`inline-block mt-0.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_CLS[s]}`}>{COST_STATUS_LABELS[s]}</span>
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
