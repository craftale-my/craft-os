import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { supabaseAdmin } from '../../shared/lib/supabase-admin'
import type {
  Staff, MissionCompletion, MonthlyReview, ProbationReview, SkillAssessment, PromotionRequest, Skill,
} from '../../shared/types'
import { SKILL_STATUS_ICONS } from '../../shared/types'
import {
  RANK_LABELS, RANK_COLORS,
  DEPT_LABELS, DEPT_STORE, BRANCHES,
  calcFinalScore, getScoreConfig, REVIEW_CATEGORIES, MONTHS_FULL,
  getProbationDay,
} from '../../shared/types'
import { useLookups } from '../../shared/lib/lookups'
import { useCan } from '../../shared/lib/permissions'
import { StarRating } from '../../shared/components/StarRating'

const CURRENT_MONTH = new Date().getMonth() + 1
const CURRENT_YEAR = new Date().getFullYear()

interface RegRequest {
  id: string
  full_name: string
  email: string
  phone: string | null
  branch: string | null
  department: string | null
  employment_type: string | null
  status: 'pending' | 'approved' | 'rejected'
  rejection_reason: string | null
  created_at: string
}

function genTempPassword(): string {
  return Math.random().toString(36).slice(-8) + 'A1!'
}

// ─── Avatar (shared across pages) ────────────────────────────────────────────

export function Avatar({
  name,
  avatar,
  size = 'md',
}: {
  name: string
  avatar: string | null
  size?: 'sm' | 'md' | 'lg'
}) {
  const sizeClass = { sm: 'w-7 h-7 text-xs', md: 'w-9 h-9 text-sm', lg: 'w-12 h-12 text-base' }[size]
  if (avatar) {
    return <img src={avatar} alt={name} className={`${sizeClass} rounded-full object-cover flex-shrink-0`} />
  }
  return (
    <div className={`${sizeClass} rounded-full bg-[#C4813A20] flex items-center justify-center font-bold text-[#8B6344] flex-shrink-0`}>
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortenBranch(branch: string | null): string {
  if (!branch) return '—'
  if (branch.includes('Connaught')) return 'Cheras'
  if (branch.includes('Puteri')) return 'Puchong'
  return branch
}

function formatTimeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ─── AddStaffModal ────────────────────────────────────────────────────────────

function AddStaffModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    name: '', email: '', password: '', rank: 'trainee', branch: '', department: '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const { activeDepartments } = useLookups()

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!supabaseAdmin) {
      setError('Service role key not configured. Add VITE_SUPABASE_SERVICE_ROLE_KEY to .env.local')
      return
    }
    if (!form.name.trim() || !form.email.trim() || form.password.length < 6) {
      setError('Name, email, and a 6+ character password are required.')
      return
    }
    setSaving(true)
    setError('')

    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email: form.email.trim(),
      password: form.password,
      email_confirm: true,
    })
    if (authErr || !authData.user) {
      setError(authErr?.message ?? 'Failed to create auth user')
      setSaving(false)
      return
    }

    const { error: profileErr } = await supabaseAdmin.from('staff').insert({
      id: authData.user.id,
      name: form.name.trim(),
      email: form.email.trim(),
      rank: form.rank,
      branch: form.branch || null,
      department: form.department || null,
      onboarding_completed: form.rank === 'manager',
      joined_at: new Date().toISOString().split('T')[0],
    })
    if (profileErr) {
      // Roll back the just-created auth user so a failed staff insert doesn't
      // leave an orphan that blocks re-creating this email later.
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id)
      setError(profileErr.message)
      setSaving(false)
      return
    }

    // Auto-assign job title (rank + department, when unambiguous) + skill checklist.
    if (form.department) {
      const { data: roleRows } = await supabaseAdmin.from('roles')
        .select('id').eq('rank', form.rank).eq('department', form.department).eq('is_active', true)
      if (roleRows && roleRows.length === 1) {
        await supabaseAdmin.from('staff').update({ job_title_id: roleRows[0].id }).eq('id', authData.user.id)
        await supabaseAdmin.rpc('initialize_staff_skills', { p_staff_id: authData.user.id })
      }
    }

    onCreated()
    onClose()
  }

  const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'
  const inputCls =
    'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Add New Staff</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div>
            <label className={labelCls}>Full Name</label>
            <input className={inputCls} value={form.name} onChange={set('name')} placeholder="e.g. Ahmad Zulkifli" />
          </div>
          <div>
            <label className={labelCls}>Email</label>
            <input className={inputCls} type="email" value={form.email} onChange={set('email')} placeholder="staff@craftale.com" />
          </div>
          <div>
            <label className={labelCls}>Temporary Password</label>
            <input className={inputCls} type="password" value={form.password} onChange={set('password')} placeholder="Min 6 characters" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Rank</label>
              <select className={inputCls} value={form.rank} onChange={set('rank')}>
                {(['trainee', 'junior', 'senior', 'supervisor', 'manager'] as const).map(r => (
                  <option key={r} value={r}>{RANK_LABELS[r]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Branch</label>
              <select className={inputCls} value={form.branch} onChange={set('branch')}>
                <option value="">Select...</option>
                {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls}>Department</label>
            <select className={inputCls} value={form.department} onChange={set('department')}>
              <option value="">Select...</option>
              {activeDepartments.map(d => <option key={d.slug} value={d.slug}>{d.name}</option>)}
            </select>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
            >
              {saving ? 'Creating...' : 'Create Staff'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── ApproveRegModal ──────────────────────────────────────────────────────────

function ApproveRegModal({
  request,
  reviewerId,
  onClose,
  onApproved,
}: {
  request: RegRequest
  reviewerId: string | undefined
  onClose: () => void
  onApproved: (creds: { email: string; password: string }) => void
}) {
  const [password, setPassword] = useState(genTempPassword())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleApprove() {
    if (!supabaseAdmin) {
      setError('Service role key not configured. Add VITE_SUPABASE_SERVICE_ROLE_KEY to .env.local')
      return
    }
    if (password.length < 6) {
      setError('Temporary password must be at least 6 characters.')
      return
    }
    setSaving(true)
    setError('')

    // 1. Create the auth user — or recover one left behind by a previously
    //    interrupted approval, so a half-finished attempt no longer dead-ends
    //    every retry with "a user with this email has already been registered".
    let userId: string
    let createdNow = false
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: request.email,
      password,
      email_confirm: true,
    })
    if (created?.user) {
      userId = created.user.id
      createdNow = true
    } else if (createErr && /already/i.test(createErr.message)) {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 })
      const existing = list?.users.find(u => u.email?.toLowerCase() === request.email.toLowerCase())
      if (!existing) {
        setError(createErr.message)
        setSaving(false)
        return
      }
      userId = existing.id
      // Reset the password so the temp password shown to the manager is valid.
      await supabaseAdmin.auth.admin.updateUserById(userId, { password, email_confirm: true })
    } else {
      setError(createErr?.message ?? 'Failed to create user')
      setSaving(false)
      return
    }

    // request.department is a department slug for new requests; DEPT_STORE
    // converts any legacy display-string values from older requests.
    const dept = request.department ? (DEPT_STORE[request.department] ?? request.department) : null

    // 2. Create the staff row (idempotent on id).
    const { error: profileErr } = await supabaseAdmin.from('staff').upsert({
      id: userId,
      name: request.full_name,
      email: request.email,
      rank: 'trainee',
      branch: request.branch,
      department: dept,
      employment_type: request.employment_type,
      contact_number: request.phone,
      onboarding_completed: false,
      joined_at: new Date().toISOString().split('T')[0],
    }, { onConflict: 'id' })
    if (profileErr) {
      // Roll back a just-created auth user so it can't become an orphan that
      // blocks every future approval of this email.
      if (createdNow) await supabaseAdmin.auth.admin.deleteUser(userId)
      setError(profileErr.message)
      setSaving(false)
      return
    }

    // 3. Auto-assign the job title (rank + department, when unambiguous) and
    //    create the career-path skill checklist. Best-effort: a new hire with
    //    no matching title simply starts without one until a manager assigns it.
    if (dept) {
      const { data: roleRows } = await supabaseAdmin.from('roles')
        .select('id').eq('rank', 'trainee').eq('department', dept).eq('is_active', true)
      if (roleRows && roleRows.length === 1) {
        await supabaseAdmin.from('staff').update({ job_title_id: roleRows[0].id }).eq('id', userId)
        await supabaseAdmin.rpc('initialize_staff_skills', { p_staff_id: userId })
      }
    }

    await supabase
      .from('registration_requests')
      .update({ status: 'approved', reviewed_by: reviewerId ?? null, reviewed_at: new Date().toISOString() })
      .eq('id', request.id)

    setSaving(false)
    onApproved({ email: request.email, password })
  }

  const inputCls =
    'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Approve Registration</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="bg-white rounded-lg border border-[#E8DDD0] p-3 space-y-1">
            <p className="text-sm font-semibold text-brown-dark">{request.full_name}</p>
            <p className="text-xs text-brown-faint">{request.email}</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-brown-medium mb-1">Temporary Password</label>
            <div className="flex gap-2">
              <input
                className={inputCls}
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setPassword(genTempPassword())}
                className="px-3 py-2 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors flex-shrink-0"
              >
                Regenerate
              </button>
            </div>
            <p className="text-xs text-brown-faint mt-1">Share this with {request.full_name.split(' ')[0]} after approving.</p>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors disabled:opacity-60"
            >
              {saving ? 'Approving...' : 'Approve & Create Account'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── RejectRegModal ───────────────────────────────────────────────────────────

function RejectRegModal({
  request,
  reviewerId,
  onClose,
  onRejected,
}: {
  request: RegRequest
  reviewerId: string | undefined
  onClose: () => void
  onRejected: () => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleReject() {
    setSaving(true)
    await supabase
      .from('registration_requests')
      .update({
        status: 'rejected',
        reviewed_by: reviewerId ?? null,
        reviewed_at: new Date().toISOString(),
        rejection_reason: reason.trim() || null,
      })
      .eq('id', request.id)
    setSaving(false)
    onRejected()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Reject Registration</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="bg-white rounded-lg border border-[#E8DDD0] p-3 space-y-1">
            <p className="text-sm font-semibold text-brown-dark">{request.full_name}</p>
            <p className="text-xs text-brown-faint">{request.email}</p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-brown-medium mb-1">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40] resize-none"
              placeholder="e.g. Branch already fully staffed"
            />
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleReject}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#C0624A] text-white text-sm font-semibold hover:bg-[#A8503A] transition-colors disabled:opacity-60"
            >
              {saving ? 'Rejecting...' : 'Reject Request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── FailAssessmentModal ──────────────────────────────────────────────────────

function FailAssessmentModal({
  assessment,
  reviewerId,
  onClose,
  onDone,
}: {
  assessment: SkillAssessment
  reviewerId: string | undefined
  onClose: () => void
  onDone: () => void
}) {
  const [remarks, setRemarks] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleFail() {
    if (remarks.trim().length < 5) {
      setError('Remarks are required: explain the reason and give advice for improvement.')
      return
    }
    setSaving(true); setError('')
    const { error: err } = await supabase.from('skill_assessments').update({
      status: 'failed',
      assessed_by: reviewerId ?? null,
      assessed_at: new Date().toISOString(),
      remarks: remarks.trim(),
      updated_at: new Date().toISOString(),
    }).eq('id', assessment.id)
    setSaving(false)
    if (err) { setError(err.message); return }
    onDone()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Fail Assessment</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="bg-white rounded-lg border border-[#E8DDD0] p-3 space-y-1">
            <p className="text-sm font-semibold text-brown-dark">{assessment.staff?.name}</p>
            <p className="text-xs text-brown-faint">
              {assessment.skill?.name}
              {assessment.skill?.name_zh ? ` · ${assessment.skill.name_zh}` : ''}
            </p>
          </div>
          <div>
            <label className="block text-xs font-semibold text-brown-medium mb-1">
              Reason & advice <span className="text-[#9E4A30]">*</span>
            </label>
            <textarea
              value={remarks}
              onChange={e => setRemarks(e.target.value)}
              rows={3}
              autoFocus
              className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40] resize-none"
              placeholder="What was missing, and what should they practise before the next attempt?"
            />
            <p className="text-xs text-brown-faint mt-1">Shown to the staff member on their Career Progress page.</p>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleFail}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-[#C0624A] text-white text-sm font-semibold hover:bg-[#A8503A] transition-colors disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Fail with Feedback'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── PromotionReviewModal ─────────────────────────────────────────────────────

function PromotionReviewModal({
  request,
  reviewerId,
  onClose,
  onDone,
}: {
  request: PromotionRequest
  reviewerId: string | undefined
  onClose: () => void
  onDone: () => void
}) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [assessments, setAssessments] = useState<SkillAssessment[]>([])
  const [review, setReview] = useState<MonthlyReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'view' | 'defer'>('view')
  const [deferReason, setDeferReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      const [sk, sa, mr] = await Promise.all([
        supabase.from('skills').select('*')
          .eq('career_path_id', request.career_path_id).eq('status', 'active').order('sort_order'),
        supabase.from('skill_assessments')
          .select('*, assessor:staff!skill_assessments_assessed_by_fkey(id,name)')
          .eq('staff_id', request.staff_id),
        supabase.from('monthly_reviews').select('*')
          .eq('staff_id', request.staff_id).eq('status', 'completed')
          .order('year', { ascending: false }).order('month', { ascending: false })
          .limit(1).maybeSingle(),
      ])
      setSkills((sk.data as Skill[]) ?? [])
      setAssessments((sa.data as SkillAssessment[]) ?? [])
      setReview((mr.data as MonthlyReview | null) ?? null)
      setLoading(false)
    })()
  }, [request.id, request.career_path_id, request.staff_id])

  const bySkill = new Map(assessments.map(a => [a.skill_id, a]))
  const reviewScore = review ? calcFinalScore(review) : null
  const scoreCfg = reviewScore != null ? getScoreConfig(reviewScore) : null

  function fmtDate(iso: string | null): string {
    return iso ? new Date(iso).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
  }

  async function approve() {
    const toId = request.career_path?.to_job_title_id
    if (!toId) { setError('This path has no target job title.'); return }
    setSaving(true); setError('')
    // 1. Promote: update the job title (rank/XP untouched by design).
    const r1 = await supabase.from('staff').update({ job_title_id: toId }).eq('id', request.staff_id)
    if (r1.error) { setError(r1.error.message); setSaving(false); return }
    // 2. Close the request.
    const r2 = await supabase.from('promotion_requests').update({
      status: 'approved', decided_by: reviewerId ?? null, decided_at: new Date().toISOString(),
    }).eq('id', request.id)
    if (r2.error) { setError(r2.error.message); setSaving(false); return }
    // 3. Assign the next segment's skill checklist, if one exists (no-op otherwise).
    await supabase.rpc('initialize_staff_skills', { p_staff_id: request.staff_id })
    setSaving(false)
    onDone()
  }

  async function defer() {
    if (deferReason.trim().length < 3) { setError('Please give a reason for deferring (management-only).'); return }
    setSaving(true); setError('')
    const { error: err } = await supabase.from('promotion_requests').update({
      status: 'deferred', decided_by: reviewerId ?? null,
      decided_at: new Date().toISOString(), defer_reason: deferReason.trim(),
    }).eq('id', request.id)
    setSaving(false)
    if (err) { setError(err.message); return }
    onDone()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0] flex-shrink-0">
          <h2 className="font-bold text-brown-dark text-lg">Promotion Evaluation</h2>
          <button onClick={onClose} className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          {/* Who & what */}
          <div className="bg-white rounded-lg border border-[#E8DDD0] p-4 flex items-center gap-3">
            <Avatar name={request.staff?.name ?? '?'} avatar={request.staff?.avatar ?? null} size="md" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-brown-dark">{request.staff?.name}</p>
              <p className="text-xs text-brown-muted mt-0.5">
                {request.career_path?.from?.name} <span className="text-brown-faint">→</span>{' '}
                <span className="font-semibold text-[#C4813A]">{request.career_path?.to?.name}</span>
              </p>
            </div>
          </div>

          {loading ? (
            <p className="text-xs text-brown-faint text-center py-6">Loading records…</p>
          ) : (
            <>
              {/* Skill record */}
              <div>
                <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest mb-2">Skill Record</p>
                <div className="bg-white rounded-lg border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
                  {skills.map(s => {
                    const a = bySkill.get(s.id)
                    const passed = a?.status === 'passed'
                    return (
                      <div key={s.id} className="px-3 py-2 flex items-center gap-2">
                        <span className="text-sm">{SKILL_STATUS_ICONS[a?.status ?? 'not_started']}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-brown-dark truncate">{s.name}</p>
                          {passed && (
                            <p className="text-[10px] text-brown-faint">
                              by {a?.assessor?.name ?? '—'} · {fmtDate(a?.assessed_at ?? null)}
                            </p>
                          )}
                        </div>
                        <span className="text-[10px] text-[#C4813A] font-semibold flex-shrink-0">+{s.xp_reward} XP</span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Latest monthly review (reference) */}
              <div>
                <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest mb-2">
                  Latest Monthly Review <span className="normal-case font-normal">(reference)</span>
                </p>
                {review && reviewScore != null && scoreCfg ? (
                  <div
                    className="flex items-center gap-3 px-4 py-3 rounded-lg border"
                    style={{ background: scoreCfg.bg, borderColor: scoreCfg.border }}
                  >
                    <span className="text-xl">{scoreCfg.emoji}</span>
                    <div className="flex-1">
                      <p className="text-sm font-bold" style={{ color: scoreCfg.color }}>
                        {reviewScore}/100 · {scoreCfg.label}
                      </p>
                      <p className="text-[11px] text-brown-muted">
                        {MONTHS_FULL[review.month - 1]} {review.year}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-brown-faint bg-white border border-[#E8DDD0] rounded-lg px-4 py-3">
                    No completed monthly review yet.
                  </p>
                )}
              </div>

              {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

              {mode === 'view' ? (
                <div className="flex gap-3 pt-1">
                  <button
                    onClick={() => { setMode('defer'); setError('') }}
                    disabled={saving}
                    className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors disabled:opacity-60"
                  >
                    Defer
                  </button>
                  <button
                    onClick={approve}
                    disabled={saving}
                    className="flex-1 py-2.5 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold hover:bg-[#2E6040] transition-colors disabled:opacity-60"
                  >
                    {saving ? 'Promoting…' : '✓ Approve Promotion'}
                  </button>
                </div>
              ) : (
                <div className="space-y-3 pt-1">
                  <div>
                    <label className="block text-xs font-semibold text-brown-medium mb-1">
                      Defer reason <span className="text-[#9E4A30]">*</span>
                      <span className="font-normal text-brown-faint ml-1">(visible to management only)</span>
                    </label>
                    <textarea
                      value={deferReason}
                      onChange={e => setDeferReason(e.target.value)}
                      rows={3}
                      autoFocus
                      className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40] resize-none"
                      placeholder="e.g. Wait for one more month of consistent attendance…"
                    />
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setMode('view')}
                      disabled={saving}
                      className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={defer}
                      disabled={saving}
                      className="flex-1 py-2.5 rounded-xl bg-[#C0624A] text-white text-sm font-semibold hover:bg-[#A8503A] transition-colors disabled:opacity-60"
                    >
                      {saving ? 'Saving…' : 'Confirm Deferral'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── CredentialsModal ─────────────────────────────────────────────────────────

function CredentialsModal({
  email,
  password,
  onClose,
}: {
  email: string
  password: string
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(`Email: ${email}\nTemporary password: ${password}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-cream-light rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#E8DDD0]">
          <h2 className="font-bold text-brown-dark text-lg">Account Created ✅</h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-brown-medium">Share these login details with the new staff member:</p>
          <div className="bg-white rounded-lg border border-[#E8DDD0] p-4 space-y-2">
            <div>
              <p className="text-xs text-brown-faint">Email</p>
              <p className="text-sm font-semibold text-brown-dark">{email}</p>
            </div>
            <div>
              <p className="text-xs text-brown-faint">Temporary Password</p>
              <p className="text-sm font-semibold text-brown-dark">{password}</p>
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={copy}
              className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
            >
              {copied ? 'Copied ✓' : 'Copy Details'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── PendingCard ──────────────────────────────────────────────────────────────

function PendingCard({
  completion,
  onApprove,
  onReject,
}: {
  completion: MissionCompletion
  onApprove: () => void
  onReject: () => void
}) {
  const [deciding, setDeciding] = useState(false)

  function approve() { setDeciding(true); onApprove() }
  function reject() { setDeciding(true); onReject() }

  return (
    <div className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex gap-3">
      {completion.photo_url ? (
        <img
          src={completion.photo_url}
          alt="proof"
          className="w-14 h-14 rounded-lg object-cover flex-shrink-0 border border-[#E8DDD0]"
        />
      ) : (
        <div className="w-14 h-14 rounded-lg bg-[#F5EDE0] flex items-center justify-center flex-shrink-0 text-2xl">
          📋
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2">
          <Avatar name={completion.staff?.name ?? '?'} avatar={completion.staff?.avatar ?? null} size="sm" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-brown-dark truncate">{completion.staff?.name ?? 'Unknown'}</p>
            <p className="text-xs text-brown-faint truncate">{completion.mission?.title ?? 'Mission'}</p>
          </div>
          <span className="text-xs text-brown-faint flex-shrink-0">{formatTimeAgo(completion.completed_at)}</span>
        </div>
        <div className="flex gap-2 mt-2.5">
          <button
            onClick={approve}
            disabled={deciding}
            className="flex-1 py-1.5 rounded-lg bg-[#EBF5EE] text-[#3D7A50] text-xs font-semibold hover:bg-[#D4EDDA] transition-colors disabled:opacity-60"
          >
            ✓ Approve
          </button>
          <button
            onClick={reject}
            disabled={deciding}
            className="flex-1 py-1.5 rounded-lg bg-[#FCF0EC] text-[#9E4A30] text-xs font-semibold hover:bg-[#F5DDD5] transition-colors disabled:opacity-60"
          >
            ✗ Reject
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── SupervisorReviewCard (inline dashboard form) ─────────────────────────────

type RatingKey = 'attitude' | 'efficiency' | 'coffee_skill' | 'service'

function SupervisorReviewCard({
  review,
  reviewerId,
  onComplete,
}: {
  review: MonthlyReview
  reviewerId: string
  onComplete: () => void
}) {
  const [lateCount, setLateCount] = useState(review.late_count ?? 0)
  const [autoLateCount, setAutoLateCount] = useState<number | null>(null)
  // Only treat late_count as a deliberate override if a supervisor has already submitted this review before
  // (the column defaults to 0 for fresh rows, so 0 alone doesn't mean "manually set").
  const [lateOverridden, setLateOverridden] = useState(review.sup_submitted_at != null)
  const [ratings, setRatings] = useState<Record<RatingKey, number>>({
    attitude: 0, efficiency: 0, coffee_skill: 0, service: 0,
  })
  const [comments, setComments] = useState('')
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const staff = review.staff as Staff | undefined

  useEffect(() => {
    if (!expanded || autoLateCount != null) return
    const start = `${review.year}-${String(review.month).padStart(2, '0')}-01`
    const lastDay = new Date(review.year, review.month, 0).getDate()
    const end = `${review.year}-${String(review.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    supabase
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('staff_id', review.staff_id)
      .eq('status', 'late')
      .gte('date', start)
      .lte('date', end)
      .then(({ count }) => {
        setAutoLateCount(count ?? 0)
        if (!lateOverridden) setLateCount(count ?? 0)
      })
  }, [expanded])

  const allRated = Object.values(ratings).every(v => v > 0)

  const previewScore = allRated
    ? Math.round(
        Math.max(0, 100 - lateCount * 10) * 0.30 +
        ratings.attitude    * 20 * 0.15 +
        ratings.efficiency  * 20 * 0.20 +
        ratings.coffee_skill * 20 * 0.20 +
        ratings.service     * 20 * 0.15,
      )
    : null

  const scoreCfg = previewScore != null ? getScoreConfig(previewScore) : null

  async function handleSubmit() {
    if (!allRated) return
    setSaving(true)
    const { error } = await supabase
      .from('monthly_reviews')
      .update({
        late_count: lateCount,
        sup_attitude: ratings.attitude,
        sup_efficiency: ratings.efficiency,
        sup_coffee_skill: ratings.coffee_skill,
        sup_service: ratings.service,
        sup_comments: comments || null,
        sup_submitted_at: new Date().toISOString(),
        reviewer_id: reviewerId,
        status: 'completed',
      })
      .eq('id', review.id)
    setSaving(false)
    if (!error) onComplete()
  }

  return (
    <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#FAF6F1] transition-colors text-left"
      >
        <Avatar name={staff?.name ?? '?'} avatar={null} size="sm" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-brown-dark">{staff?.name ?? 'Unknown'}</p>
          <p className="text-xs text-brown-faint">{staff ? RANK_LABELS[staff.rank] : ''}</p>
        </div>
        <span className="text-xs bg-[#EBF3FB] text-[#2E6E9E] px-2 py-0.5 rounded-full font-medium flex-shrink-0">
          Self done
        </span>
        <span className="text-brown-faint text-xs ml-1">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-[#EDE5D8] pt-4">
          {/* Staff self-eval (read-only) */}
          {review.self_submitted_at && (
            <div className="bg-[#FAF6F1] rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-brown-medium">Staff Self-Evaluation</p>
              {REVIEW_CATEGORIES.map(cat => {
                const val = review[cat.selfKey as keyof MonthlyReview] as number | null
                return (
                  <div key={cat.key} className="flex items-center justify-between">
                    <span className="text-xs text-brown-faint">{cat.label}</span>
                    <StarRating value={val ?? 0} readonly size="sm" />
                  </div>
                )
              })}
              {review.self_comments && (
                <p className="text-xs text-brown-medium italic mt-1">"{review.self_comments}"</p>
              )}
            </div>
          )}

          {/* Late count */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <span className="text-xs font-semibold text-brown-medium">Times Late This Month</span>
              <p className="text-xs text-brown-faint mt-0.5">
                {autoLateCount == null
                  ? 'Checking attendance records…'
                  : lateOverridden
                  ? `Manually set — attendance shows ${autoLateCount}`
                  : `Auto-detected from attendance records`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setLateOverridden(true); setLateCount(c => Math.max(0, c - 1)) }}
                className="w-7 h-7 rounded-full border border-[#D4C5B0] text-brown-dark font-bold hover:bg-[#F5EDE0] transition-colors"
              >−</button>
              <span className="w-6 text-center text-sm font-bold text-brown-dark">{lateCount}</span>
              <button
                onClick={() => { setLateOverridden(true); setLateCount(c => Math.min(10, c + 1)) }}
                className="w-7 h-7 rounded-full border border-[#D4C5B0] text-brown-dark font-bold hover:bg-[#F5EDE0] transition-colors"
              >+</button>
            </div>
            <span className="text-xs text-brown-faint w-28 text-right">
              Attendance: {Math.max(0, 100 - lateCount * 10)}%
            </span>
          </div>

          {/* Supervisor ratings */}
          <div className="space-y-2">
            {REVIEW_CATEGORIES.map(cat => (
              <div key={cat.key} className="flex items-center justify-between">
                <span className="text-xs text-brown-medium">{cat.label}</span>
                <StarRating
                  value={ratings[cat.key as RatingKey]}
                  onChange={v => setRatings(r => ({ ...r, [cat.key]: v }))}
                  size="sm"
                />
              </div>
            ))}
          </div>

          {/* Comments */}
          <textarea
            value={comments}
            onChange={e => setComments(e.target.value)}
            placeholder="Supervisor comments (optional)..."
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40] resize-none"
          />

          {/* Score preview */}
          {scoreCfg && previewScore != null && (
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg border"
              style={{ background: scoreCfg.bg, borderColor: scoreCfg.border }}
            >
              <span className="text-base">{scoreCfg.emoji}</span>
              <span className="text-sm font-bold" style={{ color: scoreCfg.color }}>{previewScore}</span>
              <span className="text-xs" style={{ color: scoreCfg.color }}>{scoreCfg.label}</span>
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={saving || !allRated}
            className="w-full py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-50"
          >
            {saving ? 'Submitting...' : 'Submit Supervisor Review'}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate()
  const { deptName } = useLookups()
  const { can, ownBranchOnly, role } = useCan()
  const [currentStaff, setCurrentStaff] = useState<Staff | null>(null)
  const [skillReviews, setSkillReviews] = useState<SkillAssessment[]>([])
  const [failTarget, setFailTarget] = useState<SkillAssessment | null>(null)
  const [savingSkillId, setSavingSkillId] = useState<string | null>(null)
  const [skillError, setSkillError] = useState('')
  const [promotions, setPromotions] = useState<PromotionRequest[]>([])
  const [promotionTarget, setPromotionTarget] = useState<PromotionRequest | null>(null)

  // Promotion decisions are for Manager/Owner (and Admin) — not supervisors.
  const canDecidePromotions = role === 'owner' || role === 'admin' || role === 'manager'
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const [completions, setCompletions] = useState<MissionCompletion[]>([])
  const [reviews, setReviews] = useState<MonthlyReview[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [search, setSearch] = useState('')
  const [filterBranch, setFilterBranch] = useState('')
  const [filterDept, setFilterDept] = useState('')
  const [filterRank, setFilterRank] = useState('')
  const [filterStatus, setFilterStatus] = useState<'active' | 'resigned' | ''>('active')
  const [startingReviews, setStartingReviews] = useState(false)
  const [reviewRefresh, setReviewRefresh] = useState(0)
  const [probations, setProbations] = useState<ProbationReview[]>([])
  const [startingProbation, setStartingProbation] = useState<string | null>(null)
  const pendingRef = useRef<HTMLDivElement>(null)
  const regRef = useRef<HTMLDivElement>(null)
  const [regRequests, setRegRequests] = useState<RegRequest[]>([])
  const [regTab, setRegTab] = useState<'pending' | 'rejected'>('pending')
  const [approveTarget, setApproveTarget] = useState<RegRequest | null>(null)
  const [rejectTarget, setRejectTarget] = useState<RegRequest | null>(null)
  const [newCredentials, setNewCredentials] = useState<{ email: string; password: string } | null>(null)

  const isManager = currentStaff?.rank === 'manager'
  const isSupervisor = currentStaff?.rank === 'supervisor' || isManager

  async function loadAll() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const [staffRes, myRes, completionsRes, reviewsRes, probationsRes] = await Promise.all([
      supabase.from('staff').select('*').order('name'),
      supabase.from('staff').select('*').eq('id', user.id).single(),
      supabase
        .from('mission_completions')
        .select('*, mission:missions(*), staff:staff!mission_completions_staff_id_fkey(*), approver:staff!mission_completions_approved_by_fkey(*)')
        .order('completed_at', { ascending: false }),
      supabase
        .from('monthly_reviews')
        .select('*, staff:staff!monthly_reviews_staff_id_fkey(id,name,rank,department)')
        .eq('month', CURRENT_MONTH)
        .eq('year', CURRENT_YEAR),
      supabase
        .from('probation_reviews')
        .select('*, staff:staff!probation_reviews_staff_id_fkey(id,name,avatar,rank,branch)')
        .is('overall_result', null)
        .order('start_date', { ascending: false }),
    ])

    const { data: skillData } = await supabase
      .from('skill_assessments')
      .select('*, skill:skills(*), staff:staff!skill_assessments_staff_id_fkey(id,name,avatar,rank,branch,branch_id)')
      .eq('status', 'pending_review')
      .order('updated_at', { ascending: true })
    setSkillReviews((skillData as SkillAssessment[]) ?? [])

    const { data: promoData } = await supabase
      .from('promotion_requests')
      .select('*, staff:staff!promotion_requests_staff_id_fkey(id,name,avatar,rank,branch_id), career_path:career_paths(*, from:roles!career_paths_from_job_title_id_fkey(*), to:roles!career_paths_to_job_title_id_fkey(*))')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
    setPromotions((promoData as PromotionRequest[]) ?? [])

    if (staffRes.data) setAllStaff(staffRes.data)
    if (myRes.data) setCurrentStaff(myRes.data)
    if (completionsRes.data) setCompletions(completionsRes.data as MissionCompletion[])
    if (reviewsRes.data) setReviews(reviewsRes.data as MonthlyReview[])
    if (probationsRes.data) setProbations(probationsRes.data as ProbationReview[])

    const { data: regData } = await supabase
      .from('registration_requests')
      .select('*')
      .in('status', ['pending', 'rejected'])
      .order('created_at', { ascending: false })
    if (regData) setRegRequests(regData as RegRequest[])

    setLoading(false)
  }

  useEffect(() => { loadAll() }, [])

  useEffect(() => {
    if (reviewRefresh === 0) return
    supabase
      .from('monthly_reviews')
      .select('*, staff:staff!monthly_reviews_staff_id_fkey(id,name,rank,department)')
      .eq('month', CURRENT_MONTH)
      .eq('year', CURRENT_YEAR)
      .then(({ data }) => { if (data) setReviews(data as MonthlyReview[]) })
  }, [reviewRefresh])

  // Supervisors (no all_branches capability) only see their own branch.
  const myBranchId = currentStaff?.branch_id
  const inBranchScope = (s: Staff) => !ownBranchOnly || !myBranchId || s.branch_id === myBranchId

  // Active staff (resigned are retained but excluded from active operations/counts)
  const activeStaff = allStaff.filter(s => s.status !== 'resigned' && inBranchScope(s))

  // Pending skill assessments, branch-scoped for supervisors.
  const visibleSkillReviews = skillReviews.filter(
    r => !ownBranchOnly || !myBranchId || r.staff?.branch_id === myBranchId
  )

  // Derived counts
  const pendingCompletions = completions.filter(c => c.status === 'pending')
  const onboardingCount = activeStaff.filter(s => !s.onboarding_completed && s.rank !== 'manager').length
  const levelUpCount = activeStaff.filter(s => {
    if (!s.last_level_up_at) return false
    return Date.now() - new Date(s.last_level_up_at).getTime() < 7 * 24 * 60 * 60 * 1000
  }).length

  const pendingRegRequests = regRequests.filter(r => r.status === 'pending')
  const rejectedRegRequests = regRequests.filter(r => r.status === 'rejected')
  const visibleRegRequests = regTab === 'pending' ? pendingRegRequests : rejectedRegRequests

  const deptBreakdown: Record<string, number> = {}
  activeStaff.forEach(s => {
    const key = s.department ?? 'other'
    deptBreakdown[key] = (deptBreakdown[key] ?? 0) + 1
  })

  // Review buckets
  const reviewStarted = reviews.length > 0
  const selfDoneReviews = reviews.filter(r => r.status === 'self_done')
  const completedReviews = reviews.filter(r => r.status === 'completed')
  const pendingSelfReviews = reviews.filter(r => r.status === 'pending')
  const poorReviews = completedReviews.filter(r => {
    const score = calcFinalScore(r)
    return score != null && score < 60
  })

  // Staff table filter
  const filteredStaff = allStaff.filter(s => {
    if (!inBranchScope(s)) return false
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterBranch && s.branch !== filterBranch) return false
    if (filterDept && s.department !== filterDept) return false
    if (filterRank && s.rank !== filterRank) return false
    if (filterStatus && (s.status ?? 'active') !== filterStatus) return false
    return true
  })

  async function handleStartReviews() {
    if (!isManager) return
    setStartingReviews(true)
    const nonManagers = allStaff.filter(s => s.rank !== 'manager' && s.status !== 'resigned')
    const records = nonManagers.map(s => ({
      staff_id: s.id,
      month: CURRENT_MONTH,
      year: CURRENT_YEAR,
      status: 'pending' as const,
    }))
    await supabase
      .from('monthly_reviews')
      .upsert(records, { onConflict: 'staff_id,month,year', ignoreDuplicates: true })
    setStartingReviews(false)
    loadAll()
  }

  async function handleStartProbation(staffMember: Staff) {
    setStartingProbation(staffMember.id)
    const { error } = await supabase.from('probation_reviews').insert({
      staff_id: staffMember.id,
      reviewer_id: currentStaff?.id,
      start_date: new Date().toISOString().split('T')[0],
    })
    setStartingProbation(null)
    if (!error) navigate(`/probation/${staffMember.id}`)
  }

  async function handleApprove(id: string) {
    await supabase
      .from('mission_completions')
      .update({ status: 'approved', approved_by: currentStaff?.id })
      .eq('id', id)
    loadAll()
  }

  async function handleReject(id: string) {
    await supabase.from('mission_completions').update({ status: 'rejected' }).eq('id', id)
    loadAll()
  }

  async function handlePassSkill(a: SkillAssessment) {
    setSavingSkillId(a.id); setSkillError('')
    // XP award + promotion-request creation happen via DB triggers on 'passed'.
    const { error } = await supabase.from('skill_assessments').update({
      status: 'passed',
      assessed_by: currentStaff?.id ?? null,
      assessed_at: new Date().toISOString(),
      remarks: null,
      updated_at: new Date().toISOString(),
    }).eq('id', a.id)
    setSavingSkillId(null)
    if (error) { setSkillError(error.message); return }
    loadAll()
  }

  function handleRegApproved(creds: { email: string; password: string }) {
    setApproveTarget(null)
    setNewCredentials(creds)
    loadAll()
  }

  function handleRegRejected() {
    setRejectTarget(null)
    loadAll()
  }

  function exportReviewsCSV() {
    const header = ['Name', 'Rank', 'Department', 'Late Count', 'Attendance', 'Attitude', 'Efficiency', 'Coffee', 'Service', 'Final Score']
    const rows = completedReviews.map(r => {
      const s = r.staff as Staff | undefined
      const score = calcFinalScore(r)
      return [
        s?.name ?? '',
        s ? RANK_LABELS[s.rank] : '',
        s?.department ? (DEPT_LABELS[s.department] ?? s.department) : '',
        r.late_count ?? '',
        r.attendance_score ?? '',
        r.sup_attitude ?? '',
        r.sup_efficiency ?? '',
        r.sup_coffee_skill ?? '',
        r.sup_service ?? '',
        score ?? '',
      ]
    })
    const csv = [header, ...rows].map(r => r.join(',')).join('\n')
    const a = document.createElement('a')
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv)
    a.download = `reviews_${MONTHS_FULL[CURRENT_MONTH - 1]}_${CURRENT_YEAR}.csv`
    a.click()
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream-light">
        <p className="text-brown-medium animate-pulse">Loading dashboard...</p>
      </div>
    )
  }

  const monthLabel = MONTHS_FULL[CURRENT_MONTH - 1]
  const selectCls =
    'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="min-h-screen bg-cream-light">
      {showAddModal && (
        <AddStaffModal onClose={() => setShowAddModal(false)} onCreated={loadAll} />
      )}
      {approveTarget && (
        <ApproveRegModal
          request={approveTarget}
          reviewerId={currentStaff?.id}
          onClose={() => setApproveTarget(null)}
          onApproved={handleRegApproved}
        />
      )}
      {rejectTarget && (
        <RejectRegModal
          request={rejectTarget}
          reviewerId={currentStaff?.id}
          onClose={() => setRejectTarget(null)}
          onRejected={handleRegRejected}
        />
      )}
      {newCredentials && (
        <CredentialsModal
          email={newCredentials.email}
          password={newCredentials.password}
          onClose={() => setNewCredentials(null)}
        />
      )}
      {failTarget && (
        <FailAssessmentModal
          assessment={failTarget}
          reviewerId={currentStaff?.id}
          onClose={() => setFailTarget(null)}
          onDone={() => { setFailTarget(null); loadAll() }}
        />
      )}
      {promotionTarget && (
        <PromotionReviewModal
          request={promotionTarget}
          reviewerId={currentStaff?.id}
          onClose={() => setPromotionTarget(null)}
          onDone={() => { setPromotionTarget(null); loadAll() }}
        />
      )}

      <div className="max-w-7xl mx-auto px-4 py-8 lg:px-8">

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-brown-dark">Dashboard</h1>
            <p className="text-sm text-brown-faint mt-0.5">
              {monthLabel} {CURRENT_YEAR} · Welcome back, {currentStaff?.name?.split(' ')[0] ?? 'there'}
            </p>
          </div>
          {isManager && (
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors shadow-sm"
            >
              + Add Staff
            </button>
          )}
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
          <div className="bg-white rounded-2xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint font-medium mb-1">Total Staff</p>
            <p className="text-3xl font-bold text-brown-dark">{activeStaff.length}</p>
            <div className="mt-2 space-y-0.5">
              {Object.entries(deptBreakdown).slice(0, 3).map(([dept, count]) => (
                <p key={dept} className="text-xs text-brown-faint">
                  {DEPT_LABELS[dept] ?? dept}: {count}
                </p>
              ))}
            </div>
          </div>

          {pendingRegRequests.length > 0 && (
            <div
              className="bg-white rounded-2xl p-4 border border-[#E8DDD0] cursor-pointer hover:border-[#C4813A60] transition-colors"
              onClick={() => regRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <p className="text-xs text-brown-faint font-medium mb-1">Registration Requests</p>
              <p className="text-3xl font-bold text-[#2E6E9E]">{pendingRegRequests.length}</p>
              <p className="text-xs text-brown-faint mt-2">Awaiting approval</p>
            </div>
          )}

          <div
            className="bg-white rounded-2xl p-4 border border-[#E8DDD0] cursor-pointer hover:border-[#C4813A60] transition-colors"
            onClick={() => pendingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            <p className="text-xs text-brown-faint font-medium mb-1">Pending Approvals</p>
            <p className="text-3xl font-bold text-brown-dark">{pendingCompletions.length}</p>
            <p className="text-xs text-brown-faint mt-2">Mission completions awaiting review</p>
          </div>

          <div className="bg-white rounded-2xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint font-medium mb-1">Onboarding</p>
            <p className="text-3xl font-bold text-brown-dark">{onboardingCount}</p>
            <p className="text-xs text-brown-faint mt-2">Staff pending onboarding</p>
          </div>

          <div className="bg-white rounded-2xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint font-medium mb-1">Level Ups</p>
            <p className="text-3xl font-bold text-[#3D7A50]">{levelUpCount}</p>
            <p className="text-xs text-brown-faint mt-2">This week</p>
          </div>
        </div>

        {/* Main content: left column + activity sidebar */}
        <div className="lg:grid lg:grid-cols-3 lg:gap-8">
          <div className="lg:col-span-2 space-y-8">

            {/* ── Monthly Reviews ── */}
            {isSupervisor && (
              <section id="reviews-section">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-base font-bold text-brown-dark">{monthLabel} Reviews</h2>
                    <p className="text-xs text-brown-faint mt-0.5">Monthly performance review cycle</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {completedReviews.length > 0 && (
                      <button
                        onClick={exportReviewsCSV}
                        className="px-3 py-1.5 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors"
                      >
                        Export CSV
                      </button>
                    )}
                    {isManager && (
                      <button
                        onClick={handleStartReviews}
                        disabled={startingReviews}
                        className="px-3 py-1.5 rounded-xl bg-[#C4813A] text-white text-xs font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
                      >
                        {startingReviews
                          ? 'Starting...'
                          : reviewStarted
                          ? `Restart ${monthLabel} Reviews`
                          : `Start ${monthLabel} Reviews`}
                      </button>
                    )}
                  </div>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-4 gap-3 mb-4">
                  {[
                    { label: 'Total',       value: reviews.length,          color: 'text-brown-dark' },
                    { label: 'Pending Self', value: pendingSelfReviews.length, color: 'text-[#C4813A]' },
                    { label: 'Need Review', value: selfDoneReviews.length,   color: 'text-[#2E6E9E]' },
                    { label: 'Completed',   value: completedReviews.length,  color: 'text-[#3D7A50]' },
                  ].map(stat => (
                    <div key={stat.label} className="bg-white rounded-xl p-3 border border-[#E8DDD0] text-center">
                      <p className={`text-xl font-bold ${stat.color}`}>{stat.value}</p>
                      <p className="text-xs text-brown-faint mt-0.5">{stat.label}</p>
                    </div>
                  ))}
                </div>

                {/* Poor performers alert */}
                {poorReviews.length > 0 && (
                  <div className="mb-4 px-4 py-3 bg-[#FCF0EC] border border-[#C0624240] rounded-xl flex items-center gap-2">
                    <span>❌</span>
                    <p className="text-xs text-[#9E4A30] font-medium">
                      {poorReviews.length} staff scored below 60 this month — follow up recommended.
                    </p>
                  </div>
                )}

                {/* Pending supervisor reviews */}
                {selfDoneReviews.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-brown-medium mb-2">
                      Awaiting Supervisor Review ({selfDoneReviews.length})
                    </p>
                    {selfDoneReviews.map(r => (
                      <SupervisorReviewCard
                        key={r.id}
                        review={r}
                        reviewerId={currentStaff?.id ?? ''}
                        onComplete={() => setReviewRefresh(n => n + 1)}
                      />
                    ))}
                  </div>
                ) : reviewStarted ? (
                  <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-6 text-center">
                    <p className="text-sm text-brown-faint">
                      {completedReviews.length > 0 && completedReviews.length === reviews.length
                        ? '✅ All reviews completed for this month!'
                        : 'No self-evaluations submitted yet. Staff will see the review banner on their profile.'}
                    </p>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl border border-[#E8DDD0] border-dashed px-6 py-8 text-center">
                    <p className="text-2xl mb-2">📋</p>
                    <p className="text-sm font-semibold text-brown-dark mb-1">No review cycle started</p>
                    <p className="text-xs text-brown-faint">
                      {isManager
                        ? 'Click "Start Reviews" to open this month\'s review cycle for all staff.'
                        : 'Ask your manager to start this month\'s review cycle.'}
                    </p>
                  </div>
                )}
              </section>
            )}

            {/* ── Probation Reviews ── */}
            {isSupervisor && (() => {
              const activeStaffIds = new Set(probations.map(p => p.staff_id))
              const traineesWithoutProbation = allStaff.filter(
                s => s.rank === 'trainee' && s.status !== 'resigned' && !activeStaffIds.has(s.id)
              )
              const hasAnything = probations.length > 0 || traineesWithoutProbation.length > 0
              if (!hasAnything) return null
              return (
                <section id="probation-section">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="text-base font-bold text-brown-dark">Probation Reviews</h2>
                      <p className="text-xs text-brown-faint mt-0.5">3-day evaluation for new trainees</p>
                    </div>
                    {probations.length > 0 && (
                      <span className="text-xs bg-[#FEF3E2] text-[#C4813A] px-2 py-0.5 rounded-full font-semibold">
                        {probations.length} active
                      </span>
                    )}
                  </div>

                  <div className="space-y-2">
                    {/* Active probations */}
                    {probations.map(p => {
                      const s = p.staff as Staff | undefined
                      const day = getProbationDay(p.start_date)
                      const d1 = p.day1_result
                      const d2 = p.day2_result
                      const pendingLabel = !d1 ? 'Day 1 pending' : d1 === 'continue' && !d2 ? 'Day 2 pending' : 'Day 3 pending'
                      return (
                        <div key={p.id} className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex items-center gap-3">
                          <Avatar name={s?.name ?? '?'} avatar={s?.avatar ?? null} size="sm" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-brown-dark truncate">{s?.name ?? 'Unknown'}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <div className="flex gap-1">
                                {[p.day1_result, p.day2_result, p.day3_result].map((r, i) => (
                                  <span key={i} className={`w-4 h-1.5 rounded-full ${
                                    r === 'eliminate' ? 'bg-[#9E4A30]' :
                                    r != null ? 'bg-[#3D7A50]' :
                                    day > i + 1 ? 'bg-[#C4813A]' :
                                    'bg-[#EDE5D8]'
                                  }`} />
                                ))}
                              </div>
                              <span className="text-xs text-brown-faint">Day {day} · {pendingLabel}</span>
                            </div>
                          </div>
                          <button
                            onClick={() => navigate(`/probation/${p.staff_id}`)}
                            className="text-xs font-semibold text-[#C4813A] px-3 py-1.5 rounded-lg border border-[#C4813A40] hover:bg-[#FEF3E2] transition-colors flex-shrink-0"
                          >
                            Review →
                          </button>
                        </div>
                      )
                    })}

                    {/* Trainees without probation */}
                    {traineesWithoutProbation.map(s => (
                      <div key={s.id} className="bg-white rounded-xl border border-[#E8DDD0] border-dashed p-4 flex items-center gap-3">
                        <Avatar name={s.name} avatar={s.avatar} size="sm" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-brown-dark truncate">{s.name}</p>
                          <p className="text-xs text-brown-faint">No probation started</p>
                        </div>
                        <button
                          onClick={() => handleStartProbation(s)}
                          disabled={startingProbation === s.id}
                          className="text-xs font-semibold text-white bg-[#C4813A] px-3 py-1.5 rounded-lg hover:bg-[#A86C2C] transition-colors disabled:opacity-60 flex-shrink-0"
                        >
                          {startingProbation === s.id ? '…' : 'Start'}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )
            })()}

            {/* ── Skill Assessments (pending review) ── */}
            {can('conduct_reviews') && visibleSkillReviews.length > 0 && (
              <section id="skill-assessments-section">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-base font-bold text-brown-dark">Skill Assessments</h2>
                    <p className="text-xs text-brown-faint mt-0.5">Staff requesting a skill sign-off</p>
                  </div>
                  <span className="text-xs bg-[#FEF3E2] text-[#C4813A] px-2 py-0.5 rounded-full font-semibold">
                    {visibleSkillReviews.length} pending
                  </span>
                </div>

                {skillError && (
                  <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{skillError}</p>
                )}

                <div className="space-y-2">
                  {visibleSkillReviews.map(r => (
                    <div key={r.id} className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex items-center gap-3 flex-wrap">
                      <Avatar name={r.staff?.name ?? '?'} avatar={r.staff?.avatar ?? null} size="sm" />
                      <div className="flex-1 min-w-[160px]">
                        <p className="text-sm font-semibold text-brown-dark truncate">{r.staff?.name ?? 'Unknown'}</p>
                        <p className="text-xs text-brown-muted">
                          {r.skill?.name ?? 'Skill'}
                          {r.skill?.name_zh ? <span className="text-brown-faint"> · {r.skill.name_zh}</span> : null}
                        </p>
                        <p className="text-[11px] text-brown-faint mt-0.5">
                          +{r.skill?.xp_reward ?? 0} XP · requested {formatTimeAgo(r.updated_at)}
                        </p>
                      </div>
                      <div className="flex gap-2 flex-shrink-0">
                        <button
                          onClick={() => setFailTarget(r)}
                          disabled={savingSkillId === r.id}
                          className="px-3 py-1.5 text-xs rounded-lg border border-[#E8DDD0] text-brown-muted hover:bg-[#FCF0EC] hover:border-[#C06242] hover:text-[#C06242] transition-colors disabled:opacity-50"
                        >
                          ✗ Fail
                        </button>
                        <button
                          onClick={() => handlePassSkill(r)}
                          disabled={savingSkillId === r.id}
                          className="px-3 py-1.5 text-xs rounded-lg bg-[#3D7A50] hover:bg-[#2E6040] text-white font-semibold transition-colors disabled:opacity-50"
                        >
                          {savingSkillId === r.id ? 'Saving…' : '✓ Pass'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Promotion Reviews (all skills passed — awaiting decision) ── */}
            {canDecidePromotions && promotions.length > 0 && (
              <section id="promotion-reviews-section">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-base font-bold text-brown-dark">Promotion Reviews</h2>
                    <p className="text-xs text-brown-faint mt-0.5">Staff who passed every skill in their career path</p>
                  </div>
                  <span className="text-xs bg-[#EBF5EE] text-[#3D7A50] px-2 py-0.5 rounded-full font-semibold">
                    {promotions.length} awaiting
                  </span>
                </div>
                <div className="space-y-2">
                  {promotions.map(p => (
                    <div key={p.id} className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex items-center gap-3">
                      <Avatar name={p.staff?.name ?? '?'} avatar={p.staff?.avatar ?? null} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-brown-dark truncate">{p.staff?.name ?? 'Unknown'}</p>
                        <p className="text-xs text-brown-muted">
                          {p.career_path?.from?.name} <span className="text-brown-faint">→</span>{' '}
                          <span className="font-semibold text-[#C4813A]">{p.career_path?.to?.name}</span>
                          <span className="text-brown-faint"> · eligible {formatTimeAgo(p.created_at)}</span>
                        </p>
                      </div>
                      <button
                        onClick={() => setPromotionTarget(p)}
                        className="text-xs font-semibold text-white bg-[#3D7A50] px-3 py-1.5 rounded-lg hover:bg-[#2E6040] transition-colors flex-shrink-0"
                      >
                        Evaluate →
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Registration Requests ── */}
            {regRequests.length > 0 && (
              <section ref={regRef}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-bold text-brown-dark flex items-center gap-2">
                    Registration Requests
                  </h2>
                  <div className="flex gap-1 bg-white rounded-lg border border-[#E8DDD0] p-0.5">
                    {(['pending', 'rejected'] as const).map(tab => (
                      <button
                        key={tab}
                        onClick={() => setRegTab(tab)}
                        className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                          regTab === tab ? 'bg-[#C4813A] text-white' : 'text-brown-muted hover:bg-[#F5EDE0]'
                        }`}
                      >
                        {tab === 'pending' ? `Pending (${pendingRegRequests.length})` : `Rejected (${rejectedRegRequests.length})`}
                      </button>
                    ))}
                  </div>
                </div>
                {visibleRegRequests.length === 0 ? (
                  <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-8 text-center">
                    <p className="text-sm text-brown-faint">No {regTab} requests.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {visibleRegRequests.map(req => (
                      <div
                        key={req.id}
                        className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex flex-col sm:flex-row sm:items-center gap-3"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-brown-dark">{req.full_name}</p>
                          <p className="text-xs text-brown-muted">{req.email}</p>
                          <div className="flex flex-wrap gap-2 mt-1">
                            {req.branch && (
                              <span className="text-xs bg-canvas text-brown-muted px-2 py-0.5 rounded-full border border-[#E8DDD0]">
                                {req.branch.includes('Connaught') ? 'Cheras' : req.branch.includes('Puteri') ? 'Puchong' : req.branch}
                              </span>
                            )}
                            {req.department && (
                              <span className="text-xs bg-canvas text-brown-muted px-2 py-0.5 rounded-full border border-[#E8DDD0]">
                                {deptName(req.department) || req.department}
                              </span>
                            )}
                            {req.employment_type && (
                              <span className="text-xs bg-canvas text-brown-muted px-2 py-0.5 rounded-full border border-[#E8DDD0]">
                                {req.employment_type}
                              </span>
                            )}
                            {req.phone && (
                              <span className="text-xs text-brown-faint">{req.phone}</span>
                            )}
                          </div>
                          {req.status === 'rejected' && req.rejection_reason && (
                            <p className="text-xs text-[#C06242] mt-1 italic">"{req.rejection_reason}"</p>
                          )}
                          <p className="text-xs text-brown-faint mt-1">{formatTimeAgo(req.created_at)}</p>
                        </div>
                        {req.status === 'pending' && (
                          <div className="flex gap-2 flex-shrink-0">
                            <button
                              onClick={() => setRejectTarget(req)}
                              className="px-3 py-1.5 text-xs rounded-lg border border-[#E8DDD0] text-brown-muted hover:bg-[#FCF0EC] hover:border-[#C06242] hover:text-[#C06242] transition-colors"
                            >
                              Reject
                            </button>
                            <button
                              onClick={() => setApproveTarget(req)}
                              className="px-3 py-1.5 text-xs rounded-lg bg-[#3D7A50] hover:bg-[#2E6040] text-white font-semibold transition-colors"
                            >
                              Approve
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* ── Pending Mission Approvals ── */}
            <section ref={pendingRef}>
              <h2 className="text-base font-bold text-brown-dark mb-4">
                Pending Approvals
                {pendingCompletions.length > 0 && (
                  <span className="ml-2 text-xs bg-[#FEF3E2] text-[#C4813A] px-2 py-0.5 rounded-full font-semibold">
                    {pendingCompletions.length}
                  </span>
                )}
              </h2>

              {pendingCompletions.length === 0 ? (
                <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-8 text-center">
                  <p className="text-2xl mb-2">✅</p>
                  <p className="text-sm text-brown-faint">All caught up! No pending approvals.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingCompletions.map(c => (
                    <PendingCard
                      key={c.id}
                      completion={c}
                      onApprove={() => handleApprove(c.id)}
                      onReject={() => handleReject(c.id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* ── Staff Table ── */}
            <section id="staff-section">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-bold text-brown-dark">All Staff</h2>
                <span className="text-xs text-brown-faint">{filteredStaff.length} of {allStaff.length}</span>
              </div>

              <div className="flex flex-wrap gap-2 mb-3">
                <input
                  type="search"
                  placeholder="Search name..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="flex-1 min-w-[140px] px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
                />
                <select className={selectCls} value={filterBranch} onChange={e => setFilterBranch(e.target.value)}>
                  <option value="">All branches</option>
                  {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
                <select className={selectCls} value={filterDept} onChange={e => setFilterDept(e.target.value)}>
                  <option value="">All depts</option>
                  {Object.entries(DEPT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <select className={selectCls} value={filterRank} onChange={e => setFilterRank(e.target.value)}>
                  <option value="">All ranks</option>
                  {(['trainee', 'junior', 'senior', 'supervisor', 'manager'] as const).map(r => (
                    <option key={r} value={r}>{RANK_LABELS[r]}</option>
                  ))}
                </select>
                <select className={selectCls} value={filterStatus} onChange={e => setFilterStatus(e.target.value as 'active' | 'resigned' | '')}>
                  <option value="active">Active</option>
                  <option value="resigned">Resigned</option>
                  <option value="">All statuses</option>
                </select>
              </div>

              <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#EDE5D8]">
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint">Name</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint hidden sm:table-cell">Rank</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint hidden md:table-cell">Branch</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-brown-faint hidden lg:table-cell">Dept</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-brown-faint">XP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStaff.map((s, i) => (
                      <tr
                        key={s.id}
                        onClick={() => navigate(`/staff/${s.id}`)}
                        className={`cursor-pointer hover:bg-[#FAF6F1] transition-colors ${i > 0 ? 'border-t border-[#F0E8DC]' : ''}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={s.name} avatar={s.avatar} size="sm" />
                            <div>
                              <p className="font-medium text-brown-dark text-sm flex items-center gap-1.5">
                                {s.name}
                                {s.status === 'resigned' && (
                                  <span className="text-[10px] font-semibold text-[#9E4A30] bg-[#C0624212] border border-[#C0624230] px-1.5 py-0.5 rounded-full">
                                    Resigned
                                  </span>
                                )}
                              </p>
                              {!s.onboarding_completed && s.rank !== 'manager' && s.status !== 'resigned' && (
                                <p className="text-xs text-[#C4813A]">Onboarding</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <span
                            className="text-xs font-semibold px-2 py-0.5 rounded-full"
                            style={{ color: RANK_COLORS[s.rank], background: `${RANK_COLORS[s.rank]}18` }}
                          >
                            {RANK_LABELS[s.rank]}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-brown-faint hidden md:table-cell">
                          {shortenBranch(s.branch)}
                        </td>
                        <td className="px-4 py-3 text-xs text-brown-faint hidden lg:table-cell">
                          {s.department ? (DEPT_LABELS[s.department] ?? s.department) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-xs font-bold text-brown-dark">{s.xp}</span>
                          <span className="text-xs text-brown-faint ml-0.5">xp</span>
                        </td>
                      </tr>
                    ))}
                    {filteredStaff.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-xs text-brown-faint">
                          No staff match your filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

          </div>

          {/* ── Activity Feed Sidebar ── */}
          <aside className="mt-8 lg:mt-0">
            <div className="lg:sticky lg:top-6">
              <h2 className="text-base font-bold text-brown-dark mb-4">Activity Feed</h2>
              <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
                {completions.length === 0 ? (
                  <p className="px-4 py-6 text-xs text-brown-faint text-center">No recent activity.</p>
                ) : (
                  completions.slice(0, 15).map(c => (
                    <div key={c.id} className="px-4 py-3 flex items-start gap-2.5">
                      <Avatar name={c.staff?.name ?? '?'} avatar={c.staff?.avatar ?? null} size="sm" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-brown-dark truncate">{c.staff?.name ?? 'Unknown'}</p>
                        <p className="text-xs text-brown-faint truncate">{c.mission?.title ?? 'Mission'}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className={`text-xs font-medium ${
                            c.status === 'approved' ? 'text-[#3D7A50]' :
                            c.status === 'rejected' ? 'text-[#9E4A30]' :
                            'text-[#C4813A]'
                          }`}>
                            {c.status === 'approved' ? '✓ Approved' : c.status === 'rejected' ? '✗ Rejected' : '⏳ Pending'}
                          </span>
                          <span className="text-xs text-brown-faint">· {formatTimeAgo(c.completed_at)}</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </aside>

        </div>
      </div>
    </div>
  )
}
