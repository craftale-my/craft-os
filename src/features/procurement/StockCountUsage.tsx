import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money, qty } from '../../shared/lib/procurement'
import { useCan } from '../../shared/lib/permissions'
import {
  normaliseUsageRow, normaliseUsageSummary, sortUsageRows, formatPct, formatPeriod, sinceLabel,
} from '../../shared/lib/stockUsage'
import type { StockUsageRow, StockUsageSummary, UnrecipeSale } from '../../shared/types'

export default function StockCountUsage({ countId }: { countId: string }) {
  const { can } = useCan()
  const [rows, setRows] = useState<StockUsageRow[] | null>(null)
  const [summary, setSummary] = useState<StockUsageSummary | null>(null)
  const [unrecipe, setUnrecipe] = useState<UnrecipeSale[]>([])
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    setRows(null); setSummary(null); setError('')
    Promise.all([
      supabase.rpc('stock_count_usage', { p_count_id: countId }),
      supabase.rpc('stock_count_usage_summary', { p_count_id: countId }),
      supabase.rpc('stock_count_unrecipe_sales', { p_count_id: countId }),
    ]).then(([u, s, n]) => {
      if (cancelled) return
      const err = u.error ?? s.error ?? n.error
      if (err) { setError(err.message); return }
      setRows(((u.data as StockUsageRow[]) ?? []).map(normaliseUsageRow))
      setSummary(normaliseUsageSummary(s.data as StockUsageSummary))
      setUnrecipe(((n.data as UnrecipeSale[]) ?? []).map(r => ({ ...r, qty_sold: Number(r.qty_sold) })))
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [countId])

  if (error) return <p className="text-sm text-red-700">Couldn't load usage since last count: {error}</p>
  if (!rows || !summary) return <p className="text-sm text-brown-faint">Loading usage since last count…</p>

  const sorted = sortUsageRows(rows)
  const withMovement = sorted.filter(r => r.sold_base !== 0 || r.wasted_base !== 0 || r.unexplained_base !== 0)
  const shown = showAll ? withMovement : withMovement.slice(0, 15)

  return (
    <section className="space-y-3 pt-2">
      <div>
        <h2 className="text-base font-bold text-brown-dark">Since last count</h2>
        <p className="text-xs text-brown-faint">
          {formatPeriod(summary.period_start, summary.period_end)} · {summary.bills_paid} bills paid
          {!summary.from_previous && ' · first count, so the last 30 days are shown'}
        </p>
        {summary.capped && <p className="text-xs text-brown-faint">Window limited to the last 180 days</p>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Sold (recipes)', value: summary.sold_value, tone: 'text-brown-dark' },
          { label: 'Wasted', value: summary.wasted_value, tone: 'text-brown-dark' },
          { label: 'Unexplained', value: summary.unexplained_value, tone: summary.unexplained_value < 0 ? 'text-red-700' : 'text-green-700' },
        ].map(t => (
          <div key={t.label} className="bg-white rounded-xl border border-[#E8DDD0] p-3 text-center">
            <p className="text-xs text-brown-faint">{t.label}</p>
            <p className={`text-base font-bold ${t.tone}`}>{money(Math.abs(t.value))}</p>
          </div>
        ))}
      </div>

      {summary.rows_without_cost > 0 && (
        <p className="text-xs text-[#8A5A1C]">
          {summary.rows_without_cost} movement{summary.rows_without_cost === 1 ? '' : 's'} had no cost, so RM totals are understated.
        </p>
      )}

      {summary.lines_without_recipe > 0 && (
        <div className="rounded-xl border border-[#F0D9B5] bg-[#FDF6EC] p-3 text-xs text-[#8A5A1C] space-y-1">
          <p className="font-semibold">
            {summary.lines_without_recipe} item{summary.lines_without_recipe === 1 ? '' : 's'} sold had no recipe, so usage is understated.
          </p>
          {unrecipe.length > 0 && (
            <p>{unrecipe.slice(0, 5).map(u => `${u.product_name} · ${u.variant_name} (${u.qty_sold})`).join(', ')}</p>
          )}
          {can('manage_procurement') && <Link to="/procurement/menu-costing" className="font-semibold underline">Add recipes in Menu Costing</Link>}
        </div>
      )}
      {summary.depletion_errors > 0 && (
        <p className="text-xs text-red-700">{summary.depletion_errors} paid bill{summary.depletion_errors === 1 ? '' : 's'} could not deduct stock. Ask a manager to check the recipes.</p>
      )}

      {withMovement.length === 0 ? (
        <p className="text-sm text-brown-faint">No sales, waste or count differences in this period.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map(r => {
            const since = sinceLabel(r.period_start, summary.period_start)
            return (
              <li key={r.item_id} className="bg-white rounded-xl border border-[#E8DDD0] px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold text-brown-dark">
                    {r.item_name}
                    {since && <span className="text-xs font-normal text-brown-faint ml-2">{since}</span>}
                  </p>
                  {r.counted ? (
                    <span className={`text-sm font-bold whitespace-nowrap ${r.unexplained_value < 0 ? 'text-red-700' : r.unexplained_value > 0 ? 'text-green-700' : 'text-brown-muted'}`}>
                      {r.unexplained_value < 0 ? '−' : r.unexplained_value > 0 ? '+' : ''}{money(Math.abs(r.unexplained_value))}
                    </span>
                  ) : (
                    <span className="text-xs font-semibold whitespace-nowrap text-brown-faint">Not counted</span>
                  )}
                </div>
                <p className="text-xs text-brown-faint mt-1">
                  Sold {qty(r.sold_base)} {r.base_unit} ({money(r.sold_value)}) · Wasted {qty(r.wasted_base)} {r.base_unit}
                  {r.counted && (
                    <>
                      {' · '}Unexplained {qty(Math.abs(r.unexplained_base))} {r.base_unit} {r.unexplained_base < 0 ? 'short' : r.unexplained_base > 0 ? 'over' : ''}
                      {r.unexplained_pct != null && r.unexplained_base < 0 && ` (${formatPct(r.unexplained_pct)} of sold)`}
                    </>
                  )}
                </p>
              </li>
            )
          })}
        </ul>
      )}
      {withMovement.length > 15 && (
        <button type="button" className="text-xs font-semibold text-[#C4813A]" onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Show fewer' : `Show all ${withMovement.length}`}
        </button>
      )}
    </section>
  )
}
