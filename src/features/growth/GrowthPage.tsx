import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import type {
  Staff, Mission, MissionCompletion, CareerPath, Skill, SkillAssessment, SkillAssessmentStatus,
} from '../../shared/types'
import { SKILL_STATUS_LABELS, SKILL_STATUS_COLORS, SKILL_STATUS_ICONS } from '../../shared/types'
import { MissionsTab } from '../staff/StaffProfile'
import { MissionsPage } from '../missions/Missions'

type GrowthTab = 'career' | 'missions' | 'manage'

// ─── Career Progress (skill matrix — gates promotion) ─────────────────────────

function CareerProgress({ staff }: { staff: Staff }) {
  const [path, setPath] = useState<CareerPath | null>(null)
  const [assessments, setAssessments] = useState<SkillAssessment[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!staff.job_title_id) { setPath(null); setLoading(false); return }
    const [pathRes, saRes] = await Promise.all([
      supabase
        .from('career_paths')
        .select('*, from:roles!career_paths_from_job_title_id_fkey(*), to:roles!career_paths_to_job_title_id_fkey(*), skills(*)')
        .eq('from_job_title_id', staff.job_title_id)
        .eq('status', 'active')
        .maybeSingle(),
      supabase
        .from('skill_assessments')
        .select('*, assessor:staff!skill_assessments_assessed_by_fkey(id,name)')
        .eq('staff_id', staff.id),
    ])
    setPath((pathRes.data as CareerPath | null) ?? null)
    setAssessments((saRes.data as SkillAssessment[]) ?? [])
    setLoading(false)
  }, [staff.id, staff.job_title_id])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-7 h-7 rounded-full border-2 border-[#8B6344] border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!staff.job_title_id) {
    return (
      <div className="bg-white rounded-xl shadow-card px-5 py-10 text-center">
        <p className="text-2xl mb-2">🧭</p>
        <p className="text-sm font-semibold text-brown-dark">No job title assigned yet</p>
        <p className="text-xs text-brown-muted mt-1">Ask your manager to assign your job title to unlock your career path.</p>
      </div>
    )
  }

  if (!path) {
    return (
      <div className="bg-white rounded-xl shadow-card px-5 py-10 text-center">
        <p className="text-2xl mb-2">🏔️</p>
        <p className="text-sm font-semibold text-brown-dark">No promotion path from your current title</p>
        <p className="text-xs text-brown-muted mt-1">
          Either you're at the top of your ladder, or the next segment hasn't been configured yet.
        </p>
      </div>
    )
  }

  const activeSkills = [...(path.skills ?? [])]
    .filter(s => s.status === 'active')
    .sort((a, b) => a.sort_order - b.sort_order)
  const byStaffSkill = new Map(assessments.map(a => [a.skill_id, a]))
  const passedCount = activeSkills.filter(s => byStaffSkill.get(s.id)?.status === 'passed').length
  const total = activeSkills.length
  const allPassed = total > 0 && passedCount === total
  const pct = total > 0 ? Math.round((passedCount / total) * 100) : 0

  async function startLearning(skill: Skill, existing: SkillAssessment | undefined) {
    setBusy(skill.id); setError('')
    try {
      // A row may not exist yet (e.g. skill added after initialization) — the
      // initialization RPC backfills missing rows for the current path.
      if (!existing) {
        const { error: rpcErr } = await supabase.rpc('initialize_staff_skills', { p_staff_id: staff.id })
        if (rpcErr) throw rpcErr
      }
      const { error: err } = await supabase.from('skill_assessments')
        .update({ status: 'learning', updated_at: new Date().toISOString() })
        .eq('staff_id', staff.id).eq('skill_id', skill.id)
        .in('status', ['not_started', 'failed'])
      if (err) throw err
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  async function requestReview(skill: Skill) {
    setBusy(skill.id); setError('')
    try {
      const { error: err } = await supabase.from('skill_assessments')
        .update({ status: 'pending_review', updated_at: new Date().toISOString() })
        .eq('staff_id', staff.id).eq('skill_id', skill.id).eq('status', 'learning')
      if (err) throw err
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  function fmtDate(iso: string | null): string {
    if (!iso) return ''
    return new Date(iso).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  return (
    <div className="space-y-4">
      {/* Promotion progress card */}
      <div className="bg-white rounded-2xl shadow-card p-5">
        <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest mb-3">Promotion Progress</p>
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <span className="text-sm font-bold text-brown-dark">{path.from?.name ?? 'Current'}</span>
          <span className="text-brown-faint">→</span>
          <span className="text-sm font-bold text-[#C4813A]">{path.to?.name ?? 'Next'}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2.5 bg-[#EDE5D8] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: allPassed ? '#3D7A50' : '#C4813A' }}
            />
          </div>
          <span className="text-sm font-bold text-brown-dark shrink-0">{passedCount} / {total}</span>
        </div>
        <p className="text-xs text-brown-faint mt-1.5">skills passed</p>

        {allPassed && (
          <div className="mt-4 bg-[#EBF5EE] border border-[#5B9E6A40] rounded-xl px-4 py-3 flex items-center gap-3">
            <span className="text-xl">🎉</span>
            <div>
              <p className="text-sm font-bold text-[#2E5E3A]">Eligible for promotion!</p>
              <p className="text-xs text-[#3D7A50]">All skills passed — awaiting manager evaluation.</p>
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

      {/* Skill checklist */}
      <div className="bg-white rounded-xl shadow-card divide-y divide-[#F0E8DC]">
        {activeSkills.map(skill => {
          const a = byStaffSkill.get(skill.id)
          const status: SkillAssessmentStatus = a?.status ?? 'not_started'
          const color = SKILL_STATUS_COLORS[status]
          const isBusy = busy === skill.id
          return (
            <div key={skill.id} className="px-4 py-3.5">
              <div className="flex items-start gap-3">
                <span className="text-lg leading-6 flex-shrink-0">{SKILL_STATUS_ICONS[status]}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-brown-dark">
                    {skill.name}
                    {skill.name_zh && <span className="font-normal text-brown-faint ml-2">{skill.name_zh}</span>}
                  </p>
                  {skill.description && (
                    <p className="text-xs text-brown-muted mt-0.5">{skill.description}</p>
                  )}
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span
                      className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: `${color}18`, color }}
                    >
                      {SKILL_STATUS_LABELS[status]}
                    </span>
                    <span className="text-xs text-[#C4813A] font-semibold">+{skill.xp_reward} XP</span>
                    {status === 'passed' && a && (
                      <span className="text-[11px] text-brown-faint">
                        by {a.assessor?.name ?? '—'} · {fmtDate(a.assessed_at)}
                      </span>
                    )}
                  </div>
                  {status === 'failed' && a?.remarks && (
                    <p className="text-xs text-[#9E4A30] bg-[#FDF3F0] rounded-lg px-3 py-2 mt-2">
                      <span className="font-semibold">Assessor feedback:</span> {a.remarks}
                    </p>
                  )}
                </div>
                <div className="flex-shrink-0">
                  {(status === 'not_started' || status === 'failed') && (
                    <button
                      onClick={() => startLearning(skill, a)}
                      disabled={isBusy}
                      className="text-xs font-semibold text-[#2E6E9E] border border-[#4A8FBF40] bg-[#4A8FBF0C] hover:bg-[#4A8FBF18] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
                    >
                      {isBusy ? '…' : status === 'failed' ? 'Practice Again' : 'Start Learning'}
                    </button>
                  )}
                  {status === 'learning' && (
                    <button
                      onClick={() => requestReview(skill)}
                      disabled={isBusy}
                      className="text-xs font-semibold text-white bg-[#C4813A] hover:bg-[#A86C2C] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
                    >
                      {isBusy ? '…' : 'Request Review'}
                    </button>
                  )}
                  {status === 'pending_review' && (
                    <span className="text-[11px] text-brown-faint whitespace-nowrap">Awaiting review</span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
        {activeSkills.length === 0 && (
          <p className="px-4 py-8 text-xs text-brown-faint text-center">No skills configured for this path yet.</p>
        )}
      </div>
    </div>
  )
}

// ─── Page (Career Progress | Missions | Manage) ───────────────────────────────

export default function GrowthPage() {
  const { staff } = useAuth()
  const { can } = useCan()
  const [tab, setTab] = useState<GrowthTab>('career')
  const [missions, setMissions] = useState<Mission[]>([])
  const [completions, setCompletions] = useState<MissionCompletion[]>([])

  const canManage = can('manage_missions')

  const loadMissions = useCallback(async () => {
    if (!staff) return
    const [mRes, cRes] = await Promise.all([
      supabase.from('missions').select('*').order('created_at'),
      supabase.from('mission_completions').select('*, mission:missions(*)').eq('staff_id', staff.id),
    ])
    setMissions((mRes.data as Mission[]) ?? [])
    setCompletions((cRes.data as MissionCompletion[]) ?? [])
  }, [staff?.id])

  useEffect(() => { loadMissions() }, [loadMissions])

  if (!staff) return null

  const tabs: { id: GrowthTab; label: string }[] = [
    { id: 'career',   label: '🎯 Career Progress' },
    { id: 'missions', label: '⚡ Missions' },
    ...(canManage ? [{ id: 'manage' as const, label: '🛠 Manage' }] : []),
  ]

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-3xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Growth</h1>
          <p className="text-sm text-brown-faint mt-0.5">
            Career skills gate your promotion · missions earn XP and honour.
          </p>
        </div>

        <div className="flex gap-1 bg-white shadow-card rounded-xl p-1 overflow-x-auto">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 py-2 text-sm rounded-lg whitespace-nowrap px-3 transition-colors ${
                tab === t.id
                  ? 'bg-[#4A2E1A] text-[#F5F0E8] font-medium'
                  : 'text-brown-muted hover:text-brown-dark'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'career' && <CareerProgress staff={staff} />}

        {tab === 'missions' && (
          <MissionsTab
            missions={missions}
            staffId={staff.id}
            completions={completions}
            isSelf
            onRefresh={loadMissions}
          />
        )}

        {tab === 'manage' && <MissionsPage />}
      </div>
    </div>
  )
}
