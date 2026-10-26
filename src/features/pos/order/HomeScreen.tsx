// src/features/pos/order/HomeScreen.tsx
import { useState, type ReactNode } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { formatSen } from './cart'
import type { BillSummary } from './billSummaries'
import { areaTabs, currentArea, elapsedLabel, visibleTables } from './home'
import type { OpenBillRow, TableRow } from './posApi'
import { tableCards, takeawayBills, type TableCard } from './tableStatus'
import { useMinuteClock } from './useMinuteClock'

/** Home (spec §1): search, refresh and the area tabs on top; the table tiles (5 a row) with each
 *  open bill's total and minutes; the Other bills column with + Takeaway and every open takeaway
 *  bill. `banners` (no shift, the offline queue, a load error) sit above the tiles. */
export default function HomeScreen({ tables, bills, summaries, newBillIds, banners, onRefresh, onPickTable, onPickBill, onNewTakeaway }: {
  tables: TableRow[]
  bills: OpenBillRow[]
  summaries: ReadonlyMap<string, BillSummary>
  newBillIds: ReadonlySet<string>      // QR orders not opened yet: the green ring
  banners: ReactNode
  onRefresh: () => void
  onPickTable: (tableId: string) => void
  onPickBill: (billId: string) => void
  onNewTakeaway: () => void
}) {
  const [area, setArea] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const now = useMinuteClock()
  const tabs = areaTabs(tables, bills)
  const shownArea = currentArea(tabs, area)
  const cards = tableCards(visibleTables(tables, shownArea, search), bills, newBillIds)
  const takeaways = takeawayBills(bills)
  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-card p-2">
          <label className="relative w-48 shrink-0">
            <Search size={18} className="pointer-events-none absolute left-3 top-3 text-brown-muted" />
            <input className="h-11 w-full rounded-xl border border-border-mid pl-9 pr-3" placeholder="Search table"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button type="button" onClick={onRefresh} aria-label="Refresh"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border-mid"><RefreshCw size={18} /></button>
          <div role="tablist" aria-label="Areas" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <button key={t.area ?? '*'} type="button" role="tab" aria-selected={!search && shownArea === t.area}
                onClick={() => { setArea(t.area); setSearch('') }}
                className={`h-11 whitespace-nowrap rounded-lg px-4 text-sm font-medium ${!search && shownArea === t.area ? 'bg-brown-dark text-cream' : 'text-brown-dark hover:bg-cream'}`}>
                {t.label} ({t.openCount})
              </button>
            ))}
          </div>
        </div>
        {banners}
        <div className="grid flex-1 grid-cols-5 content-start gap-3 overflow-y-auto p-3">
          {cards.map((c) => (
            <TableTile key={c.id} card={c} summary={c.bill ? summaries.get(c.bill.id) ?? null : null} nowMs={now} onPick={onPickTable} />
          ))}
          {cards.length === 0 && (
            <p className="col-span-5 text-brown-muted">{search ? 'No table matches.' : 'No tables — add them in POS settings.'}</p>
          )}
        </div>
      </main>
      <aside aria-label="Other bills" className="flex w-[260px] shrink-0 flex-col border-l border-border bg-card">
        <div className="p-2">
          <button type="button" onClick={onNewTakeaway}
            className="min-h-14 w-full rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover">+ Takeaway</button>
        </div>
        <h3 className="px-3 text-xs font-semibold uppercase tracking-wide text-brown-muted">Other bills</h3>
        <div className="flex-1 space-y-2 overflow-y-auto p-2">
          {takeaways.map((b) => {
            const s = summaries.get(b.id)
            return (
              <button key={b.id} type="button" onClick={() => onPickBill(b.id)}
                className="flex min-h-14 w-full items-center justify-between rounded-xl border-2 border-brown-btn bg-canvas px-3 text-left">
                <span>
                  <span className="block font-semibold text-brown-dark">{b.bill_no}</span>
                  <span className="block text-xs text-brown-muted">Takeaway · {elapsedLabel(b.opened_at, now)}</span>
                </span>
                <span className="font-semibold tabular-nums text-brown-dark">{s ? formatSen(s.totalSen) : ''}</span>
              </button>
            )
          })}
          {takeaways.length === 0 && <p className="px-1 text-sm text-brown-muted">No open takeaway bills.</p>}
        </div>
      </aside>
    </div>
  )
}

function TableTile({ card, summary, nowMs, onPick }: { card: TableCard; summary: BillSummary | null; nowMs: number; onPick: (tableId: string) => void }) {
  const open = card.state !== 'empty'
  return (
    <button type="button" onClick={() => onPick(card.id)}
      className={`flex h-28 flex-col justify-between rounded-xl border-2 p-3 text-left ${open ? 'border-brown-btn bg-brown-btn text-white' : 'border-border bg-card text-brown-dark'} ${card.state === 'new' ? 'ring-4 ring-green-400' : ''}`}>
      <span className="text-2xl font-semibold">{card.label}</span>
      <span className="text-sm">
        {card.bill
          ? <span className="tabular-nums">{summary ? `${formatSen(summary.totalSen)} · ` : ''}{elapsedLabel(card.bill.opened_at, nowMs)}</span>
          : <span className="text-brown-muted">{card.paused ? 'QR paused' : ''}</span>}
        {card.state === 'new' && <span className="block text-xs font-semibold text-green-200">New QR order</span>}
        {open && card.paused && <span className="block text-xs opacity-80">QR paused</span>}
      </span>
    </button>
  )
}
