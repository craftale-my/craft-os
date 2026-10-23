import { useEffect, useMemo, useState } from 'react'
import { fetchPosMenu, setSoldOut } from './posApi'
import { cartSubtotalSen, findProduct, formatSen, lineLabel, linePriceSen, validateLine, defaultLine, type OrderLine, type PosMenu, type PosProduct } from './cart'
import { noCatalogMessage } from './catalogs'
import { newQueuedOrder } from '../offline/orderQueue'
import type { QueuedOrder } from '../offline/orderQueue'
import type { SubmitResult } from './useOrderQueue'
import LineSheet from './LineSheet'

export type PadMode = ({ orderType: 'dine_in'; tableId: string; needsPax: boolean; initialPax?: number } | { orderType: 'takeaway' })
type Mode = PadMode

export default function OrderPad({ branchId, mode, catalogId, catalogsLoaded, initialLines, submit, onClose, onSent }: {
  branchId: string; mode: Mode
  /** The branch's catalog for this order type; null = none set (or not loaded yet). */
  catalogId: string | null; catalogsLoaded: boolean
  initialLines?: OrderLine[]
  submit: (o: QueuedOrder) => Promise<SubmitResult>
  onClose: () => void; onSent: () => void
}) {
  const [menu, setMenu] = useState<PosMenu | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState<OrderLine[]>(initialLines ?? [])
  const [sheet, setSheet] = useState<{ product: PosProduct; index: number | null } | null>(null)
  const [pax, setPax] = useState<string>(mode.orderType === 'dine_in' && mode.initialPax ? String(mode.initialPax) : '')
  const [soldOutMode, setSoldOutMode] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => { setError(null) }, [lines, pax])

  const load = async () => {
    if (!catalogId) { setMenu(null); return }
    try { setMenu(await fetchPosMenu(branchId, catalogId)); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void load() }, [branchId, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps
  const noCatalog = catalogsLoaded && !catalogId

  const products = useMemo(() => {
    if (!menu) return []
    const all = menu.categories.flatMap((c) => c.products.map((p) => ({ ...p, category: c.name })))
    const q = search.trim().toLowerCase()
    return all.filter((p) => (q ? p.name.toLowerCase().includes(q) : !category || p.category === category))
  }, [menu, category, search])

  const tap = async (p: PosProduct) => {
    if (soldOutMode) {
      try { await setSoldOut(branchId, p.id, !p.soldOut); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
      return
    }
    if (p.soldOut) return
    if (p.variants.length === 1 && p.groups.length === 0) setLines((ls) => [...ls, defaultLine(p)])
    else setSheet({ product: p, index: null })
  }

  const send = async () => {
    if (!menu || lines.length === 0) return
    const needPax = mode.orderType === 'dine_in' && mode.needsPax
    const paxNum = needPax ? Number(pax) : null
    if (needPax && (!Number.isInteger(paxNum) || (paxNum as number) < 1 || (paxNum as number) > 99)) { setError('Enter the number of guests (1–99)'); return }
    for (const l of lines) {
      const p = findProduct(menu, l.productId)
      const problem = p ? validateLine(p, l) : 'Item is no longer on the menu'
      if (problem) { setError(problem); return }
    }
    setSending(true)
    try {
      const res = await submit(newQueuedOrder(mode.orderType, mode.orderType === 'dine_in' ? mode.tableId : null, paxNum, lines))
      if (res.rejectedReason) { setError(`Rejected: ${res.rejectedReason} — fix the order and send again`); await load(); return }
      setLines([]); setError(null); onSent()
    } catch (e) {
      setError(`Order NOT saved on this iPad: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setSending(false) }
  }

  const subtotal = menu ? cartSubtotalSen(menu, lines) : 0
  return (
    <div className="fixed inset-0 z-10 grid grid-cols-[1fr_360px] bg-cream">
      <div className="flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border bg-card p-2">
          <button onClick={onClose} className="rounded-lg border border-border px-3 py-2">← Tables</button>
          <input className="flex-1 rounded-lg border border-border p-2 text-sm" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button onClick={() => setSoldOutMode((v) => !v)} className={`rounded-lg px-3 py-2 text-sm ${soldOutMode ? 'bg-red-600 text-white' : 'border border-border'}`}>
            {soldOutMode ? 'Tap items to mark sold out · Done' : 'Sold out…'}
          </button>
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-border bg-card p-2">
          {menu?.categories.map((c) => (
            <button key={c.name} onClick={() => { setCategory(c.name); setSearch('') }}
              className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${category === c.name && !search ? 'bg-brown-btn text-white' : 'border border-border'}`}>
              {c.name}
            </button>
          ))}
        </div>
        {error && <p className="m-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto p-2">
          {noCatalog && <p className="col-span-4 rounded bg-red-50 p-2 text-sm text-red-700">{noCatalogMessage(mode.orderType)}</p>}
          {!menu && !error && !noCatalog && <p className="text-brown-muted">Loading menu…</p>}
          {products.map((p) => (
            <button key={p.id} onClick={() => void tap(p)}
              className={`min-h-20 rounded-xl border p-2 text-left text-sm ${p.soldOut ? 'border-red-300 bg-red-50 text-red-700' : 'border-border bg-card'}`}>
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-brown-muted">{p.variants.length > 1 ? `${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))} –` : formatSen(p.variants[0].priceSen)}{p.soldOut && ' · SOLD OUT'}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col border-l border-border bg-card">
        <div className="border-b border-border p-3 font-semibold">{mode.orderType === 'takeaway' ? 'Takeaway' : 'Dine-in'} order</div>
        <div className="flex-1 overflow-y-auto p-3 text-sm">
          {lines.map((l, i) => {
            const p = menu ? findProduct(menu, l.productId) : undefined
            if (!p) return (
              <div key={i} className="mb-2 flex justify-between text-red-700">
                <span>Unavailable item</span>
                <button className="text-xs underline" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>remove</button>
              </div>
            )
            const { name, mods } = lineLabel(p, l)
            const unit = linePriceSen(p, l) ?? 0
            return (
              <div key={i} className="mb-2 flex justify-between">
                <button className="text-left" onClick={() => setSheet({ product: p, index: i })}>
                  {l.qty} × {name}
                  {mods.map((m) => <div key={m} className="pl-4 text-xs text-brown-muted">+ {m}</div>)}
                  {l.note && <div className="pl-4 text-xs italic text-brown-muted">* {l.note}</div>}
                </button>
                <div className="text-right">
                  <div>{formatSen(unit * l.qty)}</div>
                  <button className="text-xs text-red-700 underline" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>remove</button>
                </div>
              </div>
            )
          })}
          {lines.length === 0 && <p className="text-brown-muted">Tap items to add them.</p>}
        </div>
        <div className="border-t border-border p-3">
          {mode.orderType === 'dine_in' && mode.needsPax && (
            <label className="mb-2 block text-sm">Guests
              <input inputMode="numeric" className="ml-2 w-16 rounded border border-border p-1" value={pax} onChange={(e) => setPax(e.target.value)} />
            </label>
          )}
          <div className="flex justify-between text-sm"><span>Subtotal</span><b>{formatSen(subtotal)}</b></div>
          <button disabled={sending || lines.length === 0} onClick={() => void send()}
            className="mt-2 w-full rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {sending ? 'Saving…' : 'Send order'}
          </button>
        </div>
      </div>

      {sheet && (
        <LineSheet product={sheet.product} initial={sheet.index === null ? undefined : lines[sheet.index]}
          onCancel={() => setSheet(null)}
          onDone={(line) => { setLines((ls) => sheet.index === null ? [...ls, line] : ls.map((x, k) => (k === sheet.index ? line : x))); setSheet(null) }} />
      )}
    </div>
  )
}
