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
