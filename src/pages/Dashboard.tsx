import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { supabaseAdmin } from '../lib/supabase-admin'
import type { Staff, MissionCompletion, MonthlyReview, ProbationReview } from '../types'
import {
  RANK_LABELS, RANK_COLORS,
  DEPT_LABELS, DEPT_STORE, BRANCHES, DEPARTMENTS,
  calcFinalScore, getScoreConfig, REVIEW_CATEGORIES, MONTHS_FULL,
  getProbationDay,
} from '../types'
import { StarRating } from '../components/StarRating'

const CURRENT_MONTH = new Date().getMonth() + 1
const CURRENT_YEAR = new Date().getFullYear()

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
      rank: form.rank,
      branch: form.branch || null,
      department: form.department ? (DEPT_STORE[form.department] ?? null) : null,
      onboarding_completed: form.rank === 'manager',
      joined_at: new Date().toISOString().split('T')[0],
    })
    if (profileErr) {
      setError(profileErr.message)
      setSaving(false)
      return
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
              {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
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
  const [ratings, setRatings] = useState<Record<RatingKey, number>>({
    attitude: 0, efficiency: 0, coffee_skill: 0, service: 0,
  })
  const [comments, setComments] = useState('')
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const staff = review.staff as Staff | undefined

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
            <span className="text-xs font-semibold text-brown-medium flex-1">Times Late This Month</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setLateCount(c => Math.max(0, c - 1))}
                className="w-7 h-7 rounded-full border border-[#D4C5B0] text-brown-dark font-bold hover:bg-[#F5EDE0] transition-colors"
              >−</button>
              <span className="w-6 text-center text-sm font-bold text-brown-dark">{lateCount}</span>
              <button
                onClick={() => setLateCount(c => Math.min(10, c + 1))}
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
  const [currentStaff, setCurrentStaff] = useState<Staff | null>(null)
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const [completions, setCompletions] = useState<MissionCompletion[]>([])
  const [reviews, setReviews] = useState<MonthlyReview[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [search, setSearch] = useState('')
  const [filterBranch, setFilterBranch] = useState('')
  const [filterDept, setFilterDept] = useState('')
  const [filterRank, setFilterRank] = useState('')
  const [startingReviews, setStartingReviews] = useState(false)
  const [reviewRefresh, setReviewRefresh] = useState(0)
  const [probations, setProbations] = useState<ProbationReview[]>([])
  const [startingProbation, setStartingProbation] = useState<string | null>(null)
  const pendingRef = useRef<HTMLDivElement>(null)

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

    if (staffRes.data) setAllStaff(staffRes.data)
    if (myRes.data) setCurrentStaff(myRes.data)
    if (completionsRes.data) setCompletions(completionsRes.data as MissionCompletion[])
    if (reviewsRes.data) setReviews(reviewsRes.data as MonthlyReview[])
    if (probationsRes.data) setProbations(probationsRes.data as ProbationReview[])
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

  // Derived counts
  const pendingCompletions = completions.filter(c => c.status === 'pending')
  const onboardingCount = allStaff.filter(s => !s.onboarding_completed && s.rank !== 'manager').length
  const levelUpCount = allStaff.filter(s => {
    if (!s.last_level_up_at) return false
    return Date.now() - new Date(s.last_level_up_at).getTime() < 7 * 24 * 60 * 60 * 1000
  }).length

  const deptBreakdown: Record<string, number> = {}
  allStaff.forEach(s => {
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
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterBranch && s.branch !== filterBranch) return false
    if (filterDept && s.department !== filterDept) return false
    if (filterRank && s.rank !== filterRank) return false
    return true
  })

  async function handleStartReviews() {
    if (!isManager) return
    setStartingReviews(true)
    const nonManagers = allStaff.filter(s => s.rank !== 'manager')
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
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="bg-white rounded-2xl p-4 border border-[#E8DDD0]">
            <p className="text-xs text-brown-faint font-medium mb-1">Total Staff</p>
            <p className="text-3xl font-bold text-brown-dark">{allStaff.length}</p>
            <div className="mt-2 space-y-0.5">
              {Object.entries(deptBreakdown).slice(0, 3).map(([dept, count]) => (
                <p key={dept} className="text-xs text-brown-faint">
                  {DEPT_LABELS[dept] ?? dept}: {count}
                </p>
              ))}
            </div>
          </div>

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
                s => s.rank === 'trainee' && !activeStaffIds.has(s.id)
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
                              <p className="font-medium text-brown-dark text-sm">{s.name}</p>
                              {!s.onboarding_completed && s.rank !== 'manager' && (
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
