import { useState, useEffect } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import type { Claim, ClaimType } from '../../shared/types'
import { CLAIM_TYPE_LABELS } from '../../shared/types'
import { toCSV, downloadCSV } from '../../shared/lib/csv'
import { Avatar } from '../../shared/components/Avatar'
import { Sparkles, FileText } from 'lucide-react'
import { ScanCapture, EMPTY_SCAN, scanIsEmpty, scanToPdf, scanForAi, type ScanValue } from '../accounts/ScanCapture'
import { aiRead, loadAccounts, uploadFile } from '../accounts/api'
import { isIsoDate, numOf } from '../accounts/claimDesk'
import { TaobaoClaimModal } from './TaobaoClaimModal'

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'
const CLAIM_TYPES: ClaimType[] = ['transport', 'parking', 'meal', 'medical', 'phone', 'uniform', 'supplies', 'other']

function money(n: number): string {
  return `RM ${n.toFixed(2)}`
}

const statusColors: Record<string, string> = { pending: '#C4813A', approved: '#3D7A50', rejected: '#9E4A30' }

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: `${statusColors[status]}20`, color: statusColors[status] }}>
      {status[0].toUpperCase() + status.slice(1)}
    </span>
  )
}

const isPdf = (c: Claim) => !!c.pdf_path || /\.pdf($|\?)/i.test(c.receipt_url ?? '')

/** Foreign-currency and document details shown under a claim line. */
function ClaimExtras({ c }: { c: Claim }) {
  if (!c.receipt_url && c.source !== 'taobao') return null
  return (
    <div className="flex flex-wrap items-center gap-2 mt-1">
      {c.source === 'taobao' && c.foreign_amount != null && (
        <span className="text-[11px] text-brown-muted">Taobao · CNY {Number(c.foreign_amount).toFixed(2)} @ {c.exchange_rate}</span>
      )}
      {c.self_billed_status === 'pending' && (
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#FBEEDC] text-[#A8651F]">Self-billed e-Invoice pending</span>
      )}
      {c.receipt_url && isPdf(c) && (
        <a href={c.receipt_url} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#A86C2C] hover:underline">
          <FileText size={12} /> {c.source === 'taobao' ? 'English claim PDF' : 'Receipt PDF'}
        </a>
      )}
    </div>
  )
}

// ─── Submit claim modal ─────────────────────────────────────────────────────────

function SubmitClaimModal({ staffId, onClose, onSubmitted }: {
  staffId: string
  onClose: () => void
  onSubmitted: () => void
}) {
  const [form, setForm] = useState({ claim_type: 'transport' as ClaimType, amount: '', claim_date: new Date().toISOString().split('T')[0], description: '' })
  const [scan, setScan] = useState<ScanValue>(EMPTY_SCAN)
  const [supplier, setSupplier] = useState('')
  const [saving, setSaving] = useState(false)
  const [reading, setReading] = useState(false)
  const [aiMsg, setAiMsg] = useState('')
  const [error, setError] = useState('')

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function readReceipt() {
    setReading(true); setAiMsg(''); setError('')
    const accounts = await loadAccounts()
    const r = await aiRead<Record<string, unknown>>('receipt', await scanForAi(scan), accounts.map(a => a.name))
    setReading(false)
    if (!r.ok) { setAiMsg(r.error); return }
    const d = r.data ?? {}
    const total = numOf(d.total)
    const currency = String(d.currency || 'MYR').toUpperCase()
    setForm(f => ({
      ...f,
      amount: total != null && currency === 'MYR' ? total.toFixed(2) : f.amount,
      claim_date: isIsoDate(d.docDate) ? d.docDate : f.claim_date,
      description: f.description || [d.supplier, d.description].filter(Boolean).join(' — '),
    }))
    if (d.supplier) setSupplier(String(d.supplier))
    setAiMsg(currency !== 'MYR' && total != null
      ? `The receipt is in ${currency} ${total}. Enter the amount you paid in RM.`
      : 'Filled in from the receipt — please check.')
  }

  async function handleSubmit() {
    if (!form.amount || Number(form.amount) <= 0 || !form.description.trim() || !form.claim_date) {
      setError('Amount, description, and date are required.')
      return
    }
    setSaving(true)
    setError('')
    let receipt_url: string | null = null
    let pdf_path: string | null = null
    const pdfName = `Receipt_${form.claim_date}.pdf`
    if (!scanIsEmpty(scan)) {
      const blob = await scanToPdf(scan)
      const up = blob ? await uploadFile('claim-receipts', staffId, new File([blob], pdfName, { type: 'application/pdf' }), pdfName) : null
      if (!up?.ok) {
        setSaving(false)
        setError(`Receipt upload failed${up && !up.ok ? `: ${up.error}` : ''}. Try again.`)
        return
      }
      pdf_path = up.data.path!
      receipt_url = supabase.storage.from('claim-receipts').getPublicUrl(pdf_path).data.publicUrl
    }
    const { error: err } = await supabase.from('claims').insert({
      staff_id: staffId,
      claim_type: form.claim_type,
      amount: Number(form.amount),
      description: form.description.trim(),
      claim_date: form.claim_date,
      receipt_url,
      ...(pdf_path ? { source: 'scan', pdf_path, details: { supplier: supplier.trim() || null, pdf_name: pdfName } } : {}),
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    onSubmitted()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Submit Claim</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className={labelCls}>Claim Type</label>
            <select className={inputCls} value={form.claim_type} onChange={set('claim_type')}>
              {CLAIM_TYPES.map(t => <option key={t} value={t}>{CLAIM_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Amount (RM)</label>
              <input type="number" step="0.01" className={inputCls} value={form.amount} onChange={set('amount')} />
            </div>
            <div>
              <label className={labelCls}>Date of Expense</label>
              <input type="date" className={inputCls} value={form.claim_date} onChange={set('claim_date')} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Description</label>
            <textarea rows={2} className={`${inputCls} resize-none`} value={form.description} onChange={set('description')} />
          </div>
          <div className="space-y-2">
            <label className={labelCls}>Receipt</label>
            <ScanCapture value={scan} onChange={setScan} />
            {!scanIsEmpty(scan) && (
              <button type="button" onClick={readReceipt} disabled={reading}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#A86C2C] disabled:opacity-50">
                <Sparkles size={14} /> {reading ? 'Reading the receipt…' : 'Fill in from the receipt (AI)'}
              </button>
            )}
            {aiMsg && <p className="text-xs text-brown-muted">{aiMsg}</p>}
          </div>
          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors">Cancel</button>
            <button onClick={handleSubmit} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60">
              {saving ? 'Submitting...' : 'Submit Claim'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RejectClaimModal({ claim, reviewerId, onClose, onDone }: {
  claim: Claim
  reviewerId: string | undefined
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleReject() {
    setSaving(true)
    await supabase.from('claims').update({
      status: 'rejected', reviewed_by: reviewerId ?? null, reviewed_at: new Date().toISOString(),
      rejection_reason: reason.trim() || null,
    }).eq('id', claim.id)
    setSaving(false)
    onDone()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Reject Claim</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className={labelCls}>Reason</label>
            <textarea rows={3} className={`${inputCls} resize-none`} value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors">Cancel</button>
            <button onClick={handleReject} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-[#C0624A] text-white text-sm font-semibold hover:bg-[#A8503A] transition-colors disabled:opacity-60">
              {saving ? 'Rejecting...' : 'Reject'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Staff view ─────────────────────────────────────────────────────────────────

function MyClaimsView({ staffId, staffName }: { staffId: string; staffName: string }) {
  const [claims, setClaims] = useState<Claim[]>([])
  const [showSubmit, setShowSubmit] = useState(false)
  const [showTaobao, setShowTaobao] = useState(false)

  async function load() {
    const { data } = await supabase.from('claims').select('*').eq('staff_id', staffId).order('created_at', { ascending: false })
    setClaims((data as Claim[]) ?? [])
  }

  useEffect(() => { load() }, [])

  const now = new Date()
  const totalPending = claims.filter(c => c.status === 'pending').reduce((sum, c) => sum + c.amount, 0)
  const totalApprovedThisMonth = claims
    .filter(c => c.status === 'approved' && new Date(c.created_at).getMonth() === now.getMonth() && new Date(c.created_at).getFullYear() === now.getFullYear())
    .reduce((sum, c) => sum + c.amount, 0)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
          <p className="text-xs text-brown-faint mb-1">Total Pending</p>
          <p className="text-xl font-bold text-[#C4813A]">{money(totalPending)}</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
          <p className="text-xs text-brown-faint mb-1">Approved This Month</p>
          <p className="text-xl font-bold text-[#3D7A50]">{money(totalApprovedThisMonth)}</p>
        </div>
      </div>

      <div className="flex justify-end gap-2 flex-wrap">
        <button onClick={() => setShowTaobao(true)} className="px-4 py-2 rounded-xl border border-[#D4C5B0] bg-white text-brown-brand text-sm font-semibold hover:bg-[#F5EDE0] transition-colors">
          + Taobao Purchase
        </button>
        <button onClick={() => setShowSubmit(true)} className="px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors">
          + Submit Claim
        </button>
      </div>

      <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
        {claims.length === 0 ? (
          <p className="px-4 py-6 text-xs text-brown-faint text-center">No claims yet.</p>
        ) : (
          claims.map(c => (
            <div key={c.id} className="flex items-center gap-3 px-4 py-3 flex-wrap">
              <div className="flex-1 min-w-[180px]">
                <p className="text-sm font-medium text-brown-dark">{CLAIM_TYPE_LABELS[c.claim_type]} · {money(c.amount)}</p>
                <p className="text-xs text-brown-faint">{c.claim_date} · {c.description}</p>
                {c.status === 'rejected' && c.rejection_reason && <p className="text-xs text-[#9E4A30] italic mt-0.5">"{c.rejection_reason}"</p>}
                <ClaimExtras c={c} />
              </div>
              <StatusBadge status={c.status} />
            </div>
          ))
        )}
      </div>

      {showSubmit && <SubmitClaimModal staffId={staffId} onClose={() => setShowSubmit(false)} onSubmitted={load} />}
      {showTaobao && <TaobaoClaimModal staffId={staffId} staffName={staffName} onClose={() => setShowTaobao(false)} onSubmitted={load} />}
    </div>
  )
}

// ─── Manager view ───────────────────────────────────────────────────────────────

function ManagerClaimsView({ managerId }: { managerId: string | undefined }) {
  const [claims, setClaims] = useState<Claim[]>([])
  const [rejectTarget, setRejectTarget] = useState<Claim | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [viewingReceipt, setViewingReceipt] = useState<string | null>(null)

  async function load() {
    const { data } = await supabase.from('claims').select('*, staff:staff!claims_staff_id_fkey(id,name,avatar)').order('created_at', { ascending: false })
    setClaims((data as Claim[]) ?? [])
  }

  useEffect(() => { load() }, [])

  const pending = claims.filter(c => c.status === 'pending')
  const now = new Date()
  const thisMonth = claims.filter(c => new Date(c.created_at).getMonth() === now.getMonth() && new Date(c.created_at).getFullYear() === now.getFullYear())
  const approvedThisMonth = thisMonth.filter(c => c.status === 'approved')
  const byType: Record<string, number> = {}
  approvedThisMonth.forEach(c => { byType[c.claim_type] = (byType[c.claim_type] ?? 0) + c.amount })
  const totalPaidOut = claims.filter(c => c.paid_at && new Date(c.paid_at).getMonth() === now.getMonth() && new Date(c.paid_at).getFullYear() === now.getFullYear())
    .reduce((sum, c) => sum + c.amount, 0)

  async function approve(c: Claim) {
    setBusy(c.id)
    await supabase.from('claims').update({ status: 'approved', reviewed_by: managerId ?? null, reviewed_at: new Date().toISOString() }).eq('id', c.id)
    setBusy(null)
    load()
  }

  async function markPaid(c: Claim) {
    setBusy(c.id)
    await supabase.from('claims').update({ paid_at: new Date().toISOString() }).eq('id', c.id)
    setBusy(null)
    load()
  }

  function exportCSV() {
    const rows = claims.map(c => [c.staff?.name ?? '', CLAIM_TYPE_LABELS[c.claim_type], c.amount, c.claim_date, c.description, c.status, c.paid_at ? 'Yes' : 'No'])
    downloadCSV('claims.csv', toCSV(['Staff', 'Type', 'Amount', 'Date', 'Description', 'Status', 'Paid'], rows))
  }

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-brown-dark">Pending Claims ({pending.length})</h3>
          <button onClick={exportCSV} className="px-3 py-1.5 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors">Export CSV</button>
        </div>
        {pending.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-6 text-center text-xs text-brown-faint">No pending claims.</div>
        ) : (
          <div className="space-y-2">
            {pending.map(c => (
              <div key={c.id} className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex items-center gap-3 flex-wrap">
                <Avatar name={c.staff?.name ?? '?'} avatar={c.staff?.avatar ?? null} size="sm" />
                <div className="flex-1 min-w-[180px]">
                  <p className="text-sm font-semibold text-brown-dark">{c.staff?.name ?? 'Unknown'} · {money(c.amount)}</p>
                  <p className="text-xs text-brown-faint">{CLAIM_TYPE_LABELS[c.claim_type]} · {c.claim_date}</p>
                  <p className="text-xs text-brown-muted">{c.description}</p>
                  <ClaimExtras c={c} />
                </div>
                {c.receipt_url && !isPdf(c) && (
                  <img
                    src={c.receipt_url}
                    alt="receipt"
                    className="w-12 h-12 rounded-lg object-cover border border-[#E8DDD0] cursor-pointer flex-shrink-0"
                    onClick={() => setViewingReceipt(c.receipt_url)}
                  />
                )}
                <div className="flex gap-2 flex-shrink-0">
                  <button onClick={() => setRejectTarget(c)} className="px-3 py-1.5 text-xs rounded-lg border border-[#E8DDD0] text-brown-muted hover:bg-[#FCF0EC] hover:border-[#C06242] hover:text-[#C06242] transition-colors">Reject</button>
                  <button onClick={() => approve(c)} disabled={busy === c.id} className="px-3 py-1.5 text-xs rounded-lg bg-[#3D7A50] hover:bg-[#2E6040] text-white font-semibold transition-colors disabled:opacity-50">
                    {busy === c.id ? '…' : 'Approve'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Approved — Awaiting Payment</h3>
        <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
          {claims.filter(c => c.status === 'approved' && !c.paid_at).length === 0 ? (
            <p className="px-4 py-6 text-xs text-brown-faint text-center">Nothing awaiting payment.</p>
          ) : (
            claims.filter(c => c.status === 'approved' && !c.paid_at).map(c => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3 flex-wrap">
                <div className="flex-1 min-w-[160px]">
                  <p className="text-sm font-medium text-brown-dark">{c.staff?.name} · {money(c.amount)}</p>
                  <p className="text-xs text-brown-faint">{CLAIM_TYPE_LABELS[c.claim_type]} · {c.claim_date}</p>
                </div>
                <button onClick={() => markPaid(c)} disabled={busy === c.id} className="px-3 py-1.5 text-xs rounded-lg bg-[#2E6E9E] hover:bg-[#24587E] text-white font-semibold transition-colors disabled:opacity-50">
                  {busy === c.id ? '…' : 'Mark as Paid'}
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Monthly Summary</h3>
        <div className="bg-white rounded-xl border border-[#E8DDD0] p-4 space-y-2">
          {Object.entries(byType).length === 0 ? (
            <p className="text-xs text-brown-faint">No approved claims this month.</p>
          ) : (
            Object.entries(byType).map(([type, amt]) => (
              <div key={type} className="flex justify-between text-xs">
                <span className="text-brown-muted">{CLAIM_TYPE_LABELS[type as ClaimType]}</span>
                <span className="font-semibold text-brown-dark">{money(amt)}</span>
              </div>
            ))
          )}
          <div className="flex justify-between text-xs pt-2 border-t border-[#EDE5D8]">
            <span className="font-semibold text-brown-dark">Total Paid Out</span>
            <span className="font-bold text-[#3D7A50]">{money(totalPaidOut)}</span>
          </div>
        </div>
      </section>

      {rejectTarget && <RejectClaimModal claim={rejectTarget} reviewerId={managerId} onClose={() => setRejectTarget(null)} onDone={load} />}

      {viewingReceipt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setViewingReceipt(null)}>
          <img src={viewingReceipt} alt="receipt full" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────────

export default function HrClaimsPage() {
  const { staff } = useAuth()
  const isManager = staff?.rank === 'supervisor' || staff?.rank === 'manager'

  if (!staff) return null

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-5xl mx-auto px-4 py-8 lg:px-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Claims</h1>
          <p className="text-sm text-brown-faint mt-0.5">Submit and track expense claims.</p>
        </div>

        <MyClaimsView staffId={staff.id} staffName={staff.name} />

        {isManager && (
          <section>
            <h2 className="text-base font-bold text-brown-dark mb-4">Team Claims Management</h2>
            <ManagerClaimsView managerId={staff.id} />
          </section>
        )}
      </div>
    </div>
  )
}
