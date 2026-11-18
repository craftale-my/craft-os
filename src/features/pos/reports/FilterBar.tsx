import { useEffect, useState } from 'react'
import type { Outlet } from '../outlets/outlet'
import { PRESETS, presetOf, presetRange, rangeProblem, type DateRange, type Preset, type ReportFilter } from './reportRange'
import { rangeText } from './reportView'

const chip = (on: boolean) => `rounded px-3 py-1 text-sm ${on ? 'bg-brown-btn text-white' : 'border border-border'}`

/** The one filter bar of POS → Reports (spec §3): outlets, then a preset or a custom range of business days. */
export default function FilterBar({ outlets, filter, now, onChange }: {
  outlets: Outlet[]
  filter: ReportFilter
  now: Date
  onChange: (f: ReportFilter) => void
}) {
  const preset = presetOf(filter, now)
  const [customOpen, setCustomOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange>({ from: filter.from, to: filter.to })
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => { setDraft({ from: filter.from, to: filter.to }) }, [filter.from, filter.to])
  const custom = customOpen || preset === 'custom'

  const toggle = (id: string) => {
    const on = !filter.outlets.includes(id)
    const next = outlets.map((o) => o.id).filter((x) => (x === id ? on : filter.outlets.includes(x)))
    if (next.length === 0) { setProblem('Choose at least one outlet.'); return }
    setProblem(null)
    onChange({ ...filter, outlets: next })
  }
  const choose = (p: Preset) => {
    setCustomOpen(false)
    setProblem(null)
    onChange({ ...filter, ...presetRange(p, new Date()) })        // the clock now, not when the page opened
  }
  const show = () => {
    const why = rangeProblem(draft)
    setProblem(why)
    if (!why) onChange({ ...filter, from: draft.from, to: draft.to })
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="mb-1 text-xs text-brown-muted">Outlets</legend>
        {outlets.map((o) => (
          <label key={o.id} className="inline-flex items-center gap-1 text-sm">
            <input type="checkbox" checked={filter.outlets.includes(o.id)} onChange={() => toggle(o.id)} />
            {o.name}
          </label>
        ))}
      </fieldset>
      <div role="group" aria-label="Dates" className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" aria-pressed={!custom && preset === p.id} onClick={() => choose(p.id)}
                  className={chip(!custom && preset === p.id)}>{p.label}</button>
        ))}
        <button type="button" aria-pressed={custom} onClick={() => setCustomOpen(true)} className={chip(custom)}>Custom</button>
      </div>
      {custom && (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col">From
            <input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                   className="rounded border border-border p-1" />
          </label>
          <label className="flex flex-col">To
            <input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                   className="rounded border border-border p-1" />
          </label>
          <button type="button" onClick={show} className="rounded bg-brown-btn px-3 py-1 text-white">Show</button>
        </div>
      )}
      <p className="text-xs text-brown-muted">{rangeText(filter)}. A business day runs from 06:00 to 05:59 the next morning, Malaysia time.</p>
      {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
    </div>
  )
}
