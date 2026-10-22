import type { TableCard } from './tableStatus'
import type { OpenBillRow } from './posApi'

const TONE: Record<TableCard['state'], string> = {
  empty: 'bg-card border-border text-brown-muted',
  open: 'bg-amber-50 border-amber-300 text-brown-dark',
  new: 'bg-green-100 border-green-500 text-brown-dark ring-2 ring-green-400',
}

export default function TablesGrid({ cards, takeaway, selectedId, onPick, onTakeaway, onPickBill }: {
  cards: TableCard[]
  takeaway: OpenBillRow[]
  selectedId: string | null
  onPick: (tableId: string) => void
  onTakeaway: () => void
  onPickBill: (billId: string) => void
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        {cards.map((c) => (
          <button key={c.id} onClick={() => onPick(c.id)}
            className={`h-24 rounded-xl border-2 p-2 text-left ${TONE[c.state]} ${selectedId === c.id ? 'outline outline-2 outline-brown-btn' : ''}`}>
            <div className="text-xl font-semibold">{c.label}</div>
            <div className="text-xs">
              {c.state === 'empty' ? 'Empty' : c.state === 'new' ? 'New order' : `Bill ${c.bill?.bill_no}`}
              {c.paused && ' · QR paused'}
            </div>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={onTakeaway} className="rounded-xl bg-brown-btn px-4 py-3 text-white hover:bg-brown-btn-hover">+ Takeaway order</button>
        {takeaway.map((b) => (
          <button key={b.id} onClick={() => onPickBill(b.id)}
            className={`rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 ${selectedId === b.id ? 'outline outline-2 outline-brown-btn' : ''}`}>
            Takeaway {b.bill_no}
          </button>
        ))}
      </div>
    </div>
  )
}
