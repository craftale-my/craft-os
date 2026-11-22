import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import {
  checkSettings, cleanSettings, emptySettings, errorText, KIND_LABEL, openProblems, retryFor, retryForAttempt, STATE_CODES, toForm,
  isNeedsCheck, isUnexpectedStatus, isWaitingToResend, NEEDS_CHECK_COPY, UNEXPECTED_STATUS_COPY, WAITING_TO_RESEND_COPY,
  overdueMonths, retryForMonth, unreportedLabel,
  type Attempt, type EinvoiceDoc, type JobRun, type LargeBill, type Retry, type SettingsField, type SettingsForm,
  type UnreportedMonth,
} from './einvoice'
import {
  callEinvoice, fetchBranchNames, fetchDocuments, fetchJobRuns, fetchLargeBills, fetchReceiptDetails, fetchSettings,
  fetchStoppedAttempts, fetchUnreportedMonths, saveSettings, validationLink, type EinvoiceStatus,
} from './einvoiceApi'
import { EinvoiceJobRuns } from './EinvoiceJobRuns'
import { EinvoiceLargeBills } from './EinvoiceLargeBills'
import { EinvoiceOutlets } from './EinvoiceOutlets'

const rm = (sen: number) => `RM ${(sen / 100).toFixed(2)}`
const day = (iso: string) => new Date(iso).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })
const monthName = (isoDate: string) => new Date(`${isoDate}T00:00:00`).toLocaleDateString('en-MY', { month: 'long', year: 'numeric' })

const STATUS_STYLE: Record<EinvoiceDoc['status'], string> = {
  draft: 'bg-amber-50 text-amber-800', submitted: 'bg-blue-50 text-blue-800', valid: 'bg-green-50 text-green-800',
  invalid: 'bg-red-50 text-red-700', rejected: 'bg-red-50 text-red-700', cancelled: 'bg-gray-100 text-gray-600',
}

const FIELDS: { key: SettingsField; label: string; placeholder?: string; hint?: string; wide?: boolean }[] = [
  { key: 'supplier_name', label: 'Company name (as registered with SSM)', placeholder: 'Craftale Sdn Bhd', wide: true },
  { key: 'supplier_tin', label: 'Tax ID (TIN)', placeholder: 'C12345678090', hint: 'From MyTax → Profile' },
  { key: 'supplier_brn', label: 'SSM registration no.', placeholder: '201901012345' },
  { key: 'supplier_sst_no', label: 'SST registration no.', placeholder: 'W10-1808-31000123', hint: 'Leave blank if not registered' },
  { key: 'supplier_ttx_no', label: 'Tourism tax no.', hint: 'Usually blank for a cafe' },
  { key: 'msic_code', label: 'MSIC code', placeholder: '56101', hint: 'The 5-digit code on your SSM / LHDN profile' },
  { key: 'business_activity', label: 'Business activity', placeholder: 'Cafe and restaurant' },
  { key: 'address_line', label: 'Registered address', wide: true },
  { key: 'city', label: 'City', placeholder: 'Kuala Lumpur' },
  { key: 'postcode', label: 'Postcode', placeholder: '52100' },
  { key: 'state_code', label: 'State' },
  { key: 'phone', label: 'Phone', placeholder: '+60123456789' },
  { key: 'email', label: 'Email (optional)' },
]

function covers(d: EinvoiceDoc) {
  if (d.period_start) return monthName(d.period_start)
  return d.bill_id ? `Bill ${d.bill?.bill_no ?? d.bill_id.slice(0, 8)}` : '—'
}

export default function EinvoicePage() {
  const { staff } = useAuth()
  const [form, setForm] = useState<SettingsForm>(emptySettings())
  const [environment, setEnvironment] = useState<'sandbox' | 'production'>('sandbox')
  const [prefilled, setPrefilled] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SettingsField, string>>>({})
  const [saved, setSaved] = useState(false)
  const [docs, setDocs] = useState<EinvoiceDoc[]>([])
  const [stopped, setStopped] = useState<Attempt[]>([])
  const [largeBills, setLargeBills] = useState<LargeBill[]>([])
  const [runs, setRuns] = useState<JobRun[]>([])
  const [months, setMonths] = useState<UnreportedMonth[]>([])
  const [branches, setBranches] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<EinvoiceStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const checkStatus = async () => {
    setStatusError(null)
    const r = await callEinvoice<EinvoiceStatus>({ action: 'status' })
    if (r.ok) setStatus(r.data)
    else { setStatus(null); setStatusError(r.error) }
  }

  const loadDocs = async () => {
    const [d, b, st, lb, jr, um] = await Promise.all([
      fetchDocuments(), fetchBranchNames(), fetchStoppedAttempts(), fetchLargeBills(), fetchJobRuns(), fetchUnreportedMonths(),
    ])
    setDocs(d); setBranches(b); setStopped(st); setLargeBills(lb); setRuns(jr); setMonths(um)
  }

  useEffect(() => {
    void (async () => {
      try {
        const row = await fetchSettings()
        if (row) setEnvironment(row.environment)
        if (row?.supplier_name || !staff?.branch_id) setForm(toForm(row))
        else {
          // Nothing saved yet: start from the receipt details the branch already has.
          const r = await fetchReceiptDetails(staff.branch_id)
          setForm({
            ...toForm(row),
            supplier_name: r?.legal_name ?? '', supplier_brn: r?.registration_no ?? '', supplier_sst_no: r?.sst_no ?? '',
            address_line: r?.address ?? '', phone: r?.phone ?? '', email: r?.email ?? '',
          })
          setPrefilled(Boolean(r?.legal_name || r?.registration_no || r?.address))
        }
        await loadDocs()
      } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    })()
    void checkStatus()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaved(false); setError(null)
    const clean = cleanSettings(form)
    const errs = checkSettings(clean)
    setFieldErrors(errs)
    if (Object.keys(errs).length) return
    try {
      await saveSettings(clean)
      setForm(toForm(clean)); setPrefilled(false); setSaved(true)
      void checkStatus()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const runRetry = async (key: string, name: string, r: Retry) => {
    setBusy(key); setError(null); setNotice(null)
    const res = await callEinvoice<{ status?: string; nothingToDo?: boolean }>(r.body)
    setBusy(null)
    if (!res.ok) { setError(`${name}: ${res.error}`); return }
    setNotice(res.data.nothingToDo
      ? `${name}: every bill in that month is already covered.`
      : `${name}: ${r.label === 'Check with LHDN' ? 'status refreshed' : 'sent again'}${res.data.status ? ` — now ${res.data.status}` : ''}.`)
    try { await loadDocs() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const retry = (d: EinvoiceDoc) => {
    const r = retryFor(d)
    if (r) void runRetry(d.id, d.code_number, r)
  }
  const attemptName = (a: Attempt) =>
    `${KIND_LABEL[a.kind]} · ${branches[a.branch_id] ?? 'Outlet'}${a.period_start ? ` · ${monthName(a.period_start)}` : ''}`
  const issuedLarge = (message: string) => {
    setError(null); setNotice(message)
    void loadDocs().catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  const problems = openProblems(docs)
  // closed months not reported yet, once the daily run had its chance; a month already listed as stopped is not repeated
  const unreported = overdueMonths(months, runs[0] ?? null)
    .filter((m) => !stopped.some((a) => a.key === `CON|${m.branch_id}|${m.month.slice(0, 7)}`))
  const attention = problems.length + stopped.length + unreported.length
  const set = (key: SettingsField, value: string) => { setForm({ ...form, [key]: value }); setSaved(false) }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">E-invoice</h1>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${environment === 'production' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
          {environment === 'production' ? 'LHDN production' : 'LHDN sandbox (test only)'}
        </span>
      </div>
      <p className="text-sm text-brown-muted">
        Monthly consolidated e-invoices and customer requests are sent to LHDN automatically.
        You only need this page to set up the company once, and when something below is marked as needing attention.
      </p>
      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded bg-green-50 p-3 text-sm text-green-800">{notice}</p>}

      {attention > 0 && (
        <section className="rounded-xl border border-red-200 bg-red-50 p-4">
          <h2 className="font-semibold text-red-800">Needs attention ({attention})</h2>
          <p className="text-xs text-red-700">These were not reported to LHDN, or LHDN did not accept them. Fix the cause (usually the company details below), then press Retry.</p>
          <ul className="mt-2 space-y-2 text-sm">
            {problems.map((d) => {
              const r = retryFor(d)
              return (
                <li key={d.id} className="flex items-start justify-between gap-3 rounded bg-white p-2">
                  <div>
                    <div className="font-medium">{KIND_LABEL[d.kind]} · {branches[d.branch_id] ?? 'Branch'} · {covers(d)}</div>
                    <div className="text-xs text-red-700">{errorText(d.errors) || `Status: ${d.status}`}</div>
                  </div>
                  {r && (
                    <button disabled={busy === d.id} onClick={() => void retry(d)}
                      className="shrink-0 rounded bg-brown-btn px-3 py-1 text-xs text-white hover:bg-brown-btn-hover disabled:opacity-50">
                      {busy === d.id ? 'Sending…' : r.label}
                    </button>
                  )}
                </li>
              )
            })}
            {stopped.map((a) => (
              <li key={a.key} className="flex items-start justify-between gap-3 rounded bg-white p-2">
                <div>
                  <div className="font-medium">{attemptName(a)}</div>
                  <div className="text-xs text-red-700">Stopped after {a.failures} failed attempts{a.last_error ? `: ${a.last_error}` : ''}</div>
                </div>
                <button disabled={busy === a.key} onClick={() => void runRetry(a.key, attemptName(a), retryForAttempt(a))}
                  className="shrink-0 rounded bg-brown-btn px-3 py-1 text-xs text-white hover:bg-brown-btn-hover disabled:opacity-50">
                  {busy === a.key ? 'Sending…' : 'Retry'}
                </button>
              </li>
            ))}
            {unreported.map((m) => {
              const key = `month|${m.branch_id}|${m.month}`
              const label = unreportedLabel(m, branches[m.branch_id] ?? 'Outlet')
              return (
                <li key={key} className="flex items-start justify-between gap-3 rounded bg-white p-2">
                  <div>
                    <div className="font-medium">{label}</div>
                    <div className="text-xs text-red-700">Not reported to LHDN yet</div>
                  </div>
                  <button disabled={busy === key} onClick={() => void runRetry(key, label, retryForMonth(m))}
                    className="shrink-0 rounded bg-brown-btn px-3 py-1 text-xs text-white hover:bg-brown-btn-hover disabled:opacity-50">
                    {busy === key ? 'Sending…' : 'Retry'}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Connection to LHDN</h2>
          <button onClick={() => void checkStatus()} className="text-xs underline">Check again</button>
        </div>
        {statusError && <p className="mt-2 text-sm text-red-700">Could not reach the e-invoice service: {statusError}</p>}
        {!status && !statusError && <p className="mt-2 text-sm text-brown-muted">Checking…</p>}
        {status && (
          <ul className="mt-2 space-y-1 text-sm">
            <li>{status.credentials.clientId && status.credentials.clientSecret ? '✓' : '✗'} MyInvois API keys</li>
            <li>{status.token === 'ok' ? '✓' : '✗'} LHDN login {status.token !== 'ok' && <span className="text-xs text-brown-muted">({status.token})</span>}</li>
            <li>{status.settingsMissing.length === 0 ? '✓' : '✗'} Company details {status.settingsMissing.length > 0 && <span className="text-xs text-brown-muted">({status.settingsMissing.length} missing)</span>}</li>
          </ul>
        )}
        {status && !(status.credentials.clientId && status.credentials.clientSecret) && (
          <div className="mt-3 rounded bg-amber-50 p-3 text-xs text-amber-900">
            <p className="font-semibold">One-time setup by the company director</p>
            <ol className="ml-4 mt-1 list-decimal space-y-1">
              <li>Sign in to the MyInvois portal ({environment === 'production' ? 'myinvois.hasil.gov.my' : 'preprod.myinvois.hasil.gov.my'}) with MyTax.</li>
              <li>Open the company's profile → ERP → Register ERP. Copy the Client ID and Client Secret shown.</li>
              <li>In Supabase → Edge Functions → Secrets, add <code>MYINVOIS_CLIENT_ID</code> and <code>MYINVOIS_CLIENT_SECRET</code>.</li>
              <li>Come back here and press Check again.</li>
            </ol>
            <p className="mt-1">Keep the Client Secret private — do not send it by chat or email.</p>
          </div>
        )}
      </section>

      <EinvoiceOutlets docs={docs} />

      <EinvoiceLargeBills bills={largeBills} branches={branches} onIssued={issuedLarge} />

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">Company details</h2>
        <p className="text-xs text-brown-muted">Printed as the seller on every e-invoice. Must match what LHDN has for the company.</p>
        {prefilled && <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">Filled from your branch's receipt details. Check every field, then save.</p>}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <label key={f.key} className={`text-sm ${f.wide ? 'sm:col-span-2' : ''}`}>
              <span className="text-xs font-medium text-brown-muted">{f.label}</span>
              {f.key === 'state_code' ? (
                <select value={form.state_code} onChange={(e) => set('state_code', e.target.value)}
                  className="mt-1 w-full rounded border border-border p-2">
                  <option value="">Choose…</option>
                  {STATE_CODES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                </select>
              ) : f.key === 'address_line' ? (
                <textarea rows={2} value={form.address_line} onChange={(e) => set('address_line', e.target.value)}
                  className="mt-1 w-full rounded border border-border p-2" />
              ) : (
                <input value={form[f.key]} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)}
                  className="mt-1 w-full rounded border border-border p-2" />
              )}
              {fieldErrors[f.key]
                ? <span className="text-xs text-red-700">{fieldErrors[f.key]}</span>
                : f.hint && <span className="text-xs text-brown-muted">{f.hint}</span>}
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button onClick={() => void save()} className="rounded bg-brown-btn px-4 py-2 text-sm text-white hover:bg-brown-btn-hover">Save company details</button>
          {saved && <span className="text-sm text-green-700">Saved</span>}
          {Object.keys(fieldErrors).length > 0 && <span className="text-sm text-red-700">Fix the fields marked in red</span>}
        </div>
      </section>

      <EinvoiceJobRuns runs={runs} />

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">Sent to LHDN</h2>
        {docs.length === 0 ? (
          <p className="mt-2 text-sm text-brown-muted">Nothing sent yet. An outlet's first monthly consolidated e-invoice goes out on the 1st after its "Report e-invoices from" date.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-brown-muted">
                  <th className="py-1">Date</th><th>Type</th><th>Branch</th><th>Covers</th><th className="text-right">Total</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => {
                  const r = retryFor(d)
                  const link = validationLink(d)
                  return (
                    <tr key={d.id} className="border-t border-border align-top">
                      <td className="py-2 whitespace-nowrap">{day(d.created_at)}</td>
                      <td>{KIND_LABEL[d.kind]}<div className="text-xs text-brown-muted">{d.code_number}</div>
                        {(isNeedsCheck(d) || isUnexpectedStatus(d)) && (
                          <div className="mt-1 max-w-xs rounded bg-amber-50 p-1 text-xs text-amber-900">
                            <div>{isNeedsCheck(d) ? NEEDS_CHECK_COPY : UNEXPECTED_STATUS_COPY}</div>
                            {errorText(d.errors) && <div className="text-red-700">{errorText(d.errors)}</div>}
                          </div>
                        )}
                        {isWaitingToResend(d) && (
                          <div className="mt-1 max-w-xs text-xs text-amber-900">
                            {WAITING_TO_RESEND_COPY}{errorText(d.errors) ? ` (${errorText(d.errors)})` : ''}
                          </div>
                        )}
                      </td>
                      <td>{branches[d.branch_id] ?? '—'}</td>
                      <td>{covers(d)}</td>
                      <td className="text-right whitespace-nowrap">{rm(d.total_sen)}</td>
                      <td><span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[d.status]}`}>{d.status}</span></td>
                      <td className="space-x-2 whitespace-nowrap text-right text-xs">
                        {link && <a href={link} target="_blank" rel="noreferrer" className="underline">View on LHDN</a>}
                        {r && (
                          <button disabled={busy === d.id} onClick={() => void retry(d)} className="underline disabled:opacity-50">
                            {busy === d.id ? 'Sending…' : r.label}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
