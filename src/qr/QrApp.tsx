import { useEffect, useMemo, useRef, useState } from 'react'
import { qrClient } from './qrClient'
import { tokenFromLocation } from './qrState'
import { findProduct, formatSen, posMenuFromQr, type OrderLine, type PosMenu, type PosProduct, type QrMenuJson } from '../features/pos/order/cart'
import { mostPickedFor, parsePicks, visiblePopular, type MenuPicks } from '../features/pos/order/picks'
import LineSheet from '../features/pos/order/LineSheet'
import { avatarEmoji, loadGuest, newGuest, saveGuest, type Guest } from './qrGuest'
import {
  additionsToast, cartChannel, cartPairs, cartTotalSen, cartUnits, groupCart, isNetworkError, orderWasSent, sendGroups, sentKey, skipIds,
  unitsByProduct, type CartLine, type CartState, type GuestGroup, type OrderedItem,
} from './qrCart'
import { makeCartApi, makeCartSignal } from './qrCartApi'
import { useTableCart } from './useTableCart'
import GuestCard from './GuestCard'
import SendSheet from './SendSheet'
import MenuGrid from './MenuGrid'
import CartPage from './CartPage'
import SentPage from './SentPage'
import OrdersPage from './OrdersPage'
import { PickCard, Shell } from './qrParts'

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

/** The page's views. Cart / sent / orders push one history entry, so the phone's Back returns to the menu. */
type View = 'menu' | 'cart' | 'sent' | 'orders'
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
  const sheetBusyRef = useRef(false)
  useEffect(() => { sheetBusyRef.current = sheetBusy }, [sheetBusy])
  const backPending = useRef(false)                                  // a history.back() is on its way: popstate has not arrived yet
  const sentElsewhere = useRef(false)                                // an order was just sent from another phone: the cart view bounces once
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
  const [view, setView] = useState<View>('menu')
  const [sentGroups, setSentGroups] = useState<GuestGroup[]>([])         // what the send sheet showed when the order went: the "Order placed" view

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
    if (orderWasSent(before, after)) {
      setSendOpen(false); setPlaced(true); void loadState()
      if (!sendingRef.current) sentElsewhere.current = true         // not this phone's own send: a guest on the cart view goes back to the menu
    }
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

  // views: opening one pushes a history entry (replaces it when already on one), so Back returns to the menu
  const openView = (v: View) => {
    if (v === 'menu') return goMenu()
    if (history.state?.qrView) history.replaceState({ qrView: v }, ''); else history.pushState({ qrView: v }, '')
    if (v === 'orders') void loadState()                               // the page reads the table afresh on entry
    setView(v)
  }
  // idempotent: history.state only changes when popstate arrives, so a second fast tap must not call back() again
  const goMenu = () => {
    if (!history.state?.qrView) { setView('menu'); return }
    if (backPending.current) return
    backPending.current = true
    history.back()
  }
  useEffect(() => {
    if (history.state?.qrView) history.replaceState(null, '')          // a reload lands on the menu
    const onPop = () => {
      backPending.current = false
      const v = (history.state?.qrView as View | undefined) ?? 'menu'
      setView(v)
      if (v === 'menu') {                                              // a sheet must not float over the wrong view; never while a request is in flight
        if (!sendingRef.current) { setSendOpen(false); setSendMessage(null); setSendError(null) }
        if (!sheetBusyRef.current) setSheet(null)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // the table's order was sent from another phone while this guest is on the cart view: back to the menu
  // (its banner says so). Keyed on that send event, never on the banner or an empty cart.
  useEffect(() => {
    if (!sentElsewhere.current || sendingRef.current) return
    sentElsewhere.current = false
    if (view === 'cart') goMenu()
  }) // eslint-disable-line react-hooks/exhaustive-deps
  // the sender's banner is for the other phones: leaving the Order placed view clears it
  const prevView = useRef<View>('menu')
  useEffect(() => {
    if (prevView.current === 'sent' && view !== 'sent') setPlaced(false)
    prevView.current = view
  }, [view])

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

  /** The sheet's Add: the line goes to the table's cart on the server. */
  const done = async (line: OrderLine) => {
    if (!sheet || sheetBusy) return
    setSheetBusy(true); setSheetError(null)
    try {
      if (sheet.lineId === null) await table.add(guest, line)
      else await table.replace(guest, sheet.lineId, line)
      setSheet(null); setPlaced(false); setError(null)
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
      const status = await table.send(paxNum, skip, pending.current.id, table.cart.version)
      if (status === 'changed') { adoptSeen.current = true; setSendMessage('The order changed — please check again.'); return }
      pending.current = null
      setSendOpen(false); setError(null)                               // no menu banner for the sender: they see the Order placed view
      setSentGroups(sendable); openView('sent')                         // the groups the sheet showed are exactly what was sent
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
  const openProduct = (p: PosProduct) => { setSheetError(null); setSheet({ product: p, lineId: null }) }
  const units = cartUnits(menu, cartLines)
  const barLabel = table.status === 'offline' ? 'Reconnecting…'
    : table.status === 'loading' || cartLines.length === 0 ? 'Tap an item to start' : `View cart · ${units} · ${formatSen(subtotal)}`
  return (
    <Shell title={`Table ${info.tableLabel}`} right={
      <button type="button" onClick={() => setGuestEdit(true)} aria-label={`You are ${guest.name}. Change name or avatar`}
        className="min-h-11 rounded-full bg-white/15 px-3 text-sm">{avatarEmoji(guest.avatar)} {guest.name}</button>
    }>
      {toast && <div role="status" className="fixed inset-x-3 top-3 z-30 rounded-xl bg-brown-dark px-4 py-3 text-sm text-white shadow-lg">{toast.text}</div>}
      {view === 'menu' && (
        <>
          {placed && (
            <div className="m-3 rounded-xl bg-green-50 p-3 text-sm text-green-800">
              Order placed — it is on its way. You can add more below.
            </div>
          )}
          {popular.length > 0 && (
            <section aria-label="Popular here" className="px-3 pt-2">
              <h2 className="text-sm font-semibold text-brown-dark">Popular here</h2>
              <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
                {popular.map((p) => <PickCard key={p.id} product={p} onOpen={() => openProduct(p)} />)}
              </div>
            </section>
          )}
          <div className="flex gap-1 overflow-x-auto px-3 py-2">
            {menu.categories.map((c) => (
              <button key={c.name} onClick={() => setCategory(c.name)}
                className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${category === c.name ? 'bg-brown-btn text-white' : 'border border-border bg-card'}`}>{c.name}</button>
            ))}
          </div>
          <MenuGrid products={products} popularIds={popularIds} units={unitsByProduct(menu, cartLines)} onOpen={openProduct} />
          <div className="fixed inset-x-0 bottom-0 flex gap-2 border-t border-border bg-card p-3 text-sm shadow-lg">
            {state && state.items.length > 0 && (
              <button type="button" onClick={() => openView('orders')} className="min-h-12 rounded-xl border border-border px-4">Orders</button>
            )}
            <button type="button" disabled={table.status !== 'ready' || cartLines.length === 0} onClick={() => openView('cart')}
              className="min-h-12 flex-1 rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">{barLabel}</button>
          </div>
        </>
      )}
      {view === 'cart' && (
        <CartPage menu={menu} mine={mine} others={others} pairs={cartPairs(menu, picks, mine, cartLines)} subtotalSen={subtotal}
          sendable={sendable.length > 0} status={table.status} error={error} onBack={goMenu}
          onEdit={(p, lineId) => { setSheetError(null); setSheet({ product: p, lineId }) }} onRemove={(id) => void remove(id)}
          onOpenProduct={openProduct}
          onPlace={() => {
            seen.current = table.cart ? sentKey(table.cart, skipIds(menu, cartLines)) : null
            setSendError(null); setSendMessage(null); setSendOpen(true)
          }} />
      )}
      {view === 'sent' && (
        <SentPage menu={menu} groups={sentGroups} tableLabel={info.tableLabel} billNo={state?.billNo ?? null}
          onAddMore={goMenu} onViewOrders={() => openView('orders')} />
      )}
      {view === 'orders' && <OrdersPage items={state?.items ?? []} subtotalSen={state?.subtotalSen ?? 0} onBack={goMenu} />}

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
