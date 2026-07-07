import { useState, useEffect } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import type { Staff, LeaveRequest, LeaveEntitlement, LeaveType } from '../../shared/types'
import { LEAVE_TYPE_LABELS, MONTHS_FULL } from '../../shared/types'
import { calcAlBalance } from '../../shared/lib/leave'
import { Avatar } from '../../shared/components/Avatar'

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'
const LEAVE_TYPES: LeaveType[] = ['annual', 'medical', 'unpaid', 'maternity', 'paternity']

function daysBetween(start: string, end: string): number {
  const s = new Date(start)
  const e = new Date(end)
  return Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1
}

function datesInRange(start: string, end: string): string[] {
  const dates: string[] = []
  const cur = new Date(start)
  const e = new Date(end)
  while (cur <= e) {
    dates.push(cur.toISOString().split('T')[0])
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

const statusColors: Record<string, string> = {
  pending: '#C4813A', approved: '#3D7A50', rejected: '#9E4A30', cancelled: '#8B7355',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: `${statusColors[status]}20`, color: statusColors[status] }}>
      {status[0].toUpperCase() + status.slice(1)}
    </span>
  )
}

async function ensureEntitlement(staffMember: Staff, year: number): Promise<LeaveEntitlement> {
  const { data } = await supabase.from('leave_entitlements').select('*').eq('staff_id', staffMember.id).eq('year', year).maybeSingle()
  if (data) return data as LeaveEntitlement
  const { data: rule } = await supabase.from('system_rules').select('value').eq('key', 'leave_medical_annual').maybeSingle()
  const medical_entitled = rule ? parseInt((rule as { value: string }).value) || 14 : 14
  const { data: created } = await supabase
    .from('leave_entitlements')
    .insert({ staff_id: staffMember.id, year, annual_entitled: 0, medical_entitled })
    .select('*')
    .single()
  return created as LeaveEntitlement
}

// ─── Apply leave modal ──────────────────────────────────────────────────────────

function ApplyLeaveModal({ staffId, availableAnnualDays, onClose, onSubmitted }: {
  staffId: string
  availableAnnualDays: number
  onClose: () => void
  onSubmitted: () => void
}) {
  const [form, setForm] = useState({ leave_type: 'annual' as LeaveType, start_date: '', end_date: '', reason: '' })
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const totalDays = form.start_date && form.end_date ? Math.max(1, daysBetween(form.start_date, form.end_date)) : 0
  const overLimit = form.leave_type === 'annual' && totalDays > availableAnnualDays

  async function handleSubmit() {
    if (!form.start_date || !form.end_date || !form.reason.trim()) {
      setError('Start date, end date, and reason are required.')
      return
    }
    if (form.leave_type === 'medical' && !file) {
      setError('Please upload an MC for medical leave.')
      return
    }
    if (overLimit) {
      setError('Requested days exceed your available annual leave balance.')
      return
    }
    setSaving(true)
    setError('')
    let attachment_url: string | null = null
    if (file) {
      const ext = file.name.split('.').pop() ?? 'jpg'
      const filePath = `${staffId}/${Date.now()}.${ext}`
      const { error: uploadErr } = await supabase.storage.from('leave-attachments').upload(filePath, file, { contentType: file.type })
      if (!uploadErr) attachment_url = supabase.storage.from('leave-attachments').getPublicUrl(filePath).data.publicUrl
    }
    const { error: err } = await supabase.from('leave_requests').insert({
      staff_id: staffId,
      leave_type: form.leave_type,
      start_date: form.start_date,
      end_date: form.end_date,
      total_days: totalDays,
      reason: form.reason.trim(),
      attachment_url,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    onSubmitted()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Apply Leave</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className={labelCls}>Leave Type</label>
            <select className={inputCls} value={form.leave_type} onChange={set('leave_type')}>
              {LEAVE_TYPES.map(t => <option key={t} value={t}>{LEAVE_TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Start Date</label>
              <input type="date" className={inputCls} value={form.start_date} onChange={set('start_date')} />
            </div>
            <div>
              <label className={labelCls}>End Date</label>
              <input type="date" className={inputCls} value={form.end_date} onChange={set('end_date')} />
            </div>
          </div>
          {totalDays > 0 && <p className="text-xs text-brown-faint">Total: {totalDays} day{totalDays > 1 ? 's' : ''}</p>}
          {form.leave_type === 'annual' && (
            <p className={`text-xs ${overLimit ? 'text-red-600 font-bold' : 'text-brown-faint'}`}>
              Available: {availableAnnualDays.toFixed(1)} days
            </p>
          )}
          <div>
            <label className={labelCls}>Reason</label>
            <textarea rows={2} className={`${inputCls} resize-none`} value={form.reason} onChange={set('reason')} />
          </div>
          <div>
            <label className={labelCls}>
              Attachment {form.leave_type === 'medical' && <span className="text-[#9E4A30]">(required — MC photo)</span>}
            </label>
            <input type="file" accept="image/*,.pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} className="text-xs" />
          </div>
          <div className="flex gap-3 pt-1">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors">
              Cancel
            </button>
            <button onClick={handleSubmit} disabled={saving || overLimit} className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60">
              {saving ? 'Submitting...' : 'Submit Request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function RejectLeaveModal({ request, reviewerId, onClose, onDone }: {
  request: LeaveRequest
  reviewerId: string | undefined
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleReject() {
    setSaving(true)
    await supabase.from('leave_requests').update({
      status: 'rejected', reviewed_by: reviewerId ?? null, reviewed_at: new Date().toISOString(),
      rejection_reason: reason.trim() || null,
    }).eq('id', request.id)
    setSaving(false)
    onDone()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Reject Leave Request</h2>
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

function MyLeaveView({ staffMember }: { staffMember: Staff }) {
  const [entitlement, setEntitlement] = useState<LeaveEntitlement | null>(null)
  const [requests, setRequests] = useState<LeaveRequest[]>([])
  const [showApply, setShowApply] = useState(false)
  const [alInfo, setAlInfo] = useState<{ balance: number; available: number } | null>(null)
  const [alRate, setAlRate] = useState('0.667')

  async function load() {
    const ent = await ensureEntitlement(staffMember, new Date().getFullYear())
    setEntitlement(ent)
    const { data } = await supabase.from('leave_requests').select('*').eq('staff_id', staffMember.id).order('created_at', { ascending: false })
    const reqs = (data as LeaveRequest[]) ?? []
    setRequests(reqs)

    const { data: logs } = await supabase.from('leave_accrual_log').select('amount').eq('staff_id', staffMember.id)
    const approved = reqs.filter(r => r.leave_type === 'annual' && r.status === 'approved').reduce((s, r) => s + r.total_days, 0)
    const pending  = reqs.filter(r => r.leave_type === 'annual' && r.status === 'pending').reduce((s, r) => s + r.total_days, 0)
    setAlInfo(calcAlBalance((logs as { amount: number }[]) ?? [], approved, pending))
    const { data: rateRow } = await supabase.from('system_rules').select('value').eq('key', 'leave_al_monthly_rate').maybeSingle()
    if (rateRow) setAlRate((rateRow as { value: string }).value)
  }

  useEffect(() => { load() }, [])

  async function cancelRequest(id: string) {
    await supabase.from('leave_requests').update({ status: 'cancelled' }).eq('id', id)
    load()
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
          <p className="text-xs text-brown-faint mb-1">Annual Leave</p>
          {staffMember.confirmation_date ? (
            <>
              <p className="text-xl font-bold text-brown-dark">{alInfo ? alInfo.available.toFixed(1) : '—'}</p>
              <p className="text-xs text-brown-faint">days available</p>
              <p className="text-[10px] text-brown-faint mt-1">
                accruing {Number(alRate).toFixed(2)}/month since {new Date(staffMember.confirmation_date).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}
              </p>
            </>
          ) : (
            <p className="text-xs text-brown-faint">Awaiting confirmation date — not accruing yet</p>
          )}
        </div>
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
          <p className="text-xs text-brown-faint mb-1">Medical Leave</p>
          <p className="text-xl font-bold text-brown-dark">
            {entitlement ? entitlement.medical_entitled - entitlement.medical_used : '—'} / {entitlement?.medical_entitled ?? '—'}
          </p>
          <p className="text-xs text-brown-faint">days remaining</p>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={() => setShowApply(true)} className="px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors">
          + Apply Leave
        </button>
      </div>

      <div>
        <p className="text-sm font-semibold text-brown-dark mb-2">My Leave History</p>
        <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
          {requests.length === 0 ? (
            <p className="px-4 py-6 text-xs text-brown-faint text-center">No leave requests yet.</p>
          ) : (
            requests.map(r => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3 flex-wrap">
                <div className="flex-1 min-w-[160px]">
                  <p className="text-sm font-medium text-brown-dark">{LEAVE_TYPE_LABELS[r.leave_type]}</p>
                  <p className="text-xs text-brown-faint">{r.start_date} → {r.end_date} · {r.total_days}d</p>
                  {r.status === 'rejected' && r.rejection_reason && <p className="text-xs text-[#9E4A30] italic mt-0.5">"{r.rejection_reason}"</p>}
                </div>
                <StatusBadge status={r.status} />
                {r.status === 'pending' && (
                  <button onClick={() => cancelRequest(r.id)} className="text-xs font-semibold text-brown-muted hover:underline">Cancel</button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {showApply && (
        <ApplyLeaveModal staffId={staffMember.id} availableAnnualDays={alInfo?.available ?? 0} onClose={() => setShowApply(false)} onSubmitted={load} />
      )}
    </div>
  )
}

// ─── Manager view ───────────────────────────────────────────────────────────────

function TeamCalendar({ approvedLeave, allStaff }: { approvedLeave: LeaveRequest[]; allStaff: Staff[] }) {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const daysCount = new Date(year, month, 0).getDate()
  const days = Array.from({ length: daysCount }, (_, i) => i + 1)

  function staffOnDay(day: number): Staff[] {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const ids = approvedLeave.filter(r => r.start_date <= dateStr && r.end_date >= dateStr).map(r => r.staff_id)
    return allStaff.filter(s => ids.includes(s.id))
  }

  const selectCls = 'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={month} onChange={e => setMonth(Number(e.target.value))}>
          {MONTHS_FULL.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <input type="number" className={`${selectCls} w-24`} value={year} onChange={e => setYear(Number(e.target.value))} />
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {days.map(d => {
          const onLeave = staffOnDay(d)
          return (
            <div key={d} className="bg-white rounded-lg border border-[#E8DDD0] p-1.5 min-h-[60px]">
              <p className="text-xs font-semibold text-brown-faint">{d}</p>
              {onLeave.map(s => (
                <p key={s.id} className="text-[10px] text-[#8B7355] truncate" title={s.name}>{s.name.split(' ')[0]}</p>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ManagerLeaveView({ allStaff, managerId }: { allStaff: Staff[]; managerId: string | undefined }) {
  const [requests, setRequests] = useState<LeaveRequest[]>([])
  const [entitlements, setEntitlements] = useState<LeaveEntitlement[]>([])
  const [accrualLogs, setAccrualLogs] = useState<{ staff_id: string; amount: number }[]>([])
  const [rejectTarget, setRejectTarget] = useState<LeaveRequest | null>(null)
  const [approving, setApproving] = useState<string | null>(null)

  async function load() {
    const { data } = await supabase.from('leave_requests').select('*, staff:staff!leave_requests_staff_id_fkey(id,name,avatar)').order('created_at', { ascending: false })
    setRequests((data as LeaveRequest[]) ?? [])
    const { data: ents } = await supabase.from('leave_entitlements').select('*').eq('year', new Date().getFullYear())
    setEntitlements((ents as LeaveEntitlement[]) ?? [])
    const { data: logs } = await supabase.from('leave_accrual_log').select('staff_id, amount')
    setAccrualLogs((logs as { staff_id: string; amount: number }[]) ?? [])
  }

  useEffect(() => { load() }, [])

  const pending = requests.filter(r => r.status === 'pending')
  const approved = requests.filter(r => r.status === 'approved')

  function alBalanceFor(staffId: string): number {
    const entries = accrualLogs.filter(l => l.staff_id === staffId)
    const approved = requests.filter(r => r.staff_id === staffId && r.leave_type === 'annual' && r.status === 'approved').reduce((s, r) => s + r.total_days, 0)
    return calcAlBalance(entries, approved, 0).balance
  }

  async function approve(req: LeaveRequest) {
    setApproving(req.id)
    await supabase.from('leave_requests').update({
      status: 'approved', reviewed_by: managerId ?? null, reviewed_at: new Date().toISOString(),
    }).eq('id', req.id)

    if (req.leave_type === 'medical' || req.leave_type === 'unpaid') {
      const ent = await ensureEntitlement(allStaff.find(s => s.id === req.staff_id) ?? { id: req.staff_id, joined_at: null } as Staff, new Date().getFullYear())
      const field = req.leave_type === 'unpaid' ? 'unpaid_used' : 'medical_used'
      await supabase.from('leave_entitlements').update({ [field]: (ent[field as keyof LeaveEntitlement] as number) + req.total_days }).eq('id', ent.id)
    }

    const dates = datesInRange(req.start_date, req.end_date)
    await supabase.from('attendance').upsert(
      dates.map(date => ({ staff_id: req.staff_id, date, status: 'on_leave' as const, recorded_by: managerId ?? null })),
      { onConflict: 'staff_id,date' }
    )

    setApproving(null)
    load()
  }

  return (
    <div className="space-y-8">
      <section>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Pending Approvals ({pending.length})</h3>
        {pending.length === 0 ? (
          <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-6 text-center text-xs text-brown-faint">No pending requests.</div>
        ) : (
          <div className="space-y-2">
            {pending.map(r => (
              <div key={r.id} className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex items-center gap-3 flex-wrap">
                <Avatar name={r.staff?.name ?? '?'} avatar={r.staff?.avatar ?? null} size="sm" />
                <div className="flex-1 min-w-[180px]">
                  <p className="text-sm font-semibold text-brown-dark">{r.staff?.name ?? 'Unknown'}</p>
                  <p className="text-xs text-brown-faint">{LEAVE_TYPE_LABELS[r.leave_type]} · {r.start_date} → {r.end_date} ({r.total_days}d)</p>
                  {r.reason && <p className="text-xs text-brown-muted italic mt-0.5">"{r.reason}"</p>}
                  {r.attachment_url && <a href={r.attachment_url} target="_blank" rel="noreferrer" className="text-xs text-[#2E6E9E] hover:underline">View attachment</a>}
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button onClick={() => setRejectTarget(r)} className="px-3 py-1.5 text-xs rounded-lg border border-[#E8DDD0] text-brown-muted hover:bg-[#FCF0EC] hover:border-[#C06242] hover:text-[#C06242] transition-colors">Reject</button>
                  <button onClick={() => approve(r)} disabled={approving === r.id} className="px-3 py-1.5 text-xs rounded-lg bg-[#3D7A50] hover:bg-[#2E6040] text-white font-semibold transition-colors disabled:opacity-50">
                    {approving === r.id ? 'Approving…' : 'Approve'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Team Calendar</h3>
        <TeamCalendar approvedLeave={approved} allStaff={allStaff} />
      </section>

      <section>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Leave Balance Overview</h3>
        <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
          <table className="w-full text-xs min-w-[600px]">
            <thead>
              <tr className="border-b border-[#EDE5D8]">
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Staff</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Annual</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Medical</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Unpaid</th>
              </tr>
            </thead>
            <tbody>
              {allStaff.map((s, i) => {
                const ent = entitlements.find(e => e.staff_id === s.id)
                return (
                  <tr key={s.id} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                    <td className="px-3 py-2 font-medium text-brown-dark">{s.name}</td>
                    <td className="px-3 py-2">{alBalanceFor(s.id).toFixed(1)}</td>
                    <td className="px-3 py-2">{ent ? `${ent.medical_entitled - ent.medical_used}/${ent.medical_entitled}` : '—'}</td>
                    <td className="px-3 py-2">{ent?.unpaid_used ?? 0}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {rejectTarget && (
        <RejectLeaveModal request={rejectTarget} reviewerId={managerId} onClose={() => setRejectTarget(null)} onDone={load} />
      )}
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────────

export default function HrLeavePage() {
  const { staff } = useAuth()
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const isManager = staff?.rank === 'supervisor' || staff?.rank === 'manager'

  useEffect(() => {
    if (isManager) supabase.from('staff').select('*').order('name').then(({ data }) => { if (data) setAllStaff(data as Staff[]) })
  }, [isManager])

  if (!staff) return null

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-5xl mx-auto px-4 py-8 lg:px-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Leave</h1>
          <p className="text-sm text-brown-faint mt-0.5">Apply for leave and track your balance.</p>
        </div>

        <MyLeaveView staffMember={staff} />

        {isManager && (
          <section>
            <h2 className="text-base font-bold text-brown-dark mb-4">Team Leave Management</h2>
            <ManagerLeaveView allStaff={allStaff} managerId={staff.id} />
          </section>
        )}
      </div>
    </div>
  )
}
