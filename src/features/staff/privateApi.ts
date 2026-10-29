import { supabase } from '../../shared/lib/supabase'
import { writeOutcome } from '../../shared/lib/db-write'
import type { StaffPrivate } from '../../shared/types'

/** The four private columns; any subset may be written. */
export type StaffPrivatePatch = Partial<Pick<StaffPrivate, 'ic_number' | 'date_of_birth' | 'contact_number' | 'address'>>

/** writeOutcome's own reason for a 0-row write is a subject-less fragment
 *  ("it was not saved — …"), which reads badly after "<what> could not be
 *  saved". Phrase the two failure kinds here instead; writeOutcome still
 *  decides whether the write failed. */
function saveFailure(what: string, error: { message: string } | null): string {
  return error
    ? `${what} could not be saved: ${error.message}`
    : `${what} could not be saved — you may have been signed out.`
}

/** One staff member's private row, or null when RLS hides it from the caller
 *  (they are neither the staff member nor hr/manager/admin/owner). A real
 *  failure throws — never conflate "can't see" with "couldn't load". */
export async function fetchStaffPrivate(staffId: string): Promise<StaffPrivate | null> {
  const { data, error } = await supabase
    .from('staff_private').select('*').eq('staff_id', staffId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data ?? null) as StaffPrivate | null
}

/** Upserts only the columns present in `patch`. Throws when the database
 *  rejects the write or RLS silently filters it (0 rows back). */
export async function saveStaffPrivate(staffId: string, patch: StaffPrivatePatch): Promise<void> {
  const res = await supabase
    .from('staff_private')
    .upsert({ staff_id: staffId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'staff_id' })
    .select('staff_id')
  if (!writeOutcome(res).ok) throw new Error(saveFailure('Personal details', res.error))
}

/** Manager notes about one staff member, or null (none written, or not allowed). */
export async function fetchManagerNotes(staffId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('staff_manager_notes').select('notes').eq('staff_id', staffId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as { notes: string | null } | null)?.notes ?? null
}

export async function saveManagerNotes(staffId: string, notes: string | null, actorId: string): Promise<void> {
  const res = await supabase
    .from('staff_manager_notes')
    .upsert({ staff_id: staffId, notes, updated_by: actorId, updated_at: new Date().toISOString() }, { onConflict: 'staff_id' })
    .select('staff_id')
  if (!writeOutcome(res).ok) throw new Error(saveFailure('Notes', res.error))
}
