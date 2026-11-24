// src/features/pos/menu/BulkBar.tsx
import { useState } from 'react'
import type { ProductPatch } from './menuApi'
import { SST_CHOICES } from './menuView'
import { parseFeeSen } from './productGroups'
import { ringgit } from './productTable'
import { btnCls, inputCls, linkBtnCls } from './editorUi'

type Asking = 'route' | 'sst' | 'fee' | null

/** Shown while rows are ticked: one change for every ticked product. Set print route, Set SST and
 *  Set takeaway fee ask for the value first; Switch on and Switch off ask to confirm. */
export default function BulkBar({ count, routes, busy, onApply, onClear }: {
  count: number
  /** the print routes to offer (routeChoices) */
  routes: string[]
  busy: boolean
  /** `what` is the outcome's wording, e.g. "Print route set to Bar" */
  onApply: (patch: ProductPatch, what: string) => void
  onClear: () => void
}) {
  const [asking, setAsking] = useState<Asking>(null)
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const ask = (a: Asking, initial: string) => { setAsking(a); setValue(initial); setProblem(null) }

  const fee = asking === 'fee' ? parseFeeSen(value, { allowZero: true }) : null
  const applyLabel = fee && 'value' in fee ? `Set ${ringgit(fee.value)} on ${count}` : `Apply to ${count}`

  const apply = () => {
    if (asking === 'route') onApply({ print_route: value || null }, `Print route set to ${value || 'No ticket'}`)
    else if (asking === 'sst') onApply({ sst_rate_bp: Number(value) }, `SST set to ${Number(value) / 100}%`)
    else if (asking === 'fee') {
      const parsed = parseFeeSen(value, { allowZero: true })
      if ('problem' in parsed) { setProblem(parsed.problem); return }
      onApply({ takeaway_fee_sen: parsed.value }, `Takeaway fee set to ${ringgit(parsed.value)}`)
    }
    setAsking(null)
  }
  const switchOn = () => {
    const what = `${count} product${count === 1 ? '' : 's'}`
    if (window.confirm(`Switch on ${what}? They will show on the counter and QR menus.`)) onApply({ is_active: true }, 'Switched on')
  }
  const switchOff = () => {
    const what = `${count} product${count === 1 ? '' : 's'}`
    if (window.confirm(`Switch off ${what}? They leave the counter and the QR menu until you switch them back on.`)) {
      onApply({ is_active: false }, 'Switched off')
    }
  }

  return (
    <div role="region" aria-label="Bulk edit" className="space-y-2 rounded-xl border border-border bg-card p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{count} selected</span>
        <button className={linkBtnCls} disabled={busy} onClick={() => ask('route', routes[0] ?? '')}>Set print route</button>
        <button className={linkBtnCls} disabled={busy} onClick={() => ask('sst', String(SST_CHOICES[0].bp))}>Set SST</button>
        <button className={linkBtnCls} disabled={busy} onClick={() => ask('fee', '1.00')}>Set takeaway fee</button>
        <button className={linkBtnCls} disabled={busy} onClick={switchOn}>Switch on</button>
        <button className={linkBtnCls} disabled={busy} onClick={switchOff}>Switch off</button>
        <button className="text-sm underline" disabled={busy} onClick={() => { setAsking(null); onClear() }}>Clear</button>
      </div>
      {asking && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {asking === 'route' && (
            <select className={inputCls} aria-label="Print route" value={value} onChange={(e) => setValue(e.target.value)}>
              {routes.map((r) => <option key={r} value={r}>{r}</option>)}
              <option value="">No ticket</option>
            </select>
          )}
          {asking === 'sst' && (
            <select className={inputCls} aria-label="SST" value={value} onChange={(e) => setValue(e.target.value)}>
              {SST_CHOICES.map((c) => <option key={c.bp} value={c.bp}>{c.label}</option>)}
            </select>
          )}
          {asking === 'fee' && (
            <label className="flex items-center gap-2">RM
              <input className={`${inputCls} w-24`} inputMode="decimal" aria-label="Takeaway fee in RM" value={value} autoFocus
                onChange={(e) => { setValue(e.target.value); setProblem(null) }} onKeyDown={(e) => e.key === 'Enter' && apply()} />
            </label>
          )}
          <button className={btnCls} disabled={busy} onClick={apply}>{applyLabel}</button>
          <button className="text-sm underline" onClick={() => setAsking(null)}>Cancel</button>
          {problem && <span role="alert" className="text-red-700">{problem}</span>}
        </div>
      )}
    </div>
  )
}
