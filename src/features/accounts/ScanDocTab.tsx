import { useState } from 'react'
import { Card, Button } from '../../shared/components/ui'
import { supabase } from '../../shared/lib/supabase'
import { aiRead, uploadFile } from './api'
import { DOC_TYPES, PAYMENT, TAX, isIsoDate, numOf, supplierKey, todayMYT, type AccountRow } from './claimDesk'
import { downloadBlob } from './imaging'
import { EMPTY_SCAN, ScanCapture, scanForAi, scanIsEmpty, scanToPdf, type ScanValue } from './ScanCapture'

const selectCls = 'w-full px-2.5 py-2 rounded-lg border border-border-mid bg-canvas text-sm text-brown-dark'
const labelCls = 'block text-[11px] font-semibold text-brown-muted mb-1'

/** Paper invoice / receipt → clean A4 PDF → AI reads it → a Register record. */
export function ScanDocTab({ accounts, onCreated }: {
  accounts: AccountRow[]
  onCreated: (id: string, docDate: string) => void
}) {
  const [scan, setScan] = useState<ScanValue>(EMPTY_SCAN)
  const [kind, setKind] = useState('')
  const [payment, setPayment] = useState<string>('Paid by company')
  const [claimant, setClaimant] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const fileName = () => `Scan_${todayMYT()}_${Date.now().toString(36).slice(-4)}.pdf`

  async function downloadOnly() {
    const blob = await scanToPdf(scan)
    if (blob) downloadBlob(fileName(), blob)
  }

  async function save() {
    setBusy(true)
    try {
      setMsg('Making the PDF…')
      const pdf = await scanToPdf(scan)
      if (!pdf) return
      const name = scan.pdf?.name || fileName()
      const up = await uploadFile('account-docs', todayMYT().slice(0, 7), pdf, name)
      if (!up.ok) { setMsg(`Upload failed: ${up.error}`); return }

      setMsg('AI is reading the document (10–60 s)…')
      const r = await aiRead<Record<string, unknown>>('receipt', await scanForAi(scan), accounts.map(a => a.name))
      const ai = r.ok ? (r.data ?? {}) : null
      if (!r.ok) setMsg(`Saved without AI: ${r.error}`)

      const total = numOf(ai?.total)
      const currency = String(ai?.currency || 'MYR').toUpperCase()
      const supplier = ai?.supplier ? String(ai.supplier) : ''
      const { data: mem } = supplier
        ? await supabase.from('supplier_memory').select('gl_account, tax_treatment, platform').eq('key', supplierKey(supplier)).maybeSingle()
        : { data: null }
      const names = accounts.map(a => a.name)
      const docType = kind || (DOC_TYPES.includes(ai?.docKind as never) ? String(ai!.docKind) : 'Supplier Invoice')
      const docDate = isIsoDate(ai?.docDate) ? ai!.docDate as string : todayMYT()
      const notes = [
        ai?.supplierTin ? `Supplier TIN: ${ai.supplierTin}` : '',
        ai?.supplierRegNo ? `Reg No: ${ai.supplierRegNo}` : '',
        ai?.notes ? String(ai.notes) : '',
      ].filter(Boolean).join(' · ')

      const { data, error } = await supabase.from('account_docs').insert({
        source: 'paper',
        doc_type: docType,
        platform: mem?.platform ?? 'Walk-in / Direct',
        supplier: supplier || null,
        supplier_ref: ai?.docNo ? String(ai.docNo) : null,
        doc_date: docDate,
        currency,
        amount: total,
        amount_myr: currency === 'MYR' ? total : null,
        sst: numOf(ai?.sst),
        description: ai?.description ? String(ai.description) : null,
        gl_account: mem?.gl_account ?? (names.includes(String(ai?.suggestedAccount)) ? String(ai!.suggestedAccount) : null),
        tax_treatment: mem?.tax_treatment ?? ((TAX as readonly string[]).includes(String(ai?.suggestedTax)) ? String(ai!.suggestedTax) : null),
        payment,
        claimant: claimant.trim() || null,
        status: ai && total != null && supplier ? 'Draft' : 'Needs info',
        einvoice_uuid: ai?.einvoiceUuid ? String(ai.einvoiceUuid) : null,
        notes: notes || null,
        files: [up.data],
      }).select('id, doc_date').single()
      if (error) {
        setMsg(error.code === '23505' ? 'This e-Invoice is already in the Register.' : error.message)
        return
      }
      setScan(EMPTY_SCAN)
      setMsg('')
      onCreated(data.id, data.doc_date)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-brown-dark">Paper invoice / receipt → clean PDF</h2>
        <p className="text-sm text-brown-muted max-w-2xl">Take photos with your phone or pick images / a PDF. Shadows are removed and contrast raised, the pages become one A4 PDF, and AI reads the supplier, number, date and amount into the Register.</p>
      </div>
      <Card className="space-y-4">
        <ScanCapture value={scan} onChange={setScan} />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Document type</label>
            <select className={selectCls} value={kind} onChange={e => setKind(e.target.value)}>
              <option value="">Let AI decide</option>
              {DOC_TYPES.filter(t => !t.startsWith('Foreign')).map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Payment</label>
            <select className={selectCls} value={payment} onChange={e => setPayment(e.target.value)}>
              {PAYMENT.map(p => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Handled by (optional)</label>
            <input className={selectCls} value={claimant} onChange={e => setClaimant(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="dark" onClick={save} disabled={busy || scanIsEmpty(scan)}>{busy ? 'Working…' : 'Make PDF, read with AI and save'}</Button>
          <Button variant="secondary" onClick={downloadOnly} disabled={busy || scanIsEmpty(scan)}>Download PDF only</Button>
        </div>
        {msg && <p className="text-sm text-brown-muted" role="status">{msg}</p>}
      </Card>
    </div>
  )
}
