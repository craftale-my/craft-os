import { useState } from 'react'
import { BUYER_ID_TYPES, STATE_CODES, buyerPayload, checkBuyer, emptyBuyer, type BuyerForm, type LargeBill } from './einvoice'
import { callEinvoice } from './einvoiceApi'

const rm = (sen: number) => `RM ${(sen / 100).toFixed(2)}`

type TextField = Exclude<keyof BuyerForm, 'idType' | 'stateCode'>
const FIELDS: { key: TextField; label: string; placeholder?: string }[] = [
  { key: 'name', label: 'Buyer name', placeholder: 'As registered with SSM, or as on the IC' },
  { key: 'tin', label: 'Buyer TIN', placeholder: 'C12345678090' },
  { key: 'idValue', label: 'ID number' },
  { key: 'email', label: 'Email (optional)' },
  { key: 'phone', label: 'Phone (optional)' },
  { key: 'addressLine', label: 'Address (optional)' },
  { key: 'city', label: 'City (optional)' },
  { key: 'postcode', label: 'Postcode (optional)' },
]

/** Bills over RM 10,000 (spec W5.6): never consolidated; the owner issues each with the buyer's details. */
export function EinvoiceLargeBills({ bills, branches, onIssued }: {
  bills: LargeBill[]; branches: Record<string, string>; onIssued: (message: string) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [form, setForm] = useState<BuyerForm>(emptyBuyer())
  const [errs, setErrs] = useState<Partial<Record<keyof BuyerForm, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (bills.length === 0) return null

  const start = (id: string) => { setOpen(id); setForm(emptyBuyer()); setErrs({}); setError(null) }
  const set = (key: keyof BuyerForm, value: string) => setForm({ ...form, [key]: value })

  const issue = async (b: LargeBill) => {
    const e = checkBuyer(form)
    setErrs(e)
    if (Object.keys(e).length) return
    setBusy(true); setError(null)
    const r = await callEinvoice<{ code_number?: string; status?: string }>({ action: 'submit_bill', billId: b.id, buyer: buyerPayload(form) })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setOpen(null)
    onIssued(`Bill ${b.bill_no}: e-invoice ${r.data.code_number ?? ''} sent${r.data.status ? ` — now ${r.data.status}` : ''}.`)
  }

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h2 className="font-semibold text-amber-900">Bills over RM 10,000 ({bills.length})</h2>
      <p className="text-xs text-amber-900">
        These never go into the monthly e-invoice. Ask the customer for their details and issue an individual e-invoice.
      </p>
      <ul className="mt-2 space-y-2 text-sm">
        {bills.map((b) => (
          <li key={b.id} className="rounded bg-white p-2">
            <div className="flex items-center justify-between gap-3">
              <span>{branches[b.branch_id] ?? 'Outlet'} · Bill {b.bill_no} · {b.day} · {rm(b.total_sen)}</span>
              {open !== b.id && (
                <button onClick={() => start(b.id)} className="shrink-0 rounded bg-brown-btn px-3 py-1 text-xs text-white hover:bg-brown-btn-hover">
                  Enter buyer details
                </button>
              )}
            </div>
            {open === b.id && (
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {FIELDS.map((f) => (
                    <label key={f.key} className="text-xs">
                      <span className="font-medium text-brown-muted">{f.label}</span>
                      <input aria-label={f.label} value={form[f.key]} placeholder={f.placeholder}
                        onChange={(e) => set(f.key, e.target.value)} className="mt-1 w-full rounded border border-border p-1 text-sm" />
                      {errs[f.key] && <span className="text-red-700">{errs[f.key]}</span>}
                    </label>
                  ))}
                  <label className="text-xs">
                    <span className="font-medium text-brown-muted">ID type</span>
                    <select aria-label="ID type" value={form.idType} onChange={(e) => set('idType', e.target.value)}
                      className="mt-1 w-full rounded border border-border p-1 text-sm">
                      {BUYER_ID_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </label>
                  <label className="text-xs">
                    <span className="font-medium text-brown-muted">State (optional)</span>
                    <select aria-label="State (optional)" value={form.stateCode} onChange={(e) => set('stateCode', e.target.value)}
                      className="mt-1 w-full rounded border border-border p-1 text-sm">
                      <option value="">Choose…</option>
                      {STATE_CODES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
                    </select>
                  </label>
                </div>
                {error && <p className="text-xs text-red-700">{error}</p>}
                <div className="flex gap-2">
                  <button disabled={busy} onClick={() => void issue(b)}
                    className="rounded bg-brown-btn px-3 py-1 text-xs text-white hover:bg-brown-btn-hover disabled:opacity-50">
                    {busy ? 'Sending…' : 'Issue e-invoice'}
                  </button>
                  <button onClick={() => setOpen(null)} className="text-xs underline">Cancel</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
