import { useCallback, useEffect, useRef, useState } from 'react'
import { useCan } from '../../../shared/lib/permissions'
import { fetchMyOutlets } from '../outlets/outletsApi'
import type { Outlet } from '../outlets/outlet'
import {
  KIND_LABELS, PLATFORM_LABELS, approveProblem, lastSeenText, mytDateTime,
  type ApproveDraft, type DeviceKind, type DeviceRow, type PendingRequest,
} from './devices'
import { approveRequest, fetchDevices, fetchPendingRequests, rejectRequest, setPrintTablet, unpairDevice } from './devicesApi'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const box = 'rounded-xl border border-border bg-card p-4'
const input = 'rounded border border-border p-1'
type Outcome = { ok: boolean; text: string } | null

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null
  return outcome.ok
    ? <p role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-800">{outcome.text}</p>
    : <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{outcome.text}</p>
}

/** POS → Devices: HQ approves the tablets and print agents waiting for activation; managers
 *  see and unpair the devices of their outlets. */
export default function DevicesPage() {
  const { can } = useCan()
  const isHq = can('all_branches') && can('access_settings')
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)       // null while loading or after a failed load
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const running = useRef(false)
  const seq = useRef(0)

  const loadDevices = useCallback(async () => {
    const id = ++seq.current
    try { const d = await fetchDevices(); if (id === seq.current) setDevices(d) }
    catch (e) { if (id === seq.current) { setDevices(null); setOutcome({ ok: false, text: `Could not load the devices: ${msg(e)}` }) } }
  }, [])
  useEffect(() => { void loadDevices() }, [loadDevices])

  const act = async (d: DeviceRow, fn: () => Promise<void>, done: string) => {
    if (running.current) return
    running.current = true; setBusyId(d.id); setOutcome(null)
    try { await fn(); setOutcome({ ok: true, text: done }); await loadDevices() }
    catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusyId(null) }
  }
  const unpair = (d: DeviceRow) => {
    if (!window.confirm(`Unpair ${d.name}? It stops working at once and needs a new activation.`)) return
    void act(d, () => unpairDevice(d.id), `${d.name} unpaired`)
  }
  const makePrinter = (d: DeviceRow) =>
    void act(d, () => setPrintTablet(d.id), `${d.name} now prints and holds the cash drawer at ${d.outletName}`)

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Devices</h1>
      {isHq && <PendingSection onApproved={loadDevices} />}
      <section className={box}>
        <h2 className="font-semibold">Devices</h2>
        <p className="text-xs text-brown-muted">Tablets and print agents activated for your outlets. Every tablet works on its own; one per outlet is the printing tablet (it prints and holds the cash drawer). Unpairing stops a device at once; to move it to another outlet, unpair it and activate it again.</p>
        {devices && devices.length === 0 && <p className="mt-2 text-sm text-brown-muted">No devices yet.</p>}
        {devices && devices.length > 0 && (
          <table className="mt-3 w-full text-sm">
            <thead><tr className="text-left text-xs text-brown-muted"><th>Device</th><th>Outlet</th><th>Kind</th><th>Approved</th><th>Last seen</th><th></th><th></th></tr></thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className={`border-t border-border ${d.revokedAt ? 'text-brown-muted' : ''}`}>
                  <td className="py-2 font-medium">{d.name}<span className="ml-2 text-xs text-brown-muted">{PLATFORM_LABELS[d.platform]}</span></td>
                  <td>{d.outletName}</td>
                  <td>{KIND_LABELS[d.kind]}{d.prints && <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-800">Prints · cash drawer</span>}</td>
                  <td className="text-xs">{d.approvedByName ?? '—'} · {mytDateTime(d.approvedAt)}</td>
                  <td className="text-xs">{d.revokedAt ? `Unpaired ${mytDateTime(d.revokedAt)}` : lastSeenText(d.lastSeenAt, new Date())}</td>
                  <td className="text-right">
                    {!d.revokedAt && d.kind === 'pos' && !d.prints && <button disabled={busyId !== null} onClick={() => makePrinter(d)} className="text-xs underline disabled:opacity-50">Make printing tablet</button>}
                  </td>
                  <td className="text-right">
                    {!d.revokedAt && <button disabled={busyId !== null} onClick={() => unpair(d)} className="text-xs text-red-700 underline disabled:opacity-50">{busyId === d.id ? 'Unpairing…' : 'Unpair'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <OutcomeLine outcome={outcome} />
      </section>
    </div>
  )
}

/** HQ only: requests waiting for a decision, refreshed every 15 s while the page is open. */
function PendingSection({ onApproved }: { onApproved: () => Promise<void> }) {
  const [requests, setRequests] = useState<PendingRequest[] | null>(null)
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [open, setOpen] = useState<{ request: PendingRequest; draft: ApproveDraft } | null>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)

  const load = useCallback(async () => {
    try { setRequests(await fetchPendingRequests()) }
    catch (e) { setRequests(null); setOutcome({ ok: false, text: `Could not load the requests: ${msg(e)}` }) }
  }, [])
  useEffect(() => {
    void load()
    fetchMyOutlets().then((o) => setOutlets(o.filter((x) => x.isActive)), (e) => setOutcome({ ok: false, text: `Could not load the outlets: ${msg(e)}` }))
    const timer = window.setInterval(() => { void load() }, 15000)
    return () => window.clearInterval(timer)
  }, [load])

  const act = async (fn: () => Promise<void>, done: string) => {
    if (running.current) return
    running.current = true; setBusy(true); setOutcome(null)
    try { await fn(); setOpen(null); setOutcome({ ok: true, text: done }); await load() }
    catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusy(false) }
  }
  const approve = () => {
    if (!open) return
    const problem = approveProblem(open.draft, open.request.code)
    if (problem) { setOutcome({ ok: false, text: problem }); return }
    void act(async () => { await approveRequest(open.request.id, open.draft); await onApproved() },
      `${open.draft.name.trim()} approved — the device finishes activating within a few seconds`)
  }
  const reject = (r: PendingRequest) => {
    if (!window.confirm(`Reject the request ${r.code}?`)) return
    void act(() => rejectRequest(r.id), `Request ${r.code} rejected`)
  }
  const change = (draft: ApproveDraft) => { if (open) setOpen({ ...open, draft }); setOutcome(null) }

  return (
    <section className={box}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Waiting for approval</h2>
        <button onClick={() => void load()} className="text-xs underline">Refresh</button>
      </div>
      <p className="text-xs text-brown-muted">A new tablet or print agent shows a code. Check it is the device in front of you, type its code, choose the outlet and approve. A request expires after 24 hours.</p>
      {requests && requests.length === 0 && <p className="mt-2 text-sm text-brown-muted">No device is waiting.</p>}
      {requests?.map((r) => (
        <div key={r.id} className="mt-2 flex items-center gap-3 border-t border-border pt-2 text-sm">
          <span className="font-mono font-semibold">{r.code}</span>
          <span>{r.name ?? 'Unnamed device'}</span>
          <span className="text-xs text-brown-muted">{PLATFORM_LABELS[r.platform]} · asked {mytDateTime(r.createdAt)}</span>
          <span className="ml-auto space-x-3">
            <button disabled={busy} onClick={() => { setOpen({ request: r, draft: { code: '', branchId: '', kind: r.platform === 'agent' ? 'print_agent' : 'pos', name: r.name ?? '', prints: false } }); setOutcome(null) }} className="text-xs underline">Approve…</button>
            <button disabled={busy} onClick={() => reject(r)} className="text-xs text-red-700 underline">Reject</button>
          </span>
        </div>
      ))}
      {open && (
        <div className="mt-3 space-y-2 rounded border border-border p-3 text-sm">
          <div className="font-medium">Approve {open.request.code}</div>
          <label className="block">Code shown on the device
            <input className={`${input} ml-2 w-28 font-mono uppercase`} value={open.draft.code} onChange={(e) => change({ ...open.draft, code: e.target.value })} />
          </label>
          <label className="block">Outlet
            <select className={`${input} ml-2`} value={open.draft.branchId} onChange={(e) => change({ ...open.draft, branchId: e.target.value })}>
              <option value="">Choose…</option>
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="block">Kind
            <select className={`${input} ml-2`} value={open.draft.kind} onChange={(e) => { const kind = e.target.value as DeviceKind; change({ ...open.draft, kind, prints: kind === 'pos' && open.draft.prints }) }}>
              {(Object.keys(KIND_LABELS) as DeviceKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
          </label>
          <label className="block">Name
            <input className={`${input} ml-2 w-64`} maxLength={40} placeholder="e.g. Cheras Counter iPad" value={open.draft.name} onChange={(e) => change({ ...open.draft, name: e.target.value })} />
          </label>
          {open.draft.kind === 'pos' && (
            <label className="block">
              <input type="checkbox" checked={open.draft.prints} onChange={(e) => change({ ...open.draft, prints: e.target.checked })} />
              <span className="ml-2">This tablet prints and holds the cash drawer</span>
              <span className="ml-2 text-xs text-brown-muted">One per outlet: it takes over from the current printing tablet.</span>
            </label>
          )}
          <div className="flex gap-2">
            <button disabled={busy} onClick={approve} className="rounded bg-brown-btn px-3 py-1 text-white disabled:opacity-50">{busy ? 'Approving…' : 'Approve'}</button>
            <button disabled={busy} onClick={() => { setOpen(null); setOutcome(null) }} className="rounded border border-border px-3 py-1">Cancel</button>
          </div>
        </div>
      )}
      <OutcomeLine outcome={outcome} />
    </section>
  )
}
