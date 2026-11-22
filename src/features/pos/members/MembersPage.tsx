// src/features/pos/members/MembersPage.tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { useCan } from '../../../shared/lib/permissions'
import { formatPhone } from '../../../shared/lib/memberPhone'
import { readableError } from '../checkout/rpcResult'
import ConfirmDialog, { type ConfirmRequest } from '../shell/ConfirmDialog'
import {
  PAGE_SIZE, adjustPoints, deleteMember, fetchEarnFailures, fetchLedger, fetchMemberSettings, resolveEarnFailure, saveMemberSettings, searchMembers,
  type EarnFailure, type MemberLedger, type MemberPage, type MemberRow,
} from './membersApi'
import { KIND_LABEL, REASON_MAX, billOrReason, checkAdjust, checkSettings, dateMy, dateTimeMy, searchDigits, signedPoints } from './membersView'

export const SEARCH_DEBOUNCE_MS = 300
export const DELETE_CONFIRM = 'Delete this member? Their number is removed; past bills keep their totals.'
export const EARN_HINT = 'Use Adjust points to credit these by hand.'
export const MARK_DONE_CONFIRM = 'Mark this as handled?'

const input = 'h-10 rounded-lg border border-border-mid bg-card px-3 text-sm'
const btn = 'min-h-10 rounded-lg px-4 text-sm font-medium disabled:opacity-40'

/** POS → Members (members spec §3 "Owner (back office)"): search by number, the list 50 at a time, a member's
 *  ledger in a side panel. The owner also adjusts points, deletes a member, sees earn problems and the settings;
 *  a manager sees none of those controls (the server refuses them too). */
export default function MembersPage() {
  const { isOwner } = useCan()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(0)
  const [result, setResult] = useState<MemberPage | null>(null)   // null while loading
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [selected, setSelected] = useState<MemberRow | null>(null)

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(searchDigits(query)); setPage(0) }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])
  useEffect(() => {
    let live = true
    setResult(null); setError(null)
    searchMembers(debounced, page).then((r) => { if (live) setResult(r) }, (e: unknown) => { if (live) setError(readableError(e)) })
    return () => { live = false }
  }, [debounced, page, reloadKey])
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])
  // a page that came back empty (the last members on it were deleted): one page back
  useEffect(() => {
    if (result && result.rows.length === 0 && page > 0) setPage((p) => Math.max(0, p - 1))
  }, [result, page])

  const total = result?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return (
    <>
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Members</h1>
      <input type="search" inputMode="numeric" aria-label="Search by phone number" placeholder="Search by phone number"
        value={query} onChange={(e) => setQuery(e.target.value)} className={`${input} w-full max-w-sm`} />

      <section className="rounded-xl border border-border bg-card p-4">
        {error ? (
          <div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
            Could not load the members: {error}
            <button type="button" onClick={reload} className="ml-3 underline">Retry</button>
          </div>
        ) : !result ? (
          <p className="text-sm text-brown-muted">Loading…</p>
        ) : result.rows.length === 0 && total === 0 ? (
          <p className="text-sm text-brown-muted">{debounced ? 'No member has a number like that.' : 'No members yet.'}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-brown-muted">
                    <th className="px-2 py-1">Phone</th><th className="px-2 py-1">Joined</th>
                    <th className="px-2 py-1 text-right">Points</th><th className="px-2 py-1">Last visit</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((m) => (
                    <tr key={m.id} onClick={() => setSelected(m)} className="cursor-pointer border-t border-border hover:bg-cream">
                      <td className="px-2 py-1.5">
                        <button type="button" className="text-left font-medium underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setSelected(m) }}>
                          {formatPhone(m.phone)}
                        </button>
                      </td>
                      <td className="px-2 py-1.5">{dateMy(m.joinedAt)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{m.points}</td>
                      <td className="px-2 py-1.5">{dateMy(m.lastVisitAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-sm text-brown-muted">
              <span>{result.rows.length === 0 ? `0 of ${total}` : `${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + result.rows.length} of ${total}`}</span>
              <span className="flex gap-2">
                <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className={`${btn} border border-border-mid`}>Previous</button>
                <button type="button" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} className={`${btn} border border-border-mid`}>Next</button>
              </span>
            </div>
          </>
        )}
      </section>

      {isOwner && <SettingsSection />}
      {isOwner && <EarnProblems />}
    </div>
    {/* outside the space-y list: its margin-top would push the fixed panel 16 px down (seen in the browser) */}
    {selected && (
      <MemberPanel member={selected} isOwner={isOwner} onClose={() => setSelected(null)}
        onChanged={reload} onDeleted={() => { setSelected(null); reload() }} />
    )}
    </>
  )
}

function MemberPanel({ member, isOwner, onClose, onChanged, onDeleted }: {
  member: MemberRow
  isOwner: boolean
  onClose: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const [ledger, setLedger] = useState<MemberLedger | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState(0)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    setError(null)
    fetchLedger(member.id).then((l) => { if (live) setLedger(l) }, (e: unknown) => { if (live) setError(readableError(e)) })
    return () => { live = false }
  }, [member.id, key])

  const phone = formatPhone(member.phone)
  const points = ledger?.member.points ?? member.points
  const runAction = async (fn: () => Promise<void>) => {
    setBusy(true); setFormError(null)
    try { await fn() } catch (e) { setFormError(readableError(e)) } finally { setBusy(false) }
  }
  const adjust = (e: FormEvent) => {
    e.preventDefault()
    const c = checkAdjust(amount, reason)
    if ('error' in c) { setFormError(c.error); return }
    setFormError(null)
    setConfirm({
      title: 'Adjust points', confirmLabel: 'Adjust points',
      message: `${signedPoints(c.points)} points for ${phone}. Reason: ${reason.trim()}`,
      onConfirm: () => void runAction(async () => {
        await adjustPoints(member.id, c.points, reason.trim())
        setAmount(''); setReason(''); setKey((k) => k + 1); onChanged()
      }),
    })
  }
  const remove = () => setConfirm({
    title: DELETE_CONFIRM, confirmLabel: 'Delete member', danger: true,
    onConfirm: () => void runAction(async () => { await deleteMember(member.id); onDeleted() }),
  })

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={busy ? undefined : onClose}>
      <aside role="dialog" aria-modal="true" aria-label={`Member ${phone}`} onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-card p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-brown-dark">{phone}</h2>
            <p className="text-sm text-brown-muted">{points} {points === 1 ? 'point' : 'points'} · joined {dateMy(member.joinedAt)}</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-lg border border-border-mid"><X size={18} /></button>
        </div>

        <h3 className="mt-5 text-sm font-semibold">Ledger</h3>
        {error ? <p role="alert" className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">Could not load the ledger: {error}</p>
          : !ledger ? <p className="mt-2 text-sm text-brown-muted">Loading…</p>
          : ledger.entries.length === 0 ? <p className="mt-2 text-sm text-brown-muted">No points yet.</p>
          : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm" aria-label="Ledger">
                <thead>
                  <tr className="text-left text-xs text-brown-muted">
                    <th className="px-2 py-1">Date</th><th className="px-2 py-1">Outlet</th><th className="px-2 py-1">Kind</th>
                    <th className="px-2 py-1 text-right">Points</th><th className="px-2 py-1">Bill no. / reason</th><th className="px-2 py-1">Staff</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.entries.map((x) => (
                    <tr key={x.id} className="border-t border-border">
                      <td className="whitespace-nowrap px-2 py-1">{dateTimeMy(x.at)}</td>
                      <td className="px-2 py-1">{x.branchName ?? '—'}</td>
                      <td className="px-2 py-1">{KIND_LABEL[x.kind] ?? x.kind}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{signedPoints(x.points)}</td>
                      <td className="px-2 py-1">{billOrReason(x)}</td>
                      <td className="px-2 py-1">{x.staffName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

        {isOwner && (
          <form onSubmit={adjust} className="mt-6 space-y-2 border-t border-border pt-4" aria-label="Adjust points">
            <h3 className="text-sm font-semibold">Adjust points</h3>
            <div className="flex flex-wrap gap-2">
              <input aria-label="Points (+ or −)" placeholder="+20 or -20" inputMode="text" value={amount}
                onChange={(e) => { setAmount(e.target.value); setFormError(null) }} className={`${input} w-32`} />
              <input aria-label="Reason" placeholder="Reason" value={reason} maxLength={REASON_MAX}
                onChange={(e) => { setReason(e.target.value); setFormError(null) }} className={`${input} min-w-0 flex-1`} />
              <button type="submit" disabled={busy} className={`${btn} bg-brown-btn text-white hover:bg-brown-btn-hover`}>Adjust points</button>
            </div>
          </form>
        )}
        {formError && <p role="alert" className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{formError}</p>}
        {isOwner && (
          <div className="mt-6 border-t border-border pt-4">
            <button type="button" disabled={busy} onClick={remove} className={`${btn} border border-red-300 text-red-700`}>Delete member</button>
          </div>
        )}
      </aside>
      {confirm && (
        // its own clicks stay inside: a tap on the confirm's backdrop cancels the confirm, not the panel
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmDialog {...confirm} busy={busy} onCancel={() => setConfirm(null)}
            onConfirm={() => { const c = confirm; setConfirm(null); c.onConfirm() }} />
        </div>
      )}
    </div>
  )
}

function SettingsSection() {
  const [rate, setRate] = useState('')
  const [qrEnabled, setQrEnabled] = useState(true)
  const [cap, setCap] = useState('')
  const [sentToday, setSentToday] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const apply = (s: { rate: number; qrEnabled: boolean; smsDailyCap: number; smsSentToday: number }) => {
    setRate(String(s.rate)); setQrEnabled(s.qrEnabled); setCap(String(s.smsDailyCap)); setSentToday(s.smsSentToday); setLoaded(true)
  }
  useEffect(() => {
    let live = true
    fetchMemberSettings().then((s) => { if (live) apply(s) }, (e: unknown) => { if (live) setStatus({ ok: false, text: `Could not load the settings: ${readableError(e)}` }) })
    return () => { live = false }
  }, [])
  const save = async (e: FormEvent) => {
    e.preventDefault()
    const c = checkSettings(rate, cap)
    if ('error' in c) { setStatus({ ok: false, text: c.error }); return }
    setBusy(true); setStatus(null)
    try {
      apply(await saveMemberSettings({ rate: c.rate, qrEnabled, smsDailyCap: c.smsDailyCap }))
      setStatus({ ok: true, text: 'Saved' })
    } catch (err) { setStatus({ ok: false, text: readableError(err) }) } finally { setBusy(false) }
  }
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="Member settings">
      <h2 className="font-semibold">Settings</h2>
      <form noValidate onSubmit={(e) => void save(e)} className="mt-3 flex flex-wrap items-end gap-4">
        <label className="text-sm">
          <span className="block text-xs text-brown-muted">Points per RM 1</span>
          <input type="number" min={0} max={100} step="0.01" value={rate} disabled={!loaded}
            onChange={(e) => { setRate(e.target.value); setStatus(null) }} className={`${input} w-28`} />
        </label>
        <label className="flex h-10 items-center gap-2 text-sm">
          <input type="checkbox" role="switch" checked={qrEnabled} disabled={!loaded}
            onChange={(e) => { setQrEnabled(e.target.checked); setStatus(null) }} />
          Members on QR page
        </label>
        <label className="text-sm">
          <span className="block text-xs text-brown-muted">SMS codes per day</span>
          <input type="number" min={0} max={100000} step="1" value={cap} disabled={!loaded}
            onChange={(e) => { setCap(e.target.value); setStatus(null) }} className={`${input} w-28`} />
        </label>
        <button type="submit" disabled={!loaded || busy} className={`${btn} bg-brown-btn text-white hover:bg-brown-btn-hover`}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
      {sentToday !== null && <p className="mt-2 text-xs text-brown-muted">SMS codes sent today: {sentToday}</p>}
      {status && <p role={status.ok ? 'status' : 'alert'} className={`mt-2 text-sm ${status.ok ? 'text-green-800' : 'text-red-700'}`}>{status.text}</p>}
    </section>
  )
}

function EarnProblems() {
  const [rows, setRows] = useState<EarnFailure[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState(0)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    fetchEarnFailures().then((r) => { if (live) { setRows(r); setError(null) } }, (e: unknown) => { if (live) setError(readableError(e)) })
    return () => { live = false }
  }, [key])
  const markDone = (f: EarnFailure) => setConfirm({
    title: MARK_DONE_CONFIRM, message: `Bill ${f.billNo ?? '—'} leaves this list.`, confirmLabel: 'Mark done',
    onConfirm: () => {
      setBusy(true); setRowError(null)
      resolveEarnFailure(f.id).then(
        () => { setRows((rs) => (rs ?? []).filter((x) => x.id !== f.id)); setKey((k) => k + 1) },
        (e: unknown) => setRowError(readableError(e)),
      ).finally(() => setBusy(false))
    },
  })
  if (error) return <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">Could not load the earn problems: {error}</p>
  if (!rows || rows.length === 0) return null
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4" aria-label="Earn problems">
      <h2 className="font-semibold">Earn problems</h2>
      <p className="mt-1 text-sm text-amber-800">{EARN_HINT}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-brown-muted">
              <th className="px-2 py-1">Bill no.</th><th className="px-2 py-1">Outlet</th><th className="px-2 py-1">Time</th><th className="px-2 py-1">Error</th>
              <th className="px-2 py-1"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} className="border-t border-amber-200">
                <td className="px-2 py-1">{f.billNo ?? '—'}</td>
                <td className="px-2 py-1">{f.branchName ?? '—'}</td>
                <td className="whitespace-nowrap px-2 py-1">{dateTimeMy(f.at)}</td>
                <td className="px-2 py-1">{f.error}</td>
                <td className="px-2 py-1 text-right">
                  <button type="button" disabled={busy} onClick={() => markDone(f)}
                    className={`${btn} whitespace-nowrap border border-amber-400 bg-card`}>Mark done</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rowError && <p role="alert" className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{rowError}</p>}
      {confirm && (
        <ConfirmDialog {...confirm} busy={busy} onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); c.onConfirm() }} />
      )}
    </section>
  )
}
