import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money } from '../../shared/lib/procurement'
import { recipeCost, foodCostBp, formatBp, sameRecipeLines, costDisplay } from '../../shared/lib/menuCosting'
import type { CostDisplay } from '../../shared/lib/menuCosting'
import type { Item, MenuRecipeLine } from '../../shared/types'
import { useUnsavedWarning } from '../pos/menu/editorUi'
import RecipeLinesEditor from './RecipeLinesEditor'
import type { RecipeLinesHandle } from './RecipeLinesEditor'

interface Variant { id: string; name: string; price_sen: number; product_id: string }
interface Option { id: string; name: string; price_delta_sen: number; group_name: string }

/** Total text when the cost cannot be shown as money. */
const PENDING_TEXT: Partial<Record<CostDisplay, string>> = {
  empty: '—', loading: '…', failed: 'Cost unavailable', missing_price: 'Missing price',
}
const VARIANT_KEY = '__variant__'

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
  const [failedCosts, setFailedCosts] = useState<Set<string>>(new Set())
  // Bumped on every successful load so the line editors drop stale drafts.
  const [loadGen, setLoadGen] = useState(0)
  // Rows with typed-but-uncommitted quantities, per editor (variant or option id).
  const [openDrafts, setOpenDrafts] = useState<Record<string, boolean>>({})
  const variantEditor = useRef<RecipeLinesHandle>(null)
  const optEditors = useRef<Record<string, RecipeLinesHandle | null>>({})
  const draftCallbacks = useRef<Record<string, (open: boolean) => void>>({})
  const draftCallback = (key: string) => (draftCallbacks.current[key] ??= (open: boolean) =>
    setOpenDrafts(prev => (!!prev[key] === open ? prev : { ...prev, [key]: open })))

  useEffect(() => () => { loadReq.current += 1; costReq.current += 1 }, [])

  const loadCosts = useCallback(async (ids: string[]) => {
    const missing = ids.filter(id => !requested.current.has(id))
    if (missing.length === 0) return
    missing.forEach(id => requested.current.add(id))
    const req = costReq.current // bumped only on unmount
    try {
      const { data, error: err } = await supabase.rpc('item_standard_costs', { p_item_ids: missing })
      if (req !== costReq.current) {
        // Unmounted; a later mount may fetch these again.
        missing.forEach(id => requested.current.delete(id))
        return
      }
      if (err) { missing.forEach(id => requested.current.delete(id)); markFailed(missing); return }
      const rows = (data as { item_id: string; unit_cost: number | string | null }[] | null) ?? []
      setCosts(prev => {
        const next = new Map(prev)
        for (const id of missing) next.set(id, null) // no row = no price
        for (const r of rows) next.set(r.item_id, r.unit_cost == null ? null : Number(r.unit_cost))
        return next
      })
    } catch {
      missing.forEach(id => requested.current.delete(id))
      if (req === costReq.current) markFailed(missing)
    }
  }, [])
  function markFailed(ids: string[]) {
    setFailedCosts(prev => { const next = new Set(prev); ids.forEach(id => next.add(id)); return next })
  }
  const retryCosts = useCallback(() => {
    const ids = [...failedCosts]
    setFailedCosts(new Set())
    if (ids.length) loadCosts(ids)
  }, [failedCosts, loadCosts])

  const load = useCallback(async (): Promise<boolean> => {
    if (!variantId) return false
    const req = ++loadReq.current
    try {
      const { data: v, error: vErr } = await supabase.from('menu_variants').select('id, name, price_sen, product_id').eq('id', variantId).maybeSingle()
      if (req !== loadReq.current) return false
      if (vErr || !v) { setLoadError(vErr?.message ?? 'Menu variant not found.'); setLoading(false); return false }
      // (A failed reload keeps the old screen but blocks saving until a reload succeeds.)
      const vv = v as Variant
      const [pRes, sRes, iRes, lRes, gRes] = await Promise.all([
        supabase.from('menu_products').select('name').eq('id', vv.product_id).maybeSingle(),
        supabase.from('menu_variants').select('id, name, price_sen, product_id').eq('product_id', vv.product_id).eq('is_active', true).order('sort_order'),
        supabase.from('items').select('*').order('name'),
        supabase.from('menu_variant_recipe_lines').select('item_id, qty_base').eq('variant_id', vv.id).order('sort_order'),
        supabase.from('product_modifier_groups').select('group_id, sort_order, group:modifier_groups(name, is_active, options:modifier_options(id, name, price_delta_sen, sort_order, availability))').eq('product_id', vv.product_id).order('sort_order'),
      ])
      const opts: Option[] = []
      type Opt = { id: string; name: string; price_delta_sen: number; sort_order: number; availability: string }
      for (const g of (gRes.data as unknown as { group: { name: string; is_active: boolean; options: Opt[] } | null }[]) ?? []) {
        // Inactive groups and hidden options are never offered, so they have nothing to cost.
        if (!g.group?.is_active) continue
        for (const o of [...g.group.options].filter(x => x.availability !== 'hidden').sort((a, b) => a.sort_order - b.sort_order)) {
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
      setOpenDrafts({})
      setLoadGen(n => n + 1)
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

  const variantDirty = !sameRecipeLines(lines, savedLines) || !!openDrafts[VARIANT_KEY]
  const optionDirty = (id: string) => !sameRecipeLines(optLines[id] ?? [], optSaved[id] ?? []) || !!openDrafts[id]
  const dirty = variantDirty || options.some(o => optionDirty(o.id))
  // Covers reload / tab close (beforeunload sets returnValue). The sidebar's in-app links are not guarded.
  useUnsavedWarning(dirty)
  // A failed reload leaves a possibly stale screen; saving it could overwrite newer data.
  const saveBlocked = !!loadError

  const total = useMemo(() => recipeCost(lines.map(l => ({ qtyBase: l.qty_base, unitCost: costs.get(l.item_id) }))), [lines, costs])

  async function run(fn: () => Promise<void>) {
    if (busy.current) return
    busy.current = true; setBusyState(true); setError(''); setNotice('')
    try { await fn() } catch (e) { setError(msg(e)) } finally { busy.current = false; setBusyState(false) }
  }

  const saveVariant = () => run(async () => {
    if (saveBlocked) return
    // Apply any quantity still being typed so the saved lines equal what is on screen.
    const sent = variantEditor.current ? variantEditor.current.commitAll() : lines
    if (!sent) { setError('Fix the highlighted quantity first.'); return }
    const { error: err } = await supabase.rpc('save_variant_recipe', { p_variant_id: variantId, p_lines: sent })
    if (err) { setError(err.message); return }
    setSavedLines(sent); setNotice('Recipe saved.')
  })

  const saveOption = (optionId: string) => run(async () => {
    if (saveBlocked) return
    const ed = optEditors.current[optionId]
    const sent = ed ? ed.commitAll() : (optLines[optionId] ?? [])
    if (!sent) { setError('Fix the highlighted quantity first.'); return }
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

  const reload = () => run(async () => {
    if (dirty && !window.confirm('Reload and discard unsaved changes on this page?')) return
    if (await load()) setNotice('Reloaded.')
  })

  const confirmLeave = (e: { preventDefault: () => void }) => {
    if (dirty && !window.confirm('Leave without saving?')) e.preventDefault()
  }

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
  const totalState = costDisplay(lines.map(l => l.item_id), costs, failedCosts)

  return (
    <div className="min-h-screen bg-cream-light px-4 py-6 pb-28">
      <div className="max-w-2xl mx-auto space-y-4">
        <Link to="/procurement/menu-costing" onClick={confirmLeave} className="text-sm text-brown-muted">← Menu Costing</Link>
        {loadError && (
          <div className="rounded-xl border border-red-200 bg-[#FBE4E1] px-3 py-2.5 flex items-center justify-between gap-3">
            <p className="text-sm text-red-700">Couldn&apos;t reload this recipe: {loadError} Saving is off until it reloads.</p>
            <button type="button" disabled={busyState} onClick={reload}
              className="shrink-0 px-3 h-9 rounded-lg bg-white border border-red-300 text-sm font-semibold text-red-700 disabled:opacity-50">Reload</button>
          </div>
        )}
        <div>
          <h1 className="text-xl font-bold text-brown-dark">{productName} · {variant.name}</h1>
          <p className="text-xs text-brown-faint">Price {money(variant.price_sen / 100)} (excl. SST)</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white rounded-xl border border-[#E8DDD0] p-3 text-center">
            <p className="text-xs text-brown-faint">Cost</p>
            <p className="text-base font-bold text-brown-dark">{totalState === 'ok' && total.cost != null ? money(total.cost) : PENDING_TEXT[totalState]}</p>
          </div>
          <div className="bg-white rounded-xl border border-[#E8DDD0] p-3 text-center">
            <p className="text-xs text-brown-faint">Food cost</p>
            <p className="text-base font-bold text-brown-dark">{totalState === 'ok' || totalState === 'missing_price' ? formatBp(bp) : PENDING_TEXT[totalState]}</p>
          </div>
        </div>

        {siblings.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap text-xs text-brown-muted">
            Copy from:
            {siblings.map(s => (
              <button key={s.id} type="button" disabled={busyState || saveBlocked} onClick={() => copyFrom(s.id)}
                className="px-2.5 py-1 rounded-full border border-[#D4C5B0] bg-white font-semibold text-brown-medium disabled:opacity-50">{s.name}</button>
            ))}
          </div>
        )}

        <section className="space-y-2">
          <h2 className="text-sm font-bold text-brown-dark">Ingredients</h2>
          <RecipeLinesEditor key={`v${loadGen}`} ref={variantEditor} lines={lines} onChange={setLines} items={items} costs={costs}
            failedCosts={failedCosts} onRetryCosts={retryCosts} allowNegative={false} onDraftOpen={draftCallback(VARIANT_KEY)} />
        </section>

        {options.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-bold text-brown-dark">Add-ons</h2>
            <p className="text-xs text-brown-faint">What each add-on adds to, or removes from, the recipe above.</p>
            <p className="text-xs text-brown-faint">Each add-on applies to every menu item that offers it, in every size.</p>
            {options.map(o => {
              const ls = optLines[o.id] ?? []
              const delta = recipeCost(ls.map(l => ({ qtyBase: l.qty_base, unitCost: costs.get(l.item_id) })))
              const deltaState = costDisplay(ls.map(l => l.item_id), costs, failedCosts)
              const open = openOpt === o.id
              const optDirty = optionDirty(o.id)
              return (
                <div key={o.id} className="bg-white rounded-xl border border-[#E8DDD0]">
                  <button type="button" onClick={() => setOpenOpt(open ? null : o.id)} className="w-full flex items-center justify-between px-4 py-3 text-left">
                    <span className="text-sm text-brown-dark"><span className="text-xs text-brown-faint">{o.group_name} · </span>{o.name}</span>
                    <span className="text-xs text-brown-muted">
                      {deltaState === 'empty' ? 'No change' : deltaState === 'ok' && delta.cost != null ? `${delta.cost < 0 ? '−' : '+'}${money(Math.abs(delta.cost))}` : PENDING_TEXT[deltaState]}
                      {optDirty && ' · unsaved'}
                    </span>
                  </button>
                  {open && (
                    <div className="px-3 pb-3 space-y-2">
                      <RecipeLinesEditor key={`${o.id}-${loadGen}`} ref={h => { optEditors.current[o.id] = h }}
                        lines={ls} onChange={next => setOptLines(prev => ({ ...prev, [o.id]: next }))} items={items} costs={costs}
                        failedCosts={failedCosts} onRetryCosts={retryCosts} allowNegative onDraftOpen={draftCallback(o.id)} />
                      <button type="button" disabled={busyState || saveBlocked || !optDirty} onClick={() => saveOption(o.id)}
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
          <button type="button" disabled={busyState || saveBlocked || !variantDirty} onClick={saveVariant}
            className="w-full h-12 rounded-xl bg-brown-btn text-white text-sm font-bold disabled:opacity-40">
            {variantDirty ? 'Save recipe' : 'Recipe saved'}
          </button>
        </div>
      </div>
    </div>
  )
}
