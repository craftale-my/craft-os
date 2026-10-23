import { useEffect, useMemo, useState } from 'react'
import type { TableRow } from '../order/posApi'
import type { BillOrderType, CashRounding } from './bill'
import {
  clearPin, deleteServiceChargeRule, fetchApprovers, fetchPaymentMethods, fetchProductNames, fetchReasonTemplates,
  fetchReceiptDetails, fetchServiceChargeRules, savePaymentMethod, saveReasonTemplate, saveReceiptDetails,
  saveServiceChargeRule, type Approver, type PaymentMethodRow, type ReceiptDetails, type ServiceChargeRuleRow,
} from './checkoutApi'
import { ACTION_TITLES, type ReasonAction } from './reasons'
import { bpToPercentText, parsePercentBp, parseReasons, receiptDetailsProblem, scopeLabel } from './settingsForm'
import type { PaymentKind } from './tender'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const KINDS: PaymentKind[] = ['cash', 'card', 'duitnow', 'ewallet', 'other']
const ACTIONS: ReasonAction[] = ['void_item', 'void_bill', 'refund']
const ORDER_TYPES: { key: BillOrderType; label: string }[] = [{ key: 'dine_in', label: 'Dine-in' }, { key: 'takeaway', label: 'Takeaway' }]
const box = 'rounded-xl border border-border bg-card p-4'
const input = 'rounded border border-border p-1'

/** The checkout sections of /pos/settings: receipt details, service charge,
 *  payment methods, reason templates and approver PINs (access_settings holders). */
export default function CheckoutSettings({ branchId, routes, tables }: { branchId: string; routes: string[]; tables: TableRow[] }) {
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>, done: string) => {
    setError(null); setNote(null)
    try { await fn(); setNote(done) } catch (e) { setError(msg(e)) }
  }
  return (
    <div className="space-y-6">
      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {note && <p className="rounded bg-green-50 p-3 text-sm text-green-800">{note}</p>}
      <ReceiptSection branchId={branchId} routes={routes} run={run} onError={setError} />
      <ServiceChargeSection branchId={branchId} tables={tables} run={run} onError={setError} />
      <PaymentMethodsSection branchId={branchId} run={run} onError={setError} />
      <ReasonsSection branchId={branchId} run={run} onError={setError} />
      <ApproversSection run={run} onError={setError} />
    </div>
  )
}

type Run = (fn: () => Promise<void>, done: string) => Promise<void>

function ReceiptSection({ branchId, routes, run, onError }: { branchId: string; routes: string[]; run: Run; onError: (m: string) => void }) {
  const [d, setD] = useState<ReceiptDetails | null>(null)
  useEffect(() => { fetchReceiptDetails(branchId).then(setD, (e) => onError(msg(e))) }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <section className={box}><h2 className="font-semibold">Receipt</h2><p className="text-sm text-brown-muted">Loading…</p></section>
  const text = (key: 'receiptTitle' | 'legalName' | 'registrationNo' | 'sstNo' | 'address' | 'phone' | 'email', label: string) => (
    <label className="block text-sm">{label}
      <input className={`${input} mt-1 w-full`} value={d[key]} onChange={(e) => setD({ ...d, [key]: e.target.value })} />
    </label>
  )
  const save = () => run(async () => {
    const problem = receiptDetailsProblem(d)
    if (problem) throw new Error(problem)
    await saveReceiptDetails(d)
  }, 'Receipt settings saved')
  return (
    <section className={box}>
      <h2 className="font-semibold">Receipt</h2>
      <p className="text-xs text-brown-muted">Printed at the top and bottom of every customer receipt. ASCII only for now: Chinese prints as "?".</p>
      <div className="mt-2 grid grid-cols-2 gap-3">
        {text('receiptTitle', 'Title (shop name)')}
        {text('legalName', 'Company name')}
        {text('registrationNo', 'Registration no.')}
        {text('sstNo', 'SST no.')}
        {text('address', 'Address')}
        {text('phone', 'Phone')}
        {text('email', 'Email')}
        <label className="block text-sm">Receipt printer (route)
          <select className={`${input} mt-1 w-full`} value={d.receiptRoute ?? ''} onChange={(e) => setD({ ...d, receiptRoute: e.target.value || null })}>
            <option value="">No receipt printer</option>
            {routes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="col-span-2 block text-sm">Footer
          <input className={`${input} mt-1 w-full`} value={d.footer} onChange={(e) => setD({ ...d, footer: e.target.value })} />
        </label>
        <label className="text-sm"><input type="checkbox" checked={d.sstRegistered} onChange={(e) => setD({ ...d, sstRegistered: e.target.checked })} /> SST registered (charge SST)</label>
        <label className="text-sm">Rounding
          <select className={`${input} ml-2`} value={d.cashRounding} onChange={(e) => setD({ ...d, cashRounding: e.target.value as CashRounding })}>
            <option value="nearest_5_sen">Nearest 5 sen (whole bill)</option>
            <option value="none">None</option>
          </select>
        </label>
        <label className="col-span-2 text-sm"><input type="checkbox" checked={d.qrRequiresOpenBill} onChange={(e) => setD({ ...d, qrRequiresOpenBill: e.target.checked })} /> Staff must open a table before customers can order by QR</label>
      </div>
      <button onClick={() => void save()} className="mt-3 rounded bg-brown-btn px-3 py-2 text-sm text-white">Save receipt settings</button>
    </section>
  )
}

interface RuleDraft { id?: string; rateText: string; orderTypes: BillOrderType[]; tableIds: string[] | null; productIds: string[] | null; sortOrder: number; isActive: boolean }
const toDraft = (r: ServiceChargeRuleRow): RuleDraft => ({
  id: r.id, rateText: bpToPercentText(r.rate_bp), orderTypes: r.order_types, tableIds: r.table_ids, productIds: r.product_ids, sortOrder: r.sort_order, isActive: r.is_active,
})

function ServiceChargeSection({ branchId, tables, run, onError }: { branchId: string; tables: TableRow[]; run: Run; onError: (m: string) => void }) {
  const [rules, setRules] = useState<ServiceChargeRuleRow[]>([])
  const [products, setProducts] = useState<{ id: string; name: string }[]>([])
  const [draft, setDraft] = useState<RuleDraft | null>(null)
  const [search, setSearch] = useState('')
  const load = () => fetchServiceChargeRules(branchId).then(setRules, (e) => onError(msg(e)))
  useEffect(() => { void load(); fetchProductNames().then(setProducts, (e) => onError(msg(e))) }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const chosen = new Set(draft?.productIds ?? [])
    return products.filter((p) => chosen.has(p.id) || (q && p.name.toLowerCase().includes(q))).slice(0, 60)
  }, [products, search, draft?.productIds])

  const save = () => run(async () => {
    if (!draft) return
    const rate = parsePercentBp(draft.rateText)
    if (rate === null) throw new Error('Enter the rate as a percentage, e.g. 10')
    if (draft.orderTypes.length === 0) throw new Error('Choose at least one order type')
    if (draft.tableIds?.length === 0) throw new Error('Choose at least one table, or All tables')
    if (draft.productIds?.length === 0) throw new Error('Choose at least one product, or All products')
    await saveServiceChargeRule({
      ...(draft.id ? { id: draft.id } : {}), branch_id: branchId, rate_bp: rate, order_types: draft.orderTypes,
      table_ids: draft.tableIds, product_ids: draft.productIds, sort_order: draft.sortOrder, is_active: draft.isActive,
    })
    setDraft(null); await load()
  }, 'Service-charge rule saved')
  const remove = (r: ServiceChargeRuleRow) => {
    if (!window.confirm(`Remove the ${bpToPercentText(r.rate_bp)}% rule?`)) return
    void run(async () => { await deleteServiceChargeRule(r.id); await load() }, 'Rule removed')
  }
  const toggle = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x])

  return (
    <section className={box}>
      <h2 className="font-semibold">Service charge</h2>
      <p className="text-xs text-brown-muted">Each item takes the first matching active rule, top to bottom. Items no rule matches pay none. SST is not charged on the service charge.</p>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {rules.map((r) => (
            <tr key={r.id} className={`border-t border-border ${r.is_active ? '' : 'opacity-50'}`}>
              <td className="py-2 font-medium">{bpToPercentText(r.rate_bp)}%</td>
              <td>{r.order_types.map((t) => ORDER_TYPES.find((o) => o.key === t)?.label ?? t).join(' + ')}</td>
              <td>{scopeLabel(r.table_ids, 'table')}</td>
              <td>{scopeLabel(r.product_ids, 'product')}</td>
              <td className="text-xs">#{r.sort_order}{r.is_active ? '' : ' · off'}</td>
              <td className="space-x-3 text-right text-xs">
                <button className="underline" onClick={() => { setDraft(toDraft(r)); setSearch('') }}>Edit</button>
                <button className="text-red-700 underline" onClick={() => remove(r)}>Remove</button>
              </td>
            </tr>
          ))}
          {rules.length === 0 && <tr><td className="py-2 text-brown-muted">No service charge.</td></tr>}
        </tbody>
      </table>
      {!draft && (
        <button onClick={() => setDraft({ rateText: '10', orderTypes: ['dine_in'], tableIds: null, productIds: null, sortOrder: rules.length + 1, isActive: true })}
          className="mt-2 rounded border border-border px-3 py-1 text-sm">Add rule</button>
      )}
      {draft && (
        <div className="mt-3 space-y-3 rounded-lg bg-cream p-3 text-sm">
          <div className="flex flex-wrap items-center gap-4">
            <label>Rate % <input className={`${input} w-20`} value={draft.rateText} onChange={(e) => setDraft({ ...draft, rateText: e.target.value })} /></label>
            {ORDER_TYPES.map((o) => (
              <label key={o.key}><input type="checkbox" checked={draft.orderTypes.includes(o.key)} onChange={() => setDraft({ ...draft, orderTypes: toggle(draft.orderTypes, o.key) })} /> {o.label}</label>
            ))}
            <label>Order <input type="number" className={`${input} w-16`} value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })} /></label>
            <label><input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Active</label>
          </div>
          <div>
            <label><input type="radio" checked={draft.tableIds === null} onChange={() => setDraft({ ...draft, tableIds: null })} /> All tables</label>
            <label className="ml-4"><input type="radio" checked={draft.tableIds !== null} onChange={() => setDraft({ ...draft, tableIds: draft.tableIds ?? [] })} /> Only these tables</label>
            {draft.tableIds !== null && (
              <div className="mt-1 flex flex-wrap gap-2">
                {tables.map((t) => (
                  <label key={t.id} className="rounded border border-border px-2 py-1">
                    <input type="checkbox" checked={draft.tableIds?.includes(t.id) ?? false} onChange={() => setDraft({ ...draft, tableIds: toggle(draft.tableIds ?? [], t.id) })} /> {t.label}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div>
            <label><input type="radio" checked={draft.productIds === null} onChange={() => setDraft({ ...draft, productIds: null })} /> All products</label>
            <label className="ml-4"><input type="radio" checked={draft.productIds !== null} onChange={() => setDraft({ ...draft, productIds: draft.productIds ?? [] })} /> Only these products</label>
            {draft.productIds !== null && (
              <div className="mt-1">
                <input className={`${input} w-64`} placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} />
                <span className="ml-2 text-xs text-brown-muted">{draft.productIds.length} chosen</span>
                <div className="mt-1 max-h-48 overflow-y-auto">
                  {shown.map((p) => (
                    <label key={p.id} className="block">
                      <input type="checkbox" checked={draft.productIds?.includes(p.id) ?? false} onChange={() => setDraft({ ...draft, productIds: toggle(draft.productIds ?? [], p.id) })} /> {p.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={() => void save()} className="rounded bg-brown-btn px-3 py-1 text-white">Save rule</button>
            <button onClick={() => setDraft(null)} className="rounded border border-border px-3 py-1">Cancel</button>
          </div>
        </div>
      )}
    </section>
  )
}

function PaymentMethodsSection({ branchId, run, onError }: { branchId: string; run: Run; onError: (m: string) => void }) {
  const [rows, setRows] = useState<(Omit<PaymentMethodRow, 'id'> & { id?: string })[]>([])
  const load = () => fetchPaymentMethods(branchId, false).then(setRows, (e) => onError(msg(e)))
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = (i: number, patch: Partial<PaymentMethodRow>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const save = (i: number) => run(async () => {
    const r = rows[i]
    if (!r.name.trim()) throw new Error('Enter the payment method name')
    await savePaymentMethod({ ...r, name: r.name.trim() })
    await load()
  }, 'Payment method saved')
  return (
    <section className={box}>
      <h2 className="font-semibold">Payment methods</h2>
      <p className="text-xs text-brown-muted">Only cash gives change. "Needs reference" makes the cashier type the terminal or transfer reference. Turn a method off instead of deleting it: old bills keep its name.</p>
      {rows.map((r, i) => (
        <div key={r.id ?? `new${i}`} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <input className={`${input} w-44`} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
          <select className={input} value={r.kind} onChange={(e) => set(i, { kind: e.target.value as PaymentKind })}>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <label><input type="checkbox" checked={r.needs_reference} onChange={(e) => set(i, { needs_reference: e.target.checked })} /> Needs reference</label>
          <label><input type="checkbox" checked={r.is_active} onChange={(e) => set(i, { is_active: e.target.checked })} /> Active</label>
          <label>Order <input type="number" className={`${input} w-14`} value={r.sort_order} onChange={(e) => set(i, { sort_order: Number(e.target.value) || 0 })} /></label>
          <button onClick={() => void save(i)} className="rounded bg-brown-btn px-2 py-1 text-xs text-white">Save</button>
        </div>
      ))}
      <button onClick={() => setRows((rs) => [...rs, { branch_id: branchId, name: '', kind: 'other', needs_reference: false, sort_order: rs.length + 1, is_active: true }])}
        className="mt-2 rounded border border-border px-3 py-1 text-sm">Add payment method</button>
    </section>
  )
}

function ReasonsSection({ branchId, run, onError }: { branchId: string; run: Run; onError: (m: string) => void }) {
  const [drafts, setDrafts] = useState<Record<ReasonAction, { text: string; compulsory: boolean; allowOther: boolean }>>({
    void_item: { text: '', compulsory: true, allowOther: true },
    void_bill: { text: '', compulsory: true, allowOther: true },
    refund: { text: '', compulsory: true, allowOther: true },
  })
  useEffect(() => {
    fetchReasonTemplates(branchId).then((rows) => setDrafts((d) => {
      const next = { ...d }
      for (const r of rows) next[r.action] = { text: r.reasons.join('\n'), compulsory: r.compulsory, allowOther: r.allow_other }
      return next
    }), (e) => onError(msg(e)))
  }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = (a: ReasonAction) => run(async () => {
    const d = drafts[a]
    const reasons = parseReasons(d.text)
    if (!d.allowOther && reasons.length === 0) throw new Error('List at least one reason, or allow Other')
    await saveReasonTemplate({ branch_id: branchId, action: a, reasons, compulsory: d.compulsory, allow_other: d.allowOther })
  }, `${ACTION_TITLES[a]} reasons saved`)
  return (
    <section className={box}>
      <h2 className="font-semibold">Reasons for voids and refunds</h2>
      <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
        {ACTIONS.map((a) => (
          <div key={a}>
            <div className="font-medium">{ACTION_TITLES[a]}</div>
            <textarea rows={5} className={`${input} mt-1 w-full`} placeholder="One reason per line" value={drafts[a].text}
              onChange={(e) => setDrafts({ ...drafts, [a]: { ...drafts[a], text: e.target.value } })} />
            <label className="block"><input type="checkbox" checked={drafts[a].compulsory} onChange={(e) => setDrafts({ ...drafts, [a]: { ...drafts[a], compulsory: e.target.checked } })} /> Reason required</label>
            <label className="block"><input type="checkbox" checked={drafts[a].allowOther} onChange={(e) => setDrafts({ ...drafts, [a]: { ...drafts[a], allowOther: e.target.checked } })} /> Allow "Other" (typed)</label>
            <button onClick={() => void save(a)} className="mt-1 rounded bg-brown-btn px-2 py-1 text-xs text-white">Save</button>
          </div>
        ))}
      </div>
    </section>
  )
}

function ApproversSection({ run, onError }: { run: Run; onError: (m: string) => void }) {
  const [rows, setRows] = useState<Approver[]>([])
  const load = () => fetchApprovers().then(setRows, (e) => onError(msg(e)))
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const clear = (a: Approver) => {
    if (!window.confirm(`Clear ${a.name}'s PIN? They set a new one under My PIN on the POS.`)) return
    void run(async () => { await clearPin(a.staffId); await load() }, `${a.name}'s PIN cleared`)
  }
  return (
    <section className={box}>
      <h2 className="font-semibold">Approvers</h2>
      <p className="text-xs text-brown-muted">Staff of this branch who hold "Approve POS voids &amp; refunds" (Settings → System Roles). Each sets a PIN under My PIN on the POS.</p>
      {rows.map((a) => (
        <div key={a.staffId} className="mt-1 flex items-center justify-between text-sm">
          <span>{a.name} · {a.hasPin ? 'PIN set' : 'no PIN yet'}</span>
          {a.hasPin && <button onClick={() => clear(a)} className="text-xs text-red-700 underline">Clear PIN</button>}
        </div>
      ))}
      {rows.length === 0 && <p className="text-sm text-brown-muted">Nobody at this branch can approve yet.</p>}
    </section>
  )
}
