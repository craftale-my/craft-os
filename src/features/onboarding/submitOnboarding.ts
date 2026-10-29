import { supabase } from '../../shared/lib/supabase'
import { writeOutcome } from '../../shared/lib/db-write'
import { saveStaffPrivate } from '../staff/privateApi'
import { branchIdForLabel } from '../../shared/lib/branchLookup'

export interface OnboardingForm {
  branch: string
  department: string
  employmentType: string
  nickname: string
  fullName: string
  icNumber: string
  address: string
  gender: string
  dateOfBirth: string
  contactNumber: string
  workingExperience: string
  education: string
}

/** Order matters: the private row is written first, and onboarding is only
 *  marked complete once it landed. If the private write fails, nothing is
 *  marked and the staff member can simply submit again (both writes are
 *  idempotent). */
export async function submitOnboarding(userId: string, form: OnboardingForm): Promise<void> {
  await saveStaffPrivate(userId, {
    ic_number:      form.icNumber,
    address:        form.address,
    date_of_birth:  form.dateOfBirth,
    contact_number: form.contactNumber,
  })

  // branch_id follows the label; undefined (lookup failed) leaves it to the
  // DB trigger staff_sync_branch_id_trg.
  const branchId = await branchIdForLabel(form.branch)
  const res = await supabase.from('staff').update({
    name:                 form.fullName,
    nickname:             form.nickname || null,
    department:           form.department || null,   // already a department slug
    branch:               form.branch,
    ...(branchId !== undefined && { branch_id: branchId }),
    employment_type:      form.employmentType,
    gender:               form.gender,
    working_experience:   form.workingExperience,
    education:            form.education,
    onboarding_completed: true,
  }).eq('id', userId).select('id')
  const outcome = writeOutcome(res)
  if (!outcome.ok) throw new Error(`Your profile was not saved: ${outcome.reason}`)
}
