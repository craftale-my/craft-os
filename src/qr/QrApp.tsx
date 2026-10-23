import { useEffect, useRef, useState, type ReactNode } from 'react'
import { qrClient } from './qrClient'
import { tokenFromLocation, addLine, replaceLine, removeLine, leftTheMenu, leftTheMenuNotice, pruneAfterRefresh } from './qrState'
import {
  cartKey, cartSubtotalSen, findProduct, formatSen, lineLabel, linePriceSen, posMenuFromQr,
  type OrderLine, type PosMenu, type PosProduct, type QrMenuJson,
} from '../features/pos/order/cart'
import LineSheet from '../features/pos/order/LineSheet'

interface TableState {
  tableLabel: string
  billNo: string | null
  pax: number | null
  items: { name: string; qty: number; unitPriceSen: number; mods: string[]; note: string | null; voided: boolean }[]
  subtotalSen: number
}
type Screen = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error' } | { kind: 'ready'; info: QrMenuJson; menu: PosMenu }

/** M3: a photo path in the public menu-images bucket → its URL (no request is made). */
const photoUrl = (path: string) => qrClient.storage.from('menu-images').getPublicUrl(path).data.publicUrl
const REFRESH_MS = 60_000

export default function QrApp() {
  const token = tokenFromLocation(window.location.pathname, window.location.search)
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [state, setState] = useState<TableState | null>(null)
  const [lines, setLines] = useState<OrderLine[]>([])
  const [sheet, setSheet] = useState<{ product: PosProduct; index: number | null } | null>(null)
  const [pax, setPax] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [placed, setPlaced] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const pending = useRef<{ id: string; key: string } | null>(null)   // one client_order_id per distinct cart
  // M3: the minute refresh reads these, not a stale closure
  const linesRef = useRef(lines)
  useEffect(() => { linesRef.current = lines }, [lines])
  const menuRef = useRef<PosMenu | null>(null)
  useEffect(() => { menuRef.current = screen.kind === 'ready' ? screen.menu : null }, [screen])
  const refreshSeq = useRef(0)                                       // a slow reply never lands after a newer one

  const loadState = async () => {
    const { data } = await qrClient.rpc('qr_table_state', { p_token: token })
    if (data) setState(data as TableState)
  }
  const loadMenu = () => {
    if (!token) { setScreen({ kind: 'invalid' }); return }
    setScreen({ kind: 'loading' })
    qrClient.rpc('qr_menu', { p_token: token }).then(({ data, error }) => {
      if (error) { setScreen({ kind: 'error' }); return }
      if (!data) { setScreen({ kind: 'invalid' }); return }
      const info = data as QrMenuJson
      setScreen({ kind: 'ready', info, menu: posMenuFromQr(info, photoUrl) })
      setCategory(info.categories[0]?.name ?? null)
      void loadState()
    }, () => setScreen({ kind: 'error' }))
  }
  useEffect(() => { loadMenu() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // M3: read the menu again every minute while the page is in view, and when it comes back into
  // view, quietly: products whose time slot ends leave the menu (and the cart, with a notice; an
  // open product sheet for one closes; a sheet editing another line follows that line), products
  // whose slot starts appear. A failed read keeps the menu on screen; nothing changes while an
  // order is being sent; the server refuses anything out of its slot anyway.
  const ready = screen.kind === 'ready'
  useEffect(() => {
    if (!ready || !token) return
    const refresh = () => {
      if (document.visibilityState !== 'visible' || sendingRef.current) return
      const mine = ++refreshSeq.current
      qrClient.rpc('qr_menu', { p_token: token }).then(({ data, error }) => {
        if (mine !== refreshSeq.current || error || !data || !menuRef.current || sendingRef.current) return
        const info = data as QrMenuJson
        const menu = posMenuFromQr(info, photoUrl)
        const cart = linesRef.current
        const gone = leftTheMenu(cart, menu, menuRef.current)
        setScreen({ kind: 'ready', info, menu })
        setCategory((c) => (c && info.categories.some((x) => x.name === c) ? c : info.categories[0]?.name ?? null))
        // the sheet's line index points into the cart before the refresh: follow that line, or close
        setSheet((s) => {
          if (!s || !findProduct(menu, s.product.id)) return null
          if (s.index === null) return s
          const { index } = pruneAfterRefresh(cart, menu, s.index)
          return index === null ? null : { ...s, index }
        })
        if (gone.length > 0) {
          setLines(pruneAfterRefresh(cart, menu, null).lines)
          setNotice(leftTheMenuNotice(gone))
        }
      }, () => { /* offline for a moment: try again next minute */ })
    }
    const timer = setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [ready, token])

  if (screen.kind === 'loading') return <Shell><p className="p-6 text-center text-brown-muted">Loading menu…</p></Shell>
  if (screen.kind === 'error') {
    return (
      <Shell>
        <div className="p-6 text-center">
          <p>Could not load the menu. Check your connection and try again.</p>
          <button onClick={loadMenu} className="mt-3 rounded-xl bg-brown-btn px-5 py-2 text-white">Try again</button>
        </div>
      </Shell>
    )
  }
  if (screen.kind === 'invalid') return <Shell><p className="p-6 text-center">This table code is not valid. Please order at the counter.</p></Shell>
  const { info, menu } = screen
  if (info.paused) return <Shell title={`Table ${info.tableLabel}`}><p className="p-6 text-center">Ordering from this table is paused. Please order at the counter.</p></Shell>

  const needsPax = info.needsPax && !state?.pax
  const subtotal = cartSubtotalSen(menu, lines)

  const place = async () => {
    if (lines.length === 0 || sending || sendingRef.current) return
    const paxNum = needsPax ? Number(pax) : null
    if (needsPax && (!Number.isInteger(paxNum) || (paxNum as number) < 1 || (paxNum as number) > 99)) { setError('How many people are at the table? (1–99)'); return }
    const key = cartKey(lines)
    if (!pending.current || pending.current.key !== key) pending.current = { id: crypto.randomUUID(), key }
    sendingRef.current = true; setSending(true); setError(null)
    try {
      const { error } = await qrClient.rpc('place_table_order', { p_token: token, p_pax: paxNum, p_items: lines, p_client_order_id: pending.current.id })
      if (error) throw new Error(error.message)
      pending.current = null
      setLines([]); setPlaced(true); setNotice(null)
      await loadState()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg === 'Failed to fetch' || msg.includes('NetworkError')
        ? 'Not sent: no connection — tap Place order to try again.'
        : `Not sent: ${msg} — tap Place order to try again.`)
    } finally { sendingRef.current = false; setSending(false) }
  }

  const products = menu.categories.find((c) => c.name === category)?.products ?? []
  return (
    <Shell title={`Table ${info.tableLabel}`}>
      {placed && (
        <div className="m-3 rounded-xl bg-green-50 p-3 text-sm text-green-800">
          Order placed — it is on its way. You can add more below.
        </div>
      )}
      {state && state.items.length > 0 && (
        <details className="m-3 rounded-xl border border-border bg-card p-3 text-sm">
          <summary>Ordered so far · {formatSen(state.subtotalSen)}</summary>
          {state.items.map((i, k) => (
            <div key={k} className={`flex justify-between py-1 ${i.voided ? 'line-through opacity-50' : ''}`}>
              <span>{i.qty} × {i.name}{i.mods.length > 0 && <span className="text-brown-muted"> · {i.mods.join(', ')}</span>}</span>
              <span>{formatSen(i.unitPriceSen * i.qty)}</span>
            </div>
          ))}
        </details>
      )}
      <div className="flex gap-1 overflow-x-auto px-3 py-2">
        {menu.categories.map((c) => (
          <button key={c.name} onClick={() => setCategory(c.name)}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${category === c.name ? 'bg-brown-btn text-white' : 'border border-border bg-card'}`}>{c.name}</button>
        ))}
      </div>
      <div className={`space-y-2 px-3 ${lines.length > 0 ? 'pb-[50vh]' : notice ? 'pb-48' : 'pb-24'}`}>
        {products.filter((p) => p.variants.length > 0).map((p) => (
          <button key={p.id} disabled={p.soldOut} onClick={() => setSheet({ product: p, index: null })}
            className="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left disabled:opacity-50">
            {p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-lg object-cover" />}
            <div className="flex-1">
              <div className="font-medium">{p.name}{p.soldOut && <span className="ml-2 text-xs text-red-700">Sold out</span>}</div>
              {p.description && <div className="text-xs text-brown-muted">{p.description}</div>}
            </div>
            <div className="text-sm">{p.variants.length > 1 ? `from ${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))}` : formatSen(p.variants[0].priceSen)}</div>
          </button>
        ))}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-card p-3 text-sm shadow-lg">
        <div className="max-h-[40vh] overflow-y-auto">
        {lines.map((l, i) => {
          const p = findProduct(menu, l.productId)
          if (!p) return null
          const { name, mods } = lineLabel(p, l)
          return (
            <div key={i} className="flex justify-between py-1">
              <button className="text-left" onClick={() => setSheet({ product: p, index: i })}>
                {l.qty} × {name}{mods.length > 0 && <span className="text-brown-muted"> · {mods.join(', ')}</span>}
              </button>
              <span>{formatSen((linePriceSen(p, l) ?? 0) * l.qty)} <button className="ml-2 text-red-700" onClick={() => setLines(removeLine(lines, i))}>✕</button></span>
            </div>
          )
        })}
        {needsPax && lines.length > 0 && (
          <label className="my-1 block">How many people? <input inputMode="numeric" className="ml-2 w-16 rounded border border-border p-1 text-base" value={pax} onChange={(e) => setPax(e.target.value)} /></label>
        )}
        {notice && <p role="status" className="my-1 rounded bg-amber-50 p-2 text-amber-900">{notice}</p>}
        {error && <p className="my-1 text-red-700">{error}</p>}
        </div>
        <button disabled={lines.length === 0 || sending} onClick={() => void place()}
          className="mt-1 w-full rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">
          {sending ? 'Sending…' : lines.length === 0 ? 'Tap an item to start' : `Place order · ${formatSen(subtotal)}`}
        </button>
      </div>

      {sheet && (
        <LineSheet product={sheet.product} initial={sheet.index === null ? undefined : lines[sheet.index]}
          onCancel={() => setSheet(null)}
          onDone={(line) => { setLines(sheet.index === null ? addLine(lines, line) : replaceLine(lines, sheet.index, line)); setSheet(null); setPlaced(false); setNotice(null) }} />
      )}
    </Shell>
  )
}

function Shell({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <header className="bg-brown-header px-4 py-3 text-white">
        <div className="text-xs opacity-80">Craft Cafe</div>
        <div className="text-lg font-semibold">{title ?? 'Order'}</div>
      </header>
      {children}
    </div>
  )
}
