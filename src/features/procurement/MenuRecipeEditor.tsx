import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money } from '../../shared/lib/procurement'
import { recipeCost, foodCostBp, formatBp, sameRecipeLines } from '../../shared/lib/menuCosting'
import type { Item, MenuRecipeLine } from '../../shared/types'
import RecipeLinesEditor from './RecipeLinesEditor'

interface Variant { id: string; name: string; price_sen: number; product_id: string }
interface Option { id: string; name: string; price_delta_sen: number; group_name: string }

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Check your connection and try again.')

export default function MenuRecipeEditorPage() {
  const { variantId } = useParams<{ variantId: string }>()
  const [variant, setVariant] = useState<Variant | null>(null)
  const [productName, setProductName] = useState('')
  const [siblings, setSiblings] = useState<Variant[]>([])
  const [options, setOptions] = useState<Option[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [costs, setCosts] = useState<Map<string, number | null>>(new Map())
  const [lines, setLines] = useState<MenuRecipeLine[]>([])
  const [savedLines, setSavedLines] = useState<MenuRecipeLine[]>([])
  const [optLines, setOptLines] = useState<Record<string, MenuRecipeLine[]>>({})
  const [optSaved, setOptSaved] = useState<Record<string, MenuRecipeLine[]>>({})
  const [openOpt, setOpenOpt] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const busy = useRef(false)
  const [busyState, setBusyState] = useState(false)
  const loadReq = useRef(0)
  const costReq = useRef(0)
  const requested = useRef<Set<string>>(new Set())

  useEffect(() => () => { loadReq.current += 1; costReq.current += 1 }, [])

  const loadCosts = useCallback(async (ids: string[]) => {
    const missing = ids.filter(id => !requested.current.has(id))
    if (missing.length === 0) return
    missing.forEach(id => requested.current.add(id))
    const req = ++costReq.current
    try {
      const { data, error: err } = await supabase.rpc('item_standard_costs', { p_item_ids: missing })
      if (req !== costReq.current) {
        // A newer request superseded this one; let these ids be fetched again.
        missing.forEach(id => requested.current.delete(id))
        return
      }
      if (err) { missing.forEach(id => requested.current.delete(id)); setError(err.message); return }
      const rows = (data as { item_id: string; unit_cost: number | string | null }[] | null) ?? []
      setCosts(prev => {
        const next = new Map(prev)
        for (const id of missing) next.set(id, null) // no row = no price
        for (const r of rows) next.set(r.item_id, r.unit_cost == null ? null : Number(r.unit_cost))
        return next
      })
    } catch (e) {
      if (req === costReq.current) setError(msg(e))
      missing.forEach(id => requested.current.delete(id))
    }
  }, [])

  const load = useCallback(async (): Promise<boolean> => {
    if (!variantId) return false
    const req = ++loadReq.current
    try {
      const { data: v, error: vErr } = await supabase.from('menu_variants').select('id, name, price_sen, product_id').eq('id', variantId).maybeSingle()
      if (req !== loadReq.current) return false
      if (vErr || !v) { setLoadError(vErr?.message ?? 'Menu variant not found.'); setLoading(false); return false }
      const vv = v as Variant
      const [pRes, sRes, iRes, lRes, gRes] = await Promise.all([
        supabase.from('menu_products').select('name').eq('id', vv.product_id).maybeSingle(),
        supabase.from('menu_variants').select('id, name, price_sen, product_id').eq('product_id', vv.product_id).eq('is_active', true).order('sort_order'),
        supabase.from('items').select('*').order('name'),
        supabase.from('menu_variant_recipe_lines').select('item_id, qty_base').eq('variant_id', vv.id).order('sort_order'),
        supabase.from('product_modifier_groups').select('group_id, sort_order, group:modifier_groups(name, options:modifier_options(id, name, price_delta_sen, sort_order))').eq('product_id', vv.product_id).order('sort_order'),
      ])
      const opts: Option[] = []
      for (const g of (gRes.data as unknown as { group: { name: string; options: { id: string; name: string; price_delta_sen: number; sort_order: number }[] } | null }[]) ?? []) {
        for (const o of [...(g.group?.options ?? [])].sort((a, b) => a.sort_order - b.sort_order)) {
          opts.push({ id: o.id, name: o.name, price_delta_sen: o.price_delta_sen, group_name: g.group?.name ?? '' })
        }
      }
      const olRes = opts.length
        ? await supabase.from('modifier_recipe_lines').select('option_id, item_id, qty_base').in('option_id', opts.map(o => o.id)).order('sort_order')
        : { data: [], error: null }
      if (req !== loadReq.current) return false
      // A partial load would show an empty recipe that a save could then wipe, so any failure blocks editing.
      const firstErr = [pRes, sRes, iRes, lRes, gRes, olRes].find(r => r.error)?.error
      if (firstErr) { setLoadError(firstErr.message); setLoading(false); return false }
      const recipe = ((lRes.data as MenuRecipeLine[]) ?? []).map(l => ({ item_id: l.item_id, qty_base: Number(l.qty_base) }))
      const byOpt: Record<string, MenuRecipeLine[]> = {}
      for (const r of (olRes.data as { option_id: string; item_id: string; qty_base: number | string }[]) ?? []) {
        (byOpt[r.option_id] ??= []).push({ item_id: r.item_id, qty_base: Number(r.qty_base) })
      }
      setVariant(vv)
      setProductName((pRes.data as { name: string } | null)?.name ?? '')
      setSiblings(((sRes.data as Variant[]) ?? []).filter(s => s.id !== vv.id))
      setItems((iRes.data as Item[]) ?? [])
      setLines(recipe); setSavedLines(recipe)
      setOptions(opts); setOptLines(byOpt); setOptSaved(byOpt)
      setLoadError('')
      setLoading(false)
      return true
    } catch (e) {
      if (req === loadReq.current) { setLoadError(msg(e)); setLoading(false) }
      return false
    }
  }, [variantId])

  useEffect(() => { setLoading(true); setVariant(null); load() }, [load])

  // Fetch costs for every ingredient on screen.
  useEffect(() => {
    const ids = new Set(lines.map(l => l.item_id))
    Object.values(optLines).forEach(ls => ls.forEach(l => ids.add(l.item_id)))
    if (ids.size) loadCosts([...ids])
  }, [lines, optLines, loadCosts])

  const variantDirty = !sameRecipeLines(lines, savedLines)
  const dirty = variantDirty || options.some(o => !sameRecipeLines(optLines[o.id] ?? [], optSaved[o.id] ?? []))
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const total = useMemo(() => recipeCost(lines.map(l => ({ qtyBase: l.qty_base, unitCost: costs.get(l.item_id) }))), [lines, costs])

  async function run(fn: () => Promise<void>) {
    if (busy.current) return
    busy.current = true; setBusyState(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(msg(e)) } finally { busy.current = false; setBusyState(false) }
  }

  const saveVariant = () => run(async () => {
    const sent = lines
    const { error: err } = await supabase.rpc('save_variant_recipe', { p_variant_id: variantId, p_lines: sent })
    if (err) { setError(err.message); return }
    setSavedLines(sent); setNotice('Recipe saved.')
  })

  const saveOption = (optionId: string) => run(async () => {
    const sent = optLines[optionId] ?? []
    const { error: err } = await supabase.rpc('save_modifier_recipe', { p_option_id: optionId, p_lines: sent })
    if (err) { setError(err.message); return }
    setOptSaved(prev => ({ ...prev, [optionId]: sent })); setNotice('Add-on saved.')
  })

  const copyFrom = (fromId: string) => run(async () => {
    if (dirty || lines.length > 0) {
      const text = dirty
        ? 'Replace this recipe with the one from the other size? Any unsaved changes on this page will be lost.'
        : 'Replace this recipe with the one from the other size?'
      if (!window.confirm(text)) return
    }
    const { error: err } = await supabase.rpc('copy_variant_recipe', { p_from_variant: fromId, p_to_variant: variantId })
    if (err) { setError(err.message); return }
    if (await load()) setNotice('Recipe copied. Adjust the quantities for this size.')
  })

  if (loading) return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  if (!variant) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8 text-center space-y-2">
        <p className="text-sm text-brown-muted">{loadError || 'Menu variant not found.'}</p>
        <button type="button" onClick={() => { setLoading(true); load() }} className="text-sm text-[#C4813A] font-semibold block mx-auto">Try again</button>
        <Link to="/procurement/menu-costing" className="text-sm text-[#C4813A] font-semibold">← Menu Costing</Link>
      </div>
    )
  }

  const bp = foodCostBp(total.cost, variant.price_sen)

  return (
    <div className="min-h-screen bg-cream-light px-4 py-6 pb-28">
      <div className="max-w-2xl mx-auto space-y-4">
        <Link to="/procurement/menu-costing" className="text-sm text-brown-muted">← Menu Costing</Link>
        <div>
          <h1 className="text-xl font-bold text-brown-dark">{productName} · {variant.name}</h1>
          <p className="text-xs text-brown-faint">Price {money(variant.price_sen / 100)} (excl. SST)</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white rounded-xl border border-[#E8DDD0] p-3 text-center">
            <p className="text-xs text-brown-faint">Cost</p>
            <p className="text-base font-bold text-brown-dark">{total.cost == null ? (lines.length ? 'Missing price' : '—') : money(total.cost)}</p>
          </div>
          <div className="bg-white rounded-xl border border-[#E8DDD0] p-3 text-center">
            <p className="text-xs text-brown-faint">Food cost</p>
            <p className="text-base font-bold text-brown-dark">{formatBp(bp)}</p>
          </div>
        </div>

        {siblings.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap text-xs text-brown-muted">
            Copy from:
            {siblings.map(s => (
              <button key={s.id} type="button" disabled={busyState} onClick={() => copyFrom(s.id)}
                className="px-2.5 py-1 rounded-full border border-[#D4C5B0] bg-white font-semibold text-brown-medium disabled:opacity-50">{s.name}</button>
            ))}
          </div>
        )}

        <section className="space-y-2">
          <h2 className="text-sm font-bold text-brown-dark">Ingredients</h2>
          <RecipeLinesEditor lines={lines} onChange={setLines} items={items} costs={costs} allowNegative={false} />
        </section>

        {options.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-bold text-brown-dark">Add-ons</h2>
            <p className="text-xs text-brown-faint">What each add-on adds to, or removes from, the recipe above.</p>
            {options.map(o => {
              const ls = optLines[o.id] ?? []
              const delta = recipeCost(ls.map(l => ({ qtyBase: l.qty_base, unitCost: costs.get(l.item_id) })))
              const open = openOpt === o.id
              const optDirty = !sameRecipeLines(ls, optSaved[o.id] ?? [])
              return (
                <div key={o.id} className="bg-white rounded-xl border border-[#E8DDD0]">
                  <button type="button" onClick={() => setOpenOpt(open ? null : o.id)} className="w-full flex items-center justify-between px-4 py-3 text-left">
                    <span className="text-sm text-brown-dark"><span className="text-xs text-brown-faint">{o.group_name} · </span>{o.name}</span>
                    <span className="text-xs text-brown-muted">
                      {ls.length === 0 ? 'No change' : delta.cost == null ? 'Missing price' : `${delta.cost < 0 ? '−' : '+'}${money(Math.abs(delta.cost))}`}
                      {optDirty && ' · unsaved'}
                    </span>
                  </button>
                  {open && (
                    <div className="px-3 pb-3 space-y-2">
                      <RecipeLinesEditor lines={ls} onChange={next => setOptLines(prev => ({ ...prev, [o.id]: next }))} items={items} costs={costs} allowNegative />
                      <button type="button" disabled={busyState || !optDirty} onClick={() => saveOption(o.id)}
                        className="w-full h-10 rounded-lg bg-brown-btn text-white text-sm font-bold disabled:opacity-40">Save add-on</button>
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        )}

        {notice && <p className="text-sm text-green-700">{notice}</p>}
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>

      <div className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-[#E8DDD0] px-4 py-3">
        <div className="max-w-2xl mx-auto">
          <button type="button" disabled={busyState || !variantDirty} onClick={saveVariant}
            className="w-full h-12 rounded-xl bg-brown-btn text-white text-sm font-bold disabled:opacity-40">
            {variantDirty ? 'Save recipe' : 'Recipe saved'}
          </button>
        </div>
      </div>
    </div>
  )
}
