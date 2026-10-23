import { useEffect, useRef, useState } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { ErrorBoundary } from '../../shared/components/ErrorBoundary'
import { StarRating } from '../../shared/components/StarRating'
import { ScoreChart } from '../../shared/components/ScoreChart'
import type { Staff, StaffPrivate, Mission, MissionCompletion, SkillRating, VerificationType, MonthlyReview, ProbationReview, Role } from '../../shared/types'
import {
  SKILL_CATEGORIES, MISSION_CATEGORY_LABELS, RANK_LABELS, getProbationDay,
  VERIFICATION_CONFIG,
  BRANCHES, GENDERS,
  REVIEW_CATEGORIES, MONTHS_FULL, calcFinalScore, getScoreConfig,
} from '../../shared/types'
import { useLookups } from '../../shared/lib/lookups'
import type { Option } from '../../shared/lib/lookups'
import { canReviewStaff, canReadStaffPrivate } from '../../shared/lib/permissions'
import { fetchStaffPrivate, saveStaffPrivate, fetchManagerNotes, saveManagerNotes } from './privateApi'
import { RankBadge } from '../../shared/components/RankBadge'
import { XPBar } from '../../shared/components/XPBar'
import { SkillDots } from '../../shared/components/SkillDots'
import { Avatar } from '../../shared/components/Avatar'
import { canPromote } from '../../shared/lib/xp'
import { CareerProgress } from './CareerProgress'
import { Badge, Button, ButtonLink, Card, SegmentedTabs } from '../../shared/components/ui'

type Tab = 'missions' | 'skills' | 'career' | 'personal' | 'reviews' | 'history'

const TAB_LABELS: Record<Tab, string> = {
  missions: 'Missions',
  skills:   'Skills',
  career:   'Career',
  personal: 'Personal',
  reviews:  'Reviews',
  history:  'History',
}

// Time-of-day greeting for the self-view header.
function greeting(d = new Date()) {
  const h = d.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

const now = new Date()
const CURRENT_MONTH = now.getMonth() + 1
const CURRENT_YEAR  = now.getFullYear()

export function StaffProfilePage({ selfView = false }: { selfView?: boolean }) {
  const { id } = useParams<{ id: string }>()
  const { user, staff: currentStaff, loading: authLoading, refreshStaff } = useAuth()
  const { deptName } = useLookups()
  const staffId = selfView ? currentStaff?.id : id

  const [staff, setStaff]           = useState<Staff | null>(null)
  const [priv, setPriv]             = useState<StaffPrivate | null>(null)
  const [missions, setMissions]     = useState<Mission[]>([])
  const [completions, setCompletions] = useState<MissionCompletion[]>([])
  const [skills, setSkills]         = useState<SkillRating[]>([])
  const [pendingReviewStatus, setPendingReviewStatus] = useState<string | null>(null)
  const [probation, setProbation] = useState<ProbationReview | null>(null)
  const [tab, setTab]               = useState<Tab>('missions')
  const [loading, setLoading]       = useState(true)
  const [notFound, setNotFound]     = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [reloadKey, setReloadKey]   = useState(0)

  const isSelf       = selfView || staffId === currentStaff?.id
  const isManager    = currentStaff?.rank === 'manager'
  // hr/manager/admin/owner (or rank manager): may read staff_private and manager notes.
  const canSeePrivate = canReadStaffPrivate(currentStaff)
  // Scope-aware review permission: mirrors canReviewStaff (manager tier is
  // unconditionally true; supervisor tier requires same branch+department
  // and a target rank below supervisor). Gates review scoring + skill
  // rating UI only — management-card gating below still uses isManager.
  const canReview    = canReviewStaff(currentStaff, staff)
  const canRateSkills = canReview && !isSelf

  useEffect(() => {
    if (!authLoading && selfView && !currentStaff?.id) {
      setLoading(false); setNotFound(true)
    }
  }, [authLoading, selfView, currentStaff?.id])

  useEffect(() => {
    if (!staffId) return
    let cancelled = false
    setLoading(true); setNotFound(false); setFetchError(null)

    async function load() {
      try {
        const [staffRes, missionRes, completionRes, skillRes, reviewRes, probationRes, privRow] = await Promise.all([
          supabase.from('staff').select('*').eq('id', staffId!).single(),
          supabase.from('missions').select('*').order('created_at'),
          supabase.from('mission_completions').select('*, mission:missions(*)').eq('staff_id', staffId!),
          supabase.from('skill_ratings').select('*').eq('staff_id', staffId!).order('rated_at', { ascending: false }),
          supabase.from('monthly_reviews').select('status')
            .eq('staff_id', staffId!).eq('month', CURRENT_MONTH).eq('year', CURRENT_YEAR)
            .maybeSingle(),
          supabase.from('probation_reviews').select('*')
            .eq('staff_id', staffId!).is('overall_result', null)
            .order('created_at', { ascending: false }).limit(1).maybeSingle(),
          fetchStaffPrivate(staffId!),
        ])
        if (cancelled) return
        if (!staffRes.data) { setNotFound(true) }
        else { setStaff(staffRes.data as Staff) }
        setMissions((missionRes.data ?? []) as Mission[])
        setCompletions((completionRes.data ?? []) as MissionCompletion[])
        setSkills((skillRes.data ?? []) as SkillRating[])
        setPendingReviewStatus(reviewRes.data?.status ?? null)
        setProbation((probationRes.data ?? null) as ProbationReview | null)
        setPriv(privRow)
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : 'Failed to load profile.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [staffId, reloadKey])

  async function refreshAll() {
    if (!staffId) return
    try {
      const [staffRes, completionRes, reviewRes, privResult] = await Promise.all([
        supabase.from('staff').select('*').eq('id', staffId).single(),
        supabase.from('mission_completions').select('*, mission:missions(*)').eq('staff_id', staffId),
        supabase.from('monthly_reviews').select('status')
          .eq('staff_id', staffId).eq('month', CURRENT_MONTH).eq('year', CURRENT_YEAR).maybeSingle(),
        // A failed private fetch must not discard the other results, and must
        // not read as "Restricted" (null) — so it is caught here and the
        // previous priv is kept.
        fetchStaffPrivate(staffId).then(row => ({ row }), () => null),
      ])
      if (staffRes.data) setStaff(staffRes.data as Staff)
      if (privResult) setPriv(privResult.row)
      setCompletions((completionRes.data ?? []) as MissionCompletion[])
      setPendingReviewStatus(reviewRes.data?.status ?? null)
      if (isSelf) await refreshStaff()
    } catch { /* non-critical */ }
  }

  async function saveSkillRating(category: string, skill: string, rating: number) {
    if (!currentStaff || !staffId) return
    const existing = skills.find(s => s.category === category && s.skill === skill)
    try {
      if (existing) {
        await supabase.from('skill_ratings')
          .update({ rating, rated_by: currentStaff.id, rated_at: new Date().toISOString() })
          .eq('id', existing.id)
        setSkills(prev => prev.map(s => s.id === existing.id ? { ...s, rating } : s))
      } else {
        const { data } = await supabase.from('skill_ratings')
          .insert({ staff_id: staffId, category, skill, rating, rated_by: currentStaff.id })
          .select().single()
        if (data) setSkills(prev => [...prev, data as SkillRating])
      }
    } catch { /* silent */ }
  }

  async function handleReset() {
    if (!staffId) return
    // .select() so an RLS denial is detectable: Supabase reports a policy
    // block as success-with-0-rows, not as an error.
    const [staffRes, compRes] = await Promise.all([
      supabase.from('staff').update({ xp: 0, level: 1, last_level_up_at: null }).eq('id', staffId).select('id'),
      supabase.from('mission_completions').delete().eq('staff_id', staffId).select('id'),
    ])
    if (staffRes.error) throw staffRes.error
    if (compRes.error) throw compRes.error
    if ((staffRes.data ?? []).length === 0) {
      throw new Error('Nothing was updated — your account may not have permission for this action.')
    }
    await refreshAll()
  }

  async function handleSetStatus(status: 'active' | 'resigned') {
    if (!staffId) return
    // Supabase update() resolves with { error } rather than throwing, and an
    // RLS denial is success-with-0-rows — check both, or a failed update
    // looks like "nothing happened".
    const { data, error } = await supabase.from('staff').update({ status }).eq('id', staffId).select('id')
    if (error) throw error
    if ((data ?? []).length === 0) {
      throw new Error('Nothing was updated — your account may not have permission for this action.')
    }
    await refreshAll()
  }

  // ── Render states ────────────────────────────────────────────────────────────

  if (authLoading || loading) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 rounded-full border-2 border-[#8B6344] border-t-transparent animate-spin" />
        <p className="text-brown-muted text-sm">Loading profile…</p>
      </div>
    )
  }
  if (notFound) return <Navigate to="/login" replace />
  if (fetchError) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
        <p className="text-2xl mb-2">⚠️</p>
        <p className="text-brown-dark font-semibold mb-1">Could not load profile</p>
        <p className="text-brown-muted text-sm mb-4">{fetchError}</p>
        <Button variant="dark" onClick={() => { setFetchError(null); setLoading(true); setReloadKey(k => k + 1) }}>Retry</Button>
      </div>
    )
  }
  if (!staff) return <Navigate to="/login" replace />

  const promote = canPromote(staff.rank, staff.level)

  return (
    <ErrorBoundary>
      <div className="max-w-3xl mx-auto px-4 py-8 font-brand">
        {isSelf && <p className="type-eyebrow text-[11px] text-brown-brand mb-2.5">{greeting()}</p>}

        {/* Probation banner */}
        {staff.rank === 'trainee' && probation && (
          <Card tone="tint" padded={false} className="px-4 py-3 mb-4 flex items-center gap-3">
            <span className="text-xl flex-shrink-0">🌱</span>
            <div className="flex-1 min-w-0">
              <p className="type-semicondensed text-[15px] font-bold text-[#A86C2C]">
                Probation Period — Day {getProbationDay(probation.start_date)} of 3
              </p>
              <div className="flex gap-1.5 mt-1.5">
                {[probation.day1_result, probation.day2_result, probation.day3_result].map((r, i) => (
                  <span key={i} className={`w-8 h-1.5 rounded-full ${
                    r === 'eliminate' ? 'bg-[#9E4A30]' :
                    r != null ? 'bg-[#3D7A50]' :
                    getProbationDay(probation.start_date) > i + 1 ? 'bg-[#C4813A]' :
                    getProbationDay(probation.start_date) === i + 1 ? 'bg-[#C4813A80]' :
                    'bg-[#EDE5D8]'
                  }`} />
                ))}
              </div>
            </div>
            {canReview && (
              <ButtonLink to={`/probation/${staff.id}`} variant="secondary" size="sm" className="flex-shrink-0">
                View review →
              </ButtonLink>
            )}
          </Card>
        )}

        {/* Profile header */}
        <Card className="p-6 mb-4">
          <div className="flex items-start gap-4">
            <div className="rounded-full ring-4 ring-cream flex-shrink-0">
              <Avatar name={staff.name} avatar={staff.avatar} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="type-wordmark text-[28px] text-brown-dark break-words">{staff.name}</h1>
                <RankBadge rank={staff.rank} size="sm" />
                {staff.status === 'resigned' && <Badge tone="danger">Resigned</Badge>}
                {promote && <Badge tone="brand">Ready to promote</Badge>}
              </div>
              <p className="type-condensed text-[15px] text-brown-muted capitalize mt-1.5 mb-4">
                {deptName(staff.department) || '—'} · Level {staff.level}
              </p>
              <XPBar xp={staff.xp ?? 0} level={staff.level ?? 1} />
            </div>
          </div>
        </Card>

        {/* Review banner — shown when self-view and current month review is pending */}
        {isSelf && pendingReviewStatus === 'pending' && (
          <Card tone="tint" padded={false} className="px-5 py-4 mb-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="type-semicondensed text-[15px] font-bold text-[#8B5E2E]">Your monthly review is ready</p>
              <p className="text-xs text-brown-muted mt-0.5">
                Complete your self-evaluation for {MONTHS_FULL[CURRENT_MONTH - 1]}
              </p>
            </div>
            <Button size="sm" className="shrink-0 !h-9 !px-4 !text-sm" onClick={() => setTab('reviews')}>
              Start →
            </Button>
          </Card>
        )}

        {/* Tabs */}
        <div className="mt-6 mb-6">
          <SegmentedTabs
            label="Profile sections"
            value={tab}
            onChange={setTab}
            tabs={(Object.keys(TAB_LABELS) as Tab[]).map(t => ({
              id: t,
              label: TAB_LABELS[t],
              dot: t === 'reviews' && pendingReviewStatus === 'pending',
            }))}
          />
        </div>

        {tab === 'missions' && (
          <MissionsTab missions={missions} staffId={staffId!} completions={completions} isSelf={isSelf} onRefresh={refreshAll} />
        )}
        {tab === 'skills' && (
          <SkillsTab skills={skills} canEdit={canRateSkills} onRate={saveSkillRating} />
        )}
        {tab === 'career' && <CareerProgress staff={staff} isSelf={isSelf} />}
        {tab === 'personal' && (
          <PersonalInfoTab
            staff={staff}
            priv={priv}
            isSelf={isSelf}
            isManager={isManager}
            email={staff.email ?? (isSelf ? (user?.email ?? '') : '')}
            authEmail={user?.email ?? ''}
            onSaved={refreshAll}
          />
        )}
        {tab === 'reviews' && (
          <ReviewsTab
            staffId={staffId!}
            isSelf={isSelf}
            isSupervisor={canReview}
            currentStaffId={currentStaff?.id ?? ''}
            onStatusChange={setPendingReviewStatus}
          />
        )}
        {tab === 'history' && <HistoryTab completions={completions} />}

        {/* Notes: hr/manager/admin/owner. Status + danger zone: rank manager (unchanged). */}
        {(canSeePrivate || isManager) && !isSelf && (
          <div className="mt-6 space-y-4">
            {canSeePrivate && currentStaff && (
              <ManagerNotesCard staffId={staff.id} actorId={currentStaff.id} />
            )}
            {isManager && <EmploymentStatusCard staff={staff} onSetStatus={handleSetStatus} />}
            {isManager && <DangerZoneCard staff={staff} onReset={handleReset} />}
          </div>
        )}
      </div>
    </ErrorBoundary>
  )
}

// ─── Reviews Tab ──────────────────────────────────────────────────────────────

function ReviewsTab({
  staffId, isSelf, isSupervisor, currentStaffId, onStatusChange,
}: {
  staffId: string
  isSelf: boolean
  isSupervisor: boolean
  currentStaffId: string
  onStatusChange: (s: string | null) => void
}) {
  const [reviews, setReviews]   = useState<MonthlyReview[]>([])
  const [loading, setLoading]   = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    supabase.from('monthly_reviews').select('*')
      .eq('staff_id', staffId)
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .limit(13)
      .then(({ data }) => {
        if (cancelled) return
        setReviews((data ?? []) as MonthlyReview[])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [staffId, refreshKey])

  function refresh() {
    setRefreshKey(k => k + 1)
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-7 h-7 rounded-full border-2 border-[#8B6344] border-t-transparent animate-spin" />
      </div>
    )
  }

  const currentReview = reviews.find(r => r.month === CURRENT_MONTH && r.year === CURRENT_YEAR) ?? null
  const pastCompleted = reviews.filter(r =>
    r.status === 'completed' && !(r.month === CURRENT_MONTH && r.year === CURRENT_YEAR)
  )

  return (
    <div className="space-y-4">
      {/* Current month card */}
      <CurrentMonthCard
        review={currentReview}
        isSelf={isSelf}
        isSupervisor={isSupervisor}
        currentStaffId={currentStaffId}
        onRefresh={() => {
          refresh()
          const newStatus = currentReview?.status === 'pending' ? 'self_done'
            : currentReview?.status === 'self_done' ? 'completed' : null
          onStatusChange(newStatus)
        }}
      />

      {/* Score history chart */}
      {pastCompleted.length >= 2 && (
        <div className="bg-white rounded-xl shadow-card p-5">
          <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest mb-4">Score Trend</p>
          <ScoreChart reviews={pastCompleted} />
        </div>
      )}

      {/* Past reviews */}
      {pastCompleted.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest mb-3">Past Reviews</p>
          <div className="space-y-2">
            {pastCompleted.map(r => <PastReviewRow key={r.id} review={r} />)}
          </div>
        </div>
      )}

      {!currentReview && pastCompleted.length === 0 && (
        <div className="bg-white rounded-xl shadow-card px-5 py-10 text-center">
          <p className="text-2xl mb-2">📋</p>
          <p className="text-sm font-semibold text-brown-dark">No reviews yet</p>
          <p className="text-xs text-brown-muted mt-1">
            {isSelf
              ? 'Your supervisor will start a review cycle soon.'
              : 'Use Team > Reviews to start a review cycle.'}
          </p>
        </div>
      )}
    </div>
  )
}

function CurrentMonthCard({
  review, isSelf, isSupervisor, currentStaffId, onRefresh,
}: {
  review: MonthlyReview | null
  isSelf: boolean
  isSupervisor: boolean
  currentStaffId: string
  onRefresh: () => void
}) {
  const monthLabel = `${MONTHS_FULL[CURRENT_MONTH - 1]} ${CURRENT_YEAR}`

  if (!review) {
    return (
      <div className="bg-white rounded-xl shadow-card px-5 py-6 flex items-center gap-4">
        <div className="w-10 h-10 rounded-full bg-[#F5F0E8] flex items-center justify-center text-lg shrink-0">📅</div>
        <div>
          <p className="text-sm font-semibold text-brown-dark">{monthLabel}</p>
          <p className="text-xs text-brown-muted mt-0.5">No review started for this month yet.</p>
        </div>
      </div>
    )
  }

  if (review.status === 'pending' && isSelf) {
    return <SelfEvalForm review={review} onSubmitted={onRefresh} />
  }

  if (review.status === 'pending') {
    return (
      <div className="bg-white rounded-xl shadow-card px-5 py-5 flex items-center gap-4">
        <StatusDot color="#C4813A" />
        <div>
          <p className="text-sm font-semibold text-brown-dark">{monthLabel}</p>
          <p className="text-xs text-brown-muted mt-0.5">Waiting for staff to complete self-evaluation</p>
        </div>
      </div>
    )
  }

  if (review.status === 'self_done' && isSupervisor) {
    return <SupervisorReviewForm review={review} reviewerId={currentStaffId} onSubmitted={onRefresh} />
  }

  if (review.status === 'self_done') {
    return (
      <div className="bg-white rounded-xl shadow-card p-5">
        <div className="flex items-center gap-3 mb-4">
          <StatusDot color="#4A8FBF" />
          <div>
            <p className="text-sm font-semibold text-brown-dark">{monthLabel}</p>
            <p className="text-xs text-brown-muted">Self-evaluation submitted — awaiting supervisor review</p>
          </div>
        </div>
        <SelfEvalSummary review={review} />
      </div>
    )
  }

  // completed
  return <CompletedReviewCard review={review} />
}

// ─── Self Evaluation Form ─────────────────────────────────────────────────────

function SelfEvalForm({ review, onSubmitted }: { review: MonthlyReview; onSubmitted: () => void }) {
  const [ratings, setRatings] = useState<Record<string, number>>({
    attitude:     review.self_attitude     ?? 0,
    efficiency:   review.self_efficiency   ?? 0,
    coffee_skill: review.self_coffee_skill ?? 0,
    service:      review.self_service      ?? 0,
  })
  const [comments, setComments] = useState(review.self_comments ?? '')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  const allRated = REVIEW_CATEGORIES.every(c => (ratings[c.key] ?? 0) > 0)

  async function submit() {
    if (!allRated) { setError('Please rate all 4 categories before submitting.'); return }
    setSaving(true); setError('')
    const { error: err } = await supabase.from('monthly_reviews').update({
      self_attitude:     ratings.attitude,
      self_efficiency:   ratings.efficiency,
      self_coffee_skill: ratings.coffee_skill,
      self_service:      ratings.service,
      self_comments:     comments.trim() || null,
      self_submitted_at: new Date().toISOString(),
      status:            'self_done',
    }).eq('id', review.id)
    if (err) { setError(err.message); setSaving(false) }
    else onSubmitted()
  }

  return (
    <div className="bg-white rounded-xl shadow-card p-5">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="text-sm font-bold text-brown-dark">Self Evaluation</h3>
          <p className="text-xs text-brown-muted mt-0.5">
            {MONTHS_FULL[review.month - 1]} {review.year}
          </p>
        </div>
        <span className="text-xs text-[#C4813A] border border-[#C4813A35] bg-[#C4813A0C] px-2.5 py-0.5 rounded-full font-medium">
          Action Required
        </span>
      </div>

      <div className="space-y-4">
        {REVIEW_CATEGORIES.map(cat => (
          <div key={cat.key} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-brown-dark">{cat.label}</p>
              <p className="text-xs text-brown-faint">{cat.sub}</p>
            </div>
            <StarRating
              value={ratings[cat.key] ?? 0}
              onChange={v => setRatings(prev => ({ ...prev, [cat.key]: v }))}
              size="lg"
            />
          </div>
        ))}

        <div>
          <label className={labelCls}>Comments (optional)</label>
          <textarea
            value={comments}
            onChange={e => setComments(e.target.value)}
            rows={3}
            placeholder="How was your month? Any achievements or challenges?"
            className={`${inputCls} resize-none`}
          />
        </div>

        {error && <p className="text-red-600 text-xs">{error}</p>}

        <button
          onClick={submit}
          disabled={saving || !allRated}
          className="w-full bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-50 text-white text-sm font-semibold py-3 rounded-xl transition-colors"
        >
          {saving ? 'Submitting…' : 'Submit Self Evaluation'}
        </button>
      </div>
    </div>
  )
}

// ─── Supervisor Review Form ───────────────────────────────────────────────────

function SupervisorReviewForm({
  review, reviewerId, onSubmitted,
}: {
  review: MonthlyReview; reviewerId: string; onSubmitted: () => void
}) {
  const [lateCount, setLateCount] = useState(review.late_count ?? 0)
  const [ratings, setRatings]     = useState<Record<string, number>>({
    attitude:     review.sup_attitude     ?? 0,
    efficiency:   review.sup_efficiency   ?? 0,
    coffee_skill: review.sup_coffee_skill ?? 0,
    service:      review.sup_service      ?? 0,
  })
  const [comments, setComments] = useState(review.sup_comments ?? '')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  const attendanceScore = Math.max(0, 100 - lateCount * 10)
  const allRated = REVIEW_CATEGORIES.every(c => (ratings[c.key] ?? 0) > 0)

  const previewScore = allRated
    ? Math.round(
        attendanceScore           * 0.30 +
        ratings.attitude    * 20  * 0.15 +
        ratings.efficiency  * 20  * 0.20 +
        ratings.coffee_skill * 20 * 0.20 +
        ratings.service     * 20  * 0.15
      )
    : null

  async function submit() {
    if (!allRated) { setError('Please rate all 4 categories.'); return }
    setSaving(true); setError('')
    const { error: err } = await supabase.from('monthly_reviews').update({
      late_count:        lateCount,
      sup_attitude:      ratings.attitude,
      sup_efficiency:    ratings.efficiency,
      sup_coffee_skill:  ratings.coffee_skill,
      sup_service:       ratings.service,
      sup_comments:      comments.trim() || null,
      sup_submitted_at:  new Date().toISOString(),
      reviewer_id:       reviewerId,
      status:            'completed',
    }).eq('id', review.id)
    if (err) { setError(err.message); setSaving(false) }
    else onSubmitted()
  }

  return (
    <div className="bg-white rounded-xl shadow-card p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-brown-dark">Supervisor Review</h3>
          <p className="text-xs text-brown-muted mt-0.5">{MONTHS_FULL[review.month - 1]} {review.year}</p>
        </div>
        <span className="text-xs text-[#4A8FBF] border border-[#4A8FBF35] bg-[#4A8FBF0C] px-2.5 py-0.5 rounded-full font-medium">
          Awaiting Your Review
        </span>
      </div>

      {/* Staff self-eval (read-only) */}
      <div className="bg-[#FAF7F3] rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest">Staff Self-Evaluation</p>
        {REVIEW_CATEGORIES.map(cat => (
          <div key={cat.key} className="flex items-center justify-between gap-2">
            <span className="text-xs text-brown-muted">{cat.label}</span>
            <StarRating value={(review as unknown as Record<string, number>)[cat.selfKey] ?? 0} readonly size="sm" />
          </div>
        ))}
        {review.self_comments && (
          <p className="text-xs text-brown-muted italic border-l-2 border-[#D4C5B0] pl-2 mt-2">
            "{review.self_comments}"
          </p>
        )}
      </div>

      {/* Attendance */}
      <div>
        <p className={labelCls}>Attendance — Late Count</p>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setLateCount(Math.max(0, lateCount - 1))}
              className="w-8 h-8 rounded-lg border border-border-mid text-brown-dark hover:bg-cream transition-colors font-semibold">
              −
            </button>
            <span className="w-8 text-center text-sm font-semibold text-brown-dark">{lateCount}</span>
            <button type="button" onClick={() => setLateCount(lateCount + 1)}
              className="w-8 h-8 rounded-lg border border-border-mid text-brown-dark hover:bg-cream transition-colors font-semibold">
              +
            </button>
          </div>
          <div className="flex-1">
            <p className="text-xs text-brown-muted">
              Attendance Score: <span className="font-semibold text-brown-dark">{attendanceScore}/100</span>
              <span className="text-brown-faint ml-1">(30% weight)</span>
            </p>
            <div className="mt-1 h-1.5 bg-[#EDE5D8] rounded-full overflow-hidden">
              <div className="h-full bg-[#8B6344] rounded-full transition-all" style={{ width: `${attendanceScore}%` }} />
            </div>
          </div>
        </div>
      </div>

      {/* Supervisor ratings */}
      <div className="space-y-4">
        <p className={labelCls}>Your Ratings</p>
        {REVIEW_CATEGORIES.map(cat => (
          <div key={cat.key} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-brown-dark">{cat.label}</p>
              <p className="text-xs text-brown-faint">{cat.sub}</p>
            </div>
            <StarRating
              value={ratings[cat.key] ?? 0}
              onChange={v => setRatings(prev => ({ ...prev, [cat.key]: v }))}
              size="lg"
            />
          </div>
        ))}
      </div>

      {/* Preview score */}
      {previewScore !== null && (
        <ScoreBar score={previewScore} label="Predicted Final Score" />
      )}

      <div>
        <label className={labelCls}>Comments (optional)</label>
        <textarea
          value={comments}
          onChange={e => setComments(e.target.value)}
          rows={3}
          placeholder="Feedback for the staff member…"
          className={`${inputCls} resize-none`}
        />
      </div>

      {error && <p className="text-red-600 text-xs">{error}</p>}

      <button
        onClick={submit}
        disabled={saving || !allRated}
        className="w-full bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-50 text-white text-sm font-semibold py-3 rounded-xl transition-colors"
      >
        {saving ? 'Submitting…' : 'Submit Review'}
      </button>
    </div>
  )
}

// ─── Completed Review Card ────────────────────────────────────────────────────

function CompletedReviewCard({ review }: { review: MonthlyReview }) {
  const score = calcFinalScore(review)
  const cfg   = score !== null ? getScoreConfig(score) : null
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-white rounded-xl shadow-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-brown-dark">
            {MONTHS_FULL[review.month - 1]} {review.year}
          </p>
          <p className="text-xs text-brown-faint mt-0.5">Completed review</p>
        </div>
        {score !== null && cfg && (
          <div className="text-right">
            <p className="text-2xl font-display font-bold" style={{ color: cfg.color }}>{score}</p>
            <p className="text-xs font-medium" style={{ color: cfg.color }}>{cfg.emoji} {cfg.label}</p>
          </div>
        )}
      </div>

      {score !== null && <ScoreBar score={score} />}

      <button
        onClick={() => setExpanded(v => !v)}
        className="text-xs text-brown-muted hover:text-brown-dark underline"
      >
        {expanded ? 'Hide details' : 'Show details'}
      </button>

      {expanded && (
        <div className="space-y-4 pt-2 border-t border-border">
          {/* Score breakdown */}
          <div className="grid grid-cols-2 gap-3">
            <ScoreBreakdownRow label="Attendance" value={review.attendance_score ?? 0} outOf={100} weight="30%" />
            {REVIEW_CATEGORIES.map(cat => (
              <ScoreBreakdownRow
                key={cat.key}
                label={cat.label}
                value={(review as unknown as Record<string, number>)[cat.supKey] ?? 0}
                outOf={5}
                weight={`${Math.round(cat.weight * 100)}%`}
                selfValue={(review as unknown as Record<string, number>)[cat.selfKey] ?? 0}
              />
            ))}
          </div>

          {/* Comments */}
          {(review.sup_comments || review.self_comments) && (
            <div className="space-y-2">
              {review.self_comments && (
                <div className="text-xs text-brown-muted bg-[#FAF7F3] rounded-lg p-3">
                  <span className="font-semibold text-brown-dark">Staff: </span>
                  {review.self_comments}
                </div>
              )}
              {review.sup_comments && (
                <div className="text-xs text-brown-muted bg-[#FAF7F3] rounded-lg p-3">
                  <span className="font-semibold text-brown-dark">Supervisor: </span>
                  {review.sup_comments}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PastReviewRow({ review }: { review: MonthlyReview }) {
  const score = calcFinalScore(review)
  const cfg   = score !== null ? getScoreConfig(score) : null
  return (
    <div className="bg-white rounded-xl shadow-card px-5 py-4 flex items-center justify-between gap-4">
      <p className="text-sm font-medium text-brown-dark">
        {MONTHS_FULL[review.month - 1]} {review.year}
      </p>
      {score !== null && cfg ? (
        <div className="flex items-center gap-3">
          <div className="w-24 hidden sm:block">
            <ScoreBar score={score} compact />
          </div>
          <span className="text-sm font-bold" style={{ color: cfg.color }}>{score}</span>
          <span className="text-xs" style={{ color: cfg.color }}>{cfg.emoji}</span>
        </div>
      ) : (
        <span className="text-xs text-brown-faint">—</span>
      )}
    </div>
  )
}

// ─── Self Eval Summary (read-only) ────────────────────────────────────────────

function SelfEvalSummary({ review }: { review: MonthlyReview }) {
  return (
    <div className="space-y-3">
      {REVIEW_CATEGORIES.map(cat => (
        <div key={cat.key} className="flex items-center justify-between gap-2">
          <span className="text-xs text-brown-muted">{cat.label}</span>
          <StarRating value={(review as unknown as Record<string, number>)[cat.selfKey] ?? 0} readonly size="sm" />
        </div>
      ))}
      {review.self_comments && (
        <p className="text-xs text-brown-muted italic border-l-2 border-[#D4C5B0] pl-2">
          "{review.self_comments}"
        </p>
      )}
    </div>
  )
}

// ─── Score Bar ────────────────────────────────────────────────────────────────

function ScoreBar({ score, label, compact }: { score: number; label?: string; compact?: boolean }) {
  const cfg = getScoreConfig(score)
  if (compact) {
    return (
      <div className="h-1.5 bg-[#EDE5D8] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${score}%`, background: cfg.color }} />
      </div>
    )
  }
  return (
    <div>
      {label && <p className="text-xs text-brown-muted mb-1.5">{label}</p>}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2.5 bg-[#EDE5D8] rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${score}%`, background: cfg.color }} />
        </div>
        <span className="text-sm font-bold shrink-0" style={{ color: cfg.color }}>{score}/100</span>
      </div>
    </div>
  )
}

function ScoreBreakdownRow({
  label, value, outOf, weight, selfValue,
}: {
  label: string; value: number; outOf: number; weight: string; selfValue?: number
}) {
  return (
    <div className="text-xs">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-brown-muted">{label}</span>
        <span className="font-semibold text-brown-dark">
          {value}/{outOf}
          {selfValue !== undefined && (
            <span className="text-brown-faint font-normal ml-1">(self: {selfValue})</span>
          )}
        </span>
      </div>
      <p className="text-brown-faint">{weight} weight</p>
    </div>
  )
}

function StatusDot({ color }: { color: string }) {
  return (
    <div className="w-2.5 h-2.5 rounded-full shrink-0 mt-1" style={{ background: color }} />
  )
}

// ─── Missions Tab ─────────────────────────────────────────────────────────────

function MissionsTab({
  missions, staffId, completions, isSelf, onRefresh,
}: {
  missions: Mission[]; staffId: string; completions: MissionCompletion[]; isSelf: boolean; onRefresh: () => void
}) {
  const [activeId, setActiveId] = useState<string | null>(null)

  const approvedIds = new Set(completions.filter(c => c?.status === 'approved').map(c => c.mission_id))
  const pendingMap  = new Map(completions.filter(c => c?.status === 'pending').map(c => [c.mission_id, c]))
  const available       = missions.filter(m => m && !approvedIds.has(m.id) && !pendingMap.has(m.id))
  const pendingMissions = missions.filter(m => m && pendingMap.has(m.id))

  if (available.length === 0 && pendingMissions.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-card px-5 py-8 text-center">
        <p className="text-2xl mb-2">🏆</p>
        <p className="text-brown-dark font-semibold">All missions completed!</p>
        <p className="text-brown-muted text-sm mt-1">Check back with your manager for new challenges.</p>
      </div>
    )
  }

  return (
    <div>
      {pendingMissions.length > 0 && (
        <div className="mb-8">
          <SectionLabel>Awaiting Approval</SectionLabel>
          <div className="space-y-2">
            {pendingMissions.map(m => {
              const completion = pendingMap.get(m.id)
              return (
                <div key={m.id} className="bg-white rounded-2xl shadow-card px-5 py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="type-semicondensed text-base font-bold text-brown-dark">{m.title}</p>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className="type-condensed text-sm text-accent-text font-semibold">+{m.xp_reward} XP</span>
                      {m.verification_type && <VerificationTag type={m.verification_type} />}
                      {completion?.photo_url && (
                        <button onClick={() => window.open(completion.photo_url!, '_blank')}
                          className="text-xs text-[#2E6E9E] hover:underline">View proof →</button>
                      )}
                    </div>
                  </div>
                  <Badge tone="brand" className="shrink-0 whitespace-nowrap">Pending</Badge>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {available.length > 0 && (
        <div>
          {pendingMissions.length > 0 && <SectionLabel>Available Missions</SectionLabel>}
          <div className="space-y-2">
            {available.map(m => (
              <div key={m.id}>
                <div className="bg-white rounded-2xl shadow-card px-5 py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="type-semicondensed text-base font-bold text-brown-dark">{m.title}</p>
                    {m.description && <p className="text-xs text-brown-muted mt-0.5 line-clamp-1">{m.description}</p>}
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className="type-condensed text-sm text-accent-text font-semibold">+{m.xp_reward} XP</span>
                      {m.category && <span className="text-xs text-brown-faint">{MISSION_CATEGORY_LABELS[m.category]}</span>}
                      {m.verification_type && <VerificationTag type={m.verification_type} />}
                    </div>
                  </div>
                  {isSelf && (
                    <Button
                      size="sm"
                      variant={activeId === m.id ? 'dark' : 'secondary'}
                      className="shrink-0"
                      onClick={() => setActiveId(prev => prev === m.id ? null : m.id)}
                    >
                      {activeId === m.id ? 'Cancel' : 'Complete'}
                    </Button>
                  )}
                </div>
                {activeId === m.id && isSelf && (
                  <CompletionForm
                    mission={m} staffId={staffId}
                    onSubmitted={() => { setActiveId(null); onRefresh() }}
                    onCancel={() => setActiveId(null)}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Completion Form ──────────────────────────────────────────────────────────

function CompletionForm({
  mission, staffId, onSubmitted, onCancel,
}: {
  mission: Mission; staffId: string; onSubmitted: () => void; onCancel: () => void
}) {
  const [photoFile, setPhotoFile]       = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [submitting, setSubmitting]     = useState(false)
  const [error, setError]               = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const needsPhoto = mission.verification_type === 'photo' || mission.verification_type === 'both'

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoFile(file); setPhotoPreview(URL.createObjectURL(file)); setError('')
  }

  async function handleSubmit() {
    if (needsPhoto && !photoFile) { setError('Please upload a photo as proof before submitting.'); return }
    setSubmitting(true); setError('')
    let photoUrl: string | null = null
    if (photoFile) {
      try {
        const ext = photoFile.name.split('.').pop() ?? 'jpg'
        const filePath = `${staffId}/${mission.id}/${Date.now()}.${ext}`
        const { error: uploadErr } = await supabase.storage.from('mission-proofs').upload(filePath, photoFile, { contentType: photoFile.type })
        if (uploadErr) { setError(`Photo upload failed: ${uploadErr.message}`); setSubmitting(false); return }
        photoUrl = supabase.storage.from('mission-proofs').getPublicUrl(filePath).data.publicUrl
      } catch (err) { setError(err instanceof Error ? err.message : 'Upload failed.'); setSubmitting(false); return }
    }
    try {
      const { error: insertErr } = await supabase.from('mission_completions').insert({ staff_id: staffId, mission_id: mission.id, status: 'pending', photo_url: photoUrl })
      if (insertErr) { setError(insertErr.message); setSubmitting(false); return }
    } catch (err) { setError(err instanceof Error ? err.message : 'Submission failed.'); setSubmitting(false); return }
    setSubmitting(false); onSubmitted()
  }

  return (
    <div className="bg-cream border border-border rounded-b-xl px-5 py-4 -mt-1 space-y-4">
      {needsPhoto ? (
        <div>
          <p className="text-xs font-semibold text-brown-dark uppercase tracking-wider mb-2">Upload proof photo</p>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
          {photoPreview ? (
            <div className="flex items-start gap-3">
              <div className="relative">
                <img src={photoPreview} alt="Proof preview" className="w-28 h-28 object-cover rounded-lg border border-border shadow-sm" />
                <button onClick={() => { setPhotoFile(null); setPhotoPreview(null); if (fileRef.current) fileRef.current.value = '' }}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-white rounded-full shadow text-brown-muted hover:text-brown-dark text-xs font-bold flex items-center justify-center border border-border">×</button>
              </div>
              <button onClick={() => fileRef.current?.click()} className="text-xs text-brown-muted hover:text-brown-dark underline mt-1">Change photo</button>
            </div>
          ) : (
            <button onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 px-4 py-3 border-2 border-dashed border-border-mid rounded-xl text-sm text-brown-muted hover:border-[#8B6344] hover:text-brown-dark transition-colors w-full justify-center">
              📷 Tap to choose or take a photo
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-start gap-2.5 text-sm text-brown-muted">
          <span className="text-base mt-0.5">✋</span>
          <p>Your supervisor will verify and sign off on this mission in person.</p>
        </div>
      )}
      {error && <p className="text-red-600 text-xs">{error}</p>}
      <div className="flex gap-2">
        <button onClick={handleSubmit} disabled={submitting}
          className="text-sm bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors font-medium">
          {submitting ? 'Submitting…' : 'Submit for Approval'}
        </button>
        <button onClick={onCancel} className="text-sm text-brown-muted hover:text-brown-dark px-3 py-2 transition-colors">Cancel</button>
      </div>
    </div>
  )
}

// ─── Skills Tab ───────────────────────────────────────────────────────────────

function SkillsTab({ skills, canEdit, onRate }: {
  skills: SkillRating[]; canEdit: boolean; onRate: (cat: string, skill: string, r: number) => void
}) {
  function getRating(category: string, skill: string) {
    return (skills ?? []).find(s => s?.category === category && s?.skill === skill)?.rating ?? 0
  }
  return (
    <div className="space-y-4">
      {SKILL_CATEGORIES.map(cat => (
        <div key={cat.key} className="bg-white rounded-xl shadow-card p-5">
          <h3 className="text-sm font-semibold text-brown-dark mb-4">{cat.label}</h3>
          <div className="space-y-3">
            {cat.skills.map(skill => {
              const rating = getRating(cat.key, skill)
              return (
                <div key={skill} className="flex items-center justify-between">
                  <span className="text-sm text-brown-muted">{skill}</span>
                  {canEdit ? (
                    <div className="flex gap-1.5">
                      {[1,2,3,4,5].map(n => (
                        <button key={n} onClick={() => onRate(cat.key, skill, n)} title={`Rate ${n}/5`}
                          className="w-5 h-5 rounded-full transition-all hover:scale-110"
                          style={{ background: n <= rating ? '#8B6344' : '#E0D5C5' }} />
                      ))}
                    </div>
                  ) : (
                    <SkillDots rating={rating} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Personal Info Tab ────────────────────────────────────────────────────────

interface PersonalFormData {
  fullName: string; nickname: string; gender: string; contactNumber: string
  address: string; branch: string; department: string; employmentType: string
  workingExperience: string; education: string; rank: string; level: string
  jobTitleId: string; confirmationDate: string; supervisorId: string
}

type SupervisorCandidate = Pick<Staff, 'id' | 'name' | 'status'>

/**
 * Options for the Supervisor picker.
 *
 * - Never offers the staff member themselves: the DB has a CHECK constraint
 *   forbidding `supervisor_id = id`, so an unfiltered list would offer a
 *   choice guaranteed to fail on save.
 * - Only offers active staff — but if the staff member's *current*
 *   supervisor isn't active (they resigned; `supervisor_id` is a real FK
 *   with `on delete set null`, so it can never point at a deleted row, only
 *   an inactive one), that person is still pinned at the top labelled
 *   "(inactive)". This mirrors `useLookups().departmentOptions()`, which
 *   keeps a stale-but-current slug visible instead of silently dropping it —
 *   without it, opening Edit on a staff member whose supervisor left would
 *   make the picker default to blank and could unassign a real supervisor
 *   simply by clicking Save without touching the field.
 */
export function supervisorOptions(allStaff: SupervisorCandidate[], staff: Pick<Staff, 'id' | 'supervisor_id'>): Option[] {
  const opts = allStaff
    .filter(s => s.id !== staff.id && s.status === 'active')
    .map(s => ({ slug: s.id, name: s.name }))
  const currentId = staff.supervisor_id
  if (currentId && !opts.some(o => o.slug === currentId)) {
    const current = allStaff.find(s => s.id === currentId)
    if (current) opts.unshift({ slug: current.id, name: `${current.name} (inactive)` })
  }
  return opts
}

export function PersonalInfoTab({
  staff, priv, isSelf, isManager, email, authEmail, onSaved,
}: {
  staff: Staff; priv: StaffPrivate | null; isSelf: boolean; isManager: boolean; email: string; authEmail: string; onSaved: () => void
}) {
  const canEdit = isSelf || (isManager && !isSelf)
  // null ⇒ RLS hid this staff member's private row from the viewer.
  const restricted = priv === null
  const privValue = (v: string | null | undefined) => (restricted ? 'Restricted' : (v ?? '—'))
  const { departmentOptions, deptName, employmentTypeOptions } = useLookups()
  const deptDisplay = deptName(staff.department)   // slug → display label
  const [editing, setEditing]   = useState(false)
  const [saving, setSaving]     = useState(false)
  const [saveError, setSaveError] = useState('')

  const [form, setForm] = useState<PersonalFormData>({
    fullName: staff.name ?? '', nickname: staff.nickname ?? '', gender: staff.gender ?? '',
    contactNumber: priv?.contact_number ?? '', address: priv?.address ?? '',
    branch: staff.branch ?? '', department: staff.department ?? '',   // store the slug
    employmentType: staff.employment_type ?? '', workingExperience: staff.working_experience ?? '',
    education: staff.education ?? '', rank: staff.rank, level: String(staff.level),
    jobTitleId: staff.job_title_id ?? '', confirmationDate: staff.confirmation_date ?? '',
    supervisorId: staff.supervisor_id ?? '',
  })

  // Job titles for the manager's assignment dropdown (drives the career path).
  const [jobTitles, setJobTitles] = useState<Role[]>([])
  useEffect(() => {
    if (!isManager) return
    supabase.from('roles').select('*').eq('is_active', true).order('name').then(({ data }) => {
      if (data) setJobTitles(data as Role[])
    })
  }, [isManager])

  // All staff for the Supervisor dropdown — fetched unfiltered (not just
  // `status=active`) so supervisorOptions() can still resolve the name of an
  // inactive current supervisor rather than rendering their id. Also fetched
  // for isSelf (not just isManager): a staff member's own read-only
  // Supervisor row (below) resolves the supervisor's name from this same
  // list, and without it here the row would render "Unknown" even when
  // supervisor_id is set. staff_select's RLS ("using (true)") already lets
  // any authenticated caller read id/name/status for every staff row, so this
  // exposes nothing the self-viewer couldn't already query directly.
  const [allStaff, setAllStaff] = useState<SupervisorCandidate[]>([])
  useEffect(() => {
    if (!isManager && !isSelf) return
    supabase.from('staff').select('id, name, status').order('name').then(({ data }) => {
      if (data) setAllStaff(data as SupervisorCandidate[])
    })
  }, [isManager, isSelf])

  function update(field: keyof PersonalFormData, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function save() {
    setSaving(true); setSaveError('')
    try {
      const payload: Record<string, unknown> = {
        name: form.fullName, nickname: form.nickname || null, gender: form.gender || null,
        branch: form.branch || null,
        department: form.department || null,   // already a department slug
        employment_type: form.employmentType || null,
        working_experience: form.workingExperience || null, education: form.education || null,
      }
      if (isManager && !isSelf) {
        payload.rank = form.rank
        payload.level = parseInt(form.level) || 1
        payload.job_title_id = form.jobTitleId || null
        payload.confirmation_date = form.confirmationDate || null
        payload.supervisor_id = form.supervisorId || null
      }
      const { error } = await supabase.from('staff').update(payload).eq('id', staff.id)
      if (error) throw error
      const nextContact = form.contactNumber || null
      const nextAddress = form.address || null
      if (priv && (nextContact !== priv.contact_number || nextAddress !== priv.address)) {
        await saveStaffPrivate(staff.id, { contact_number: nextContact, address: nextAddress })
      }
      // Job title changed → create the skill records for its career path
      // (idempotent RPC; no-op if the title has no active path).
      if (isManager && !isSelf && form.jobTitleId && form.jobTitleId !== (staff.job_title_id ?? '')) {
        await supabase.rpc('initialize_staff_skills', { p_staff_id: staff.id })
      }
      setEditing(false); await onSaved()
    } catch (err) { setSaveError(err instanceof Error ? err.message : 'Save failed.') }
    finally { setSaving(false) }
  }

  function cancel() {
    setForm({ fullName: staff.name ?? '', nickname: staff.nickname ?? '', gender: staff.gender ?? '',
      contactNumber: priv?.contact_number ?? '', address: priv?.address ?? '', branch: staff.branch ?? '',
      department: staff.department ?? '', employmentType: staff.employment_type ?? '',
      workingExperience: staff.working_experience ?? '', education: staff.education ?? '',
      rank: staff.rank, level: String(staff.level), jobTitleId: staff.job_title_id ?? '',
      confirmationDate: staff.confirmation_date ?? '', supervisorId: staff.supervisor_id ?? '' })
    setSaveError(''); setEditing(false)
  }

  return (
    <div className="space-y-4">
      {canEdit && <AvatarUploadCard staff={staff} onSaved={onSaved} />}

      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest">Personal Details</p>
        {canEdit && !editing && (
          <button onClick={() => setEditing(true)}
            className="text-xs px-3 py-1.5 rounded-lg border border-[#8B634440] text-[#8B6344] bg-[#8B634408] hover:bg-[#8B634418] transition-colors">
            Edit
          </button>
        )}
      </div>

      {isManager && !isSelf && (
        <div className="bg-white rounded-xl shadow-card p-5 space-y-4">
          <SectionTitle>Rank & Level</SectionTitle>
          {editing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Rank</label>
                  <select value={form.rank} onChange={e => update('rank', e.target.value)} className={inputCls}>
                    {Object.entries(RANK_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Level</label>
                  <input type="number" min={1} max={99} value={form.level} onChange={e => update('level', e.target.value)} className={inputCls} />
                </div>
              </div>
              <div>
                <label className={labelCls}>Job Title</label>
                <select value={form.jobTitleId} onChange={e => update('jobTitleId', e.target.value)} className={inputCls}>
                  <option value="">— Not assigned —</option>
                  {jobTitles.map(t => <option key={t.id} value={t.id}>{t.name} ({RANK_LABELS[t.rank]})</option>)}
                </select>
                <p className="text-[11px] text-brown-faint mt-1">
                  Drives the career path: assigning a title creates its skill checklist for this staff member.
                </p>
              </div>
              <div>
                <label className={labelCls}>Confirmation Date</label>
                <input type="date" value={form.confirmationDate} onChange={e => update('confirmationDate', e.target.value)} className={inputCls} />
                <p className="text-[11px] text-brown-faint mt-1">
                  Annual leave starts accruing from this date. Leave blank if not yet confirmed.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <InfoRow label="Rank"      value={RANK_LABELS[staff.rank] ?? staff.rank} />
              <InfoRow label="Level"     value={`Level ${staff.level} · ${staff.xp} XP total`} />
              <InfoRow label="Job Title" value={jobTitles.find(t => t.id === staff.job_title_id)?.name ?? '—'} />
              <InfoRow label="Confirmed" value={staff.confirmation_date ? new Date(staff.confirmation_date).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'} />
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl shadow-card p-5 space-y-4">
        <SectionTitle>Employment</SectionTitle>
        {editing ? (
          <div className="space-y-4">
            <PISelectRow label="Branch"          value={form.branch}         options={BRANCHES}         onChange={v => update('branch', v)} />
            <PISelectRowKV label="Department"    value={form.department}     options={departmentOptions(staff.department)} onChange={v => update('department', v)} />
            {isManager && !isSelf && (
              <PISelectRowKV
                label="Supervisor"
                value={form.supervisorId}
                options={supervisorOptions(allStaff, staff)}
                onChange={v => update('supervisorId', v)}
              />
            )}
            <PISelectRow label="Employment Type" value={form.employmentType} options={employmentTypeOptions(staff.employment_type)} onChange={v => update('employmentType', v)} />
          </div>
        ) : (
          <div className="space-y-2">
            <InfoRow label="Branch"     value={staff.branch ?? '—'} />
            <InfoRow label="Department" value={deptDisplay || '—'} />
            {/* Read-only display is gated on isManager || isSelf: seeing who your
                own supervisor is isn't sensitive, and a staff member is the person
                most affected by the value being wrong or missing. The *editable*
                control above stays gated on isManager && !isSelf, unchanged — this
                only widens the display, never who can edit. */}
            {(isManager || isSelf) && (
              <InfoRow label="Supervisor" value={allStaff.find(s => s.id === staff.supervisor_id)?.name ?? (staff.supervisor_id ? 'Unknown' : 'None — falls back to branch managers')} />
            )}
            <InfoRow label="Employment" value={staff.employment_type ?? '—'} />
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-card p-5 space-y-4">
        <SectionTitle>Personal</SectionTitle>
        {editing ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <PIInputRow label="Full Name" value={form.fullName} onChange={v => update('fullName', v)} />
              <PIInputRow label="Nickname"  value={form.nickname} onChange={v => update('nickname', v)} placeholder="Optional" />
            </div>
            <InfoRow label="IC Number"     value={privValue(priv?.ic_number)}     note="Cannot be changed" />
            <InfoRow label="Date of Birth" value={privValue(priv?.date_of_birth)} note="Cannot be changed" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className={labelCls}>Gender</p>
                <div className="flex gap-2">
                  {GENDERS.map(g => (
                    <button key={g} type="button" onClick={() => update('gender', g)}
                      className={`flex-1 py-2.5 rounded-xl border text-sm font-medium transition-all ${
                        form.gender === g
                          ? 'border-[#8B6344] bg-[#8B634410] text-[#8B6344]'
                          : 'border-[#EDE5D8] bg-[#FAFAF8] text-brown-muted hover:border-[#D4C5B0]'
                      }`}>{g}</button>
                  ))}
                </div>
              </div>
              {!restricted && (
                <PIInputRow label="Contact Number" type="tel" value={form.contactNumber} onChange={v => update('contactNumber', v)} />
              )}
            </div>
            <InfoRow label="Email" value={email} note="From your account" />
            {!restricted && (
              <PITextareaRow label="Address" value={form.address} onChange={v => update('address', v)} />
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <InfoRow label="Full Name"     value={staff.name} />
            <InfoRow label="Nickname"      value={staff.nickname ?? '—'} />
            <InfoRow label="IC Number"     value={privValue(priv?.ic_number)} />
            <InfoRow label="Date of Birth" value={privValue(priv?.date_of_birth)} />
            <InfoRow label="Gender"        value={staff.gender ?? '—'} />
            <InfoRow label="Contact"       value={privValue(priv?.contact_number)} />
            <InfoRow label="Email"         value={email} />
            <InfoRow label="Address"       value={privValue(priv?.address)} multiline />
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl shadow-card p-5 space-y-4">
        <SectionTitle>Background</SectionTitle>
        {editing ? (
          <div className="space-y-4">
            <PITextareaRow label="Working Experience"   value={form.workingExperience} onChange={v => update('workingExperience', v)} />
            <PITextareaRow label="Education Background" value={form.education}         onChange={v => update('education', v)} />
          </div>
        ) : (
          <div className="space-y-2">
            <InfoRow label="Experience" value={staff.working_experience ?? '—'} multiline />
            <InfoRow label="Education"  value={staff.education ?? '—'}          multiline />
          </div>
        )}
      </div>

      {editing && (
        <div className="space-y-3">
          {saveError && <p className="text-red-600 text-xs">{saveError}</p>}
          <div className="flex gap-3">
            <button onClick={save} disabled={saving}
              className="bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors">
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            <button onClick={cancel} disabled={saving}
              className="text-sm text-brown-muted hover:text-brown-dark px-4 py-2.5 transition-colors">Cancel</button>
          </div>
        </div>
      )}

      {/* Security — self-service password change */}
      {isSelf && (
        <>
          <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest pt-2">Security</p>
          <ChangePasswordCard email={authEmail} />
        </>
      )}
    </div>
  )
}

// ─── Avatar Upload ────────────────────────────────────────────────────────────

function AvatarUploadCard({ staff, onSaved }: { staff: Staff; onSaved: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('Please choose an image file.'); return }
    if (file.size > 5 * 1024 * 1024) { setError('Image must be under 5MB.'); return }
    setUploading(true); setError('')
    try {
      const ext = file.name.split('.').pop() ?? 'jpg'
      const filePath = `${staff.id}/${Date.now()}.${ext}`
      // 路径首段是 staff id。storage 策略 staff_avatars_write 据此放行:写自己的
      // 目录,或调用者是 manager / hr / supervisor / admin / owner —— 后者正是
      // 经理替下属换头像的通路。
      // 这里曾有一段用 service_role 客户端的兜底,理由是"策略还没配";实际策略
      // 一直都在,兜底是历史遗留。而那把 key 会被打进构建产物,等于公开一把绕过
      // 全部 RLS 的钥匙,已移除。
      const { error: upErr } = await supabase.storage.from('staff-avatars').upload(filePath, file, {
        contentType: file.type, upsert: true,
      })
      if (upErr) throw upErr
      const url = supabase.storage.from('staff-avatars').getPublicUrl(filePath).data.publicUrl
      const { error: updErr } = await supabase.from('staff').update({ avatar: url }).eq('id', staff.id)
      if (updErr) throw updErr
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-card p-5 flex items-center gap-4">
      <Avatar name={staff.name} avatar={staff.avatar} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-brown-dark">Profile Photo</p>
        <p className="text-xs text-brown-muted mt-0.5">JPG or PNG, up to 5MB.</p>
        {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
      <button onClick={() => fileRef.current?.click()} disabled={uploading}
        className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-[#8B634440] text-[#8B6344] bg-[#8B634408] hover:bg-[#8B634418] transition-colors disabled:opacity-50">
        {uploading ? 'Uploading…' : staff.avatar ? 'Change' : 'Upload'}
      </button>
    </div>
  )
}

// ─── Change Password ──────────────────────────────────────────────────────────

function ChangePasswordCard({ email }: { email: string }) {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  function reset() {
    setCurrent(''); setNext(''); setConfirm(''); setError('')
  }

  async function submit() {
    setError('')
    if (next.length < 6) { setError('New password must be at least 6 characters.'); return }
    if (next !== confirm) { setError('New passwords do not match.'); return }
    if (next === current) { setError('New password must be different from your current password.'); return }
    setSaving(true)
    try {
      // Verify the current password before allowing the change
      const { error: authErr } = await supabase.auth.signInWithPassword({ email, password: current })
      if (authErr) {
        // 400 = invalid credentials; anything else (network, rate limit) gets the real message
        setError(authErr.status === 400 ? 'Current password is incorrect.' : authErr.message)
        return
      }
      const { error: updErr } = await supabase.auth.updateUser({ password: next })
      if (updErr) { setError(updErr.message); return }
      reset()
      setSuccess(true)
      setTimeout(() => { setSuccess(false); setOpen(false) }, 3000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-card p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-brown-dark">Password</p>
          <p className="text-xs text-brown-muted mt-0.5">Change the password you use to sign in.</p>
        </div>
        {!open && !success && (
          <button onClick={() => setOpen(true)}
            className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-[#8B634440] text-[#8B6344] bg-[#8B634408] hover:bg-[#8B634418] transition-colors">
            Change Password
          </button>
        )}
        {success && (
          <span className="text-xs font-medium text-[#3D7A50] bg-[#EBF5EE] px-3 py-1.5 rounded-lg">✓ Password updated</span>
        )}
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          <div>
            <label className={labelCls}>Current Password</label>
            <input type="password" autoComplete="current-password" value={current}
              onChange={e => setCurrent(e.target.value)} className={inputCls} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>New Password</label>
              <input type="password" autoComplete="new-password" value={next}
                onChange={e => setNext(e.target.value)} placeholder="Min 6 characters" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Confirm New Password</label>
              <input type="password" autoComplete="new-password" value={confirm}
                onChange={e => setConfirm(e.target.value)} className={inputCls} />
            </div>
          </div>
          {error && <p className="text-red-600 text-xs">{error}</p>}
          <div className="flex gap-2">
            <button onClick={submit} disabled={saving || !current || !next || !confirm}
              className="text-sm bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-50 text-white px-4 py-2 rounded-lg transition-colors font-medium">
              {saving ? 'Updating…' : 'Update Password'}
            </button>
            <button onClick={() => { reset(); setOpen(false) }} disabled={saving}
              className="text-sm text-brown-muted hover:text-brown-dark px-3 py-2 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Manager Cards ────────────────────────────────────────────────────────────

function ManagerNotesCard({ staffId, actorId }: { staffId: string; actorId: string }) {
  const [notes, setNotes]   = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
  const [error, setError]   = useState('')

  useEffect(() => {
    let cancelled = false
    fetchManagerNotes(staffId)
      .then(n => { if (!cancelled) { setNotes(n ?? ''); setLoaded(true) } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load notes.') })
    return () => { cancelled = true }
  }, [staffId])

  async function save() {
    setSaving(true); setError('')
    try {
      await saveManagerNotes(staffId, notes || null, actorId)
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save notes.')
    } finally { setSaving(false) }
  }

  return (
    <div className="bg-white rounded-xl shadow-card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest">Manager Notes</p>
        <span className="text-xs text-brown-faint italic">Private — only visible to HR and managers</span>
      </div>
      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{error}</p>}
      <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} disabled={!loaded}
        placeholder="Performance notes, observations, development feedback…"
        className={`${inputCls} resize-none mb-3`} />
      <button onClick={save} disabled={saving || !loaded}
        className={`text-xs px-3 py-1.5 rounded-lg border transition-colors font-medium ${
          saved ? 'bg-[#EBF5EE] text-[#3D7A50] border-[#5B9E6A30]'
                : 'border-[#8B634440] text-[#8B6344] bg-[#8B634408] hover:bg-[#8B634418]'
        }`}>
        {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save Notes'}
      </button>
    </div>
  )
}

function EmploymentStatusCard({ staff, onSetStatus }: { staff: Staff; onSetStatus: (s: 'active' | 'resigned') => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const resigned = staff.status === 'resigned'

  async function apply(next: 'active' | 'resigned') {
    setBusy(true); setError('')
    try {
      await onSetStatus(next)
      setConfirming(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update status. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-card p-5">
      <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest mb-4">Employment Status</p>
      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{error}</p>
      )}
      {resigned ? (
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-brown-dark">
              {staff.name} is <span className="text-[#9E4A30] font-semibold">Resigned</span>
            </p>
            <p className="text-xs text-brown-muted mt-0.5">
              Hidden from scheduling and blocked from logging in. All historical records are kept.
            </p>
          </div>
          <button onClick={() => apply('active')} disabled={busy}
            className="shrink-0 text-xs text-[#3D7A50] border border-[#5B9E6A40] bg-[#5B9E6A0C] hover:bg-[#5B9E6A18] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap disabled:opacity-50">
            {busy ? 'Reactivating…' : 'Reactivate'}
          </button>
        </div>
      ) : !confirming ? (
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-brown-dark">Active employee</p>
            <p className="text-xs text-brown-muted mt-0.5">
              Mark as resigned to remove from scheduling and block login. Records are retained and can be restored anytime.
            </p>
          </div>
          <button onClick={() => setConfirming(true)}
            className="shrink-0 text-xs text-[#9E4A30] border border-[#C0624235] bg-[#C0624208] hover:bg-[#C0624218] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap">
            Mark as Resigned
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-brown-dark">
            Mark <strong>{staff.name}</strong> as resigned? They'll disappear from scheduling and won't be able to log in. You can reactivate them later — no data is deleted.
          </p>
          <div className="flex gap-2">
            <button onClick={() => apply('resigned')} disabled={busy}
              className="text-xs bg-[#C06242] hover:bg-[#A85030] text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50">
              {busy ? 'Saving…' : 'Yes, Mark as Resigned'}
            </button>
            <button onClick={() => setConfirming(false)}
              className="text-xs text-brown-muted hover:text-brown-dark px-3 py-2 transition-colors">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

function DangerZoneCard({ staff, onReset }: { staff: Staff; onReset: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [resetting, setResetting]   = useState(false)
  const [error, setError]           = useState('')

  async function doReset() {
    setResetting(true); setError('')
    try {
      await onReset()
      setConfirming(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset progress. Please try again.')
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-card p-5 border border-[#C0624218]">
      <p className="text-xs font-semibold text-[#9E4A30] uppercase tracking-widest mb-4">Danger Zone</p>
      {!confirming ? (
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-brown-dark">Reset Progress</p>
            <p className="text-xs text-brown-muted mt-0.5">
              Clears all XP, resets level to 1, and deletes all mission completions for {staff.name}.
            </p>
          </div>
          <button onClick={() => setConfirming(true)}
            className="shrink-0 text-xs text-[#9E4A30] border border-[#C0624235] bg-[#C0624208] hover:bg-[#C0624218] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap">
            Reset
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-brown-dark">
            Are you sure? This will permanently erase <strong>{staff.name}'s</strong> XP, level, and all mission history. This cannot be undone.
          </p>
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex gap-2">
            <button onClick={doReset} disabled={resetting}
              className="text-xs bg-[#C06242] hover:bg-[#A85030] text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50">
              {resetting ? 'Resetting…' : 'Yes, Reset Everything'}
            </button>
            <button onClick={() => setConfirming(false)}
              className="text-xs text-brown-muted hover:text-brown-dark px-3 py-2 transition-colors">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── History Tab ──────────────────────────────────────────────────────────────

function HistoryTab({ completions }: { completions: MissionCompletion[] }) {
  const sorted = [...(completions ?? [])].filter(Boolean)
    .sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())

  if (sorted.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-card px-5 py-8 text-center">
        <p className="text-brown-muted text-sm">No mission history yet.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {sorted.map(c => {
        const mission = c.mission as Mission | undefined
        return (
          <div key={c.id} className="bg-white rounded-xl shadow-card px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-brown-dark">{mission?.title ?? '—'}</p>
                <p className="text-xs text-brown-faint mt-0.5">
                  {new Date(c.completed_at).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
                {c.photo_url && (
                  <button onClick={() => window.open(c.photo_url!, '_blank')}
                    className="text-xs text-[#2E6E9E] hover:underline mt-1 block">📷 View proof photo</button>
                )}
                {c.supervisor_note && (
                  <p className="text-xs text-brown-muted mt-1.5 italic border-l-2 border-border pl-2">{c.supervisor_note}</p>
                )}
              </div>
              <StatusPill status={c.status} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Shared small components ──────────────────────────────────────────────────

export function VerificationTag({ type }: { type: VerificationType }) {
  const config = VERIFICATION_CONFIG[type]
  if (!config) return null
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${config.style}`}>{config.label}</span>
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    approved: 'text-[#3D7A50] bg-[#5B9E6A12] border-[#5B9E6A35]',
    pending:  'text-[#C4813A] bg-[#C4813A10] border-[#C4813A35]',
    rejected: 'text-[#9E4A30] bg-[#C0624210] border-[#C0624235]',
  }
  return (
    <span className={`shrink-0 text-xs px-2.5 py-0.5 rounded-full border capitalize ${styles[status] ?? 'text-brown-muted border-border'}`}>
      {status}
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="type-eyebrow text-[11px] text-brown-brand mb-3">{children}</p>
}
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="type-eyebrow text-[11px] text-brown-brand">{children}</p>
}
function InfoRow({ label, value, note, multiline }: { label: string; value: string; note?: string; multiline?: boolean }) {
  return (
    <div className={`flex gap-3 ${multiline ? 'items-start' : 'items-center'}`}>
      <span className="text-xs text-brown-faint w-28 shrink-0 pt-0.5">{label}</span>
      <div className="min-w-0 flex-1">
        <span className="text-sm text-brown-dark break-words">{value}</span>
        {note && <span className="text-xs text-brown-faint ml-2 italic">({note})</span>}
      </div>
    </div>
  )
}

const labelCls = 'block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase'
const inputCls = 'w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all'

function PIInputRow({ label, value, onChange, placeholder = '', type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className={`${inputCls} placeholder-brown-faint`} />
    </div>
  )
}
function PITextareaRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={2} className={`${inputCls} resize-none`} />
    </div>
  )
}
function PISelectRow({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  // Include the current value even if it isn't in the option list, so the select
  // stays pre-filled instead of falling back to "— Select —".
  const opts = value && !options.includes(value) ? [value, ...options] : options
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} className={inputCls}>
        <option value="">— Select —</option>
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}

function PISelectRowKV({ label, value, options, onChange }: {
  label: string; value: string; options: { slug: string; name: string }[]; onChange: (v: string) => void
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} className={inputCls}>
        <option value="">— Select —</option>
        {options.map(o => <option key={o.slug} value={o.slug}>{o.name}</option>)}
      </select>
    </div>
  )
}
