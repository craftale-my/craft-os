import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { qrClient } from './qrClient'
import { tokenFromLocation } from './qrState'
import { defaultLine, findProduct, type OrderLine, type PosProduct } from '../features/pos/order/cart'
import { mostPickedFor, visiblePopular } from '../features/pos/order/picks'
import { loadGuest, newGuest, saveGuest, type Guest } from './qrGuest'
import {
  additionsToast, cartPairs, cartTotalSen, groupCart, isNetworkError, itemPairs, orderWasSent, sendGroups, sentKey, skipIds,
  unitsByProduct, type CartLine, type CartState, type GuestGroup,
} from './qrCart'
import { makeCartApi, makeCartSignal } from './qrCartApi'
import { useCartTopic, useTableCart } from './useTableCart'
import { useQrMenu, useTableState, useToast } from './useQrMenu'
import GuestCard, { GuestModal } from './GuestCard'
import SendSheet from './SendSheet'
import MenuPage from './MenuPage'
import ItemPage from './ItemPage'
import CartPage from './CartPage'
import SentPage from './SentPage'
import OrdersPage from './OrdersPage'
import { Notice, Shell } from './qrParts'
import { aiPick, kindsOf } from './aiPick'
import { useMinuteClock } from '../features/pos/order/useMinuteClock'
import { qrClosedMessage } from '../features/pos/order/orderWindow'

/** The page's views. Cart / sent / orders push one history entry, so the phone's Back returns to the menu;
 *  the item page pushes its own on top (from the menu or the cart), so Back returns to where it was opened. */
type View = 'menu' | 'item' | 'cart' | 'sent' | 'orders'
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function QrApp() {
  const token = tokenFromLocation(window.location.pathname, window.location.search)
  const { state, loadState } = useTableState(token)
  // table cart (docs/superpowers/specs/2026-11-22-qr-shared-table-cart-design.md): who this phone is
  const [guest, setGuest] = useState<Guest | null>(() => (token ? loadGuest(token) : null))
  const guestRef = useRef(guest)
  useEffect(() => { guestRef.current = guest }, [guest])
  const [guestEdit, setGuestEdit] = useState(false)                  // the card, reopened from the header
  const [item, setItem] = useState<{ product: PosProduct; lineId: string | null; from: 'menu' | 'cart' } | null>(null)   // the item page
  const [itemBusy, setItemBusy] = useState(false)
  const [itemError, setItemError] = useState<string | null>(null)
  const [pax, setPax] = useState('')
  const [error, setError] = useState<string | null>(null)           // the cart panel: a removal that failed
  const [sendOpen, setSendOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendMessage, setSendMessage] = useState<string | null>(null)
  const [placed, setPlaced] = useState(false)
  const { toast, say } = useToast()
  const sendingRef = useRef(false)
  const itemBusyRef = useRef(false)
  useEffect(() => { itemBusyRef.current = itemBusy }, [itemBusy])
  const viewRef = useRef<View>('menu')              // the view now, for a request that ends after the guest moved on
  const itemFrom = useRef<'menu' | 'cart'>('menu')  // where the item page was opened from
  const backPending = useRef(false)                                  // a history.back() is on its way: popstate has not arrived yet
  const sentElsewhere = useRef(false)                                // an order was just sent from another phone: the cart view bounces once
  const seen = useRef<string | null>(null)                           // sentKey of the cart the sender last looked at (spec §2)
  const adoptSeen = useRef(false)                                    // after a refused send: take the re-read cart as seen
  const pending = useRef<{ id: string; key: string } | null>(null)   // one client_order_id per distinct cart sent
  const clock = useMinuteClock()                                     // W7: the last-order banner turns on and off on the minute
  const [view, setView] = useState<View>('menu')
  const menuY = useRef(0)                                            // the menu's scroll position, restored on return
  const [sentGroups, setSentGroups] = useState<GuestGroup[]>([])         // what the send sheet showed when the order went: the "Order placed" view
  // AI Pick (spec 2026-11-22-qr-ai-pick-mascot-design.md §5): hidden with ✕ for this visit; the seed keeps
  // its sentence fixed for the visit; one Add from the card at a time
  const [aiHidden, setAiHidden] = useState(false)
  const [aiSeed] = useState(() => Math.floor(Math.random() * 2 ** 31))
  const [aiBusy, setAiBusy] = useState(false)

  const { screen, loadMenu, picks, menuRef, refreshNow } = useQrMenu(token, sendingRef, {
    loaded: () => { void loadState() },
    refreshed: (menu) => {
      setItem((s) => (s && findProduct(menu, s.product.id) ? s : null))
      void loadState()                                              // "Ordered so far" picks up what the counter added
    },
  })
  const ready = screen.kind === 'ready'

  // ── the table's shared cart ──
  const topic = useCartTopic(token)
  const api = useMemo(() => (token ? makeCartApi(qrClient, token) : null), [token])
  const signal = useMemo(() => (topic ? makeCartSignal(qrClient, topic) : null), [topic])
  const table = useTableCart(ready ? api : null, ready ? signal : null, (before: CartState | null, after: CartState) => {
    const menu = menuRef.current
    const me = guestRef.current
    if (menu && me) {
      const text = additionsToast(before, after, me.id, menu)
      if (text) say(text)
    }
    setError(null)                                                  // a failed removal's message goes when the cart moves on
    // an order was sent from this table's cart (from any phone): the server says so, not a count
    if (orderWasSent(before, after)) {
      setSendOpen(false); setPlaced(true); void loadState()
      if (!sendingRef.current) sentElsewhere.current = true         // not this phone's own send: a guest on the cart view goes back to the menu
    }
    else if (after.lines.length === 0) setSendOpen(false)           // the last line went: nothing left to send
  })
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
  // the item page closes when the line it edits is gone
  useEffect(() => {
    if (!item || item.lineId === null || itemBusy || !table.cart || !guest) return
    if (!table.cart.lines.some((l) => l.id === item.lineId && l.guestId === guest.id)) setItem(null)
  }, [item, itemBusy, table.cart, guest])

  // views: opening one pushes a history entry (replaces it when already on one), so Back returns to the menu
  const openView = (v: View) => {
    if (v === 'menu') return goMenu()
    if (view === 'menu') menuY.current = window.scrollY
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
      }
      if (v !== 'item' && !itemBusyRef.current) setItem(null)          // left the item page (Back); never while its line is being written

    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // the table's order was sent from another phone while this guest is on the cart view: back to the menu
  // (its banner says so). Keyed on that send event, never on the banner or an empty cart.
  useEffect(() => {
    if (!sentElsewhere.current || sendingRef.current) return
    if (view === 'item' && item?.from === 'cart') return               // decided when the guest is back on the cart
    sentElsewhere.current = false
    if (view === 'cart') goMenu()
  }) // eslint-disable-line react-hooks/exhaustive-deps
  // the item page with nothing to show (it closed, or Forward landed on it): step back to where it was opened
  useEffect(() => { if (view === 'item' && !item) goMenu() }) // eslint-disable-line react-hooks/exhaustive-deps
  // the menu comes back where the guest left it; every other view starts at the top
  useLayoutEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
    window.scrollTo(0, view === 'menu' ? menuY.current : 0)
  }, [view])
  // the sender's banner is for the other phones: leaving the Order placed view clears it
  const prevView = useRef<View>('menu')
  useEffect(() => {
    if (prevView.current === 'sent' && view !== 'sent') setPlaced(false)
    prevView.current = view
    viewRef.current = view
  }, [view])

  if (screen.kind === 'loading') return <Notice muted>Loading menu…</Notice>
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
  if (screen.kind === 'invalid' || !token) return <Notice>This table code is not valid. Please order at the counter.</Notice>
  const { info, menu } = screen
  if (info.paused) return <Notice title={`Table ${info.tableLabel}`}>Ordering from this table is paused. Please order at the counter.</Notice>
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
  // W7 spec §3: outside the outlet's window the page says when ordering opens again; Add and Place order are
  // off (the server refuses them anyway — its clock decides)
  const closedMsg = qrClosedMessage(info.ordersOpenAt ?? null, info.lastOrderAt ?? null, new Date(clock))
  // AI Pick: not past last order, not offline (CartPage checks both too), not once hidden
  const pick = aiHidden || closedMsg || table.status !== 'ready' ? null : aiPick(menu, picks, mine, cartLines, kindsOf(menu), aiSeed)

  /** The AI Pick card's Add: the product's default line to the table's cart. A failure keeps the card and
   *  says so in the cart's error line; on success the card moves on to the next suggestion (or goes). */
  const addPick = async (p: PosProduct) => {
    if (aiBusy) return
    setAiBusy(true); setError(null)
    try { await table.add(guest, defaultLine(p)); setPlaced(false) } catch (e) {
      const msg = errorText(e)
      setError(isNetworkError(msg) ? 'Not added — no connection. Try again.' : `Not added: ${msg}`)
    } finally { setAiBusy(false) }
  }

  /** The item page's Add / Save: the line goes to the table's cart on the server, then each ticked pairing
   *  as its own line, one after another. A pairing that fails leaves the item added; a toast names it. On
   *  success the page closes, which steps back to where it was opened. */
  const done = async (line: OrderLine, pairings: PosProduct[]) => {
    if (!item || itemBusy) return
    setItemBusy(true); setItemError(null)
    try {
      if (item.lineId === null) await table.add(guest, line)
      else await table.replace(guest, item.lineId, line)
      const missed: string[] = []
      let why = ''
      for (const p of pairings) {
        try { await table.add(guest, defaultLine(p)) } catch (e) { missed.push(p.name); why = errorText(e) }
      }
      if (missed.length > 0) say(`Not added: ${missed.join(', ')}${isNetworkError(why) ? ' — no connection.' : ` — ${why}`}`)
      setItem(null); setPlaced(false); setError(null)
    } catch (e) {
      const msg = errorText(e)
      const text = isNetworkError(msg) ? 'Not added — no connection. Tap Add to try again.' : `Not added: ${msg}`
      // the guest left the page while the write was in flight: the page is gone, so a toast says it
      if (viewRef.current !== 'item') { say(isNetworkError(msg) ? `${line.qty} × ${item.product.name} was not added — no connection.` : text); setItem(null) }
      else setItemError(text)
    } finally { setItemBusy(false) }
  }

  /** The cart's quantity select: the same write as an edit, with only the quantity changed. */
  const changeQty = async (lineId: string, qty: number) => {
    const l = mine.find((x) => x.id === lineId)
    if (!l) return
    setError(null)
    try { await table.replace(guest, lineId, { productId: l.productId, variantId: l.variantId, qty, note: l.note, optionIds: l.optionIds }) } catch (e) {
      const msg = errorText(e)
      setError(isNetworkError(msg) ? 'Not changed — no connection. Try again.' : `Not changed: ${msg}`)
    }
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

  /** The item page: a page of its own, with a history entry on top of the menu or the cart. */
  const openItem = (product: PosProduct, lineId: string | null) => {
    if (itemBusyRef.current) return                                    // one write at a time: the earlier item is still being added
    itemFrom.current = view === 'cart' ? 'cart' : 'menu'
    if (view === 'menu') menuY.current = window.scrollY
    setItemError(null); setItem({ product, lineId, from: view === 'cart' ? 'cart' : 'menu' })
    history.pushState({ qrView: 'item' }, ''); setView('item')
  }
  const sections = [...(popular.length > 0 ? [{ name: 'Popular', products: popular, popular: true }] : []), ...menu.categories]
  const shown: View = view === 'item' && !item ? itemFrom.current : view   // closing: already where Back will land
  return (
    <div className="min-h-screen bg-cream">
      <div className="mx-auto max-w-lg">
      {toast && <div role="status" className="fixed inset-x-3 top-3 z-30 rounded-xl bg-brown-dark px-4 py-3 text-sm text-white shadow-lg">{toast.text}</div>}
      {shown === 'menu' && (
        <MenuPage tableLabel={info.tableLabel} guest={guest} onGuest={() => setGuestEdit(true)} closed={closedMsg} placed={placed}
          sections={sections} popularIds={popularIds} units={unitsByProduct(menu, cartLines)} onOpen={(p) => openItem(p, null)}
          cartLines={cartLines.length} subtotalSen={subtotal} status={table.status} ordered={!!state && state.items.length > 0}
          onCart={() => openView('cart')} onOrders={() => openView('orders')} />
      )}
      {shown === 'item' && item && (
        <ItemPage key={`${item.product.id}|${item.lineId ?? ''}`} product={item.product} from={item.from}
          initial={item.lineId === null ? undefined : mine.find((l) => l.id === item.lineId)}
          mostPicked={mostPickedFor(picks, item.product.id)} pairs={itemPairs(menu, picks, item.product.id, cartLines)}
          busy={itemBusy} error={itemError} closed={closedMsg} onBack={goMenu} onAdd={(line, pairings) => void done(line, pairings)} />
      )}
      {shown === 'cart' && (
        <CartPage menu={menu} me={guest} mine={mine} others={others} pairs={cartPairs(menu, picks, mine, cartLines)} subtotalSen={subtotal}
          sendable={sendable.length > 0} status={table.status} error={error} closed={closedMsg} onBack={goMenu}
          onEdit={(p, lineId) => openItem(p, lineId)} onRemove={(id) => void remove(id)} onQty={changeQty}
          onOpenProduct={(p) => openItem(p, null)}
          aiPick={pick} aiBusy={aiBusy} onAiAdd={(p) => void addPick(p)} onAiHide={() => setAiHidden(true)}
          onPlace={() => {
            seen.current = table.cart ? sentKey(table.cart, skipIds(menu, cartLines)) : null
            setSendError(null); setSendMessage(null); setSendOpen(true)
          }} />
      )}
      {shown === 'sent' && (
        <SentPage menu={menu} groups={sentGroups} tableLabel={info.tableLabel} billNo={state?.billNo ?? null}
          onAddMore={goMenu} onViewOrders={() => openView('orders')} />
      )}
      {shown === 'orders' && <OrdersPage items={state?.items ?? []} subtotalSen={state?.subtotalSen ?? 0} onBack={goMenu} />}

      {sendOpen && sendable.length > 0 && (
        <SendSheet groups={sendable} menu={menu} totalSen={subtotal} needsPax={needsPax} pax={pax} onPax={setPax}
          sending={sending} message={sendMessage} error={sendError}
          onSend={() => void send()} onCancel={() => setSendOpen(false)} />
      )}
      {guestEdit && <GuestModal guest={guest} onDone={renameGuest} onCancel={() => setGuestEdit(false)} />}
      </div>
    </div>
  )
}
