import { useState, useEffect, useMemo } from 'react'
import { money, qty } from '../../shared/lib/procurement'
import { packsLooseToBase, baseToPacksLoose, lineCost } from '../../shared/lib/menuCosting'
import type { Item, MenuRecipeLine } from '../../shared/types'

const numCls = 'w-20 h-10 px-2 rounded-lg border border-[#E8DDD0] bg-[#FDFAF6] text-center text-sm font-bold text-brown-dark'

function parse(v: string): number | null {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

function QtyInputs({ item, value, negative, onCommit }: {
  item: Item; value: number; negative: boolean; onCommit: (base: number) => void
}) {
  const rate = Number(item.conversion_rate) || 1
  const single = rate === 1
  const fromValue = () => {
    const s = baseToPacksLoose(Math.abs(value), rate)
    return { p: s.packs ? String(s.packs) : '', l: s.loose ? String(s.loose) : '' }
  }
  const [p, setP] = useState(() => fromValue().p)
  const [l, setL] = useState(() => fromValue().l)
  const [warn, setWarn] = useState('')

  // Show the new quantity when it changes from outside (e.g. after "Copy from").
  useEffect(() => {
    const s = baseToPacksLoose(Math.abs(value), rate)
    setP(s.packs ? String(s.packs) : '')
    setL(s.loose ? String(s.loose) : '')
    setWarn('')
  }, [value, rate])

  function revert(msg: string) {
    const s = fromValue()
    setP(s.p); setL(s.l); setWarn(msg)
  }
  function commit() {
    const pp = parse(p); const ll = single ? null : parse(l)
    if (Number.isNaN(pp) || Number.isNaN(ll)) return revert('Enter a number, 0 or more.')
    const base = packsLooseToBase(pp, ll, rate)
    if (base == null || base === 0) return revert('Quantity cannot be empty. Use Remove to drop this ingredient.')
    setWarn('')
    const signed = negative ? -base : base
    if (signed !== value) onCommit(signed)
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <input className={numCls} inputMode="decimal" value={p} aria-label={`${item.name} ${single ? item.base_unit : item.purchase_unit}`}
          onChange={e => setP(e.target.value)} onBlur={commit} />
        <span className="text-xs text-brown-muted">{single ? item.base_unit : item.purchase_unit}</span>
        {!single && (<>
          <span className="text-brown-faint">+</span>
          <input className={numCls} inputMode="decimal" value={l} aria-label={`${item.name} ${item.base_unit}`}
            onChange={e => setL(e.target.value)} onBlur={commit} />
          <span className="text-xs text-brown-muted">{item.base_unit}</span>
        </>)}
      </div>
      {warn && <p className="text-xs text-[#B46309]">{warn}</p>}
    </div>
  )
}

export default function RecipeLinesEditor({ lines, onChange, items, costs, allowNegative }: {
  lines: MenuRecipeLine[]
  onChange: (next: MenuRecipeLine[]) => void
  items: Item[]
  costs: Map<string, number | null>
  allowNegative: boolean
}) {
  const [search, setSearch] = useState('')
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items])
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    const used = new Set(lines.map(l => l.item_id))
    return items.filter(i => i.status === 'active' && !used.has(i.id) && i.name.toLowerCase().includes(q)).slice(0, 8)
  }, [search, items, lines])

  function setQty(itemId: string, base: number) {
    onChange(lines.map(l => (l.item_id === itemId ? { ...l, qty_base: base } : l)))
  }
  function flip(itemId: string) {
    onChange(lines.map(l => (l.item_id === itemId ? { ...l, qty_base: -l.qty_base } : l)))
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
              <button type="button" className="text-xs text-red-700" onClick={() => onChange(lines.filter(x => x.item_id !== l.item_id))}>Remove</button>
            </div>
          )
        }
        const c = lineCost(l.qty_base, costs.get(l.item_id))
        const neg = l.qty_base < 0
        return (
          <div key={l.item_id} className="bg-white rounded-xl border border-[#E8DDD0] px-3 py-2.5 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-brown-dark">{it.name}{it.status !== 'active' && <span className="ml-2 text-xs text-[#B46309]">Inactive</span>}</p>
                <p className="text-xs text-brown-faint">{qty(Math.abs(l.qty_base))} {it.base_unit} · {c == null ? <span className="text-[#B46309]">No price</span> : money(c)}</p>
              </div>
              <button type="button" className="text-xs text-red-700" onClick={() => onChange(lines.filter(x => x.item_id !== l.item_id))}>Remove</button>
            </div>
            <div className="flex items-start gap-2 flex-wrap">
              {allowNegative && (
                <button type="button" onClick={() => flip(l.item_id)}
                  className={`px-2 h-10 rounded-full text-xs font-semibold border ${neg ? 'border-red-300 text-red-700' : 'border-green-300 text-green-700'}`}>
                  {neg ? 'Removes' : 'Adds'}
                </button>
              )}
              <QtyInputs item={it} value={l.qty_base} negative={neg} onCommit={b => setQty(l.item_id, b)} />
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
                  onClick={() => { onChange([...lines, { item_id: i.id, qty_base: Number(i.conversion_rate) || 1 }]); setSearch('') }}>
                  {i.name} <span className="text-xs text-brown-faint">({i.purchase_unit}, {qty(Number(i.conversion_rate))} {i.base_unit})</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
