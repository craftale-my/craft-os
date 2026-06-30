import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import type { Staff, ProbationReview } from '../../shared/types'
import { PROBATION_CHECKLIST, getProbationDay, RANK_LABELS } from '../../shared/types'
import { Avatar } from '../../shared/components/Avatar'

type Checks = Record<string, boolean | null>
type CL = typeof PROBATION_CHECKLIST

interface Day1Data { attitude: Checks; communication: Checks; elimination: Checks }
interface Day2Data { process: Checks; serving: Checks; elimination: Checks }
interface Day3Data { attitude: Checks; performance: Checks }

function initChecks(items: readonly { key: string }[], src: Record<string, boolean>): Checks {
  return Object.fromEntries(items.map(it => [it.key, it.key in src ? src[it.key] : null]))
}

function anyTriggered(checks: Checks): boolean {
  return Object.values(checks).some(v => v === true)
}

function emptyDay1(CL: CL): Day1Data {
  return {
    attitude: initChecks(CL.day1.attitude, {}),
    communication: initChecks(CL.day1.communication, {}),
    elimination: initChecks(CL.day1.elimination, {}),
  }
}
function emptyDay2(CL: CL): Day2Data {
  return {
    process: initChecks(CL.day2.process, {}),
    serving: initChecks(CL.day2.serving, {}),
    elimination: initChecks(CL.day2.elimination, {}),
  }
}
function emptyDay3(CL: CL): Day3Data {
  return {
    attitude: initChecks(CL.day3.attitude, {}),
    performance: initChecks(CL.day3.performance, {}),
  }
}

// ─── CheckToggle ──────────────────────────────────────────────────────────────

function CheckToggle({
  value, onChange, disabled,
}: { value: boolean | null; onChange: (v: boolean | null) => void; disabled?: boolean }) {
  return (
    <div className="flex gap-1.5 flex-shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(value === true ? null : true)}
        className={`w-9 h-9 rounded-xl text-sm font-bold transition-all flex items-center justify-center select-none ${
          value === true
            ? 'bg-[#3D7A50] text-white shadow-sm'
            : 'bg-[#F0EDE8] text-[#B0A090] hover:bg-[#EBF5EE] hover:text-[#3D7A50]'
        } ${disabled ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}
      >✔</button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(value === false ? null : false)}
        className={`w-9 h-9 rounded-xl text-sm font-bold transition-all flex items-center justify-center select-none ${
          value === false
            ? 'bg-[#9E4A30] text-white shadow-sm'
            : 'bg-[#F0EDE8] text-[#B0A090] hover:bg-[#FCF0EC] hover:text-[#9E4A30]'
        } ${disabled ? 'opacity-50 pointer-events-none' : 'cursor-pointer'}`}
      >✘</button>
    </div>
  )
}

// ─── CheckItem ────────────────────────────────────────────────────────────────

function CheckItem({
  label, sub, value, onChange, disabled, red = false,
}: {
  label: string; sub?: string; value: boolean | null
  onChange: (v: boolean | null) => void; disabled?: boolean; red?: boolean
}) {
  const triggered = red && value === true
  return (
    <div className={`flex items-center justify-between gap-3 py-2.5 px-3 rounded-xl transition-colors ${
      triggered ? 'bg-[#FCE8E2]' : ''
    }`}>
      <div className="flex-1 min-w-0">
        <p className={`text-sm leading-snug ${red ? 'text-[#9E4A30]' : 'text-brown-dark'}`}>{label}</p>
        {sub && <p className="text-xs text-brown-faint mt-0.5">{sub}</p>}
      </div>
      <CheckToggle value={value} onChange={onChange} disabled={disabled} />
    </div>
  )
}

// ─── Section ─────────────────────────────────────────────────────────────────

function Section({
  title, emoji, items, checks, onChange, disabled,
}: {
  title: string; emoji: string
  items: readonly { key: string; label: string; sub?: string }[]
  checks: Checks
  onChange: (key: string, v: boolean | null) => void
  disabled?: boolean
}) {
  const passed = Object.values(checks).filter(v => v === true).length
  return (
    <div className="bg-white rounded-2xl border border-[#E8DDD0] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#EDE5D8] bg-[#FAF7F3]">
        <h4 className="text-sm font-bold text-brown-dark">{emoji} {title}</h4>
        <span className="text-xs text-brown-faint font-medium">{passed}/{items.length} ✔</span>
      </div>
      <div className="p-2 space-y-0.5">
        {items.map(item => (
          <CheckItem
            key={item.key}
            label={item.label}
            sub={'sub' in item ? item.sub : undefined}
            value={checks[item.key] ?? null}
            onChange={v => onChange(item.key, v)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  )
}

// ─── EliminationSection ───────────────────────────────────────────────────────

function EliminationSection({
  items, checks, onChange, disabled,
}: {
  items: readonly { key: string; label: string }[]
  checks: Checks
  onChange: (key: string, v: boolean | null) => void
  disabled?: boolean
}) {
  const count = Object.values(checks).filter(v => v === true).length
  return (
    <div className="rounded-2xl border border-[#E89A8080] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#E89A8040] bg-[#FEF3F0]">
        <h4 className="text-sm font-bold text-[#9E4A30]">⚠️ 淘汰标准 Elimination Criteria</h4>
        {count > 0 && (
          <span className="text-xs bg-[#9E4A30] text-white px-2 py-0.5 rounded-full font-semibold">
            {count} flagged
          </span>
        )}
      </div>
      {count > 0 && (
        <div className="px-4 py-2.5 bg-[#FCE8E2] border-b border-[#E89A8040]">
          <p className="text-xs text-[#9E4A30] font-semibold">
            ⛔ Elimination criteria triggered — consider stopping probation now.
          </p>
        </div>
      )}
      <div className="bg-[#FEF9F8] p-2 space-y-0.5">
        {items.map(item => (
          <CheckItem
            key={item.key}
            label={item.label}
            value={checks[item.key] ?? null}
            onChange={v => onChange(item.key, v)}
            disabled={disabled}
            red
          />
        ))}
      </div>
    </div>
  )
}

// ─── ResultArea ───────────────────────────────────────────────────────────────

function ResultArea({
  day, done, result, hasElimination, confirmEliminate, setConfirmEliminate,
  onSubmit, saving, notes, setNotes,
}: {
  day: 1 | 2 | 3
  done: boolean
  result: string | null
  hasElimination: boolean
  confirmEliminate: boolean
  setConfirmEliminate: (v: boolean) => void
  onSubmit: (result: string) => void
  saving: boolean
  notes: string
  setNotes: (v: string) => void
}) {
  if (done) {
    const isElim = result === 'eliminate'
    const isHire = result === 'hire'
    return (
      <div className={`px-4 py-3.5 rounded-xl border flex items-center gap-3 ${
        isElim ? 'bg-[#FCF0EC] border-[#C0624240]' :
        isHire ? 'bg-[#EBF5EE] border-[#5B9E6A40]' :
        'bg-[#EBF5EE] border-[#5B9E6A40]'
      }`}>
        <span className="text-xl">{isElim ? '❌' : isHire ? '🎉' : '✅'}</span>
        <p className={`text-sm font-bold ${isElim ? 'text-[#9E4A30]' : 'text-[#3D7A50]'}`}>
          {isElim
            ? `Eliminated on Day ${day}`
            : isHire
            ? 'Hired — Probation Passed!'
            : `Day ${day} passed — continues to Day ${day + 1}`}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3 pt-2">
      <div>
        <label className="block text-xs font-semibold text-brown-medium mb-1.5">
          Supervisor Notes (optional)
        </label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Any observations or context for today..."
          rows={2}
          className="w-full px-3 py-2.5 rounded-xl border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40] resize-none"
        />
      </div>

      {hasElimination && !confirmEliminate && (
        <div className="px-4 py-3 bg-[#FCE8E2] border border-[#C0624240] rounded-xl">
          <p className="text-xs text-[#9E4A30] font-semibold">
            ⛔ Elimination criteria detected — review carefully before deciding.
          </p>
        </div>
      )}

      {!confirmEliminate ? (
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => onSubmit(day === 3 ? 'hire' : 'continue')}
            disabled={saving}
            className="py-3.5 rounded-xl bg-[#3D7A50] text-white text-sm font-bold hover:bg-[#2E6040] transition-colors disabled:opacity-60 leading-tight"
          >
            {saving ? '…'
              : day === 3 ? '✓ Hire'
              : `Continue →\nDay ${day + 1}`}
          </button>
          <button
            onClick={() => setConfirmEliminate(true)}
            disabled={saving}
            className="py-3.5 rounded-xl border-2 border-[#9E4A30] text-[#9E4A30] text-sm font-bold hover:bg-[#FCF0EC] transition-colors disabled:opacity-60"
          >
            {day === 3 ? '✗ Not Suitable' : 'Eliminate'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="px-4 py-3 bg-[#FCE8E2] border border-[#C06242] rounded-xl">
            <p className="text-sm font-bold text-[#9E4A30] mb-0.5">Confirm Elimination?</p>
            <p className="text-xs text-[#9E4A30]">
              This will end the probation. The staff record will be marked inactive.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setConfirmEliminate(false)}
              className="py-3 rounded-xl border border-[#D4C5B0] text-sm font-medium text-brown-medium hover:bg-[#F5EDE0] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onSubmit('eliminate')}
              disabled={saving}
              className="py-3 rounded-xl bg-[#9E4A30] text-white text-sm font-bold hover:bg-[#7E3820] transition-colors disabled:opacity-60"
            >
              {saving ? '…' : '⛔ Confirm'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Day progress indicator ───────────────────────────────────────────────────

function DayProgress({
  review, activeDay, setActiveDay,
}: {
  review: ProbationReview
  activeDay: 1 | 2 | 3
  setActiveDay: (d: 1 | 2 | 3) => void
}) {
  const days = [1, 2, 3] as const
  const results = [review.day1_result, review.day2_result, review.day3_result]
  const locked = [false, review.day1_result !== 'continue', review.day2_result !== 'continue']

  return (
    <div className="flex items-center justify-center gap-0 mb-6 bg-white rounded-2xl border border-[#E8DDD0] p-4">
      {days.map((d, i) => {
        const result = results[i]
        const isLocked = locked[i]
        const isActive = activeDay === d
        const isElim = result === 'eliminate'
        const isDone = result != null

        return (
          <div key={d} className="flex items-center flex-1">
            <button
              onClick={() => { if (!isLocked) setActiveDay(d) }}
              disabled={isLocked}
              className={`flex flex-col items-center gap-1.5 flex-shrink-0 px-3 py-2 rounded-xl w-full transition-all ${
                isLocked ? 'opacity-35 cursor-default' : 'cursor-pointer hover:bg-[#FAF6F1]'
              } ${isActive ? 'bg-[#FEF3E2]' : ''}`}
            >
              <div className={`w-11 h-11 rounded-full flex items-center justify-center text-base font-bold transition-all ${
                isElim ? 'bg-[#9E4A30] text-white' :
                isDone ? 'bg-[#3D7A50] text-white' :
                isActive ? 'bg-[#C4813A] text-white' :
                'bg-[#EDE5D8] text-brown-medium'
              }`}>
                {isElim ? '✗' : isDone ? '✓' : d}
              </div>
              <span className={`text-xs font-semibold ${isActive ? 'text-[#C4813A]' : 'text-brown-faint'}`}>
                Day {d}
              </span>
              {result && (
                <span className={`text-xs leading-none ${isElim ? 'text-[#9E4A30]' : 'text-[#3D7A50]'}`}>
                  {isElim ? 'Eliminated' : result === 'hire' ? 'Hired' : 'Passed'}
                </span>
              )}
            </button>
            {i < 2 && (
              <div className={`flex-none w-6 h-0.5 rounded ${
                results[i] === 'continue' ? 'bg-[#3D7A50]' : 'bg-[#EDE5D8]'
              }`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ProbationReviewPage() {
  const { staffId } = useParams<{ staffId: string }>()
  const navigate = useNavigate()
  const CL = PROBATION_CHECKLIST

  const [staff, setStaff] = useState<Staff | null>(null)
  const [review, setReview] = useState<ProbationReview | null>(null)
  const [currentUser, setCurrentUser] = useState<Staff | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeDay, setActiveDay] = useState<1 | 2 | 3>(1)
  const [saving, setSaving] = useState(false)
  const [confirmEliminate, setConfirmEliminate] = useState(false)
  const [notes, setNotes] = useState('')

  const [day1, setDay1] = useState<Day1Data>(() => emptyDay1(CL))
  const [day2, setDay2] = useState<Day2Data>(() => emptyDay2(CL))
  const [day3, setDay3] = useState<Day3Data>(() => emptyDay3(CL))

  useEffect(() => { if (staffId) loadData() }, [staffId])

  async function loadData() {
    setLoading(true)
    const [{ data: authData }, { data: staffData }, { data: reviewData }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from('staff').select('*').eq('id', staffId!).single(),
      supabase
        .from('probation_reviews')
        .select('*')
        .eq('staff_id', staffId!)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    if (authData.user) {
      const { data: me } = await supabase.from('staff').select('*').eq('id', authData.user.id).single()
      if (me) setCurrentUser(me)
    }
    if (staffData) setStaff(staffData as Staff)
    if (reviewData) applyReview(reviewData as ProbationReview)
    setLoading(false)
  }

  function applyReview(r: ProbationReview) {
    setReview(r)
    setNotes(r.supervisor_notes ?? '')
    setDay1({
      attitude: initChecks(CL.day1.attitude, r.day1_attitude),
      communication: initChecks(CL.day1.communication, r.day1_communication),
      elimination: initChecks(CL.day1.elimination, r.day1_elimination),
    })
    setDay2({
      process: initChecks(CL.day2.process, r.day2_process),
      serving: initChecks(CL.day2.serving, r.day2_serving),
      elimination: initChecks(CL.day2.elimination, r.day2_elimination),
    })
    setDay3({
      attitude: initChecks(CL.day3.attitude, r.day3_attitude),
      performance: initChecks(CL.day3.performance, r.day3_performance),
    })
    if (!r.day1_result) setActiveDay(1)
    else if (r.day1_result === 'continue' && !r.day2_result) setActiveDay(2)
    else if (r.day2_result === 'continue' && !r.day3_result) setActiveDay(3)
    else setActiveDay(r.day3_result ? 3 : r.day2_result ? 2 : 1)
  }

  async function handleStartReview() {
    setSaving(true)
    const { data, error } = await supabase
      .from('probation_reviews')
      .insert({
        staff_id: staffId,
        reviewer_id: currentUser?.id,
        start_date: new Date().toISOString().split('T')[0],
      })
      .select()
      .single()
    setSaving(false)
    if (!error && data) applyReview(data as ProbationReview)
  }

  function cleanChecks(c: Checks): Record<string, boolean> {
    return Object.fromEntries(
      Object.entries(c).filter(([, v]) => v !== null) as [string, boolean][]
    )
  }

  async function submitDay(result: string) {
    if (!review) return
    setSaving(true)
    setConfirmEliminate(false)
    const eliminated = result === 'eliminate'
    const hired = result === 'hire'

    let update: Record<string, unknown> = { supervisor_notes: notes || null }

    if (activeDay === 1) {
      Object.assign(update, {
        day1_attitude: cleanChecks(day1.attitude),
        day1_communication: cleanChecks(day1.communication),
        day1_elimination: cleanChecks(day1.elimination),
        day1_result: result,
        day1_completed_at: new Date().toISOString(),
        ...(eliminated ? { overall_result: 'eliminated' } : {}),
      })
    } else if (activeDay === 2) {
      Object.assign(update, {
        day2_process: cleanChecks(day2.process),
        day2_serving: cleanChecks(day2.serving),
        day2_elimination: cleanChecks(day2.elimination),
        day2_result: result,
        day2_completed_at: new Date().toISOString(),
        ...(eliminated ? { overall_result: 'eliminated' } : {}),
      })
    } else {
      Object.assign(update, {
        day3_attitude: cleanChecks(day3.attitude),
        day3_performance: cleanChecks(day3.performance),
        day3_result: result,
        day3_completed_at: new Date().toISOString(),
        overall_result: hired ? 'hired' : 'eliminated',
      })
    }

    await supabase.from('probation_reviews').update(update).eq('id', review.id)
    if (eliminated) await supabase.from('staff').update({ is_active: false }).eq('id', staffId!)
    if (hired) await supabase.from('staff').update({ onboarding_completed: true }).eq('id', staffId!)

    setSaving(false)
    loadData()
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream-light">
        <p className="text-brown-medium animate-pulse">Loading…</p>
      </div>
    )
  }
  if (!staff) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream-light">
        <p className="text-brown-medium">Staff not found.</p>
      </div>
    )
  }

  const day1Done = !!review?.day1_result
  const day2Done = !!review?.day2_result
  const day3Done = !!review?.day3_result
  const overallDone = !!review?.overall_result

  const currentDayElimination =
    activeDay === 1 ? anyTriggered(day1.elimination) :
    activeDay === 2 ? anyTriggered(day2.elimination) : false

  const activeDayResult =
    activeDay === 1 ? review?.day1_result :
    activeDay === 2 ? review?.day2_result :
    review?.day3_result

  const probationDay = review ? getProbationDay(review.start_date) : 1

  return (
    <div className="min-h-screen bg-cream-light pb-16">
      <div className="max-w-xl mx-auto px-4 py-6">

        {/* Back */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1 text-sm text-brown-faint hover:text-brown-dark mb-5 transition-colors"
        >
          ← Back
        </button>

        {/* Staff card */}
        <div className="bg-white rounded-2xl border border-[#E8DDD0] p-5 mb-5">
          <div className="flex items-center gap-4">
            <Avatar name={staff.name} avatar={staff.avatar} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-0.5">
                <h1 className="font-bold text-brown-dark text-lg leading-snug">{staff.name}</h1>
              </div>
              <p className="text-sm text-brown-faint">
                {RANK_LABELS[staff.rank]} · {staff.branch ?? 'No branch'}
              </p>
              {review && !overallDone && (
                <p className="text-xs text-[#C4813A] mt-1.5 font-medium">
                  🌱 Probation Day {probationDay} of 3 · Started{' '}
                  {new Date(review.start_date).toLocaleDateString('en-MY', {
                    day: 'numeric', month: 'short', year: 'numeric',
                  })}
                </p>
              )}
            </div>
          </div>

          {/* Overall result banner */}
          {overallDone && (
            <div className={`mt-4 px-4 py-3 rounded-xl flex items-center gap-3 ${
              review?.overall_result === 'hired'
                ? 'bg-[#EBF5EE] border border-[#5B9E6A40]'
                : 'bg-[#FCF0EC] border border-[#C0624240]'
            }`}>
              <span className="text-2xl">{review?.overall_result === 'hired' ? '🎉' : '❌'}</span>
              <div>
                <p className={`font-bold text-sm ${
                  review?.overall_result === 'hired' ? 'text-[#3D7A50]' : 'text-[#9E4A30]'
                }`}>
                  {review?.overall_result === 'hired'
                    ? 'Hired — Probation Passed!'
                    : 'Eliminated — Probation Failed'}
                </p>
                {review?.supervisor_notes && (
                  <p className="text-xs text-brown-faint mt-0.5 italic">"{review.supervisor_notes}"</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* No review yet */}
        {!review && (
          <div className="bg-white rounded-2xl border border-[#E8DDD0] p-8 text-center">
            <p className="text-4xl mb-3">🌱</p>
            <h2 className="font-bold text-brown-dark text-base mb-2">
              Start 3-Day Probation Review
            </h2>
            <p className="text-sm text-brown-faint mb-6 leading-relaxed">
              This begins the probation clock from today. Fill in the checklist at the end of each working day.
            </p>
            <button
              onClick={handleStartReview}
              disabled={saving}
              className="px-8 py-3 bg-[#C4813A] text-white rounded-xl font-semibold text-sm hover:bg-[#A86C2C] transition-colors disabled:opacity-60"
            >
              {saving ? 'Starting…' : 'Start Probation Review'}
            </button>
          </div>
        )}

        {/* Review in progress */}
        {review && (
          <>
            <DayProgress review={review} activeDay={activeDay} setActiveDay={setActiveDay} />

            {/* Day 1 */}
            {activeDay === 1 && (
              <div className="space-y-4">
                <div className="mb-1">
                  <p className="text-xs font-bold text-brown-faint uppercase tracking-wider">Day 1</p>
                  <h2 className="text-base font-bold text-brown-dark mt-0.5">观察期 · Attitude & Basic Response</h2>
                  <p className="text-xs text-brown-faint">Core: 态度 &gt; 能力</p>
                </div>
                <Section
                  title="工作态度 Attitude" emoji="😊"
                  items={CL.day1.attitude}
                  checks={day1.attitude}
                  onChange={(k, v) => setDay1(d => ({ ...d, attitude: { ...d.attitude, [k]: v } }))}
                  disabled={day1Done}
                />
                <Section
                  title="沟通与学习 Communication" emoji="💬"
                  items={CL.day1.communication}
                  checks={day1.communication}
                  onChange={(k, v) => setDay1(d => ({ ...d, communication: { ...d.communication, [k]: v } }))}
                  disabled={day1Done}
                />
                <EliminationSection
                  items={CL.day1.elimination}
                  checks={day1.elimination}
                  onChange={(k, v) => setDay1(d => ({ ...d, elimination: { ...d.elimination, [k]: v } }))}
                  disabled={day1Done}
                />
                <ResultArea
                  day={1} done={day1Done} result={activeDayResult ?? null}
                  hasElimination={currentDayElimination}
                  confirmEliminate={confirmEliminate} setConfirmEliminate={setConfirmEliminate}
                  onSubmit={submitDay} saving={saving}
                  notes={notes} setNotes={setNotes}
                />
              </div>
            )}

            {/* Day 2 */}
            {activeDay === 2 && (
              <div className="space-y-4">
                <div className="mb-1">
                  <p className="text-xs font-bold text-brown-faint uppercase tracking-wider">Day 2</p>
                  <h2 className="text-base font-bold text-brown-dark mt-0.5">执行力 & 学习能力</h2>
                  <p className="text-xs text-brown-faint">Core: 会不会做 + 会不会改</p>
                </div>
                <Section
                  title="流程执行 Process" emoji="📋"
                  items={CL.day2.process}
                  checks={day2.process}
                  onChange={(k, v) => setDay2(d => ({ ...d, process: { ...d.process, [k]: v } }))}
                  disabled={day2Done}
                />
                <Section
                  title="出餐相关 Serving" emoji="🍽️"
                  items={CL.day2.serving}
                  checks={day2.serving}
                  onChange={(k, v) => setDay2(d => ({ ...d, serving: { ...d.serving, [k]: v } }))}
                  disabled={day2Done}
                />
                <EliminationSection
                  items={CL.day2.elimination}
                  checks={day2.elimination}
                  onChange={(k, v) => setDay2(d => ({ ...d, elimination: { ...d.elimination, [k]: v } }))}
                  disabled={day2Done}
                />
                <ResultArea
                  day={2} done={day2Done} result={activeDayResult ?? null}
                  hasElimination={currentDayElimination}
                  confirmEliminate={confirmEliminate} setConfirmEliminate={setConfirmEliminate}
                  onSubmit={submitDay} saving={saving}
                  notes={notes} setNotes={setNotes}
                />
              </div>
            )}

            {/* Day 3 */}
            {activeDay === 3 && (
              <div className="space-y-4">
                <div className="mb-1">
                  <p className="text-xs font-bold text-brown-faint uppercase tracking-wider">Day 3</p>
                  <h2 className="text-base font-bold text-brown-dark mt-0.5">稳定度 & 团队适配</h2>
                  <p className="text-xs text-brown-faint">Core: 适不适合留下</p>
                </div>
                <Section
                  title="工作态度 Attitude" emoji="🌟"
                  items={CL.day3.attitude}
                  checks={day3.attitude}
                  onChange={(k, v) => setDay3(d => ({ ...d, attitude: { ...d.attitude, [k]: v } }))}
                  disabled={day3Done}
                />
                <Section
                  title="工作表现 Performance" emoji="⚡"
                  items={CL.day3.performance}
                  checks={day3.performance}
                  onChange={(k, v) => setDay3(d => ({ ...d, performance: { ...d.performance, [k]: v } }))}
                  disabled={day3Done}
                />
                <ResultArea
                  day={3} done={day3Done} result={activeDayResult ?? null}
                  hasElimination={false}
                  confirmEliminate={confirmEliminate} setConfirmEliminate={setConfirmEliminate}
                  onSubmit={submitDay} saving={saving}
                  notes={notes} setNotes={setNotes}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
