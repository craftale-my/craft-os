// src/qr/MenuPage.tsx
/** The menu view (reference frames 01–05, 10): one long page — the shop block, the Menu heading with a
 *  grid / list switch, the sticky category bar, every category as a section — and the bottom bar. */
import { Fragment, useRef, useState } from 'react'
import { ConciergeBell, LayoutGrid, List, ReceiptText } from 'lucide-react'
import { formatSen, type PosProduct } from '../features/pos/order/cart'
import { avatarEmoji, type Guest } from './qrGuest'
import CategoryBar from './CategoryBar'
import MenuGrid from './MenuGrid'
import MenuList from './MenuList'
import { useScrollSpy } from './useScrollSpy'

export const MENU_VIEW_KEY = 'qr-menu-view'
type MenuView = 'grid' | 'list'
const readView = (): MenuView => {
  try { return localStorage.getItem(MENU_VIEW_KEY) === 'list' ? 'list' : 'grid' } catch { return 'grid' }
}

export interface MenuSection { name: string; products: PosProduct[]; /** the Popular section: no Popular pill inside it */ popular?: boolean }

export default function MenuPage({ tableLabel, guest, onGuest, closed, placed, sections, popularIds, units, onOpen,
  cartLines, subtotalSen, status, ordered, onCart, onOrders }: {
  tableLabel: string
  guest: Guest
  onGuest: () => void
  /** W7: the last-order sentence, or null inside the window */
  closed: string | null
  /** an order was sent from another phone */
  placed: boolean
  sections: MenuSection[]
  popularIds: ReadonlySet<string>
  units: ReadonlyMap<string, number>
  onOpen: (product: PosProduct) => void
  /** lines in the table's cart */
  cartLines: number
  subtotalSen: number
  status: 'loading' | 'ready' | 'offline'
  /** the table has ordered something */
  ordered: boolean
  onCart: () => void
  onOrders: () => void
}) {
  const [view, setView] = useState<MenuView>(readView)
  const bar = useRef<HTMLElement>(null)
  const ids = sections.map((_, i) => `qr-sec-${i}`)
  const { active, jumpTo } = useScrollSpy(ids, bar, sections.map((s) => s.name).join('|'))
  const choose = (v: MenuView) => {
    setView(v)
    try { localStorage.setItem(MENU_VIEW_KEY, v) } catch { /* private mode: this visit only */ }
  }
  const noPopular = new Set<string>()
  const showBar = cartLines > 0 || ordered

  return (
    <div className={showBar ? 'pb-28' : 'pb-8'}>
      <div className="flex min-h-12 items-center justify-end px-4 pt-2">
        <button type="button" onClick={onGuest} aria-label={`You are ${guest.name}. Change name or avatar`}
          className="flex min-h-10 items-center gap-2 rounded-full bg-brown-track py-1 pl-1 pr-3 text-[15px] font-medium text-brown-dark">
          <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-card text-base">{avatarEmoji(guest.avatar)}</span>
          {guest.name}
        </button>
      </div>
      {closed && <div role="status" className="mx-4 mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{closed}</div>}

      <div className="px-4 pb-4 pt-3">
        <h1 className="text-[28px] font-bold leading-tight text-brown-dark">Craft Cafe</h1>
        <div className="mt-2 flex items-center gap-2 text-[17px] text-brown-dark">
          <ConciergeBell size={20} strokeWidth={1.75} aria-hidden="true" />
          <span>Table {tableLabel}</span>
        </div>
      </div>
      {placed && (
        <div className="mx-4 mb-3 rounded-xl bg-green-50 p-3 text-sm text-green-800">
          Order placed — it is on its way. You can add more below.
        </div>
      )}

      <div className="h-px bg-border" />
      <div className="flex items-center justify-between px-4 pb-1 pt-4">
        <h2 className="text-[26px] font-bold text-brown-dark">Menu</h2>
        <div className="flex rounded-lg bg-brown-track p-1">
          {([['grid', 'Grid view', LayoutGrid], ['list', 'List view', List]] as const).map(([v, label, Icon]) => (
            <button key={v} type="button" aria-label={label} aria-pressed={view === v} onClick={() => choose(v)}
              className={`flex h-9 w-10 items-center justify-center rounded-md ${view === v ? 'bg-card text-brown-dark shadow-sm' : 'text-brown-faint'}`}>
              <Icon size={20} strokeWidth={2} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>

      <CategoryBar ref={bar} names={sections.map((s) => s.name)} active={active} onPick={jumpTo} />

      {sections.map((s, i) => (
        <Fragment key={`${i}:${s.name}`}>
          {i > 0 && <div aria-hidden="true" className="h-2 bg-brown-track" />}
          <section id={ids[i]} aria-labelledby={`${ids[i]}-h`} className={view === 'grid' ? 'pb-5' : 'pb-1'}>
            <h2 id={`${ids[i]}-h`} className="px-4 pb-1 pt-5 text-[26px] font-bold leading-tight text-brown-dark">{s.name}</h2>
            {view === 'grid'
              ? <MenuGrid products={s.products} popularIds={s.popular ? noPopular : popularIds} units={units} onOpen={onOpen} />
              : <MenuList products={s.products} popularIds={s.popular ? noPopular : popularIds} units={units} onOpen={onOpen} />}
          </section>
        </Fragment>
      ))}

      {showBar && (
        <div className="fixed inset-x-0 bottom-0 z-10 mx-auto flex max-w-lg gap-3 bg-gradient-to-t from-cream via-cream to-cream/0 px-4 pb-4 pt-3">
          {ordered && (
            <button type="button" onClick={onOrders} aria-label="Orders"
              className={`flex min-h-14 items-center justify-center gap-2 rounded-xl border-2 border-brown-btn bg-cream px-4 text-base font-semibold text-brown-btn ${cartLines > 0 ? '' : 'flex-1'}`}>
              <ReceiptText size={20} aria-hidden="true" /> Orders
            </button>
          )}
          {cartLines > 0 && (
            <button type="button" disabled={status !== 'ready'} onClick={onCart}
              className="min-h-14 flex-1 rounded-xl bg-brown-btn text-[17px] font-semibold text-white shadow-md disabled:opacity-50">
              {status === 'offline' ? 'Reconnecting…' : `Cart · ${formatSen(subtotalSen)}`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
