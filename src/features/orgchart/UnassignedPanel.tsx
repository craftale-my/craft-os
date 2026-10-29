import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Card, Badge } from '../../shared/components/ui'
import { Avatar } from '../../shared/components/Avatar'
import { RANK_LABELS } from '../../shared/types'
import { useLookups } from '../../shared/lib/lookups'
import { shortenBranch } from '../../shared/lib/branches'
import { supervisorChoices, type OrgTree, type UnassignedReason } from './orgTree'
import { assignSupervisor } from './api'

const REASON_LABEL: Record<UnassignedReason, string> = {
  none: 'No supervisor',
  inactive: 'Supervisor inactive',
  broken: 'Not connected to owner',
}

/** Managers only: who has no supervisor, with a picker that saves on change. */
export function UnassignedPanel({ tree, onAssigned }: { tree: OrgTree; onAssigned: () => Promise<void> }) {
  const { deptName } = useLookups()
  const [open, setOpen] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const count = tree.unassigned.length
  if (count === 0) return null

  async function choose(personId: string, supervisorId: string) {
    if (!supervisorId) return
    setSavingId(personId)
    setErrors(prev => ({ ...prev, [personId]: '' }))
    const out = await assignSupervisor(personId, supervisorId)
    if (out.ok) await onAssigned()
    else setErrors(prev => ({ ...prev, [personId]: `Couldn't save: ${out.reason}` }))
    setSavingId(null)
  }

  return (
    <Card tone="tint" className="mb-4">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="flex items-center gap-2 font-semibold text-brown-dark">
          <AlertTriangle size={16} className="text-accent" aria-hidden />
          {count} staff {count === 1 ? 'has' : 'have'} no supervisor
        </span>
        <span className="text-sm text-accent-text">{open ? 'Hide' : 'Assign'}</span>
      </button>

      {open && (
        <ul className="mt-4 divide-y divide-border">
          {tree.unassigned.map(({ person, reason }) => (
            // lg, not sm: beside the 240px sidebar the main column is only
            // ~500px at sm/md, and a side-by-side row squeezed names to two letters.
            <li key={person.id} className="py-3 flex flex-col lg:flex-row lg:items-center gap-2 lg:gap-4">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Avatar name={person.name} avatar={person.avatar} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm font-medium text-brown-dark truncate">{person.name}</p>
                    <Badge tone={reason === 'none' ? 'neutral' : 'danger'} className="flex-shrink-0 whitespace-nowrap">
                      {REASON_LABEL[reason]}
                    </Badge>
                  </div>
                  <p className="text-xs text-brown-muted">
                    {shortenBranch(person.branch)} · {person.department ? deptName(person.department) : '—'}
                  </p>
                </div>
              </div>
              <div className="lg:w-64">
                <label className="sr-only" htmlFor={`sup-${person.id}`}>Supervisor for {person.name}</label>
                <select
                  id={`sup-${person.id}`}
                  value=""
                  disabled={savingId === person.id}
                  onChange={e => { void choose(person.id, e.target.value) }}
                  className="w-full rounded-lg border border-border-mid bg-white px-3 py-2 text-sm text-brown-dark"
                >
                  <option value="">{savingId === person.id ? 'Saving…' : 'Choose supervisor…'}</option>
                  {supervisorChoices(tree, person.id).map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {RANK_LABELS[c.rank]} · {shortenBranch(c.branch)}
                    </option>
                  ))}
                </select>
                {errors[person.id] && <p role="alert" className="mt-1 text-xs text-bad">{errors[person.id]}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
