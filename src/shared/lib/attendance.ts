/** Device-local calendar date as YYYY-MM-DD. new Date().toISOString() would
 *  give the UTC date, which is YESTERDAY between 00:00 and 07:59 in Malaysia
 *  (UTC+8) — wrong for attendance-day and lateness math. */
export function localDateStr(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Strict lateness vs the scheduled shift start (no grace period).
 *  Baseline is device-local `${dateStr}T${startTime}`, matching how the app
 *  builds todayStr()/times everywhere. Sub-minute lateness rounds UP so a
 *  `late` status never shows "0 minutes". */
export function calcLateness(
  clockInIso: string,
  dateStr: string,
  startTime: string,
): { isLate: boolean; lateMinutes: number } {
  const start = new Date(`${dateStr}T${startTime}`)
  const diffMs = new Date(clockInIso).getTime() - start.getTime()
  if (diffMs <= 0) return { isLate: false, lateMinutes: 0 }
  return { isLate: true, lateMinutes: Math.ceil(diffMs / 60000) }
}
