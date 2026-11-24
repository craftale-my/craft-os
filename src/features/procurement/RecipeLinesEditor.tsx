import { useState, useEffect, useMemo, useRef, useImperativeHandle, forwardRef } from 'react'
import type { FocusEvent } from 'react'
import { money, qty } from '../../shared/lib/procurement'
import { lineCost, draftFromBase, commitQtyDraft } from '../../shared/lib/menuCosting'
import type { QtyDraft } from '../../shared/lib/menuCosting'
import type { Item, MenuRecipeLine } from '../../shared/types'

const numCls = 'w-20 h-10 px-2 rounded-lg border border-[#E8DDD0] bg-[#FDFAF6] text-center text-sm font-bold text-brown-dark'

/** Open draft for one row, tied to the quantity it was opened against. */
interface OpenDraft { from: number; draft: QtyDraft }

export interface RecipeLinesHandle {
  /** Applies every open draft. Returns the lines as on screen, or null when a draft is invalid (its warning is shown). */
  commitAll: () => MenuRecipeLine[] | null
}

const rateOf = (it: Item | undefined) => Number(it?.conversion_rate) || 1

const RecipeLinesEditor = forwardRef<RecipeLinesHandle, {
  lines: MenuRecipeLine[]
  onChange: (next: MenuRecipeLine[]) => void
  items: Item[]
  costs: Map<string, number | null>
  failedCosts: Set<string>
  onRetryCosts: () => void
  allowNegative: boolean
  onDraftOpen?: (open: boolean) => void
}>(function RecipeLinesEditor({ lines, onChange, items, costs, failedCosts, onRetryCosts, allowNegative, onDraftOpen }, ref) {
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<Record<string, OpenDraft>>({})
  const [warns, setWarns] = useState<Record<string, string>>({})
  const [focusId, setFocusId] = useState<string | null>(null)
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items])
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    const used = new Set(lines.map(l => l.item_id))
    return items.filter(i => i.status === 'active' && !used.has(i.id) && i.name.toLowerCase().includes(q)).slice(0, 8)
  }, [search, items, lines])

  // Latest values for commitAll, which may run before a re-render.
  const linesRef = useRef(lines); linesRef.current = lines
  const draftsRef = useRef(drafts); draftsRef.current = drafts

  /** A draft counts only while the row still holds the quantity it was opened against. */
  const liveDraft = (l: MenuRecipeLine, d: Record<string, OpenDraft>) => {
    const o = d[l.item_id]
    return o && o.from === l.qty_base ? o.draft : null
  }
  const hasOpen = lines.some(l => liveDraft(l, drafts) != null)
  useEffect(() => { onDraftOpen?.(hasOpen) }, [hasOpen, onDraftOpen])
  useEffect(() => () => onDraftOpen?.(false), [onDraftOpen])

  function setWarn(itemId: string, text: string) {
    setWarns(prev => {
      if ((prev[itemId] ?? '') === text) return prev
      const next = { ...prev }
      if (text) next[itemId] = text; else delete next[itemId]
      return next
    })
  }
  function dropDraft(itemId: string) {
    setDrafts(prev => {
      if (!(itemId in prev)) return prev
      const next = { ...prev }; delete next[itemId]; return next
    })
  }

  /** Commit one row (focus left it). Invalid input reverts to the saved quantity with a warning. */
  function commitRow(itemId: string): number | null {
    const l = linesRef.current.find(x => x.item_id === itemId)
    if (!l) { dropDraft(itemId); return null }
    const d = liveDraft(l, draftsRef.current)
    dropDraft(itemId)
    if (!d) return l.qty_base
    const r = commitQtyDraft(d, rateOf(byId.get(itemId)), l.qty_base < 0)
    if (!r.ok) { setWarn(itemId, r.message); return l.qty_base }
    setWarn(itemId, '')
    if (r.base !== l.qty_base) {
      const next = linesRef.current.map(x => (x.item_id === itemId ? { ...x, qty_base: r.base } : x))
      linesRef.current = next
      onChange(next)
    }
    return r.base
  }

  useImperativeHandle(ref, () => ({
    commitAll() {
      let bad = false
      const next = linesRef.current.map(l => {
        const d = liveDraft(l, draftsRef.current)
        if (!d) return l
        const r = commitQtyDraft(d, rateOf(byId.get(l.item_id)), l.qty_base < 0)
        if (!r.ok) { bad = true; setWarn(l.item_id, r.message); return l }
        setWarn(l.item_id, '')
        return r.base === l.qty_base ? l : { ...l, qty_base: r.base }
      })
      if (bad) return null // keep the drafts on screen so they can be fixed
      setDrafts({})
      if (next.some((l, i) => l !== linesRef.current[i])) { linesRef.current = next; onChange(next) }
      return next
    },
  }))

  function onRowBlur(itemId: string, e: FocusEvent<HTMLDivElement>) {
    const to = e.relatedTarget as Node | null
    if (to && e.currentTarget.contains(to)) return // still inside the row
    commitRow(itemId)
  }

  function editDraft(l: MenuRecipeLine, patch: Partial<QtyDraft>) {
    const rate = rateOf(byId.get(l.item_id))
    const shown = liveDraft(l, drafts) ?? draftFromBase(l.qty_base, rate)
    const nextDraft = { ...shown, ...patch }
    const canon = draftFromBase(l.qty_base, rate)
    setDrafts(prev => {
      const next = { ...prev }
      if (nextDraft.packs === canon.packs && nextDraft.loose === canon.loose) delete next[l.item_id]
      else next[l.item_id] = { from: l.qty_base, draft: nextDraft }
      return next
    })
  }

  function flip(itemId: string) {
    const base = commitRow(itemId)
    if (base == null) return
    const next = linesRef.current.map(l => (l.item_id === itemId ? { ...l, qty_base: -base } : l))
    linesRef.current = next
    onChange(next)
  }
  function remove(itemId: string) {
    dropDraft(itemId); setWarn(itemId, '')
    onChange(linesRef.current.filter(x => x.item_id !== itemId))
  }

  function costText(l: MenuRecipeLine) {
    if (!costs.has(l.item_id)) {
      return failedCosts.has(l.item_id)
        ? <span className="text-[#B46309]">Couldn&apos;t load cost — <button type="button" className="underline font-semibold" onClick={onRetryCosts}>Retry</button></span>
        : <span>…</span>
    }
    const c = lineCost(l.qty_base, costs.get(l.item_id))
    return c == null ? <span className="text-[#B46309]">No price</span> : money(c)
  }

  return (
    <div className="space-y-2">
      {lines.length === 0 && <p className="text-sm text-brown-faint">No ingredients yet.</p>}
      {lines.map(l => {
        const it = byId.get(l.item_id)
        if (!it) {
          return (
            <div key={l.item_id} className="bg-white rounded-xl border border-[#E8DDD0] px-3 py-2.5 flex items-center justify-between gap-2">
              <p className="text-sm text-[#B46309]">Unknown item (no longer available)</p>
              <button type="button" className="text-xs text-red-700" onClick={() => remove(l.item_id)}>Remove</button>
            </div>
          )
        }
        const rate = rateOf(it)
        const single = rate === 1
        const shown = liveDraft(l, drafts) ?? draftFromBase(l.qty_base, rate)
        const neg = l.qty_base < 0
        const warn = warns[l.item_id]
        return (
          <div key={l.item_id} className="bg-white rounded-xl border border-[#E8DDD0] px-3 py-2.5 space-y-2"
            onBlur={e => onRowBlur(l.item_id, e)}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-brown-dark">{it.name}{it.status !== 'active' && <span className="ml-2 text-xs text-[#B46309]">Inactive</span>}</p>
                <p className="text-xs text-brown-faint">{qty(Math.abs(l.qty_base))} {it.base_unit} · {costText(l)}</p>
              </div>
              <button type="button" className="text-xs text-red-700" onClick={() => remove(l.item_id)}>Remove</button>
            </div>
            <div className="flex items-start gap-2 flex-wrap">
              {allowNegative && (
                <button type="button" onClick={() => flip(l.item_id)}
                  className={`px-2 h-10 rounded-full text-xs font-semibold border ${neg ? 'border-red-300 text-red-700' : 'border-green-300 text-green-700'}`}>
                  {neg ? 'Removes' : 'Adds'}
                </button>
              )}
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <FirstBox focusNow={focusId === l.item_id} onFocused={() => setFocusId(null)}
                    className={numCls} inputMode="decimal" value={shown.packs} aria-label={`${it.name} ${single ? it.base_unit : it.purchase_unit}`}
                    onChange={v => editDraft(l, { packs: v })} />
                  <span className="text-xs text-brown-muted">{single ? it.base_unit : it.purchase_unit}</span>
                  {!single && (<>
                    <span className="text-brown-faint">+</span>
                    <input className={numCls} inputMode="decimal" value={shown.loose} aria-label={`${it.name} ${it.base_unit}`}
                      onChange={e => editDraft(l, { loose: e.target.value })} />
                    <span className="text-xs text-brown-muted">{it.base_unit}</span>
                  </>)}
                </div>
                {warn && <p className="text-xs text-[#B46309]">{warn}</p>}
              </div>
            </div>
          </div>
        )
      })}
      <div className="relative">
        <input className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm" placeholder="Add ingredient — search items"
          value={search} onChange={e => setSearch(e.target.value)} />
        {matches.length > 0 && (
          <ul className="mt-1 bg-white rounded-lg border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
            {matches.map(i => (
              <li key={i.id}>
                <button type="button" className="w-full text-left px-3 py-2 text-sm text-brown-dark"
                  onClick={() => {
                    onChange([...linesRef.current, { item_id: i.id, qty_base: Number(i.conversion_rate) || 1 }])
                    setSearch(''); setFocusId(i.id)
                  }}>
                  {i.name} <span className="text-xs text-brown-faint">({i.purchase_unit}, {qty(Number(i.conversion_rate))} {i.base_unit})</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
})

export default RecipeLinesEditor

/** The row's first quantity box; focuses and selects itself once when a line is just added. */
function FirstBox({ focusNow, onFocused, onChange, ...rest }: {
  focusNow: boolean; onFocused: () => void; onChange: (v: string) => void
  className: string; inputMode: 'decimal'; value: string; 'aria-label': string
}) {
  const el = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!focusNow || !el.current) return
    el.current.focus(); el.current.select(); onFocused()
  }, [focusNow, onFocused])
  return <input ref={el} {...rest} onChange={e => onChange(e.target.value)} />
}
