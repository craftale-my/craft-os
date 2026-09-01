/** Why someone was late. Codes are stored in attendance.late_reason_code and
 *  mirrored by a CHECK constraint — keep both lists in step. */
export const LATE_REASON_CODES = [
  'traffic', 'transport', 'medical', 'work_errand', 'personal', 'other',
] as const

export type LateReasonCode = (typeof LATE_REASON_CODES)[number]

export const LATE_REASON_LABELS: Record<LateReasonCode, string> = {
  traffic: 'Traffic jam',
  transport: 'Transport breakdown',
  medical: 'Medical',
  work_errand: 'Work errand',
  personal: 'Personal emergency',
  other: 'Other',
}

/** Fallback for the system_rules key `late_reason_written_threshold`. */
export const DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES = 15

/** Tapping a code is enough for a small overrun; past the threshold the staff
 *  member has to say what actually happened. The threshold minute itself is
 *  still "small" — same inclusive spirit as the lateness rule. */
export function requiresWrittenExplanation(lateMinutes: number, thresholdMinutes: number): boolean {
  return lateMinutes > thresholdMinutes
}

export function isLateReasonComplete({
  code, note, lateMinutes, thresholdMinutes,
}: {
  code: LateReasonCode | null
  note: string
  lateMinutes: number
  thresholdMinutes: number
}): boolean {
  if (!code) return false
  if (requiresWrittenExplanation(lateMinutes, thresholdMinutes)) return note.trim().length > 0
  return true
}
