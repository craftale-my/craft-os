import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import { useAuth } from '../../auth/AuthContext'
import { fetchRoutes, fetchTables, insertTestPrint, type TableRow } from './posApi'
import type { PrintRoute, PrinterKind } from '../print/adapter'
import { qrLink, newQrToken } from './qrLink'
import { PRINT_ROUTES } from '../menu/menuView'

const KINDS: PrinterKind[] = ['agent', 'epson-epos', 'star-webprnt']

function check(res: { data: unknown[] | null; error: { message: string } | null }, what: string) {
  const out = writeOutcome(res)
  if (!out.ok) throw new Error(`${what} failed: ${out.reason}`)
}

export default function PosSettingsPage() {
  const { staff } = useAuth()
  const branchId = staff?.branch_id ?? null
  const [tables, setTables] = useState<TableRow[]>([])
  const [routes, setRoutes] = useState<PrintRoute[]>([])
  const [error, setError] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [card, setCard] = useState<{ table: TableRow; url: string; png: string } | null>(null)
  const [draft, setDraft] = useState<Record<string, { kind: PrinterKind; address: string }>>({})

  const load = async () => {
    if (!branchId) return
    try {
      const [t, r] = await Promise.all([fetchTables(branchId), fetchRoutes(branchId)])
      setTables(t); setRoutes(r)
      setDraft(Object.fromEntries(r.map((x) => [x.route, { kind: x.kind, address: x.address }])))
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<void>) => {
    try { await fn(); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const addTable = () => run(async () => {
    const label = newLabel.trim()
    if (!label || !branchId) throw new Error('Enter a table label')
    check(await supabase.from('dining_tables').insert({ branch_id: branchId, label, sort_order: tables.length + 1 }).select('id'), 'Adding the table')
    setNewLabel('')
  })
  const rename = (t: TableRow) => {
    const label = window.prompt('Table label', t.label)?.trim()
    if (!label || label === t.label) return
    void run(async () => { check(await supabase.from('dining_tables').update({ label }).eq('id', t.id).select('id'), 'Renaming') })
  }
  const remove = (t: TableRow) => {
    if (!window.confirm(`Remove table ${t.label}? Its QR code stops working.`)) return
    void run(async () => { check(await supabase.from('dining_tables').update({ is_active: false }).eq('id', t.id).select('id'), 'Removing') })
  }
  const regenerate = (t: TableRow) => {
    if (!window.confirm(`New QR code for ${t.label}? The printed card for this table must be replaced.`)) return
    void run(async () => { check(await supabase.from('dining_tables').update({ qr_token: newQrToken() }).eq('id', t.id).select('id'), 'New QR code') })
  }
  const showCard = async (t: TableRow) => {
    const url = qrLink(window.location.origin, t.qr_token, import.meta.env.DEV)
    setCard({ table: t, url, png: await QRCode.toDataURL(url, { width: 320, margin: 1 }) })
  }

  const saveRoute = (name: string) => run(async () => {
    const d = draft[name]
    if (!branchId || !d || !d.address.trim()) throw new Error('Enter the printer address')
    check(await supabase.from('print_routes').upsert({ branch_id: branchId, name, kind: d.kind, address: d.address.trim() }).select('name'), 'Saving the printer')
  })
  const removeRoute = (name: string) => run(async () => {
    if (!branchId) return
    check(await supabase.from('print_routes').delete().eq('branch_id', branchId).eq('name', name).select('name'), 'Removing the printer')
  })

  if (!branchId) return <div className="p-6">Your account has no branch — set it in Team first.</div>
  const routeNames = [...new Set([...PRINT_ROUTES, ...routes.map((r) => r.route)])]
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tables & printers</h1>
        <Link to="/pos" className="text-sm underline">Open POS</Link>
      </div>
      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">Tables</h2>
        <div className="mt-2 flex gap-2">
          <input className="rounded border border-border p-2 text-sm" placeholder="New table label, e.g. T11" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
          <button onClick={() => void addTable()} className="rounded bg-brown-btn px-3 py-2 text-sm text-white hover:bg-brown-btn-hover">Add table</button>
        </div>
        <table className="mt-3 w-full text-sm">
          <thead><tr className="text-left text-xs text-brown-muted"><th>Label</th><th>QR</th><th></th></tr></thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="py-2 font-medium">{t.label}{t.qr_paused && <span className="ml-2 text-xs text-amber-700">paused</span>}</td>
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
              <select className="rounded border border-border p-1" value={d.kind} onChange={(e) => setDraft({ ...draft, [name]: { ...d, kind: e.target.value as PrinterKind } })}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <input className="flex-1 rounded border border-border p-1" placeholder="192.168.0.8:9100" value={d.address} onChange={(e) => setDraft({ ...draft, [name]: { ...d, address: e.target.value } })} />
              <button onClick={() => void saveRoute(name)} className="rounded bg-brown-btn px-2 py-1 text-xs text-white">Save</button>
              {saved && <button onClick={() => insertTestPrint(name).catch((e) => setError(e.message))} className="rounded border border-border px-2 py-1 text-xs">Test print</button>}
              {saved && <button onClick={() => void removeRoute(name)} className="text-xs text-red-700 underline">Remove</button>}
            </div>
          )
        })}
      </section>

      {card && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={() => setCard(null)}>
          <div className="rounded-2xl bg-white p-6 text-center" onClick={(e) => e.stopPropagation()}>
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
