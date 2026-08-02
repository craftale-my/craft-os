import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import type {
  Staff, MonthlyReview, ProbationReview, SkillAssessment, PromotionRequest, Skill,
} from '../../shared/types'
import {
  SKILL_STATUS_ICONS,
  RANK_LABELS, DEPT_LABELS,
  calcFinalScore, getScoreConfig, REVIEW_CATEGORIES, MONTHS_FULL,
  getProbationDay,
} from '../../shared/types'
import { useAuth } from '../auth/AuthContext'
import { useCan, canReviewStaff } from '../../shared/lib/permissions'
import { bucketProbations } from '../../shared/lib/probation'
import { StarRating } from '../../shared/components/StarRating'
import { Avatar } from '../../shared/components/Avatar'
import { formatTimeAgo } from './Directory'
import { useTeamData } from './useTeamData'

const CURRENT_MONTH = new Date().getMonth() + 1
const CURRENT_YEAR = new Date().getFullYear()

/**
 * 四个考核区块共用的 props。`staff` 是 useTeamData 的全员名册,`loading` 是它的
 * 加载态,`onChange` 只在动作真的改动了 staff 行时调用(通过技能加 XP、晋升改
 * job_title_id)。`me` 是当前登录者 —— 决定 reviewer 身份、isManager,以及
 * canReviewStaff 的复核范围,拆分前它来自 Dashboard 的 currentStaff。
 */
interface SectionProps {
  staff: Staff[]
  loading: boolean
  onChange: () => void
  me: Staff | null
}

function SectionSpinner() {
  return <p className="text-xs text-brown-faint text-center py-10">Loading…</p>
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-[#E8DDD0] px-6 py-8 text-center">
      <p className="text-sm text-brown-faint">{children}</p>
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

// ─── SupervisorReviewCard (inline review form) ────────────────────────────────

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

// ─── Monthly Reviews ──────────────────────────────────────────────────────────

function MonthlyReviews({ staff, loading, me }: SectionProps) {
  const [reviews, setReviews] = useState<MonthlyReview[]>([])
  const [reviewsLoading, setReviewsLoading] = useState(true)
  const [startingReviews, setStartingReviews] = useState(false)

  const isManager = me?.rank === 'manager'
  const monthLabel = MONTHS_FULL[CURRENT_MONTH - 1]

  const loadReviews = useCallback(async () => {
    const { data } = await supabase
      .from('monthly_reviews')
      .select('*, staff:staff!monthly_reviews_staff_id_fkey(id,name,rank,department,branch,branch_id)')
      .eq('month', CURRENT_MONTH)
      .eq('year', CURRENT_YEAR)
    if (data) setReviews(data as MonthlyReview[])
    setReviewsLoading(false)
  }, [])

  useEffect(() => { loadReviews() }, [loadReviews])

  // Review buckets
  const reviewStarted = reviews.length > 0
  // The "awaiting supervisor review" list is scoped to the reviewer's own
  // team (canReviewStaff is unconditionally true for manager tier), while
  // the stats row above still reflects the full cycle.
  const selfDoneReviews = reviews.filter(r => r.status === 'self_done' && canReviewStaff(me, r.staff))
  const completedReviews = reviews.filter(r => r.status === 'completed')
  const pendingSelfReviews = reviews.filter(r => r.status === 'pending')
  const poorReviews = completedReviews.filter(r => {
    const score = calcFinalScore(r)
    return score != null && score < 60
  })

  async function handleStartReviews() {
    if (!isManager) return
    setStartingReviews(true)
    const nonManagers = staff.filter(s => s.rank !== 'manager' && s.status !== 'resigned')
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
    loadReviews()
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

  if (loading || reviewsLoading) return <SectionSpinner />

  return (
    <section>
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
              reviewerId={me?.id ?? ''}
              onComplete={loadReviews}
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
  )
}

// ─── Probation Reviews ────────────────────────────────────────────────────────

function ProbationReviews({ staff, loading, me }: SectionProps) {
  const navigate = useNavigate()
  const [probations, setProbations] = useState<ProbationReview[]>([])
  const [probationsLoading, setProbationsLoading] = useState(true)
  const [startingProbation, setStartingProbation] = useState<string | null>(null)
  const [probationError, setProbationError] = useState('')

  const loadProbations = useCallback(async () => {
    const { data } = await supabase
      .from('probation_reviews')
      .select('*, staff:staff!probation_reviews_staff_id_fkey(id,name,avatar,rank,branch,department,branch_id)')
      .order('start_date', { ascending: false })
    if (data) setProbations(data as ProbationReview[])
    setProbationsLoading(false)
  }, [])

  useEffect(() => { loadProbations() }, [loadProbations])

  async function handleStartProbation(staffMember: Staff) {
    setStartingProbation(staffMember.id)
    setProbationError('')
    // A review may already exist (started by another manager, or finished
    // earlier) — never create a duplicate row; just open the existing one.
    const { data: existing } = await supabase
      .from('probation_reviews')
      .select('id')
      .eq('staff_id', staffMember.id)
      .limit(1)
      .maybeSingle()
    if (existing) {
      setStartingProbation(null)
      navigate(`/probation/${staffMember.id}`)
      return
    }
    const { error } = await supabase.from('probation_reviews').insert({
      staff_id: staffMember.id,
      reviewer_id: me?.id,
      start_date: new Date().toISOString().split('T')[0],
    })
    setStartingProbation(null)
    if (error) {
      setProbationError(`Couldn't start probation for ${staffMember.name}: ${error.message}`)
      return
    }
    navigate(`/probation/${staffMember.id}`)
  }

  if (loading || probationsLoading) return <SectionSpinner />

  // Scope the trainee pool and their probation reviews to what
  // the current reviewer may act on (unconditionally true for
  // manager tier via canReviewStaff).
  const reviewableStaff = staff.filter(s => canReviewStaff(me, s))
  const reviewableProbations = probations.filter(p => canReviewStaff(me, p.staff))
  const { active, completed, unstarted } = bucketProbations(reviewableStaff, reviewableProbations)
  const hasAnything = active.length > 0 || completed.length > 0 || unstarted.length > 0

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold text-brown-dark">Probation Reviews</h2>
          <p className="text-xs text-brown-faint mt-0.5">3-day evaluation for new trainees</p>
        </div>
        {active.length > 0 && (
          <span className="text-xs bg-[#FEF3E2] text-[#C4813A] px-2 py-0.5 rounded-full font-semibold">
            {active.length} active
          </span>
        )}
      </div>

      {probationError && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{probationError}</p>
      )}

      {!hasAnything ? (
        <EmptyState>No trainees in your review scope right now.</EmptyState>
      ) : (
        <div className="space-y-2">
          {/* Active probations */}
          {active.map(p => {
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

          {/* Completed probations — outcome shown, no restart */}
          {completed.map(({ staff: s, review: r }) => {
            const hired = r.overall_result === 'hired'
            return (
              <div key={r.id} className="bg-white rounded-xl border border-[#E8DDD0] p-4 flex items-center gap-3">
                <Avatar name={s.name} avatar={s.avatar} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-brown-dark truncate">{s.name}</p>
                  <span className={`inline-block mt-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                    hired ? 'bg-[#EBF5EE] text-[#3D7A50]' : 'bg-[#FCF0EC] text-[#9E4A30]'
                  }`}>
                    {hired ? '🎉 Hired' : '❌ Eliminated'}
                  </span>
                </div>
                <button
                  onClick={() => navigate(`/probation/${s.id}`)}
                  className="text-xs font-semibold text-brown-faint px-3 py-1.5 rounded-lg border border-[#E8DDD0] hover:bg-[#FAF6F1] transition-colors flex-shrink-0"
                >
                  View →
                </button>
              </div>
            )
          })}

          {/* Trainees without probation */}
          {unstarted.map(s => (
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
      )}
    </section>
  )
}

// ─── Skill Assessments (pending review) ───────────────────────────────────────

function SkillAssessments({ loading, onChange, me }: SectionProps) {
  const [skillReviews, setSkillReviews] = useState<SkillAssessment[]>([])
  const [assessmentsLoading, setAssessmentsLoading] = useState(true)
  const [failTarget, setFailTarget] = useState<SkillAssessment | null>(null)
  const [savingSkillId, setSavingSkillId] = useState<string | null>(null)
  const [skillError, setSkillError] = useState('')

  const loadAssessments = useCallback(async () => {
    const { data } = await supabase
      .from('skill_assessments')
      .select('*, skill:skills(*), staff:staff!skill_assessments_staff_id_fkey(id,name,avatar,rank,branch,branch_id,department)')
      .eq('status', 'pending_review')
      .order('updated_at', { ascending: true })
    setSkillReviews((data as SkillAssessment[]) ?? [])
    setAssessmentsLoading(false)
  }, [])

  useEffect(() => { loadAssessments() }, [loadAssessments])

  // Pending skill assessments, scoped to the current user's review scope
  // (canReviewStaff is unconditionally true for manager tier).
  const visibleSkillReviews = skillReviews.filter(r => canReviewStaff(me, r.staff))

  async function handlePassSkill(a: SkillAssessment) {
    setSavingSkillId(a.id); setSkillError('')
    // XP award + promotion-request creation happen via DB triggers on 'passed'.
    const { error } = await supabase.from('skill_assessments').update({
      status: 'passed',
      assessed_by: me?.id ?? null,
      assessed_at: new Date().toISOString(),
      remarks: null,
      updated_at: new Date().toISOString(),
    }).eq('id', a.id)
    setSavingSkillId(null)
    if (error) { setSkillError(error.message); return }
    loadAssessments()
    onChange() // 触发器给 staff 加了 XP,名册要跟着刷新
  }

  if (loading || assessmentsLoading) return <SectionSpinner />

  return (
    <section>
      {failTarget && (
        <FailAssessmentModal
          assessment={failTarget}
          reviewerId={me?.id}
          onClose={() => setFailTarget(null)}
          onDone={() => { setFailTarget(null); loadAssessments() }}
        />
      )}

      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold text-brown-dark">Skill Assessments</h2>
          <p className="text-xs text-brown-faint mt-0.5">Staff requesting a skill sign-off</p>
        </div>
        {visibleSkillReviews.length > 0 && (
          <span className="text-xs bg-[#FEF3E2] text-[#C4813A] px-2 py-0.5 rounded-full font-semibold">
            {visibleSkillReviews.length} pending
          </span>
        )}
      </div>

      {skillError && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{skillError}</p>
      )}

      {visibleSkillReviews.length === 0 ? (
        <EmptyState>No skill sign-offs waiting on you.</EmptyState>
      ) : (
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
      )}
    </section>
  )
}

// ─── Promotion Reviews (all skills passed — awaiting decision) ────────────────

function PromotionReviews({ loading, onChange, me }: SectionProps) {
  const [promotions, setPromotions] = useState<PromotionRequest[]>([])
  const [promotionsLoading, setPromotionsLoading] = useState(true)
  const [promotionTarget, setPromotionTarget] = useState<PromotionRequest | null>(null)

  const loadPromotions = useCallback(async () => {
    const { data } = await supabase
      .from('promotion_requests')
      .select('*, staff:staff!promotion_requests_staff_id_fkey(id,name,avatar,rank,branch_id), career_path:career_paths(*, from:roles!career_paths_from_job_title_id_fkey(*), to:roles!career_paths_to_job_title_id_fkey(*))')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
    setPromotions((data as PromotionRequest[]) ?? [])
    setPromotionsLoading(false)
  }, [])

  useEffect(() => { loadPromotions() }, [loadPromotions])

  if (loading || promotionsLoading) return <SectionSpinner />

  return (
    <section>
      {promotionTarget && (
        <PromotionReviewModal
          request={promotionTarget}
          reviewerId={me?.id}
          onClose={() => setPromotionTarget(null)}
          onDone={() => {
            setPromotionTarget(null)
            loadPromotions()
            onChange() // 批准会改 staff.job_title_id,名册要跟着刷新
          }}
        />
      )}

      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-bold text-brown-dark">Promotion Reviews</h2>
          <p className="text-xs text-brown-faint mt-0.5">Staff who passed every skill in their career path</p>
        </div>
        {promotions.length > 0 && (
          <span className="text-xs bg-[#EBF5EE] text-[#3D7A50] px-2 py-0.5 rounded-full font-semibold">
            {promotions.length} awaiting
          </span>
        )}
      </div>

      {promotions.length === 0 ? (
        <EmptyState>No promotions awaiting a decision.</EmptyState>
      ) : (
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
      )}
    </section>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'monthly' | 'probation' | 'skills' | 'promotion'

const TAB_LABELS: Record<Tab, string> = {
  monthly:   'Monthly',
  probation: 'Probation',
  skills:    'Skills',
  promotion: 'Promotion',
}

export default function ReviewsPage() {
  const [tab, setTab] = useState<Tab>('monthly')
  const { staff, loading, reload } = useTeamData()
  const { staff: me } = useAuth()
  const { role } = useCan()

  // 晋升决定属于 Manager/Owner(与 Admin),主管无权 —— 与拆分前 Dashboard 里
  // canDecidePromotions 的门槛一致,所以这个 tab 对主管整块不出现。
  const canDecidePromotions = role === 'owner' || role === 'admin' || role === 'manager'
  const tabs = (Object.keys(TAB_LABELS) as Tab[])
    .filter(t => t !== 'promotion' || canDecidePromotions)

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold text-brown-dark mb-6">Reviews</h1>

      <div className="flex gap-1 mb-6 bg-white shadow-card rounded-xl p-1 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-sm rounded-lg whitespace-nowrap px-2 transition-colors ${
              tab === t
                ? 'bg-[#4A2E1A] text-[#F5F0E8] font-medium'
                : 'text-brown-muted hover:text-brown-dark'
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'monthly'   && <MonthlyReviews   staff={staff} loading={loading} onChange={reload} me={me} />}
      {tab === 'probation' && <ProbationReviews staff={staff} loading={loading} onChange={reload} me={me} />}
      {tab === 'skills'    && <SkillAssessments staff={staff} loading={loading} onChange={reload} me={me} />}
      {tab === 'promotion' && <PromotionReviews staff={staff} loading={loading} onChange={reload} me={me} />}
    </div>
  )
}
