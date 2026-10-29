import { useState } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { writeOutcome } from '../../shared/lib/db-write'
import { CS_ROLES, CS_ROLE_LABELS } from '../../shared/types'
import type { CsRole, Staff } from '../../shared/types'

// Who can open the Craft Marketing inbox from Craft OS, and at what level.
// staff_guard_cs_role() (supabase/migration-2026-10-29-cs-role.sql) lets only
// an owner or admin write cs_role. `.select()` + writeOutcome() are what make
// a rejected or silently-dropped write show up here instead of as "Saved".
export function CustomerServiceAccessTab({ allStaff, onRefresh }: { allStaff: Staff[]; onRefresh: () => void }) {
  const [saving, setSaving] = useState<string | null>(null)
  const [rowMessage, setRowMessage] = useState<{ staffId: string; ok: boolean; text: string } | null>(null)

  async function assign(staffId: string, value: string) {
    const cs_role: CsRole | null = value === '' ? null : (value as CsRole)
    setSaving(staffId)
    setRowMessage(null)
    const outcome = writeOutcome(
      await supabase.from('staff').update({ cs_role }).eq('id', staffId).select()
    )
    setSaving(null)
    if (!outcome.ok) {
      setRowMessage({ staffId, ok: false, text: outcome.reason })
      return
    }
    setRowMessage({ staffId, ok: true, text: 'Saved' })
    onRefresh()
  }

  const activeStaff = allStaff.filter(s => s.status !== 'resigned')

  return (
    <div>
      <h3 className="text-sm font-bold text-brown-dark mb-1">Customer Service Access</h3>
      <p className="text-xs text-brown-faint mb-3">
        Who can open the Customer Service inbox from the sidebar. Removing access signs the person out of the inbox within 15 minutes.
      </p>
      <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
        {activeStaff.map(s => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-brown-dark truncate">{s.name}</p>
              {s.email && <p className="text-[11px] text-brown-faint truncate">{s.email}</p>}
              {rowMessage?.staffId === s.id && (
                <p className={`text-xs mt-0.5 ${rowMessage.ok ? 'text-[#3D7A50]' : 'text-red-600'}`}>{rowMessage.text}</p>
              )}
            </div>
            <select
              value={s.cs_role ?? ''}
              disabled={saving === s.id}
              onChange={e => assign(s.id, e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40] disabled:opacity-50"
            >
              <option value="">None</option>
              {CS_ROLES.map(r => <option key={r} value={r}>{CS_ROLE_LABELS[r]}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  )
}
