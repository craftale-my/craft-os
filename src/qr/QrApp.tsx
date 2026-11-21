import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { qrClient } from './qrClient'
import { tokenFromLocation } from './qrState'
import {
  findProduct, formatSen, lineLabel, linePriceSen, posMenuFromQr,
  type OrderLine, type PosMenu, type PosProduct, type QrMenuJson,
} from '../features/pos/order/cart'
import { goesWellVisible, mostPickedFor, offerPairs, pairsFor, parsePicks, visiblePopular, type MenuPicks } from '../features/pos/order/picks'
import LineSheet from '../features/pos/order/LineSheet'
import PickPill from '../features/pos/order/PickPill'
import { avatarEmoji, loadGuest, newGuest, saveGuest, type Guest } from './qrGuest'
import {
  additionsToast, cartChannel, cartTotalSen, groupCart, groupOrdered, isNetworkError, lineAvailable, orderWasSent, sendGroups, sentKey, skipIds,
  type CartLine, type CartState, type OrderedItem,
} from './qrCart'
import { makeCartApi, makeCartSignal } from './qrCartApi'
import { useTableCart } from './useTableCart'
import GuestCard from './GuestCard'
import SendSheet from './SendSheet'

interface TableState {
  tableLabel: string
  billNo: string | null
  pax: number | null
  items: OrderedItem[]
  subtotalSen: number
}
type Screen = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error' } | { kind: 'ready'; info: QrMenuJson; menu: PosMenu }

/** M3: a photo path in the public menu-images bucket → its URL (no request is made). */
const photoUrl = (path: string) => qrClient.storage.from('menu-images').getPublicUrl(path).data.publicUrl
const REFRESH_MS = 60_000
/** picks: read with the menu, then again with the minute refresh at most this often */
const PICKS_REFRESH_MS = 10 * 60_000
const TOAST_MS = 4_000

/** "RM 9.00", or "from RM 9.00" when the product has several sizes. */
const priceText = (p: PosProduct) =>
  p.variants.length > 1 ? `from ${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))}` : formatSen(p.variants[0].priceSen)
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function QrApp() {
  const token = tokenFromLocation(window.location.pathname, window.location.search)
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [state, setState] = useState<TableState | null>(null)
  // table cart (docs/superpowers/specs/2026-11-22-qr-shared-table-cart-design.md): who this phone is
  const [guest, setGuest] = useState<Guest | null>(() => (token ? loadGuest(token) : null))
  const guestRef = useRef(guest)
  useEffect(() => { guestRef.current = guest }, [guest])
  const [guestEdit, setGuestEdit] = useState(false)                  // the card, reopened from the header
  const [sheet, setSheet] = useState<{ product: PosProduct; lineId: string | null } | null>(null)
  const [sheetBusy, setSheetBusy] = useState(false)
  const [sheetError, setSheetError] = useState<string | null>(null)
  const [pax, setPax] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)           // the cart panel: a removal that failed
  const [sendOpen, setSendOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendMessage, setSendMessage] = useState<string | null>(null)
  const [placed, setPlaced] = useState(false)
  const [toast, setToast] = useState<{ text: string; at: number } | null>(null)   // `at` restarts the timer for the same text twice
  const sendingRef = useRef(false)
  const seen = useRef<string | null>(null)                           // sentKey of the cart the sender last looked at (spec §2)
  const adoptSeen = useRef(false)                                    // after a refused send: take the re-read cart as seen
  const pending = useRef<{ id: string; key: string } | null>(null)   // one client_order_id per distinct cart sent
  const menuRef = useRef<PosMenu | null>(null)
  useEffect(() => { menuRef.current = screen.kind === 'ready' ? screen.menu : null }, [screen])
  const refreshSeq = useRef(0)                                       // a slow reply never lands after a newer one
  const refreshNow = useRef<(() => void) | null>(null)               // the minute refresh, callable after a refused send
  // picks (docs/superpowers/specs/2026-11-17-menu-picks-design.md §4): hints only. A failed first read
  // leaves them hidden, a failed re-read keeps the last ones; ordering never waits on them.
  const [picks, setPicks] = useState<MenuPicks | null>(null)
  const picksAt = useRef(0)                                          // when picks last LOADED; 0 until they have
  const picksSeq = useRef(0)                                         // an older reply never overwrites a newer one
  const picksLoaded = useRef(false)
  const [goesWellFor, setGoesWellFor] = useState<string | null>(null)   // the product the Goes well with panel is about
  const pairsShown = useRef(new Set<string>())                           // Goes well with: once per product per visit

  const loadState = async (): Promise<TableState | null> => {
    const { data } = await qrClient.rpc('qr_table_state', { p_token: token })
    if (!data) return null
    setState(data as TableState)
    return data as TableState
  }
  const loadPicks = () => {
    if (!token) return
    const mine = ++picksSeq.current
    qrClient.rpc('qr_picks', { p_token: token }).then(
      ({ data, error }) => {
        if (error || mine !== picksSeq.current) return
        picksAt.current = Date.now(); picksLoaded.current = true
        setPicks(parsePicks(data))
      },
      () => { /* offline for a moment: the last picks stay */ },
    )
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
      loadPicks()
    }, () => setScreen({ kind: 'error' }))
  }
  useEffect(() => { loadMenu() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // M3: read the menu again every minute while the page is in view, and when it comes back into
  // view, quietly: products whose time slot ends leave the menu (an open product sheet for one
  // closes; a cart line for one shows "Not available now" — the cart itself lives on the server),
  // products whose slot starts appear. A failed read keeps the menu on screen; nothing changes while
  // an order is being sent; the server refuses anything out of its slot anyway. The picks are read
  // again with it at most every PICKS_REFRESH_MS.
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
        setScreen({ kind: 'ready', info, menu })
        setCategory((c) => (c && info.categories.some((x) => x.name === c) ? c : info.categories[0]?.name ?? null))
        setSheet((s) => (s && findProduct(menu, s.product.id) ? s : null))
        void loadState()                                            // "Ordered so far" picks up what the counter added
        if (!picksLoaded.current || Date.now() - picksAt.current >= PICKS_REFRESH_MS) loadPicks()
      }, () => { /* offline for a moment: try again next minute */ })
    }
    refreshNow.current = refresh
    const timer = setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => { refreshNow.current = null; clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [ready, token]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── the table's shared cart ──
  const [topic, setTopic] = useState<string | null>(null)
  useEffect(() => {
    if (!token) return
    let live = true
    cartChannel(token).then((t) => { if (live) setTopic(t) }, () => { /* no channel: the 15 s read still runs */ })
    return () => { live = false }
  }, [token])
  const api = useMemo(() => (token ? makeCartApi(qrClient, token) : null), [token])
  const signal = useMemo(() => (topic ? makeCartSignal(qrClient, topic) : null), [topic])
  const table = useTableCart(ready ? api : null, ready ? signal : null, (before: CartState | null, after: CartState) => {
    const menu = menuRef.current
    const me = guestRef.current
    if (menu && me) {
      const text = additionsToast(before, after, me.id, menu)
      if (text) setToast({ text, at: Date.now() })
    }
    setError(null)                                                  // a failed removal's message goes when the cart moves on
    // an order was sent from this table's cart (from any phone): the server says so, not a count
    if (orderWasSent(before, after)) { setSendOpen(false); setPlaced(true); void loadState() }
    else if (after.lines.length === 0) setSendOpen(false)           // the last line went: nothing left to send
  })
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])
  // after a refused send ('changed'): the cart as re-read is what the sender sees now
  useEffect(() => {
    if (!adoptSeen.current || !table.cart || screen.kind !== 'ready') return
    seen.current = sentKey(table.cart, skipIds(screen.menu, table.cart.lines))
    adoptSeen.current = false
  })
  // the send sheet closes itself when nothing is sendable any more, so it cannot reopen later with a stale message
  useEffect(() => {
    if (!sendOpen) return
    const lines = table.cart?.lines ?? []
    if (screen.kind !== 'ready' || !guest || sendGroups(screen.menu, lines, guest.id).length === 0) {
      setSendOpen(false); setSendMessage(null); setSendError(null)
    }
  }, [sendOpen, screen, guest, table.cart])
  // the item sheet closes when the line it edits is gone
  useEffect(() => {
    if (!sheet || sheet.lineId === null || sheetBusy || !table.cart || !guest) return
    if (!table.cart.lines.some((l) => l.id === sheet.lineId && l.guestId === guest.id)) setSheet(null)
  }, [sheet, sheetBusy, table.cart, guest])

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
  if (screen.kind === 'invalid' || !token) return <Shell><p className="p-6 text-center">This table code is not valid. Please order at the counter.</p></Shell>
  const { info, menu } = screen
  if (info.paused) return <Shell title={`Table ${info.tableLabel}`}><p className="p-6 text-center">Ordering from this table is paused. Please order at the counter.</p></Shell>
  if (!guest) {
    return (
      <Shell title={`Table ${info.tableLabel}`}>
        <GuestCard initial={null} onDone={(name, avatar) => { const g = newGuest(name, avatar); saveGuest(token, g); setGuest(g) }} />
      </Shell>
    )
  }

  const cartLines: CartLine[] = table.cart?.lines ?? []
  const { mine, others } = groupCart(cartLines, guest.id)
  const sendable = sendGroups(menu, cartLines, guest.id)
  const subtotal = cartTotalSen(menu, cartLines)
  const needsPax = info.needsPax && !state?.pax
  // picks, filtered to what this menu offers now; "in the cart" = anywhere in the table's cart
  const popular = visiblePopular(menu, picks)
  const popularIds = new Set(popular.map((p) => p.id))
  const goesWell = goesWellFor ? pairsFor(menu, picks, goesWellFor, cartLines) : []
  const goesWellName = goesWellFor ? findProduct(menu, goesWellFor)?.name ?? null : null
  const showGoesWell = goesWell.length > 0 && goesWellName !== null && goesWellVisible(goesWellFor, cartLines)

  /** The sheet's Add: the line goes to the table's cart on the server. A new line may open Goes well
   *  with (once per product per visit). */
  const done = async (line: OrderLine) => {
    if (!sheet || sheetBusy) return
    const isNew = sheet.lineId === null
    setSheetBusy(true); setSheetError(null)
    try {
      if (sheet.lineId === null) await table.add(guest, line)
      else await table.replace(guest, sheet.lineId, line)
      setSheet(null); setPlaced(false); setError(null)
      if (isNew) {
        const offer = offerPairs(menu, picks, line.productId, [...cartLines, line], pairsShown.current)
        if (offer) pairsShown.current.add(line.productId)
        setGoesWellFor(offer ? line.productId : null)
      }
    } catch (e) {
      const msg = errorText(e)
      setSheetError(isNetworkError(msg) ? 'Not added — no connection. Tap Add to try again.' : `Not added: ${msg}`)
    } finally { setSheetBusy(false) }
  }

  const remove = async (lineId: string) => {
    setError(null)
    try { await table.remove(guest.id, lineId) } catch (e) {
      const msg = errorText(e)
      setError(isNetworkError(msg) ? 'Not removed — no connection. Try again.' : `Not removed: ${msg}`)
    }
  }

  const send = async () => {
    if (sendingRef.current || !table.cart) return
    const paxNum = needsPax ? Number(pax) : null
    if (needsPax && (!Number.isInteger(paxNum) || (paxNum as number) < 1 || (paxNum as number) > 99)) {
      setSendError('How many people are at the table? (1–99)'); return
    }
    const skip = skipIds(menu, cartLines)
    const key = sentKey(table.cart, skip)
    // what is sent is always what the sender saw (spec §2): a change since the sheet opened is shown first
    if (seen.current !== key) {
      seen.current = key; setSendError(null); setSendMessage('The order changed — please check again.'); return
    }
    if (!pending.current || pending.current.key !== key) pending.current = { id: crypto.randomUUID(), key }
    let refused = false
    sendingRef.current = true; setSending(true); setSendError(null); setSendMessage(null)
    try {
      const status = await table.send(paxNum, skip, pending.current.id)
      if (status === 'changed') { adoptSeen.current = true; setSendMessage('The order changed — please check again.'); return }
      pending.current = null
      setSendOpen(false); setPlaced(true); setGoesWellFor(null); setError(null)
      await loadState()
    } catch (e) {
      const msg = errorText(e)
      if (isNetworkError(msg)) setSendError('Not sent: no connection — tap Send to try again.')
      else { setSendError(`Not sent: ${msg}`); refused = true }
    } finally { sendingRef.current = false; setSending(false) }
    // the server refused a line (it left the menu within the last minute): read the menu now, so the
    // line shows as unavailable and the next Send leaves it out
    if (refused) refreshNow.current?.()
  }

  const renameGuest = (name: string, avatar: string) => {
    const g: Guest = { ...guest, name, avatar }
    saveGuest(token, g); setGuest(g); setGuestEdit(false)
    void table.rename(g).catch(() => { /* the next line this guest adds carries the new name */ })
  }

  const products = menu.categories.find((c) => c.name === category)?.products ?? []
  const ordered = groupOrdered(state?.items ?? [])
  const placeLabel = table.status === 'offline' ? 'Reconnecting…'
    : sendable.length === 0 ? 'Tap an item to start' : `Place order · ${formatSen(subtotal)}`
  return (
    <Shell title={`Table ${info.tableLabel}`} right={
      <button type="button" onClick={() => setGuestEdit(true)} aria-label={`You are ${guest.name}. Change name or avatar`}
        className="min-h-11 rounded-full bg-white/15 px-3 text-sm">{avatarEmoji(guest.avatar)} {guest.name}</button>
    }>
      {toast && <div role="status" className="fixed inset-x-3 top-3 z-30 rounded-xl bg-brown-dark px-4 py-3 text-sm text-white shadow-lg">{toast.text}</div>}
      {placed && (
        <div className="m-3 rounded-xl bg-green-50 p-3 text-sm text-green-800">
          Order placed — it is on its way. You can add more below.
        </div>
      )}
      {state && state.items.length > 0 && (
        <details className="m-3 rounded-xl border border-border bg-card p-3 text-sm">
          <summary>Ordered so far · {formatSen(state.subtotalSen)}</summary>
          {ordered.map((g) => (
            <div key={g.label ?? '-counter-'} className="mt-2">
              <div className="text-xs font-semibold text-brown-muted">{g.label === null ? 'Ordered at the counter' : `${avatarEmoji(g.avatar)} ${g.label}`.trim()}</div>
              {g.items.map((i, k) => (
                <div key={k} className={`flex justify-between py-1 ${i.voided ? 'line-through opacity-50' : ''}`}>
                  <span>{i.qty} × {i.name}{i.mods.length > 0 && <span className="text-brown-muted"> · {i.mods.join(', ')}</span>}</span>
                  <span>{formatSen(i.unitPriceSen * i.qty)}</span>
                </div>
              ))}
            </div>
          ))}
        </details>
      )}
      {popular.length > 0 && (
        <section aria-label="Popular here" className="px-3 pt-2">
          <h2 className="text-sm font-semibold text-brown-dark">Popular here</h2>
          <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
            {popular.map((p) => <PickCard key={p.id} product={p} onOpen={() => { setSheetError(null); setSheet({ product: p, lineId: null }) }} />)}
          </div>
        </section>
      )}
      <div className="flex gap-1 overflow-x-auto px-3 py-2">
        {menu.categories.map((c) => (
          <button key={c.name} onClick={() => setCategory(c.name)}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${category === c.name ? 'bg-brown-btn text-white' : 'border border-border bg-card'}`}>{c.name}</button>
        ))}
      </div>
      <div className={`space-y-2 px-3 ${cartLines.length > 0 ? (showGoesWell ? 'pb-[75vh]' : 'pb-[50vh]') : 'pb-24'}`}>
        {products.filter((p) => p.variants.length > 0).map((p) => (
          <button key={p.id} disabled={p.soldOut} onClick={() => { setSheetError(null); setSheet({ product: p, lineId: null }) }}
            className="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left disabled:opacity-50">
            {p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-lg object-cover" />}
            <div className="flex-1">
              <div className="font-medium">
                {p.name}
                {popularIds.has(p.id) && <PickPill text="Popular" />}
                {p.soldOut && <span className="ml-2 text-xs text-red-700">Sold out</span>}
              </div>
              {p.description && <div className="text-xs text-brown-muted">{p.description}</div>}
            </div>
            <div className="text-sm">{priceText(p)}</div>
          </button>
        ))}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-card p-3 text-sm shadow-lg">
        {showGoesWell && (
          <section aria-label="Goes well with" className="mb-2 rounded-xl border border-border bg-cream p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-brown-dark">Goes well with your {goesWellName}</span>
              <button type="button" aria-label="Close" className="-m-1 h-11 w-11 shrink-0" onClick={() => setGoesWellFor(null)}>✕</button>
            </div>
            <div className="mt-1 flex gap-2 overflow-x-auto">
              {goesWell.map((p) => <PickCard key={p.id} product={p} onOpen={() => { setSheetError(null); setSheet({ product: p, lineId: null }) }} />)}
            </div>
          </section>
        )}
        <div className="max-h-[40vh] overflow-y-auto">
          {mine.length > 0 && <div className="text-xs font-semibold uppercase text-brown-muted">Your items</div>}
          {mine.map((l) => (
            <CartRow key={l.id} menu={menu} line={l}
              onEdit={(p) => { setSheetError(null); setSheet({ product: p, lineId: l.id }) }} onRemove={() => void remove(l.id)} />
          ))}
          {others.length > 0 && <div className="mt-2 text-xs font-semibold uppercase text-brown-muted">Others at this table</div>}
          {others.map((g) => (
            <div key={g.guestId}>
              <div className="mt-1 text-xs text-brown-muted">{avatarEmoji(g.avatar)} {g.label}</div>
              {g.lines.map((l) => <CartRow key={l.id} menu={menu} line={l} />)}
            </div>
          ))}
          {error && <p role="alert" className="my-1 text-red-700">{error}</p>}
        </div>
        <button disabled={sendable.length === 0 || table.status !== 'ready'}
          onClick={() => {
            seen.current = table.cart ? sentKey(table.cart, skipIds(menu, cartLines)) : null
            setSendError(null); setSendMessage(null); setSendOpen(true)
          }}
          className="mt-1 w-full rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">
          {placeLabel}
        </button>
      </div>

      {sheet && (
        <LineSheet product={sheet.product} initial={sheet.lineId === null ? undefined : mine.find((l) => l.id === sheet.lineId)}
          mostPicked={mostPickedFor(picks, sheet.product.id)} busy={sheetBusy} error={sheetError} confirmLabel={sheet.lineId === null ? undefined : 'Save'}
          onCancel={() => { if (!sheetBusy) setSheet(null) }}
          onDone={(line) => void done(line)} />
      )}
      {sendOpen && sendable.length > 0 && (
        <SendSheet groups={sendable} menu={menu} totalSen={subtotal} needsPax={needsPax} pax={pax} onPax={setPax}
          sending={sending} message={sendMessage} error={sendError}
          onSend={() => void send()} onCancel={() => setSendOpen(false)} />
      )}
      {guestEdit && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={() => setGuestEdit(false)}>
          <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <GuestCard initial={guest} onDone={renameGuest} onCancel={() => setGuestEdit(false)} />
          </div>
        </div>
      )}
    </Shell>
  )
}

/** One line of the table's cart. With onEdit / onRemove it is the guest's own; without, someone else's
 *  (read-only). A line the menu no longer offers is struck through and says so. */
function CartRow({ menu, line, onEdit, onRemove }: {
  menu: PosMenu
  line: CartLine
  onEdit?: (product: PosProduct) => void
  onRemove?: () => void
}) {
  const p = findProduct(menu, line.productId)
  const ok = lineAvailable(menu, line)
  const label = p && ok ? lineLabel(p, line) : { name: p?.name ?? 'Unavailable item', mods: [] as string[] }
  const text = <>{line.qty} × {label.name}{label.mods.length > 0 && <span className="text-brown-muted"> · {label.mods.join(', ')}</span>}</>
  return (
    <div className="flex justify-between gap-2 py-1">
      <span>
        {onEdit && p && ok
          ? <button type="button" className="text-left" onClick={() => onEdit(p)}>{text}</button>
          : <span className={ok ? '' : 'line-through opacity-60'}>{text}</span>}
        {!ok && <span className="block text-xs text-red-700">Not available now</span>}
      </span>
      <span className="shrink-0">
        {p && ok ? formatSen((linePriceSen(p, line) ?? 0) * line.qty) : ''}
        {onRemove && <button type="button" aria-label={`Remove ${label.name}`} className="ml-2 text-red-700" onClick={onRemove}>✕</button>}
      </span>
    </div>
  )
}

/** A card of Popular here and Goes well with: photo, name, price; a tap opens the item sheet. */
function PickCard({ product, onOpen }: { product: PosProduct; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}
      className="flex w-28 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-left">
      {product.imageUrl
        ? <img src={product.imageUrl} alt="" loading="lazy" className="h-20 w-full object-cover" />
        : <div className="h-20 w-full bg-border" />}
      <div className="p-2">
        <div className="line-clamp-2 text-xs font-medium">{product.name}</div>
        <div className="mt-0.5 text-xs text-brown-muted">{priceText(product)}</div>
      </div>
    </button>
  )
}

function Shell({ title, right, children }: { title?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <header className="flex items-center justify-between gap-3 bg-brown-header px-4 py-3 text-white">
        <div>
          <div className="text-xs opacity-80">Craft Cafe</div>
          <div className="text-lg font-semibold">{title ?? 'Order'}</div>
        </div>
        {right}
      </header>
      {children}
    </div>
  )
}
