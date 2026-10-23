import { supabase } from '../../shared/lib/supabase'
import { writeOutcome, type WriteOutcome, type WriteResponse } from '../../shared/lib/db-write'
import type { OrgPerson } from './orgTree'

/** Every active staff member, narrow columns only (see get_org_chart()). */
export async function fetchOrgChart(): Promise<OrgPerson[]> {
  const { data, error } = await supabase.rpc('get_org_chart')
  if (error) throw new Error(error.message)
  return (data ?? []) as OrgPerson[]
}

/** Sets one staff member's supervisor. The DB's loop guard rejects choices
 *  that would make a reporting loop; its message comes back as `reason`. */
export async function assignSupervisor(staffId: string, supervisorId: string): Promise<WriteOutcome> {
  const res = await supabase.from('staff').update({ supervisor_id: supervisorId }).eq('id', staffId).select('id')
  return writeOutcome(res as WriteResponse)
}
