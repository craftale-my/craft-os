import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import { useCan } from '../../../shared/lib/permissions'
import { fetchRoutes, fetchTables, insertTestPrint, type TableRow } from './posApi'
import type { PrintRoute, PrinterKind } from '../print/adapter'
import { qrLink, newQrToken } from './qrLink'
import { PRINT_ROUTES } from '../menu/menuView'
import { addTableAction, friendlyDbMessage, normalizeArea, openBillMessage, renameConflict } from './tableAdmin'
import CheckoutSettings from '../checkout/CheckoutSettings'
import MenuCatalogsSection from './MenuCatalogsSection'
import ShiftSettingsSection from '../shift/ShiftSettingsSection'
import OutletsSection from '../outlets/OutletsSection'
import { fetchMyOutlets } from '../outlets/outletsApi'
import { OUTLET_KINDS, pickOutlet, type Outlet } from '../outlets/outlet'

const KINDS: PrinterKind[] = ['agent', 'epson-epos', 'star-webprnt']

function check(res: { data: unknown[] | null; error: { message: string } | null }, what: string) {
  const out = writeOutcome(res)
  if (!out.ok) throw new Error(`${what} failed: ${friendlyDbMessage(out.reason)}`)
}

export default function PosSettingsPage() {
  const { can } = useCan()
  const [params, setParams] = useSearchParams()
  const [outlets, setOutlets] = useState<Outlet[] | null>(null)     // null while loading
  const [outletsError, setOutletsError] = useState<string | null>(null)
  const outlet = outlets ? pickOutlet(outlets, params.get('outlet')) : null
  const branchId = outlet?.id ?? null
  const loadOutlets = async () => {
    try { setOutlets(await fetchMyOutlets()); setOutletsError(null) }
    catch (e) { setOutletsError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void loadOutlets() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const chooseOutlet = (id: string) => setParams((p) => { p.set('outlet', id); return p }, { replace: true })
  const [tables, setTables] = useState<TableRow[]>([])
  const [routes, setRoutes] = useState<PrintRoute[]>([])
  const [error, setError] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [card, setCard] = useState<{ table: TableRow; url: string; png: string } | null>(null)
  const [draft, setDraft] = useState<Record<string, { kind: PrinterKind; address: string }>>({})

  const dirty = useRef<Set<string>>(new Set())

  const load = async () => {
    if (!branchId) return
    try {
      const [t, r] = await Promise.all([fetchTables(branchId), fetchRoutes(branchId)])
      setTables(t); setRoutes(r)
      setDraft((prev) => {
        const next: Record<string, { kind: PrinterKind; address: string }> = Object.fromEntries(r.map((x) => [x.route, { kind: x.kind, address: x.address }]))
        for (const name of dirty.current) if (prev[name]) next[name] = prev[name]
        return next
      })
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { setTables([]); setRoutes([]); setDraft({}); dirty.current.clear(); void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<void>) => {
    try { await fn(); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const addTable = () => run(async () => {
    const label = newLabel.trim()
    if (!label || !branchId) throw new Error('Enter a table label')
    const { data: inactive, error: inactiveErr } = await supabase.from('dining_tables').select('id').eq('branch_id', branchId).eq('label', label).eq('is_active', false).limit(1)
    if (inactiveErr) throw new Error(`Adding the table failed: ${inactiveErr.message}`)
    const action = addTableAction(label, tables, (inactive ?? []).length > 0)
    if (action === 'exists') throw new Error(`Table ${label} already exists.`)
    if (action === 'reactivate') {
      check(await supabase.from('dining_tables').update({ is_active: true, qr_token: newQrToken(), sort_order: tables.length + 1 }).eq('branch_id', branchId).eq('label', label).eq('is_active', false).select('id'), 'Adding the table')
    } else {
      check(await supabase.from('dining_tables').insert({ branch_id: branchId, label, sort_order: tables.length + 1 }).select('id'), 'Adding the table')
    }
    setNewLabel('')
  })
  const rename = (t: TableRow) => {
    const label = window.prompt('Table label', t.label)?.trim()
    if (!label || label === t.label) return
    void run(async () => {
      let inactiveExists = false
      if (!renameConflict(label, t.id, tables, false) && branchId) {
        const { data, error: err } = await supabase.from('dining_tables').select('id').eq('branch_id', branchId).eq('label', label).eq('is_active', false).neq('id', t.id).limit(1)
        if (err) throw new Error(`Renaming failed: ${err.message}`)
        inactiveExists = (data ?? []).length > 0
      }
      const conflict = renameConflict(label, t.id, tables, inactiveExists)
      if (conflict) throw new Error(conflict)
      check(await supabase.from('dining_tables').update({ label }).eq('id', t.id).select('id'), 'Renaming')
    })
  }
  const remove = (t: TableRow) => {
    if (!window.confirm(`Remove table ${t.label}? Its QR code stops working.`)) return
    void run(async () => {
      const { data, error: err } = await supabase.from('bills').select('bill_no').eq('table_id', t.id).eq('status', 'open').limit(1)
      if (err) throw new Error(`Removing failed: ${err.message}`)
      if (data && data.length > 0) throw new Error(openBillMessage(t.label, String(data[0].bill_no)))
      check(await supabase.from('dining_tables').update({ is_active: false }).eq('id', t.id).select('id'), 'Removing')
    })
  }
  const regenerate = (t: TableRow) => {
    if (!window.confirm(`New QR code for ${t.label}? The printed card for this table must be replaced.`)) return
    void run(async () => { check(await supabase.from('dining_tables').update({ qr_token: newQrToken() }).eq('id', t.id).select('id'), 'New QR code') })
  }
  // the home screen's area tabs: empty = no area (the table is only under All)
  const saveArea = (t: TableRow, text: string) => {
    const r = normalizeArea(text)
    if ('problem' in r) { setError(r.problem); return }
    if (r.area === t.area) return
    void run(async () => { check(await supabase.from('dining_tables').update({ area: r.area }).eq('id', t.id).select('id'), 'Saving the area') })
  }
  const showCard = async (t: TableRow) => {
    const url = qrLink(window.location.origin, t.qr_token, import.meta.env.DEV)
    try {
      setCard({ table: t, url, png: await QRCode.toDataURL(url, { width: 320, margin: 1 }) })
    } catch (e) {
      setError(`Could not make the QR code: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const saveRoute = (name: string) => run(async () => {
    const d = draft[name]
    if (!branchId || !d || !d.address.trim()) throw new Error('Enter the printer address')
    check(await supabase.from('print_routes').upsert({ branch_id: branchId, name, kind: d.kind, address: d.address.trim() }).select('name'), 'Saving the printer')
    dirty.current.delete(name)
  })
  const removeRoute = (name: string) => run(async () => {
    if (!branchId) return
    check(await supabase.from('print_routes').delete().eq('branch_id', branchId).eq('name', name).select('name'), 'Removing the printer')
    dirty.current.delete(name)
  })

  if (outletsError) return <div className="p-6 text-red-700">Could not load your outlets: {outletsError}</div>
  if (!outlets) return <div className="p-6">Loading…</div>
  if (!branchId) return <div className="p-6">You have no outlets — ask HQ to set your home branch in Team.</div>
  const routeNames = [...new Set([...PRINT_ROUTES, ...routes.map((r) => r.route)])]
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">POS settings</h1>
        <label className="text-sm">Outlet
          <select className="ml-2 rounded border border-border p-1" value={branchId} onChange={(e) => chooseOutlet(e.target.value)}>
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name} · {OUTLET_KINDS.find((k) => k.kind === o.kind)?.label}</option>)}
          </select>
        </label>
        <Link to="/pos" className="text-sm underline">Open POS</Link>
      </div>
      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <OutletsSection outlets={outlets} isHq={can('all_branches')} onSaved={async (id) => { await loadOutlets(); chooseOutlet(id) }} />

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">Tables</h2>
        <p className="text-xs text-brown-muted">The area groups tables into tabs on the POS home screen, in table order. Leave it empty for a table that is only under All.</p>
        <div className="mt-2 flex gap-2">
          <input className="rounded border border-border p-2 text-sm" placeholder="New table label, e.g. T11" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
          <button onClick={() => void addTable()} className="rounded bg-brown-btn px-3 py-2 text-sm text-white hover:bg-brown-btn-hover">Add table</button>
        </div>
        <table className="mt-3 w-full text-sm">
          <thead><tr className="text-left text-xs text-brown-muted"><th>Label</th><th>Area</th><th>QR</th><th></th></tr></thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="py-2 font-medium">{t.label}{t.qr_paused && <span className="ml-2 text-xs text-amber-700">paused</span>}</td>
                <td><AreaField key={`${t.id}:${t.area ?? ''}`} table={t} onSave={(text) => saveArea(t, text)} /></td>
                <td><button className="underline" onClick={() => void showCard(t)}>Show QR card</button></td>
                <td className="space-x-3 text-right text-xs">
                  <button className="underline" onClick={() => rename(t)}>Rename</button>
                  <button className="underline" onClick={() => regenerate(t)}>New QR code</button>
                  <button className="text-red-700 underline" onClick={() => remove(t)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">Printers by route</h2>
        <p className="text-xs text-brown-muted">A product's print route (set on Menu) is sent to the printer named here. `agent` = the Node print agent on the shop Mac (address `ip:9100`).</p>
        {routeNames.map((name) => {
          const d = draft[name] ?? { kind: 'agent' as PrinterKind, address: '' }
          const saved = routes.find((r) => r.route === name)
          return (
            <div key={name} className="mt-2 flex items-center gap-2 text-sm">
              <span className="w-28 font-medium">{name}</span>
              <select className="rounded border border-border p-1" value={d.kind} onChange={(e) => { dirty.current.add(name); setDraft({ ...draft, [name]: { ...d, kind: e.target.value as PrinterKind } }) }}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <input className="flex-1 rounded border border-border p-1" placeholder="192.168.0.8:9100" value={d.address} onChange={(e) => { dirty.current.add(name); setDraft({ ...draft, [name]: { ...d, address: e.target.value } }) }} />
              <button onClick={() => void saveRoute(name)} className="rounded bg-brown-btn px-2 py-1 text-xs text-white">Save</button>
              {saved && <button onClick={() => insertTestPrint(name, branchId).catch((e) => setError(e.message))} className="rounded border border-border px-2 py-1 text-xs">Test print</button>}
              {saved && <button onClick={() => void removeRoute(name)} className="text-xs text-red-700 underline">Remove</button>}
            </div>
          )
        })}
      </section>

      <MenuCatalogsSection branchId={branchId} />

      <CheckoutSettings branchId={branchId} routes={routes.map((r) => r.route)} tables={tables} />

      <ShiftSettingsSection branchId={branchId} />

      {card && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={() => setCard(null)}>
          <div className="print-card rounded-2xl bg-white p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <div className="text-3xl font-semibold">Table {card.table.label}</div>
            <img src={card.png} alt={`QR for ${card.table.label}`} className="mx-auto my-3 h-80 w-80" />
            <div className="text-xs text-brown-muted">Scan to order · {card.url}</div>
            <button className="mt-3 rounded border border-border px-3 py-1 text-sm" onClick={() => window.print()}>Print this card</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** A table's area, saved when the field loses focus or Enter is pressed. Remounted (by its key)
 *  when the saved area changes, so it always starts from what is stored. */
function AreaField({ table, onSave }: { table: TableRow; onSave: (text: string) => void }) {
  const [text, setText] = useState(table.area ?? '')
  return (
    <input aria-label={`Area of table ${table.label}`} className="w-36 rounded border border-border p-1 text-sm" placeholder="No area"
      maxLength={60} value={text} onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text.trim() !== (table.area ?? '')) onSave(text) }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  )
}
