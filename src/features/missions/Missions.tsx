import { useEffect, useState, FormEvent } from 'react'
import { supabase } from '../../shared/lib/supabase'
import type { Mission, MissionCategory, VerificationType } from '../../shared/types'
import { MISSION_CATEGORY_LABELS, RANK_LABELS, VERIFICATION_CONFIG } from '../../shared/types'
import type { Rank } from '../../shared/types'

export function MissionsPage() {
  const [missions, setMissions] = useState<Mission[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Mission | null>(null)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  async function reload() {
    setFetchError(null)
    try {
      const { data, error: fetchErr } = await supabase
        .from('missions')
        .select('*')
        .order('created_at')
      if (fetchErr) throw fetchErr
      setMissions((data ?? []) as Mission[])
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load missions.')
      setMissions([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reload() }, [])

  async function deleteMission(id: string) {
    if (!confirm('Delete this mission?')) return
    try {
      await supabase.from('missions').delete().eq('id', id)
      await reload()
    } catch {
      // reload will reflect state
    }
  }

  function openCreate() { setEditing(null); setShowForm(true) }
  function openEdit(m: Mission) { setEditing(m); setShowForm(true) }

  if (loading) return <PageLoader />

  if (fetchError) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center">
        <p className="text-2xl mb-2">⚠️</p>
        <p className="text-brown-dark font-semibold mb-1">Could not load missions</p>
        <p className="text-brown-muted text-sm mb-4">{fetchError}</p>
        <button
          onClick={reload}
          className="text-sm bg-brown-btn hover:bg-brown-btn-hover text-white px-4 py-2 rounded-lg transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="font-display text-2xl font-bold text-brown-dark mb-1">Missions</h1>
          <p className="text-brown-muted text-sm">Create and manage XP missions for your team</p>
        </div>
        <button
          onClick={openCreate}
          className="bg-brown-btn hover:bg-brown-btn-hover text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors shadow-sm"
        >
          + New Mission
        </button>
      </div>

      {showForm && (
        <MissionForm mission={editing} onClose={() => setShowForm(false)} onSaved={reload} />
      )}

      <div className="space-y-3">
        {missions.map(m => (
          <div
            key={m.id}
            className="bg-white rounded-xl shadow-card px-5 py-4 flex items-center justify-between gap-4"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-brown-dark">{m.title}</p>
              {m.description && (
                <p className="text-xs text-brown-muted mt-0.5 line-clamp-1">{m.description}</p>
              )}
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="text-xs text-[#C4813A] font-semibold">+{m.xp_reward} XP</span>
                {m.category && (
                  <span className="text-xs text-brown-faint">{MISSION_CATEGORY_LABELS[m.category]}</span>
                )}
                <span className="text-xs text-brown-faint">Min: {RANK_LABELS[m.min_rank]}</span>
                {m.verification_type && <VerificationPill type={m.verification_type} />}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={() => openEdit(m)}
                className="text-xs px-3 py-1.5 rounded-lg border border-border-mid text-brown-muted hover:text-brown-dark hover:border-[#B8A890] transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => deleteMission(m.id)}
                className="text-xs px-3 py-1.5 rounded-lg border border-[#C0624230] text-[#9E4A30] bg-[#C0624208] hover:bg-[#C0624218] transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {missions.length === 0 && (
          <p className="text-brown-muted text-sm">No missions yet. Create one above.</p>
        )}
      </div>
    </div>
  )
}

// ─── Mission Form ─────────────────────────────────────────────────────────────

function MissionForm({
  mission,
  onClose,
  onSaved,
}: {
  mission: Mission | null
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(mission?.title ?? '')
  const [description, setDescription] = useState(mission?.description ?? '')
  const [xpReward, setXpReward] = useState(String(mission?.xp_reward ?? 100))
  const [category, setCategory] = useState<MissionCategory | ''>(mission?.category ?? '')
  const [minRank, setMinRank] = useState<Rank>(mission?.min_rank ?? 'trainee')
  const [verificationType, setVerificationType] = useState<VerificationType>(
    mission?.verification_type ?? 'supervisor'
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setSaveError('')
    const payload = {
      title,
      description: description || null,
      xp_reward: parseInt(xpReward),
      category: category || null,
      min_rank: minRank,
      requires_approval: true,
      verification_type: verificationType,
    }
    try {
      if (mission) {
        const { error } = await supabase.from('missions').update(payload).eq('id', mission.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('missions').insert(payload)
        if (error) throw error
      }
      onSaved()
      onClose()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const categories: { value: MissionCategory | ''; label: string }[] = [
    { value: '', label: '— No category —' },
    ...Object.entries(MISSION_CATEGORY_LABELS).map(([k, v]) => ({
      value: k as MissionCategory, label: v,
    })),
  ]
  const ranks = Object.entries(RANK_LABELS).map(([k, v]) => ({ value: k as Rank, label: v }))
  const verificationOptions: { value: VerificationType; label: string; description: string }[] = [
    { value: 'supervisor', label: '✓ Supervisor sign-off', description: 'Supervisor verifies in person' },
    { value: 'photo',      label: '📷 Photo proof',        description: 'Staff uploads a photo as evidence' },
    { value: 'both',       label: '📷 + Supervisor',       description: 'Photo upload AND supervisor sign-off' },
  ]

  return (
    <div className="bg-white rounded-2xl shadow-card p-6 mb-6 border border-border">
      <h2 className="font-display text-lg font-bold text-brown-dark mb-5">
        {mission ? 'Edit Mission' : 'New Mission'}
      </h2>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Title">
            <input required value={title} onChange={e => setTitle(e.target.value)} className={inputCls} placeholder="Pull 50 espresso shots" />
          </Field>
          <Field label="XP Reward">
            <input type="number" required min={1} value={xpReward} onChange={e => setXpReward(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Category">
            <select value={category} onChange={e => setCategory(e.target.value as MissionCategory | '')} className={inputCls}>
              {categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Min Rank">
            <select value={minRank} onChange={e => setMinRank(e.target.value as Rank)} className={inputCls}>
              {ranks.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Description (optional)">
          <textarea value={description} onChange={e => setDescription(e.target.value)} className={`${inputCls} resize-none`} rows={2} placeholder="Describe the mission requirements…" />
        </Field>
        <div>
          <label className="block text-xs text-brown-muted mb-2 font-medium tracking-widest uppercase">Verification Method</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {verificationOptions.map(opt => (
              <button key={opt.value} type="button" onClick={() => setVerificationType(opt.value)}
                className={`text-left p-3 rounded-xl border transition-all ${verificationType === opt.value ? 'border-[#8B6344] bg-[#8B634410] ring-1 ring-[#8B634430]' : 'border-border hover:border-border-mid'}`}>
                <p className="text-sm font-semibold text-brown-dark">{opt.label}</p>
                <p className="text-xs text-brown-muted mt-0.5">{opt.description}</p>
              </button>
            ))}
          </div>
        </div>
        {saveError && <p className="text-red-600 text-xs">{saveError}</p>}
        <div className="flex gap-3 pt-1">
          <button type="submit" disabled={saving} className="bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors">
            {saving ? 'Saving…' : 'Save Mission'}
          </button>
          <button type="button" onClick={onClose} className="text-sm text-brown-muted hover:text-brown-dark px-4 py-2 transition-colors">
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function VerificationPill({ type }: { type: VerificationType | null | undefined }) {
  if (!type || !VERIFICATION_CONFIG[type]) return null
  const { label, style } = VERIFICATION_CONFIG[type]
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${style}`}>{label}</span>
}

const inputCls = 'w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">{label}</label>
      {children}
    </div>
  )
}

function PageLoader() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="w-8 h-8 rounded-full border-2 border-[#8B6344] border-t-transparent animate-spin" />
    </div>
  )
}
