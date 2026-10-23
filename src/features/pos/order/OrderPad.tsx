import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchPosMenu, setSoldOut } from './posApi'
import { cartSubtotalSen, findProduct, formatSen, lineLabel, linePriceSen, validateLine, defaultLine, type OrderLine, type PosMenu, type PosProduct } from './cart'
import { noCatalogMessage, SWITCH_CATALOG_CONFIRM, type CatalogChoice } from './catalogs'
import { newQueuedOrder } from '../offline/orderQueue'
import type { QueuedOrder } from '../offline/orderQueue'
import type { SubmitResult } from './useOrderQueue'
import LineSheet from './LineSheet'
import ProductTiles from './ProductTiles'
import { usePadWindows } from './usePadWindows'

export type PadMode = ({ orderType: 'dine_in'; tableId: string; needsPax: boolean; initialPax?: number } | { orderType: 'takeaway' })
type Mode = PadMode

export default function OrderPad({
  branchId, mode, catalogs, defaultProblem, catalogsError, onRetryCatalogs, initialCatalogId, initialLines, submit, onClose, onSent,
}: {
  branchId: string; mode: Mode
  /** What this order may be priced from, the order type's default first; null until the
   *  branch's catalogs have been fetched for this pad (never a stale list). */
  catalogs: CatalogChoice[] | null
  /** Why the order type has no usable default (none set, or switched off); null when it has one. */
  defaultProblem: string | null
  /** The branch's catalogs could not be fetched and this iPad has no earlier list. */
  catalogsError: string | null
  onRetryCatalogs: () => void
  /** A rejected order being edited keeps its catalog. */
  initialCatalogId?: string | null
  initialLines?: OrderLine[]
  submit: (o: QueuedOrder) => Promise<SubmitResult>
  onClose: () => void; onSent: () => void
}) {
  const [catalogId, setCatalogId] = useState<string | null>(initialCatalogId ?? null)
  const [menu, setMenu] = useState<PosMenu | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState<OrderLine[]>(initialLines ?? [])
  const [sheet, setSheet] = useState<{ product: PosProduct; index: number | null } | null>(null)
  const [pax, setPax] = useState<string>(mode.orderType === 'dine_in' && mode.initialPax ? String(mode.initialPax) : '')
  const [soldOutMode, setSoldOutMode] = useState(false)
  const [sending, setSending] = useState(false)
  const [carry, setCarry] = useState<{ lines: OrderLine[]; to: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const loadSeq = useRef(0)
  // load() is also called after awaits (sold-out toggle, rejected send) from a closure of an
  // older render, so it reads the catalog from here and never from its own closure.
  const catalogIdRef = useRef(catalogId)
  useEffect(() => { catalogIdRef.current = catalogId }, [catalogId])
  const slots = usePadWindows(catalogId)                    // M3: time slots, re-read every minute

  useEffect(() => { setError(null) }, [lines, pax])

  // Only the order type's default is ever picked for the cashier. With no usable default
  // the pad says why and waits for an explicit pick (never an additional catalog by itself).
  useEffect(() => {
    if (!catalogs) return
    const def = catalogs.find((c) => c.isDefault)
    // belt and braces: a catalog the fresh list does not offer, that is not the edited
    // order's own, is dropped while the cart is still empty
    if (catalogId !== null && catalogId !== (initialCatalogId ?? null) && lines.length === 0
        && !catalogs.some((c) => c.id === catalogId)) {
      setCatalogId(def?.id ?? null)
      return
    }
    if (catalogId === null && def) setCatalogId(def.id)
  }, [catalogs, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    const seq = ++loadSeq.current                // a slow reply for the previous catalog must not win
    const id = catalogIdRef.current
    if (!id) { setMenu(null); return }
    try {
      const m = await fetchPosMenu(id)
      if (seq === loadSeq.current) { setMenu(m); setError(null) }
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => { void load() }, [branchId, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = catalogs?.find((c) => c.id === catalogId) ?? null
  const noCatalog = catalogs !== null && catalogId === null && !catalogs.some((c) => c.isDefault)

  // One order = one catalog: switching starts the cart again. Leaving the catalog of an
  // edited order that the branch no longer offers keeps what the new catalog also sells.
  const switchCatalog = (id: string) => {
    if (!id || id === catalogId) return
    const carrying = lines.length > 0 && !!current && !current.offered
    if (!carrying && lines.length > 0 && !window.confirm(SWITCH_CATALOG_CONFIRM)) return
    // A carry waits for its own catalog's menu: the cart stays untouched until then (and for
    // good if that menu fails to load); any other switch drops a carry still pending.
    setCarry(carrying ? { lines, to: id } : null)
    if (!carrying) setLines([])
    setSheet(null); setMenu(null); setCategory(null); setNotice(null); setCatalogId(id)
  }
  useEffect(() => {
    if (!carry || !menu || carry.to !== catalogId) return
    const kept = carry.lines.filter((l) => {
      const p = findProduct(menu, l.productId)
      return p !== undefined && validateLine(p, l) === null
    })
    setLines(kept)
    if (kept.length < carry.lines.length) setNotice(`Items not in ${current?.name ?? 'this catalog'} were removed`)
    setCarry(null)
  }, [menu, carry, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const products = useMemo(() => {
    if (!menu) return []
    const all = menu.categories.flatMap((c) => c.products.map((p) => ({ ...p, category: c.name })))
    const q = search.trim().toLowerCase()
    return all.filter((p) => (q ? p.name.toLowerCase().includes(q) : !category || p.category === category))
  }, [menu, category, search])

  const tap = async (p: PosProduct, outOfSlot: boolean) => {
    if (soldOutMode) {
      try { await setSoldOut(branchId, p.id, !p.soldOut); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
      return
    }
    if (p.soldOut || outOfSlot) return
    if (p.variants.length === 1 && p.groups.length === 0) setLines((ls) => [...ls, defaultLine(p)])
    else setSheet({ product: p, index: null })
  }

  const send = async () => {
    if (!menu || lines.length === 0) return
    if (!catalogId) { setError(noCatalogMessage(mode.orderType)); return }
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
      const late = await slots.check(lines, (id) => findProduct(menu, id)?.name ?? 'An item')
      if (late) { setError(late); return }                   // the server would refuse it with the same words
      const res = await submit(newQueuedOrder(mode.orderType, mode.orderType === 'dine_in' ? mode.tableId : null, paxNum, lines,
        Date.now(), crypto.randomUUID(), catalogId))
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
          {catalogs && catalogs.length > 0 && (
            <select aria-label="Catalog" value={catalogId ?? ''} disabled={sending} onChange={(e) => switchCatalog(e.target.value)}
              className={`rounded-lg border p-2 text-sm ${current && !current.isDefault ? 'border-amber-500 bg-amber-50' : 'border-border'}`}>
              {catalogId === null && <option value="" disabled>Choose a catalog…</option>}
              {catalogs.map((c) => <option key={c.id} value={c.id}>{c.name}{c.offered ? '' : ' (no longer offered)'}</option>)}
            </select>
          )}
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
        {notice && <p className="m-2 rounded bg-amber-50 p-2 text-sm text-amber-800">{notice}</p>}
        <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto p-2">
          {catalogs === null && catalogsError && (
            <p className="col-span-4 rounded bg-red-50 p-2 text-sm text-red-700">
              Could not load the menu catalogs: {catalogsError}{' '}
              <button className="underline" onClick={onRetryCatalogs}>Retry</button>
            </p>
          )}
          {noCatalog && (
            <p className="col-span-4 rounded bg-red-50 p-2 text-sm text-red-700">
              {defaultProblem ?? noCatalogMessage(mode.orderType)}
              {catalogs.length > 0 && ' — or choose a catalog above for this order.'}
            </p>
          )}
          {!menu && !error && !noCatalog && !(catalogs === null && catalogsError) && <p className="text-brown-muted">Loading menu…</p>}
          <ProductTiles products={products} windows={slots.windows} now={slots.now} soldOutMode={soldOutMode} onTap={(p, outOfSlot) => void tap(p, outOfSlot)} />
        </div>
      </div>

      <div className="flex flex-col border-l border-border bg-card">
        <div className="border-b border-border p-3 font-semibold">
          {mode.orderType === 'takeaway' ? 'Takeaway' : 'Dine-in'} order
          {current && <span className={`ml-2 text-sm font-normal ${current.isDefault ? 'text-brown-muted' : 'text-amber-700'}`}>· {current.name}</span>}
        </div>
        <div className="flex-1 overflow-y-auto p-3 text-sm">
          {carry && !menu && !error && <p className="text-brown-muted">Loading menu…</p>}
          {!(carry && !menu && !error) && lines.map((l, i) => {
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
