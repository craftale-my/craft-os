import { useState, useEffect } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { money, qty, packs } from '../../shared/lib/procurement'
import { sortResultLines } from '../../shared/lib/stocktake'
import type { StockCount, StockCountItem, Item } from '../../shared/types'
import { STOCK_COUNT_KIND_LABELS } from '../../shared/types'

type Line = StockCountItem & { item: Pick<Item, 'name' | 'base_unit' | 'purchase_unit' | 'conversion_rate'> }

function signed(n: number, fmt: (v: number) => string): string {
  return `${n < 0 ? '−' : n > 0 ? '+' : ''}${fmt(Math.abs(n))}`
}

export default function StockCountResult({ count, branchName }: { count: StockCount; branchName: string }) {
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    supabase
      .from('stock_count_items')
      .select('*, item:items(name, base_unit, purchase_unit, conversion_rate)')
      .eq('count_id', count.id)
      .then(({ data, error: err }) => {
        if (err) setError(err.message)
        setLines((data as Line[]) ?? [])
        setLoading(false)
      })
  }, [count.id])

  const sorted = sortResultLines(lines.map(l => ({ ...l, name: l.item.name, variance_value: Number(l.variance_value) })))
  const changed = sorted.filter(l => Number(l.variance_base) !== 0)
  const shown = showAll ? sorted : changed
  // Lines with a difference but no cost add nothing to the RM totals, so call them out.
  const noCost = changed.filter(l => l.unit_cost == null).length

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-brown-dark">{STOCK_COUNT_KIND_LABELS[count.kind]} count · {branchName}</h1>
        <p className="text-xs text-brown-faint mt-0.5">
          Submitted {count.submitted_at ? new Date(count.submitted_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }) : ''} · {count.item_count ?? 0} items. Stock on hand now matches these counts.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Loss', value: -Number(count.loss_value ?? 0) },
          { label: 'Gain', value: Number(count.gain_value ?? 0) },
          { label: 'Net', value: Number(count.net_value ?? 0) },
        ].map(t => (
          <div key={t.label} className="bg-white rounded-xl border border-[#E8DDD0] p-3 text-center">
            <p className="text-xs text-brown-faint">{t.label}</p>
            <p className={`text-base font-bold ${t.value < 0 ? 'text-red-700' : t.value > 0 ? 'text-green-700' : 'text-brown-dark'}`}>
              {signed(t.value, money)}
            </p>
          </div>
        ))}
      </div>
      {noCost > 0 && (
        <p className="text-xs text-[#B46309]">
          {noCost} item{noCost === 1 ? '' : 's'} with a difference had no cost yet, so {noCost === 1 ? 'it is' : 'they are'} not in the RM totals.
        </p>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-brown-dark">
          {loading ? 'Loading…'
            : error ? ''
            : showAll ? 'All items' : `${changed.length} item${changed.length === 1 ? '' : 's'} with a difference`}
        </h2>
        <button type="button" onClick={() => setShowAll(v => !v)} className="text-xs font-semibold text-[#C4813A]">
          {showAll ? 'Only differences' : 'Show all'}
        </button>
      </div>

      <ul className="space-y-2">
        {shown.map(l => {
          const v = Number(l.variance_base)
          return (
            <li key={l.item_id} className="bg-white rounded-xl border border-[#E8DDD0] px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-brown-dark">{l.item.name}</p>
                {l.unit_cost == null ? (
                  // No cost known anywhere when submitted: the line carries no RM value.
                  <span className="text-xs font-semibold whitespace-nowrap text-brown-faint">No cost</span>
                ) : (
                  <span className={`text-sm font-bold whitespace-nowrap ${l.variance_value < 0 ? 'text-red-700' : l.variance_value > 0 ? 'text-green-700' : 'text-brown-muted'}`}>
                    {signed(l.variance_value, money)}
                  </span>
                )}
              </div>
              <p className="text-xs text-brown-faint mt-1">
                Counted {qty(Number(l.counted_base))} {l.item.base_unit} · Expected {qty(Number(l.expected_base))} {l.item.base_unit} ·{' '}
                <span className={v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : ''}>
                  {signed(v, n => `${qty(n)} ${l.item.base_unit}`)}
                  {Number(l.item.conversion_rate) !== 1 && ` (${signed(v, n => `${packs(n, l.item.conversion_rate)} ${l.item.purchase_unit}`)})`}
                </span>
              </p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
