// src/qr/useQrMenu.ts
/** The QR page's menu and picks: the first read, the quiet minute refresh, and the picks read with them.
 *  Moved out of QrApp unchanged (M3, docs/superpowers/specs/2026-11-17-menu-picks-design.md §4). */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { qrClient } from './qrClient'
import { posMenuFromQr, type PosMenu, type QrMenuJson } from '../features/pos/order/cart'
import { parsePicks, type MenuPicks } from '../features/pos/order/picks'
import type { OrderedItem } from './qrCart'

export type Screen = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error' } | { kind: 'ready'; info: QrMenuJson; menu: PosMenu }

/** M3: a photo path in the public menu-images bucket → its URL (no request is made). */
const photoUrl = (path: string) => qrClient.storage.from('menu-images').getPublicUrl(path).data.publicUrl
const REFRESH_MS = 60_000
/** picks: read with the menu, then again with the minute refresh at most this often */
const PICKS_REFRESH_MS = 10 * 60_000

export function useQrMenu(token: string | null, sendingRef: RefObject<boolean>, on: {
  /** the first read landed (and Try again) */
  loaded: () => void
  /** a minute refresh landed with this menu */
  refreshed: (menu: PosMenu) => void
}) {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const handlers = useRef(on)
  useEffect(() => { handlers.current = on })
  const menuRef = useRef<PosMenu | null>(null)
  useEffect(() => { menuRef.current = screen.kind === 'ready' ? screen.menu : null }, [screen])
  const refreshSeq = useRef(0)                                       // a slow reply never lands after a newer one
  const refreshNow = useRef<(() => void) | null>(null)               // the minute refresh, callable after a refused send
  // picks: hints only. A failed first read leaves them hidden, a failed re-read keeps the last ones;
  // ordering never waits on them.
  const [picks, setPicks] = useState<MenuPicks | null>(null)
  const picksAt = useRef(0)                                          // when picks last LOADED; 0 until they have
  const picksSeq = useRef(0)                                         // an older reply never overwrites a newer one
  const picksLoaded = useRef(false)

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
      handlers.current.loaded()
      loadPicks()
    }, () => setScreen({ kind: 'error' }))
  }
  useEffect(() => { loadMenu() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // M3: read the menu again every minute while the page is in view, and when it comes back into
  // view, quietly: products whose time slot ends leave the menu (an open item page for one
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
        handlers.current.refreshed(menu)
        if (!picksLoaded.current || Date.now() - picksAt.current >= PICKS_REFRESH_MS) loadPicks()
      }, () => { /* offline for a moment: try again next minute */ })
    }
    refreshNow.current = refresh
    const timer = setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => { refreshNow.current = null; clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [ready, token]) // eslint-disable-line react-hooks/exhaustive-deps

  return { screen, loadMenu, picks, menuRef, refreshNow }
}

const TOAST_MS = 4_000
/** The toast at the top: `at` restarts the timer for the same text twice. */
export function useToast() {
  const [toast, setToast] = useState<{ text: string; at: number } | null>(null)
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(timer)
  }, [toast])
  return { toast, say: (text: string) => setToast({ text, at: Date.now() }) }
}

export interface TableState { tableLabel: string; billNo: string | null; pax: number | null; items: OrderedItem[]; subtotalSen: number }
/** qr_table_state: the table's bill so far (Orders, Order details, the pax question). */
export function useTableState(token: string | null) {
  const [state, setState] = useState<TableState | null>(null)
  const loadState = async (): Promise<TableState | null> => {
    const { data } = await qrClient.rpc('qr_table_state', { p_token: token })
    if (!data) return null
    setState(data as TableState)
    return data as TableState
  }
  return { state, loadState }
}
