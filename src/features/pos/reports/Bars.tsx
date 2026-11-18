import { formatSen } from '../order/cart'
import { barPercents } from './reportView'

export interface Bar {
  label: string
  valueSen: number
}

/** A plain CSS bar chart (no chart library): one column per bar, heights against the largest. */
export default function Bars({ title, bars }: { title: string; bars: Bar[] }) {
  const pct = barPercents(bars.map((b) => b.valueSen))
  const gap = bars.length > 62 ? 'gap-0' : 'gap-px'                           // a long range: no gaps to widen the row
  const every = bars.length > 31 ? Math.ceil(bars.length / 12) : 1           // at most ~12 labels under a long range
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">{title}</h2>
      <div className="overflow-x-auto">
      <div role="list" aria-label={title} className={`mt-3 flex h-40 items-end ${gap}`}>
        {bars.map((b, i) => (
          <div key={i} role="listitem" aria-label={`${b.label}: ${formatSen(b.valueSen)}`} title={`${b.label}: ${formatSen(b.valueSen)}`}
               className="flex h-full min-w-0 flex-1 flex-col justify-end">
            <div className="rounded-t bg-brown-btn" style={{ height: `${pct[i]}%` }} />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className={`mt-1 flex ${gap} text-[10px] text-brown-muted`}>
        {bars.map((b, i) => <span key={i} className="min-w-0 flex-1 truncate text-center">{i % every === 0 ? b.label : ''}</span>)}
      </div>
      </div>
    </section>
  )
}
