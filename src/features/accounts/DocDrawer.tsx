import { useEffect, useState } from 'react'
import { X, ExternalLink, Upload, Download } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { Button } from '../../shared/components/ui'
import { aiRead, fileUrl, inbox, uploadFile } from './api'
import {
  CURRENCIES, DOC_TYPES, PAYMENT, PLATFORM, SELF_BILLED, SOURCE_LABEL, STATUS, TAX,
  isIsoDate, money, numOf, round2, suggestVoucher, supplierKey, todayMYT,
  type AccountDoc, type AccountRow, type DocFile,
} from './claimDesk'
import { blobToBase64, canvasForAi, loadImage } from './imaging'

const inputCls = 'w-full px-2.5 py-1.5 rounded-lg border border-border-mid bg-canvas text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-accent/30'
const labelCls = 'block text-[11px] font-semibold text-brown-muted mb-1'

type Form = Record<string, string>

const toForm = (d: AccountDoc): Form => ({
  doc_type: d.doc_type ?? '', platform: d.platform ?? '', supplier: d.supplier ?? '', supplier_ref: d.supplier_ref ?? '',
  doc_date: d.doc_date, currency: d.currency || 'MYR', amount: d.amount?.toString() ?? '', rate: d.rate?.toString() ?? '',
  amount_myr: d.amount_myr?.toString() ?? '', sst: d.sst?.toString() ?? '', description: d.description ?? '',
  gl_account: d.gl_account ?? '', tax_treatment: d.tax_treatment ?? '', payment: d.payment ?? '', claimant: d.claimant ?? '',
  self_billed: d.self_billed, self_billed_uuid: d.self_billed_uuid ?? '', voucher_no: d.voucher_no ?? '', status: d.status,
  notes: d.notes ?? '',
})

function Sel({ value, onChange, options, blank }: { value: string; onChange: (v: string) => void; options: readonly string[]; blank?: boolean }) {
  return (
    <select className={inputCls} value={value} onChange={e => onChange(e.target.value)}>
      {blank && <option value="">—</option>}
      {options.filter(o => o !== '').map(o => <option key={o} value={o}>{o}</option>)}
      {value && !options.includes(value) && <option value={value}>{value}</option>}
    </select>
  )
}

/** One Register record: classification, amounts, voucher, attachments. */
export function DocDrawer({ doc, accounts, portal, onClose, onSaved }: {
  doc: AccountDoc
  accounts: AccountRow[]
  portal: string
  onClose: () => void
  onSaved: (msg: string) => void
}) {
  const [f, setF] = useState<Form>(() => toForm(doc))
  const [files, setFiles] = useState<DocFile[]>(doc.files ?? [])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = (k: string, v: string) => setF(prev => {
    const next = { ...prev, [k]: v }
    if (k === 'currency' || k === 'amount' || k === 'rate') {
      const amt = numOf(next.amount), rate = numOf(next.rate)
      if (next.currency === 'MYR' && amt != null) next.amount_myr = amt.toFixed(2)
      else if (amt != null && rate) next.amount_myr = round2(amt * rate).toFixed(2)
    }
    return next
  })

  async function suggest() {
    const draft = { doc_type: f.doc_type, payment: f.payment, doc_date: f.doc_date }
    const yymm = (f.doc_date || todayMYT()).slice(2, 7).replace('-', '')
    const { data } = await supabase.from('account_docs').select('voucher_no').like('voucher_no', `%-${yymm}-%`)
    set('voucher_no', suggestVoucher(draft, (data ?? []).map(r => r.voucher_no as string)))
  }

  async function save() {
    setBusy('save'); setMsg('')
    const docDate = isIsoDate(f.doc_date) ? f.doc_date : doc.doc_date
    let status = f.status
    const amountMyr = numOf(f.amount_myr)
    if (status === 'Needs info' && amountMyr != null && f.supplier.trim()) status = 'Draft'
    const patch = {
      doc_type: f.doc_type || null, platform: f.platform || null, supplier: f.supplier.trim() || null,
      supplier_ref: f.supplier_ref.trim() || null, doc_date: docDate, currency: f.currency, amount: numOf(f.amount),
      rate: numOf(f.rate), amount_myr: amountMyr, sst: numOf(f.sst), description: f.description.trim() || null,
      gl_account: f.gl_account || null, tax_treatment: f.tax_treatment || null, payment: f.payment || null,
      claimant: f.claimant.trim() || null, self_billed: f.self_billed, self_billed_uuid: f.self_billed_uuid.trim() || null,
      voucher_no: f.voucher_no.trim() || null, status, notes: f.notes.trim() || null, files,
    }
    const { error } = await supabase.from('account_docs').update(patch).eq('id', doc.id)
    if (error) {
      setBusy('')
      setMsg(error.code === '23505' ? 'That voucher number is already used. Press Suggest for the next free one.' : error.message)
      return
    }
    // Keep a Taobao claim's self-billed flag in step with the Register.
    if (doc.claim_id && f.self_billed !== doc.self_billed) {
      await supabase.from('claims').update({
        self_billed_status: f.self_billed === 'Issued' ? 'issued' : f.self_billed === 'Required – pending' ? 'pending' : 'not_required',
      }).eq('id', doc.claim_id)
    }
    if (patch.supplier && patch.gl_account && doc.source !== 'taobao' && doc.source !== 'claim') {
      await supabase.from('supplier_memory').upsert({
        key: supplierKey(patch.supplier), supplier: patch.supplier, gl_account: patch.gl_account,
        tax_treatment: patch.tax_treatment, platform: patch.platform, updated_at: new Date().toISOString(),
      })
    }
    setBusy('')
    onSaved(docDate.slice(0, 7) !== doc.doc_date.slice(0, 7) ? `Saved — moved to ${docDate.slice(0, 7)}` : 'Saved')
  }

  async function remove() {
    if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return }
    const { error } = await supabase.from('account_docs').delete().eq('id', doc.id)
    if (error) { setMsg(error.message); return }
    onSaved('Record deleted (attached files are kept)')
  }

  async function open(fl: DocFile) {
    const url = await fileUrl(fl)
    if (url) window.open(url, '_blank', 'noopener')
    else setMsg('Could not open the file.')
  }

  async function attach(file: File | undefined) {
    if (!file) return
    setBusy('upload'); setMsg('Uploading…')
    const up = await uploadFile('account-docs', doc.doc_date.slice(0, 7), file, file.name)
    if (!up.ok) { setBusy(''); setMsg(`Upload failed: ${up.error}`); return }
    const nextFiles = [...files, up.data]
    setFiles(nextFiles)
    await supabase.from('account_docs').update({ files: nextFiles }).eq('id', doc.id)
    setMsg('Attached. Reading the amount with AI…')
    const input = file.type === 'application/pdf'
      ? { pdf: await blobToBase64(file) }
      : { images: canvasForAi(await loadImage(file)) }
    const r = await aiRead<Record<string, unknown>>('receipt', input, accounts.map(a => a.name))
    setBusy('')
    if (!r.ok) { setMsg(`Attached. ${r.error}`); return }
    const d = r.data ?? {}
    setF(prev => {
      const next = { ...prev }
      const put = (k: string, v: unknown) => { if (v != null && v !== '' && !next[k]) next[k] = String(v) }
      put('supplier', d.supplier); put('supplier_ref', d.docNo); put('description', d.description)
      if (isIsoDate(d.docDate)) next.doc_date = d.docDate
      const total = numOf(d.total)
      if (total != null) {
        next.currency = String(d.currency || 'MYR').toUpperCase()
        next.amount = total.toFixed(2)
        if (next.currency === 'MYR') next.amount_myr = total.toFixed(2)
      }
      const sst = numOf(d.sst); if (sst != null) next.sst = sst.toFixed(2)
      return next
    })
    setMsg('Filled in from the document — check, then Save.')
  }

  async function loadLines() {
    if (!doc.einvoice_uuid) return
    setBusy('lines'); setMsg('Reading the e-Invoice from MyInvois…')
    const r = await inbox('details', { uuid: doc.einvoice_uuid })
    setBusy('')
    if (!r.ok) { setMsg(`MyInvois: ${r.error}`); return }
    const items = (r.data.items as { descEn: string }[]) ?? []
    if (!f.description && items.length) set('description', items.map(i => i.descEn).join('; ').slice(0, 300))
    if (typeof r.data.tax === 'number') set('sst', String(r.data.tax))
    setMsg(items.length ? `${items.length} line${items.length > 1 ? 's' : ''} loaded.` : 'No line descriptions in this e-Invoice.')
  }

  const ev = doc.einvoice as Record<string, string | null> | null
  const myinvoisLink = doc.einvoice_uuid
    ? ev?.longId ? `${portal}/${doc.einvoice_uuid}/share/${ev.longId}` : `${portal}/documents/${doc.einvoice_uuid}`
    : ''

  return (
    <>
      <div className="fixed inset-0 bg-black/25 z-40" onClick={onClose} />
      <aside aria-label="Document details" className="fixed top-0 right-0 bottom-0 w-full sm:w-[560px] bg-white z-50 shadow-2xl flex flex-col">
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wider text-brown-muted">{SOURCE_LABEL[doc.source]}</p>
            <p className="font-semibold text-brown-dark truncate">{doc.supplier || 'Untitled document'}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 text-brown-faint hover:text-brown-dark"><X size={18} /></button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {doc.einvoice_uuid && (
            <div className="rounded-xl bg-[#E2EDF5] text-[#2F5F82] text-xs px-3 py-2.5 space-y-1">
              <p>e-Invoice UUID <span className="font-mono">{doc.einvoice_uuid}</span>{ev?.number ? <> · No. <span className="font-mono">{ev.number}</span></> : null}</p>
              {ev?.supplierTin && <p>Supplier TIN <span className="font-mono">{ev.supplierTin}</span></p>}
              <div className="flex gap-3">
                <a className="inline-flex items-center gap-1 font-semibold underline" href={myinvoisLink} target="_blank" rel="noopener noreferrer">
                  Open in MyInvois <ExternalLink size={11} />
                </a>
                <button type="button" className="font-semibold underline disabled:opacity-50" disabled={busy !== ''} onClick={loadLines}>
                  Load line items
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>Document type</label><Sel value={f.doc_type} onChange={v => set('doc_type', v)} options={DOC_TYPES} blank /></div>
            <div><label className={labelCls}>Platform</label><Sel value={f.platform} onChange={v => set('platform', v)} options={PLATFORM} blank /></div>
            <div className="col-span-2"><label className={labelCls}>Supplier / Creditor</label><input className={inputCls} value={f.supplier} onChange={e => set('supplier', e.target.value)} /></div>
            <div><label className={labelCls}>Supplier ref.</label><input className={inputCls} value={f.supplier_ref} onChange={e => set('supplier_ref', e.target.value)} /></div>
            <div><label className={labelCls}>Document date</label><input type="date" className={inputCls} value={f.doc_date} onChange={e => set('doc_date', e.target.value)} /></div>
            <div><label className={labelCls}>Currency</label><Sel value={f.currency} onChange={v => set('currency', v)} options={CURRENCIES} /></div>
            <div><label className={labelCls}>Amount ({f.currency})</label><input inputMode="decimal" className={inputCls} value={f.amount} onChange={e => set('amount', e.target.value)} /></div>
            {f.currency !== 'MYR' && <div><label className={labelCls}>Rate → MYR</label><input inputMode="decimal" className={inputCls} value={f.rate} onChange={e => set('rate', e.target.value)} /></div>}
            <div><label className={labelCls}>Amount (MYR)</label><input inputMode="decimal" className={inputCls} value={f.amount_myr} onChange={e => set('amount_myr', e.target.value)} /></div>
            <div><label className={labelCls}>SST / tax (MYR)</label><input inputMode="decimal" className={inputCls} value={f.sst} onChange={e => set('sst', e.target.value)} /></div>
          </div>
          <div><label className={labelCls}>Description (English)</label><input className={inputCls} value={f.description} onChange={e => set('description', e.target.value)} /></div>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Account</label>
              <Sel value={f.gl_account} onChange={v => set('gl_account', v)} options={accounts.map(a => a.name)} blank />
            </div>
            <div className="col-span-2"><label className={labelCls}>Tax treatment</label><Sel value={f.tax_treatment} onChange={v => set('tax_treatment', v)} options={TAX} blank /></div>
            <div><label className={labelCls}>Payment</label><Sel value={f.payment} onChange={v => set('payment', v)} options={PAYMENT} blank /></div>
            <div><label className={labelCls}>Claimant / handled by</label><input className={inputCls} value={f.claimant} onChange={e => set('claimant', e.target.value)} /></div>
            <div><label className={labelCls}>Self-billed e-Invoice</label><Sel value={f.self_billed} onChange={v => set('self_billed', v)} options={SELF_BILLED} /></div>
            <div><label className={labelCls}>Self-billed UUID</label><input className={`${inputCls} font-mono`} value={f.self_billed_uuid} onChange={e => set('self_billed_uuid', e.target.value)} /></div>
            <div>
              <label className={labelCls}>Voucher No.</label>
              <div className="flex gap-1">
                <input className={`${inputCls} font-mono`} value={f.voucher_no} onChange={e => set('voucher_no', e.target.value)} />
                <button type="button" onClick={suggest} className="px-2 rounded-lg border border-border-mid text-xs text-brown-brand hover:bg-cream">Suggest</button>
              </div>
            </div>
            <div><label className={labelCls}>Status</label><Sel value={f.status} onChange={v => set('status', v)} options={STATUS} /></div>
          </div>
          <div><label className={labelCls}>Notes</label><textarea rows={2} className={`${inputCls} resize-y`} value={f.notes} onChange={e => set('notes', e.target.value)} /></div>

          {doc.items?.length > 0 && (
            <details className="text-sm">
              <summary className="text-xs text-brown-muted cursor-pointer">{doc.items.length} line item{doc.items.length > 1 ? 's' : ''}</summary>
              <ul className="mt-1.5 pl-4 list-disc text-xs text-brown-dark space-y-0.5">
                {doc.items.map((i, k) => (
                  <li key={k}>{i.descEn || i.descZh} × {i.qty ?? '—'} — {doc.currency} {money(i.amountCny ?? i.amount ?? null)}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="rounded-xl bg-cream p-3 space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-brown-muted">Attachments</p>
            {files.length === 0 && <p className="text-xs text-brown-faint">No attachments.</p>}
            {files.map((fl, k) => (
              <div key={k} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-brown-dark">{fl.name}</span>
                <button type="button" onClick={() => open(fl)} className="inline-flex items-center gap-1 text-xs font-semibold text-accent-text">
                  <Download size={12} /> Open
                </button>
              </div>
            ))}
            <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-brown-brand cursor-pointer">
              <Upload size={13} /> Attach invoice (PDF / photo) — AI reads the amount
              <input type="file" accept="image/*,application/pdf" hidden disabled={busy !== ''} onChange={e => { attach(e.target.files?.[0]); e.target.value = '' }} />
            </label>
          </div>
          {msg && <p className="text-xs text-brown-muted" role="status">{msg}</p>}
        </div>

        <footer className="flex items-center justify-between gap-2 px-5 py-3 border-t border-line">
          <Button variant="ghost" size="sm" className="!text-bad" onClick={remove}>{armed ? 'Press again to delete' : 'Delete record'}</Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button variant="dark" size="sm" onClick={save} disabled={busy !== ''}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
          </div>
        </footer>
      </aside>
    </>
  )
}
