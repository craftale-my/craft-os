import { useState, useEffect, useRef, Fragment } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { useCan } from '../../shared/lib/permissions'
import type { Staff, Attendance, AttendanceStatus, AttendanceBreak, ScheduledShift, ShiftType, ScheduleLeaveType } from '../../shared/types'
import { ATTENDANCE_STATUS_LABELS, ATTENDANCE_STATUS_COLORS, BRANCHES, DEPT_LABELS, MONTHS_FULL, DEFAULT_BREAK_MINUTES, computeBreakOvertime, SCHEDULE_LEAVE_LABELS, DEPT_SHIFT_COLORS } from '../../shared/types'
import { toCSV, downloadCSV } from '../../shared/lib/csv'
import { calcLateness, localDateStr, prevDateStr, resolveAttendanceDate } from '../../shared/lib/attendance'
import { writeOutcome, writeOutcomeWithRow, type WriteOutcome, type WriteOutcomeWithRow } from '../../shared/lib/db-write'
import { DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES, LATE_REASON_LABELS, type LateReasonCode } from '../../shared/lib/lateReason'
import { buildStaffReport } from '../../shared/lib/attendance-report'
import type { DailyDetail } from '../../shared/lib/attendance-report'
import { Avatar } from '../../shared/components/Avatar'
import { MapPin, CheckCircle, X, AlertTriangle, ZoomIn, Coffee, ChevronDown, ChevronRight } from 'lucide-react'
import { ClockModal, type ClockResult } from './ClockModal'
import { LateReasonStep } from './LateReasonStep'

// ─── Utilities ────────────────────────────────────────────────────────────────

function todayStr(): string {
  return localDateStr()
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * Resigned staff stay out of the team views unless they have something on
 * record for the period being viewed: a month they actually worked still
 * needs their row, the months after they left do not.
 */
export function hideIdleResigned(staff: Staff[], withRecords: Set<string>): Staff[] {
  return staff.filter(s => s.status !== 'resigned' || withRecords.has(s.id))
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// Formats a `time` column value (HH:MM[:SS]) to `9:30am` style. `fmtTime` above
// takes an ISO timestamp, not a bare time-of-day, so it isn't reusable here.
function fmtTime2(t: string): string {
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`
}

// ─── Photo viewer modal ───────────────────────────────────────────────────────

function PhotoViewer({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button className="absolute top-4 right-4 text-white/70 hover:text-white p-2" onClick={onClose}>
        <X size={24} />
      </button>
      <img
        src={url}
        alt="Attendance selfie"
        className="max-w-full max-h-full rounded-xl object-contain"
        onClick={e => e.stopPropagation()}
      />
    </div>
  )
}

// ─── Manager: daily roster ────────────────────────────────────────────────────

const STATUS_OPTIONS: AttendanceStatus[] = ['present', 'late', 'absent', 'half_day', 'on_leave']

export function DailyRoster({ allStaff, managerId }: { allStaff: Staff[]; managerId: string | undefined }) {
  const [date, setDate] = useState(todayStr())
  const [records, setRecords] = useState<Record<string, Attendance>>({})
  const [breaksByAtt, setBreaksByAtt] = useState<Record<string, AttendanceBreak[]>>({})
  const [filterBranch, setFilterBranch] = useState('')
  const [filterDept, setFilterDept] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [viewPhoto, setViewPhoto] = useState<string | null>(null)
  // A rejected excuse must be visible, not silent — surfaced above the list
  // rather than per-row, since the row itself may re-render away on reload.
  const [rosterError, setRosterError] = useState<string | null>(null)

  async function load() {
    // Fallback trigger for the hourly cron: opening/refreshing the roster
    // auto-marks any ended-but-unclocked shifts before we read the day.
    // Best-effort — errors are ignored so the roster always loads.
    await supabase.rpc('mark_absent_for_missed_shifts').then(() => {}, () => {})

    const { data } = await supabase.from('attendance').select('*').eq('date', date)
    const rows = (data as Attendance[] | null) ?? []
    const map: Record<string, Attendance> = {}
    rows.forEach(r => { map[r.staff_id] = r })
    setRecords(map)

    const attIds = rows.map(r => r.id)
    if (attIds.length === 0) { setBreaksByAtt({}); return }
    const { data: brk } = await supabase.from('attendance_breaks').select('*').in('attendance_id', attIds)
    const bmap: Record<string, AttendanceBreak[]> = {}
    ;(brk as AttendanceBreak[] | null)?.forEach(b => {
      ;(bmap[b.attendance_id] ??= []).push(b)
    })
    setBreaksByAtt(bmap)
  }

  useEffect(() => { load() }, [date])

  async function setStatus(staffId: string, status: AttendanceStatus, lateMinutes = 0) {
    setSaving(staffId)
    await supabase.from('attendance').upsert({
      staff_id: staffId,
      date,
      status,
      late_minutes: lateMinutes,
      recorded_by: managerId ?? null,
      marked_by: managerId ?? null,   // manual mark — overrides a 'system' auto-mark
    }, { onConflict: 'staff_id,date' })
    setSaving(null)
    load()
  }

  async function markAllPresent() {
    // A resigned row is only on screen because of an existing record; never
    // overwrite it with a fresh "present".
    const rows = visibleStaff.filter(s => s.status !== 'resigned').map(s => ({
      staff_id: s.id,
      date,
      status: 'present' as const,
      recorded_by: managerId ?? null,
      marked_by: managerId ?? null,
    }))
    await supabase.from('attendance').upsert(rows, { onConflict: 'staff_id,date' })
    load()
  }

  const isManagerTier = (me: Staff | undefined) =>
    !!me && (me.rank === 'manager' || me.system_role === 'manager' ||
             me.system_role === 'admin' || me.system_role === 'owner')

  // Mirrors excuse_lateness()'s own authorisation check exactly (see
  // supabase/migration-2026-09-02-late-reason-notifications.sql). manage_hr
  // — the capability that gates access to this whole page — is branch-wide,
  // so it is broader than this predicate: a supervisor can see a colleague's
  // row here without being allowed to excuse it. Showing this button to
  // anyone else would give them a click the database rejects.
  function canExcuse(target: Staff): boolean {
    const me = allStaff.find(s => s.id === managerId)
    return isManagerTier(me) || target.supervisor_id === managerId
  }

  // `saving` holds a STAFF id everywhere else in this component
  // (`saving === s.id`); keep that, or the disabled states stop matching.
  async function excuse(staffId: string, attendanceId: string) {
    setSaving(staffId)
    // Goes through the excuse_lateness() RPC, not a direct update: RLS is
    // row-scoped, so a policy permissive enough to allow this would also let
    // a supervisor rewrite clock_in and late_minutes. The function writes
    // only the excuse columns.
    const { error } = await supabase.rpc('excuse_lateness', { p_attendance_id: attendanceId })
    const outcome: WriteOutcome = error ? { ok: false, reason: error.message } : { ok: true }
    setSaving(null)
    if (!outcome.ok) setRosterError(`Could not excuse this lateness — ${outcome.reason}`)
    else { setRosterError(null); load() }
  }

  const visibleStaff = hideIdleResigned(allStaff, new Set(Object.keys(records))).filter(s => {
    if (filterBranch && s.branch !== filterBranch) return false
    if (filterDept && s.department !== filterDept) return false
    return true
  })

  const selectCls = 'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="space-y-4">
      {viewPhoto && <PhotoViewer url={viewPhoto} onClose={() => setViewPhoto(null)} />}

      {rosterError && (
        <div role="alert" className="px-4 py-2.5 rounded-xl bg-[#FDF3F0] border border-[#E8B8A8] text-sm text-[#9E4A30]">
          {rosterError}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className={selectCls} />
        <select className={selectCls} value={filterBranch} onChange={e => setFilterBranch(e.target.value)}>
          <option value="">All branches</option>
          {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className={selectCls} value={filterDept} onChange={e => setFilterDept(e.target.value)}>
          <option value="">All depts</option>
          {Object.entries(DEPT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button
          onClick={markAllPresent}
          className="px-3 py-1.5 rounded-lg bg-[#3D7A50] text-white text-xs font-semibold hover:bg-[#2E6040] transition-colors"
        >
          Mark all present
        </button>
      </div>

      <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
        {visibleStaff.map(s => {
          const rec = records[s.id]
          const distM = rec?.clock_in_distance_m
          const highDist = distM != null && distM > 200
          return (
            <div key={s.id} className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <Avatar name={s.name} avatar={s.avatar} size="sm" />
                <p className="text-sm font-medium text-brown-dark flex-1 min-w-[100px]">
                  {s.name}
                  {rec?.marked_by === 'system' && (
                    <span
                      className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#F0E8DC] text-brown-muted align-middle"
                      title="Marked automatically — no clock-in for the scheduled shift"
                    >
                      ⚙ Auto
                    </span>
                  )}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {STATUS_OPTIONS.map(opt => (
                    <button
                      key={opt}
                      disabled={saving === s.id}
                      onClick={() => setStatus(s.id, opt, opt === 'late' ? (rec?.late_minutes || 5) : 0)}
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
                      style={
                        rec?.status === opt
                          ? { background: `${ATTENDANCE_STATUS_COLORS[opt]}20`, color: ATTENDANCE_STATUS_COLORS[opt], border: `1px solid ${ATTENDANCE_STATUS_COLORS[opt]}60` }
                          : { background: '#F5EDE0', color: '#8B7355', border: '1px solid transparent' }
                      }
                    >
                      {ATTENDANCE_STATUS_LABELS[opt]}
                    </button>
                  ))}
                  {rec?.status === 'late' && (
                    <input
                      type="number"
                      min={0}
                      value={rec.late_minutes}
                      onChange={e => setStatus(s.id, 'late', Number(e.target.value))}
                      className="w-16 px-2 py-1 rounded-lg border border-[#D4C5B0] text-xs text-brown-dark"
                      placeholder="mins"
                    />
                  )}
                  {rec?.status === 'late' && (
                    <span className="px-2 py-1 rounded-lg text-xs bg-[#F5EDE0] text-brown-muted">
                      {/* A late record can reach here with no reason code at
                          all — DailyRoster.setStatus (below) writes
                          status='late' without one when a manager sets it by
                          hand — and, defensively, with a code outside the
                          six LATE_REASON_LABELS knows (the DB CHECK
                          constraint should prevent this, but the cast on the
                          next line bypasses TypeScript's own check). Either
                          way this must render something visible, never the
                          blank chrome an unguarded index into
                          LATE_REASON_LABELS would produce. */}
                      {rec.late_reason_code
                        ? (LATE_REASON_LABELS[rec.late_reason_code as LateReasonCode] ?? rec.late_reason_code)
                        : 'No reason given'}
                      {rec.late_reason ? ` — ${rec.late_reason}` : ''}
                    </span>
                  )}
                  {rec?.status === 'late' && !rec.late_excused && canExcuse(s) && (
                    <button
                      disabled={saving === s.id}
                      onClick={() => excuse(s.id, rec.id)}
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#EEF5EF] text-[#3D7A50] border border-[#A8C5AE] disabled:opacity-50"
                    >
                      Excuse
                    </button>
                  )}
                  {rec?.late_excused && (
                    <span className="px-2 py-1 rounded-lg text-xs font-semibold bg-[#EEF5EF] text-[#3D7A50]">
                      Excused
                    </span>
                  )}
                </div>
              </div>

              {rec && (rec.clock_in || rec.clock_in_photo_url) && (
                <div className="flex items-center gap-4 pl-9 flex-wrap">
                  {/* Clock times */}
                  <div className="flex items-center gap-3 text-xs text-brown-faint">
                    {rec.clock_in && <span>In: <span className="font-medium text-brown-medium">{fmtTime(rec.clock_in)}</span></span>}
                    {rec.clock_out && <span>Out: <span className="font-medium text-brown-medium">{fmtTime(rec.clock_out)}</span></span>}
                  </div>

                  {/* Breaks (per-break from attendance_breaks) */}
                  {(breaksByAtt[rec.id] ?? [])
                    .filter(b => b.clock_in_time != null)
                    .sort((a, b) => a.break_number - b.break_number)
                    .map(b => (
                      <span key={b.id} className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                        b.is_overtime ? 'bg-[#FDF3F0] text-[#9E4A30]' : 'bg-[#FBF0E6] text-[#8B5E2E]'
                      }`}>
                        <Coffee size={10} />
                        B{b.break_number} {b.duration_minutes ?? 0}m
                        {b.is_overtime ? ` (+${b.overtime_minutes}m ⚠️)` : ' ✓'}
                      </span>
                    ))}

                  {/* GPS distance */}
                  {distM != null && (
                    <span className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                      highDist
                        ? 'bg-[#FDF3F0] text-[#9E4A30]'
                        : 'bg-[#EBF5EE] text-[#3D7A50]'
                    }`}>
                      <MapPin size={10} />
                      {distM}m from branch {highDist ? '⚠️' : '✓'}
                    </span>
                  )}

                  {/* Selfie thumbnails */}
                  <div className="flex items-center gap-2">
                    {rec.clock_in_photo_url && (
                      <button
                        onClick={() => setViewPhoto(rec.clock_in_photo_url!)}
                        className="relative group"
                        title="Clock-in selfie"
                      >
                        <img
                          src={rec.clock_in_photo_url}
                          alt="Clock-in"
                          className="w-10 h-10 rounded-lg object-cover border-2 border-[#3D7A50] hover:border-[#2E6040] transition-colors"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg flex items-center justify-center transition-colors">
                          <ZoomIn size={12} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                        <span className="absolute -bottom-0.5 -right-0.5 bg-[#3D7A50] text-white text-[8px] font-bold px-1 rounded">IN</span>
                      </button>
                    )}
                    {rec.clock_out_photo_url && (
                      <button
                        onClick={() => setViewPhoto(rec.clock_out_photo_url!)}
                        className="relative group"
                        title="Clock-out selfie"
                      >
                        <img
                          src={rec.clock_out_photo_url}
                          alt="Clock-out"
                          className="w-10 h-10 rounded-lg object-cover border-2 border-[#C4813A] hover:border-[#A86C2C] transition-colors"
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg flex items-center justify-center transition-colors">
                          <ZoomIn size={12} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                        <span className="absolute -bottom-0.5 -right-0.5 bg-[#C4813A] text-white text-[8px] font-bold px-1 rounded">OUT</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Manager: monthly grid ────────────────────────────────────────────────────

function MonthlyGrid({ allStaff }: { allStaff: Staff[] }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [records, setRecords] = useState<Attendance[]>([])
  const [exporting, setExporting] = useState(false)

  async function load() {
    const start = `${year}-${String(month).padStart(2, '0')}-01`
    const end = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`
    const { data } = await supabase.from('attendance').select('*').gte('date', start).lte('date', end)
    setRecords((data as Attendance[]) ?? [])
  }

  useEffect(() => { load() }, [year, month])

  const days = Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1)
  const map: Record<string, Record<number, Attendance>> = {}
  records.forEach(r => {
    const day = Number(r.date.split('-')[2])
    if (!map[r.staff_id]) map[r.staff_id] = {}
    map[r.staff_id][day] = r
  })
  const gridStaff = hideIdleResigned(allStaff, new Set(Object.keys(map)))

  async function exportCSV() {
    setExporting(true)
    const rows = records.map(r => {
      const s = allStaff.find(st => st.id === r.staff_id)
      return [s?.name ?? r.staff_id, r.date, ATTENDANCE_STATUS_LABELS[r.status], r.late_minutes, r.clock_in_distance_m ?? '']
    })
    downloadCSV(`attendance_${MONTHS_FULL[month - 1]}_${year}.csv`, toCSV(['Staff', 'Date', 'Status', 'Late Minutes', 'GPS Distance (m)'], rows))
    setExporting(false)
  }

  const selectCls = 'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={month} onChange={e => setMonth(Number(e.target.value))}>
          {MONTHS_FULL.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <input type="number" className={`${selectCls} w-24`} value={year} onChange={e => setYear(Number(e.target.value))} />
        <button onClick={exportCSV} disabled={exporting} className="px-3 py-1.5 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors disabled:opacity-60">
          {exporting ? 'Exporting...' : 'Export CSV'}
        </button>
      </div>
      <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
        <table className="text-xs min-w-max">
          <thead>
            <tr className="border-b border-[#EDE5D8]">
              <th className="text-left px-3 py-2 font-semibold text-brown-faint sticky left-0 bg-white">Staff</th>
              {days.map(d => <th key={d} className="px-1.5 py-2 font-semibold text-brown-faint text-center">{d}</th>)}
            </tr>
          </thead>
          <tbody>
            {gridStaff.map((s, i) => (
              <tr key={s.id} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                <td className="px-3 py-1.5 font-medium text-brown-dark sticky left-0 bg-white whitespace-nowrap">{s.name}</td>
                {days.map(d => {
                  const rec = map[s.id]?.[d]
                  return (
                    <td key={d} className="px-1.5 py-1.5 text-center">
                      {rec ? (
                        <span
                          title={`${ATTENDANCE_STATUS_LABELS[rec.status]}${rec.clock_in_distance_m != null ? ` · ${rec.clock_in_distance_m}m` : ''}`}
                          className="inline-block w-4 h-4 rounded-sm"
                          style={{ background: ATTENDANCE_STATUS_COLORS[rec.status] }}
                        />
                      ) : (
                        <span className="inline-block w-4 h-4 rounded-sm bg-[#F0E8DC]" />
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Manager: date-range report ───────────────────────────────────────────────

/** A scheduled_shifts row with its shift_type embedded — the shape
 *  buildStaffReport reads shift name/start/end from. */
type ReportShift = ScheduledShift & {
  shift_type?: Pick<ShiftType, 'name' | 'start_time' | 'end_time'> | null
}

type RangePreset = 'last7' | 'last30' | 'this_month' | 'last_month' | 'custom'

const RANGE_PRESETS: { key: Exclude<RangePreset, 'custom'>; label: string }[] = [
  { key: 'last7',      label: 'Last 7 days' },
  { key: 'last30',     label: 'Last 30 days' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
]

/** PostgREST answers at most this many rows per request. */
const PAGE_SIZE = 1000

/** Ceiling on a single report's reads, so a runaway filter cannot page forever.
 *  50 staff over a year is ~18k attendance rows, so no real range reaches it. */
const REPORT_MAX_ROWS = 20000

/** Reads every page of a range instead of accepting PostgREST's first one.
 *
 *  Taking the capped slice silently was worse than an under-count: attendance
 *  came back ordered by date, so its cut fell at a date boundary, while
 *  scheduled_shifts came back unordered, so its cut fell anywhere. A scheduled
 *  day whose attendance row had been dropped then looked like a missed
 *  clock-in that never happened — on a full roster the untouched "Last 30 days"
 *  default invented dated absences for staff who clocked in every day, and both
 *  CSV exports carried them. Paging needs a total order to be stable, so every
 *  caller sorts on a unique tiebreaker. */
async function fetchAllRows<T>(
  page: (lo: number, hi: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<{ rows: T[]; truncated: boolean; error: { message: string } | null }> {
  const rows: T[] = []
  for (let lo = 0; lo < REPORT_MAX_ROWS; lo += PAGE_SIZE) {
    const { data, error } = await page(lo, lo + PAGE_SIZE - 1)
    if (error) return { rows, truncated: false, error }
    const batch = (data as T[] | null) ?? []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return { rows, truncated: false, error: null }
  }
  return { rows, truncated: true, error: null }
}

/** `dateStr` shifted by whole calendar days — prevDateStr, generalised. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + days)
  return localDateStr(d)
}

/** First and last day of the month `offset` months from the current one.
 *  Day 0 of the next month is the last day of this one — same trick as
 *  daysInMonth above. */
function monthBounds(offset: number): { first: string; last: string } {
  const now = new Date()
  return {
    first: localDateStr(new Date(now.getFullYear(), now.getMonth() + offset, 1)),
    last: localDateStr(new Date(now.getFullYear(), now.getMonth() + offset + 1, 0)),
  }
}

function presetRange(preset: Exclude<RangePreset, 'custom'>): { from: string; to: string } {
  const today = todayStr()
  if (preset === 'last7') return { from: addDays(today, -6), to: today }
  if (preset === 'last30') return { from: addDays(today, -29), to: today }
  // "This month" stops at today — days that haven't happened yet would only pad
  // the detail table with empty rows.
  if (preset === 'this_month') return { from: monthBounds(0).first, to: today }
  const prev = monthBounds(-1)
  return { from: prev.first, to: prev.last }
}

/** 465 → "7h 45m", 45 → "45m", null (a missing clock) → "—". */
function fmtWorked(minutes: number | null): string {
  if (minutes == null) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function weekdayShort(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-MY', { weekday: 'short' })
}

/** "Morning 9:30am–6:00pm", the leave label on a leave-marker day, else "—". */
function shiftLabel(d: DailyDetail): string {
  if (d.leaveType) return SCHEDULE_LEAVE_LABELS[d.leaveType as ScheduleLeaveType] ?? d.leaveType
  if (!d.shiftName) return '—'
  if (!d.shiftStart || !d.shiftEnd) return d.shiftName
  return `${d.shiftName} ${fmtTime2(d.shiftStart)}–${fmtTime2(d.shiftEnd)}`
}

type ReportBreak = DailyDetail['breaks'][number]

const breakAt = (d: DailyDetail, n: 1 | 2): ReportBreak | null => d.breaks.find(b => b.number === n) ?? null

/** Every other value on a report row is fixed Malaysian time — `date` and the
 *  shift's `start_time`/`end_time` are date/time columns, and `late_minutes` was
 *  computed on the staff member's own on-site device. Only clock_in/clock_out
 *  are timestamptz, so reading them with the viewer's local hours put "1:32am"
 *  next to "Morning 9:30am–6:00pm" on a laptop set to UTC, and made the exported
 *  CSV differ depending on who ran it. Pin them to the same zone as everything
 *  beside them. */
const MYT_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kuala_Lumpur', hour: 'numeric', minute: '2-digit', hour12: true,
})

/** ISO timestamp -> `9:32am` in Malaysian time. The page-wide `fmtTime` renders
 *  `09:32 am` (zero-padded, spaced); the report puts clock times next to shift
 *  times formatted by `fmtTime2`, so it needs the same compact spelling.
 *  Changing `fmtTime` itself would restyle the clock card and daily roster. */
function fmtClock(iso: string): string {
  const parts = MYT_CLOCK.formatToParts(new Date(iso))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return `${get('hour')}:${get('minute')}${get('dayPeriod').toLowerCase().replace(/\s/g, '')}`
}

/** The Malaysian calendar date an instant falls on. */
function mytDateOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso))
}

/** A clock time that says so when it belongs to a later day than the row it sits
 *  on. An overnight shift is filed under the day it STARTS, so its clock-out
 *  lands on the next calendar date — printed bare, `1:04am` beside a `5:02pm`
 *  clock-in reads as a clock-out eight hours before the clock-in, and the CSV
 *  carries the same trap into whatever a payroll clerk computes from it. */
function fmtClockOn(iso: string, rowDate: string): string {
  const base = fmtClock(iso)
  const stamp = mytDateOf(iso)
  if (stamp === rowDate) return base
  const days = Math.round(
    (new Date(`${stamp}T00:00:00`).getTime() - new Date(`${rowDate}T00:00:00`).getTime()) / 86400000,
  )
  return `${base} ${days > 0 ? '+' : ''}${days}d`
}

/** "12:05pm–12:38pm (33m)" — the overtime suffix is added separately so the UI
 *  can paint it red while the CSV keeps it inline. */
function fmtBreakWindow(b: ReportBreak | null): string {
  if (!b?.start) return '—'
  if (!b.end) return `${fmtClock(b.start)}–…`
  return `${fmtClock(b.start)}–${fmtClock(b.end)}${b.durationMinutes != null ? ` (${b.durationMinutes}m)` : ''}`
}

function breakCellText(b: ReportBreak | null): string {
  const base = fmtBreakWindow(b)
  if (base === '—' || !b?.isOvertime) return base
  return `${base} +${b.overtimeMinutes}m`
}

/** Status as plain text for the CSV — the missed-clock-in chip becomes a suffix. */
function statusText(d: DailyDetail): string {
  const base = d.status ? ATTENDANCE_STATUS_LABELS[d.status] : 'No record'
  return d.missedClockIn ? `${base} · Missed` : base
}

const SUMMARY_HEADERS = ['Staff', 'Present', 'Late', 'Late mins', 'Absent', 'Leave', 'Half day', 'Missed clock-in', 'Break OT']
const DETAIL_HEADERS = ['Staff', 'Date', 'Day', 'Shift', 'Clock In', 'Clock Out', 'Worked', 'Break 1', 'Break 2', 'Late', 'Status', 'GPS']

/** Summary counter cell: zero is muted, non-zero is highlighted in the column's
 *  warning colour (red for absent/missed, amber for late/break overtime). */
function CountCell({ value, warnColor }: { value: number; warnColor?: string }) {
  const hot = value > 0 && !!warnColor
  return (
    <td
      className={`px-3 py-2 text-center tabular-nums ${
        value === 0 ? 'text-brown-faint' : hot ? 'font-semibold' : 'text-brown-dark'
      }`}
      style={hot ? { color: warnColor } : undefined}
    >
      {value}
    </td>
  )
}

// Exported for tests — the range/query behaviour is pinned in
// HrAttendance.report-range.test.tsx.
export function AttendanceReport({ allStaff }: { allStaff: Staff[] }) {
  const [preset, setPreset] = useState<RangePreset>('last30')
  const [from, setFrom] = useState(() => presetRange('last30').from)
  const [to, setTo] = useState(() => presetRange('last30').to)
  const [filterStaff, setFilterStaff] = useState('')
  const [filterBranch, setFilterBranch] = useState('')
  const [filterDept, setFilterDept] = useState('')
  const [attendance, setAttendance] = useState<Attendance[]>([])
  const [breaks, setBreaks] = useState<AttendanceBreak[]>([])
  const [shifts, setShifts] = useState<ReportShift[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  /** Newest load() run. Anything older must not touch state — see load(). */
  const runIdRef = useRef(0)

  // Branch/department narrow the pool the staff dropdown offers; the dropdown
  // then narrows the report itself to one person.
  const scopeStaff = allStaff.filter(s => {
    if (filterBranch && s.branch !== filterBranch) return false
    if (filterDept && s.department !== filterDept) return false
    return true
  })
  const visibleStaff = filterStaff ? scopeStaff.filter(s => s.id === filterStaff) : scopeStaff
  const staffIds = visibleStaff.map(s => s.id)
  // Effect key — the id array itself is a fresh object on every render.
  const staffKey = staffIds.join(',')

  async function load() {
    // The three result sets are only meaningful together: breaks join to
    // attendance rows by id, shifts join by date. Publishing them one-by-one
    // means a later failure leaves fresh attendance beside the PREVIOUS
    // selection's breaks/shifts, so the Shift column and Missed clock-in count
    // silently read as empty instead of as an error. Clear on every exit that
    // isn't a full success; publish all three together at the end.
    const clear = () => { setAttendance([]); setBreaks([]); setShifts([]); setTruncated(false) }

    // Each run stakes a claim on the newest request id. Changing the range or
    // the filters starts a run without cancelling the one already in flight, and
    // the reads are paged, so a superseded run can answer seconds after the one
    // that replaced it. Whoever answered last used to win: the table showed an
    // abandoned selection's rows under the current heading, an abandoned run's
    // failure blanked a result that had loaded fine, and both CSV exports read
    // that same state. Every publish below is gated on still being current.
    const runId = ++runIdRef.current
    const current = () => runIdRef.current === runId
    const fail = (message: string) => {
      if (!current()) return
      clear(); setError(message); setLoading(false)
    }

    setTruncated(false)
    if (staffIds.length === 0) { clear(); setError(null); return }
    // Clearing a date input leaves an empty string, which is not caught by the
    // ordering compare below ('' > '2026-08-31' is false) and reaches PostgREST
    // as `date=gte.`, surfacing a raw `invalid input syntax for type date` at
    // the manager. Name the field that is actually empty.
    if (!from || !to) { clear(); setError(!from ? 'Pick a start date.' : 'Pick an end date.'); return }
    if (from > to) { clear(); setError('Start date must be on or before the end date.'); return }
    setLoading(true)
    setError(null)

    const att = await fetchAllRows<Attendance>((lo, hi) => supabase
      .from('attendance')
      .select('*')
      .in('staff_id', staffIds)
      .gte('date', from)
      .lte('date', to)
      .order('date')
      .order('id')
      .range(lo, hi))
    if (att.error) { fail(`Could not load attendance — ${att.error.message}`); return }
    if (!current()) return
    const attRows = att.rows
    // All three reads page to the same ceiling, and all three matter: a dropped
    // break inflates Worked minutes and hides break overtime, a dropped shift
    // loses the Shift column, a dropped attendance row fabricates a missed
    // clock-in. The banner reflects whichever ran out.
    let hitLimit = att.truncated

    // Breaks are filtered through the parent row's own date/staff predicates
    // rather than by listing the attendance ids we just read. supabase-js puts
    // an `.in()` list in the query string, so an id-per-row filter grew the URL
    // by ~39 bytes per attendance day: a full roster crossed the API gateway's
    // ~25KB ceiling at around 17 days and the request came back a bare
    // `400 Bad Request`. Joined this way the URL tracks the roster, not the
    // range. `!inner` makes the embedded filters restrict the breaks themselves.
    let brkRows: AttendanceBreak[] = []
    if (attRows.length > 0) {
      const brk = await fetchAllRows<AttendanceBreak & { attendance?: unknown }>((lo, hi) => supabase
        .from('attendance_breaks')
        .select('*, attendance!inner(staff_id, date)')
        .in('attendance.staff_id', staffIds)
        .gte('attendance.date', from)
        .lte('attendance.date', to)
        .order('attendance_id')
        .order('break_number')
        .range(lo, hi))
      if (brk.error) { fail(`Could not load breaks — ${brk.error.message}`); return }
      if (!current()) return
      // Drop the embedded parent — buildStaffReport groups on attendance_id,
      // which every row still carries.
      brkRows = brk.rows.map(({ attendance: _parent, ...b }) => b as AttendanceBreak)
      if (brk.truncated) hitLimit = true
    }

    // Shifts drive the "missed clock-in" count and the detail table's shift column.
    const shift = await fetchAllRows<ReportShift>((lo, hi) => supabase
      .from('scheduled_shifts')
      .select('*, shift_type:shift_types(name,start_time,end_time)')
      .in('staff_id', staffIds)
      .gte('date', from)
      .lte('date', to)
      .order('date')
      .order('id')
      .range(lo, hi))
    if (shift.error) { fail(`Could not load shifts — ${shift.error.message}`); return }
    if (!current()) return
    const shiftRows = shift.rows
    if (shift.truncated) hitLimit = true

    setAttendance(attRows)
    setBreaks(brkRows)
    setShifts(shiftRows)
    setTruncated(hitLimit)
    setLoading(false)
  }

  useEffect(() => { load() }, [from, to, staffKey])
  // Picking one person makes their detail the whole point — open it immediately.
  useEffect(() => { setExpanded(filterStaff || null) }, [filterStaff])

  function applyPreset(p: Exclude<RangePreset, 'custom'>) {
    const r = presetRange(p)
    setPreset(p)
    setFrom(r.from)
    setTo(r.to)
  }

  // `now` decides which rostered days have had their chance to be worked — a
  // shift still in progress is not a missed clock-in. Passed explicitly so the
  // dependency on the clock is visible at the call site.
  const withRecords = new Set([...attendance.map(a => a.staff_id), ...shifts.map(sh => sh.staff_id)])
  const shownIds = new Set(hideIdleResigned(visibleStaff, withRecords).map(s => s.id))
  const summaries = buildStaffReport(staffIds, attendance, breaks, shifts, new Date())
    .filter(s => shownIds.has(s.staffId))
  const staffName = (id: string) => allStaff.find(s => s.id === id)?.name ?? id

  // A CSV outlives the screen it came from: it gets mailed to payroll with no
  // banner attached. So the export refuses to run while the numbers on screen
  // are not real, and when a read did truncate, the warning travels inside the
  // file and in its name rather than staying on the page.
  const exportBlocked = loading || error != null || staffIds.length === 0
  const INCOMPLETE_NOTE = `INCOMPLETE EXPORT — this range passed the ${REPORT_MAX_ROWS.toLocaleString()}-record read ceiling. Rows were left out: totals are understated and missed clock-ins may be overstated. Narrow the date range or pick one staff member before acting on these numbers.`
  const exportName = (kind: string) =>
    `attendance_${kind}_${from}_${to}${truncated ? '_INCOMPLETE' : ''}.csv`

  function exportSummaryCSV() {
    if (exportBlocked) return
    const rows = summaries.map(s => [
      staffName(s.staffId), s.present, s.late, s.lateMinutes,
      s.absent, s.onLeave, s.halfDay, s.missedClockIn, s.breakOvertimes,
    ])
    if (truncated) rows.push([INCOMPLETE_NOTE])
    downloadCSV(exportName('summary'), toCSV(SUMMARY_HEADERS, rows))
  }

  function exportDetailCSV() {
    if (exportBlocked) return
    const rows = summaries.flatMap(s => s.days.map(d => [
      staffName(s.staffId),
      d.date,
      weekdayShort(d.date),
      shiftLabel(d),
      d.clockIn ? fmtClockOn(d.clockIn, d.date) : '—',
      d.clockOut ? fmtClockOn(d.clockOut, d.date) : '—',
      fmtWorked(d.workedMinutes),
      breakCellText(breakAt(d, 1)),
      breakCellText(breakAt(d, 2)),
      d.lateMinutes > 0 ? `+${d.lateMinutes}m` : '',
      statusText(d),
      d.distanceM != null ? `${d.distanceM}m` : '',
    ]))
    if (truncated) rows.push([INCOMPLETE_NOTE])
    downloadCSV(exportName('detail'), toCSV(DETAIL_HEADERS, rows))
  }

  const selectCls = 'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

  return (
    <div className="space-y-4">
      {/* Range presets */}
      <div className="flex flex-wrap items-center gap-2">
        {RANGE_PRESETS.map(p => (
          <button
            key={p.key}
            onClick={() => applyPreset(p.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${
              preset === p.key
                ? 'bg-[#C4813A] text-white border-[#C4813A]'
                : 'bg-white text-brown-muted border-[#D4C5B0] hover:bg-[#F5EDE0]'
            }`}
          >
            {p.label}
          </button>
        ))}
        <input
          type="date"
          value={from}
          onChange={e => { setFrom(e.target.value); setPreset('custom') }}
          className={selectCls}
        />
        <span className="text-xs text-brown-faint">to</span>
        <input
          type="date"
          value={to}
          onChange={e => { setTo(e.target.value); setPreset('custom') }}
          className={selectCls}
        />
      </div>

      {/* Staff / branch / department + exports */}
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={filterStaff} onChange={e => setFilterStaff(e.target.value)}>
          <option value="">All staff</option>
          {scopeStaff.map(s => <option key={s.id} value={s.id}>{s.status === 'resigned' ? `${s.name} (resigned)` : s.name}</option>)}
        </select>
        <select
          className={selectCls}
          value={filterBranch}
          onChange={e => { setFilterBranch(e.target.value); setFilterStaff('') }}
        >
          <option value="">All branches</option>
          {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select
          className={selectCls}
          value={filterDept}
          onChange={e => { setFilterDept(e.target.value); setFilterStaff('') }}
        >
          <option value="">All depts</option>
          {Object.entries(DEPT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button
          onClick={exportSummaryCSV}
          disabled={exportBlocked}
          className="px-3 py-1.5 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          Export Summary CSV
        </button>
        <button
          onClick={exportDetailCSV}
          disabled={exportBlocked}
          className="px-3 py-1.5 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          Export Detail CSV
        </button>
        {loading && <span className="text-xs text-brown-faint">Loading…</span>}
      </div>

      {error && (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>
      )}

      {truncated && (
        <p className="text-xs text-[#9E4A30] bg-[#FDF3F0] rounded-lg px-3 py-2">
          This range passed the {REPORT_MAX_ROWS.toLocaleString()}-record ceiling, so some rows were left out. Totals below can be understated <em>and</em> the missed clock-in count overstated, because a day whose attendance row was dropped still counts against its scheduled shift — narrow the date range or pick one staff member before acting on these numbers.
        </p>
      )}

      {staffIds.length === 0 ? (
        <div className="bg-white rounded-xl border border-[#E8DDD0] px-4 py-8 text-center">
          <p className="text-sm text-brown-muted font-medium">No staff match these filters.</p>
          <p className="text-xs text-brown-faint mt-1">Try clearing the branch or department filter.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
          <table className="text-xs min-w-max w-full">
            <thead>
              <tr className="border-b border-[#EDE5D8]">
                <th className="text-left px-3 py-2 font-semibold text-brown-faint">Staff</th>
                <th className="px-3 py-2 font-semibold text-brown-faint text-center">Present</th>
                <th className="px-3 py-2 font-semibold text-brown-faint text-center">Late</th>
                <th className="px-3 py-2 font-semibold text-brown-faint text-center">Late mins</th>
                <th className="px-3 py-2 font-semibold text-brown-faint text-center">Absent</th>
                <th className="px-3 py-2 font-semibold text-brown-faint text-center">Leave</th>
                <th className="px-3 py-2 font-semibold text-brown-faint text-center">Half day</th>
                <th className="px-3 py-2 font-semibold text-brown-faint text-center">Missed clock-in</th>
                <th className="px-3 py-2 font-semibold text-brown-faint text-center">Break OT</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map(s => {
                const open = expanded === s.staffId
                return (
                  <Fragment key={s.staffId}>
                    <tr
                      onClick={() => setExpanded(open ? null : s.staffId)}
                      className="border-t border-[#F0E8DC] cursor-pointer hover:bg-[#FBF7F0] transition-colors"
                    >
                      <td className="px-3 py-2 font-medium text-brown-dark whitespace-nowrap">
                        <span className="flex items-center gap-1.5">
                          {open
                            ? <ChevronDown size={13} className="text-brown-faint" />
                            : <ChevronRight size={13} className="text-brown-faint" />}
                          {staffName(s.staffId)}
                        </span>
                      </td>
                      <CountCell value={s.present} />
                      <CountCell value={s.late} warnColor="#C4813A" />
                      <CountCell value={s.lateMinutes} warnColor="#C4813A" />
                      <CountCell value={s.absent} warnColor="#9E4A30" />
                      <CountCell value={s.onLeave} />
                      <CountCell value={s.halfDay} />
                      <CountCell value={s.missedClockIn} warnColor="#9E4A30" />
                      <CountCell value={s.breakOvertimes} warnColor="#C4813A" />
                    </tr>
                    {open && (
                      <tr className="border-t border-[#F0E8DC] bg-[#FDFBF7]">
                        <td colSpan={9} className="px-3 py-3">
                          <DailyDetailTable days={s.days} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function DailyDetailTable({ days }: { days: DailyDetail[] }) {
  if (days.length === 0) {
    return <p className="text-xs text-brown-faint py-2">No attendance or scheduled shifts in this range.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="text-xs min-w-max w-full">
        <thead>
          <tr className="border-b border-[#EDE5D8]">
            {['Date', 'Day', 'Shift', 'Clock In', 'Clock Out', 'Worked', 'Break 1', 'Break 2', 'Late', 'Status', 'GPS'].map(h => (
              <th key={h} className="text-left px-2.5 py-1.5 font-semibold text-brown-faint whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map(d => {
            const b1 = breakAt(d, 1)
            const b2 = breakAt(d, 2)
            const highDist = d.distanceM != null && d.distanceM > 200
            return (
              <tr
                key={d.date}
                className={`border-t border-[#F0E8DC] ${d.missedClockIn ? 'bg-[#FDF3F0]' : ''}`}
              >
                <td className="px-2.5 py-1.5 text-brown-medium whitespace-nowrap">{d.date}</td>
                <td className="px-2.5 py-1.5 text-brown-faint whitespace-nowrap">{weekdayShort(d.date)}</td>
                <td className="px-2.5 py-1.5 text-brown-medium whitespace-nowrap">{shiftLabel(d)}</td>
                <td className="px-2.5 py-1.5 text-brown-dark whitespace-nowrap">{d.clockIn ? fmtClockOn(d.clockIn, d.date) : '—'}</td>
                <td className="px-2.5 py-1.5 text-brown-dark whitespace-nowrap">{d.clockOut ? fmtClockOn(d.clockOut, d.date) : '—'}</td>
                <td className="px-2.5 py-1.5 text-brown-dark whitespace-nowrap tabular-nums">{fmtWorked(d.workedMinutes)}</td>
                {[b1, b2].map((b, i) => (
                  <td key={i} className="px-2.5 py-1.5 text-brown-medium whitespace-nowrap">
                    {fmtBreakWindow(b)}
                    {b?.isOvertime && <span className="text-[#9E4A30] font-semibold"> +{b.overtimeMinutes}m</span>}
                  </td>
                ))}
                <td className="px-2.5 py-1.5 whitespace-nowrap font-semibold text-[#9E4A30]">
                  {d.lateMinutes > 0 ? `+${d.lateMinutes}m` : ''}
                </td>
                <td className="px-2.5 py-1.5 whitespace-nowrap">
                  <span className="flex items-center gap-1.5">
                    {d.status ? (
                      <span
                        className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={{ background: `${ATTENDANCE_STATUS_COLORS[d.status]}20`, color: ATTENDANCE_STATUS_COLORS[d.status] }}
                      >
                        {ATTENDANCE_STATUS_LABELS[d.status]}
                      </span>
                    ) : (
                      <span className="text-brown-faint">No record</span>
                    )}
                    {d.missedClockIn && (
                      <span
                        className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#FCF0EC] text-[#9E4A30]"
                        title="Scheduled to work but never clocked in"
                      >
                        Missed
                      </span>
                    )}
                  </span>
                </td>
                <td className={`px-2.5 py-1.5 whitespace-nowrap tabular-nums ${highDist ? 'text-[#9E4A30] font-semibold' : 'text-brown-faint'}`}>
                  {d.distanceM != null ? `${d.distanceM}m` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Staff: my attendance ─────────────────────────────────────────────────────

// Exported for tests — the night-shift/midnight behaviour lives entirely in here.
export function MyAttendance({ staff }: { staff: Staff }) {
  const [today, setToday] = useState<Attendance | null>(null)
  const [monthRecords, setMonthRecords] = useState<Attendance[]>([])
  const [clockModal, setClockModal] = useState<'in' | 'out' | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  // Write failures must be shown, not swallowed — a clock-out that silently
  // fails leaves the staff member believing they went home on the record.
  // Unlike successMsg this never auto-dismisses.
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [viewPhoto, setViewPhoto] = useState<string | null>(null)
  const [break1Allowed, setBreak1Allowed] = useState(0)
  const [break2Allowed, setBreak2Allowed] = useState(0)
  const [todayShift, setTodayShift] = useState<ShiftType | null>(null)
  const [todayLeave, setTodayLeave] = useState<ScheduleLeaveType | null>(null)
  const [breaks, setBreaks] = useState<AttendanceBreak[]>([])
  const [breakBusy, setBreakBusy] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // The attendance day this card is acting on. Usually the wall-clock date, but
  // a night shift that ran past midnight holds it on the day the shift STARTED.
  const [attDate, setAttDate] = useState(todayStr())
  // A late clock-in that has been photographed and located but NOT yet written:
  // it is held here until the staff member says why, then written in one upsert
  // carrying the reason, so a late row can never exist without one. `at` is the
  // arrival — the instant the selfie and GPS check passed — held so that time
  // spent choosing a reason cannot rewrite clock_in out of step with
  // late_minutes, which is already fixed at that same instant.
  const [pendingLate, setPendingLate] = useState<
    { result: ClockResult; at: Date; lateMinutes: number; shiftStart: string } | null
  >(null)
  const [savingLate, setSavingLate] = useState(false)
  // A failed late write is reported inside the step, not in the card behind it:
  // the step covers the screen, so the card's banner would be under the dimmer.
  const [lateError, setLateError] = useState<string | null>(null)
  // How many minutes of lateness force a written explanation on top of the
  // tapped code. HR tunes it; the constant is the fallback for a missing or
  // malformed row, because a bad settings value must never make the step
  // unanswerable.
  const [threshold, setThreshold] = useState(DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES)

  useEffect(() => {
    supabase.from('system_rules').select('value').eq('key', 'late_reason_written_threshold')
      .maybeSingle()
      .then(({ data }) => {
        // `system_rules.value` is `text not null`, so a blank string is
        // reachable — and Number('') is 0, a valid-looking lateness threshold
        // that would demand written prose for every late minute. Blank counts
        // as missing, same as anything else that doesn't parse.
        const raw = (data as { value?: string } | null)?.value
        const n = raw != null && raw.trim() !== '' ? Number(raw) : NaN
        if (Number.isFinite(n) && n >= 0) setThreshold(n)
      })
  }, [])

  // Loads the month's records, resolves which attendance day is active, and
  // pulls that day's shift + break allowances. One pass, because the shift
  // lookup depends on the resolved day and the resolved day depends on whether
  // yesterday's session is still open.
  async function load() {
    const now = new Date()
    const wallDate = localDateStr(now)
    const yesterday = prevDateStr(wallDate)
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    // On the 1st of a month yesterday falls in the previous month, so widen the
    // fetch to reach it — the month stats below stay scoped to the month.
    const from = yesterday < monthStart ? yesterday : monthStart

    const { data } = await supabase
      .from('attendance')
      .select('*')
      .eq('staff_id', staff.id)
      .gte('date', from)
      .order('date')
    const rows = (data as Attendance[] | null) ?? []
    setMonthRecords(rows.filter(r => r.date >= monthStart))

    // Yesterday's shift decides whether a night shift is still running;
    // the active day's shift drives the badge and break allowances.
    type ShiftRow = { date: string; leave_type: ScheduleLeaveType | null; shift_type: ShiftType | null }
    const { data: shiftRows } = await supabase
      .from('scheduled_shifts')
      .select('date, leave_type, shift_type:shift_types(*)')
      .eq('staff_id', staff.id)
      .in('date', [yesterday, wallDate])
    const shifts = (shiftRows as ShiftRow[] | null) ?? []
    const shiftFor = (d: string) => shifts.find(s => s.date === d) ?? null

    const prevRow = rows.find(r => r.date === yesterday) ?? null
    const date = resolveAttendanceDate({
      now,
      prevShift: shiftFor(yesterday)?.shift_type ?? null,
      prevOpen: !!prevRow?.clock_in && !prevRow.clock_out,
    })
    setAttDate(date)
    setToday(rows.find(r => r.date === date) ?? null)

    // Break allowances come from the active day's shift (break 1 & 2). With no
    // shift, fall back to the company default rule for break 1 only.
    const active = shiftFor(date)
    const st = active?.shift_type ?? null
    setTodayShift(st)
    setTodayLeave(active?.leave_type ?? null)
    if (st) {
      setBreak1Allowed(st.break1_duration_minutes ?? 0)
      setBreak2Allowed(st.break2_duration_minutes ?? 0)
      return
    }
    const { data: ruleRow } = await supabase
      .from('system_rules')
      .select('value')
      .eq('key', 'default_break_minutes')
      .maybeSingle()
    const ruleVal = ruleRow ? parseInt((ruleRow as { value: string }).value) : NaN
    setBreak1Allowed(Number.isFinite(ruleVal) ? ruleVal : DEFAULT_BREAK_MINUTES)
    setBreak2Allowed(0)
  }

  // Load today's break rows (may be empty, or hold break 1 and/or break 2).
  async function loadBreaks(attendanceId: string | undefined) {
    if (!attendanceId) { setBreaks([]); return }
    const { data } = await supabase
      .from('attendance_breaks')
      .select('*')
      .eq('attendance_id', attendanceId)
      .order('break_number')
    setBreaks((data as AttendanceBreak[]) ?? [])
  }

  useEffect(() => { load() }, [])
  useEffect(() => { loadBreaks(today?.id) }, [today?.id])

  // Break rows by number, and which one is currently in progress.
  const break1 = breaks.find(b => b.break_number === 1) ?? null
  const break2 = breaks.find(b => b.break_number === 2) ?? null
  const activeBreak = breaks.find(b => b.clock_out_time && !b.clock_in_time) ?? null
  const onBreak = !!activeBreak

  // Tick every second while on break so the countdown stays live.
  useEffect(() => {
    if (!onBreak) return
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [onBreak])

  async function startBreak(breakNumber: 1 | 2, allowed: number) {
    if (!today) return
    setBreakBusy(true)
    setErrorMsg(null)
    const nowIso = new Date().toISOString()
    const outcome = writeOutcome(await supabase.from('attendance_breaks').upsert({
      attendance_id: today.id,
      break_number: breakNumber,
      clock_out_time: nowIso,
    }, { onConflict: 'attendance_id,break_number' }).select())
    setBreakBusy(false)
    if (!outcome.ok) {
      setErrorMsg(`Could not start break ${breakNumber} — ${outcome.reason} Please try again.`)
      return
    }
    setNowMs(Date.now())
    setSuccessMsg(`Break ${breakNumber} started — ${allowed} min allowed ☕`)
    loadBreaks(today.id)
    setTimeout(() => setSuccessMsg(null), 5000)
  }

  async function endBreak(row: AttendanceBreak, allowed: number) {
    if (!row.clock_out_time) return
    setBreakBusy(true)
    setErrorMsg(null)
    const endIso = new Date().toISOString()
    const { durationMinutes, overtimeMinutes, isOvertime } =
      computeBreakOvertime(row.clock_out_time, endIso, allowed)
    const outcome = writeOutcome(await supabase.from('attendance_breaks').update({
      clock_in_time: endIso,
      duration_minutes: durationMinutes,
      overtime_minutes: overtimeMinutes,
      is_overtime: isOvertime,
    }).eq('id', row.id).select())
    setBreakBusy(false)
    if (!outcome.ok) {
      setErrorMsg(`Could not end break ${row.break_number} — ${outcome.reason} Please try again.`)
      return
    }
    setSuccessMsg(
      isOvertime
        ? `Back from break ${row.break_number} — ${durationMinutes} min (${overtimeMinutes} min over) ⚠️`
        : `Back from break ${row.break_number} — ${durationMinutes} min ✓`
    )
    loadBreaks(row.attendance_id)
    setTimeout(() => setSuccessMsg(null), 6000)
  }

  // attendance_guard_late_update() (supabase/migration-2026-09-02-late-reason-
  // notifications.sql) may silently clamp a clock-in's status/late_minutes
  // back to whatever the row already carried, rather than let the write erase
  // a verdict a manager or the system already recorded (an absent sweep, a
  // hand-marked late, an approved leave). The clock-in still lands either
  // way — but when the STORED status disagrees with what this clock-in
  // intended, the staff member is not clean: they were told they clocked in
  // fine while the record they'll be judged on at month end says otherwise,
  // and they cannot fix it themselves (a second update has no clock-in
  // transition and the same guard would refuse it). The returned row is the
  // only place that shows what actually landed — compare it against intent
  // and say so, rather than trusting the lateness this component computed.
  //
  // Three things review caught in the first version of this copy:
  //   - it read as an error even when nothing was wrong. on_leave and
  //     public_holiday are the day's own nature, not a mistake anyone needs
  //     to chase — only absent/half_day/late (a verdict an auto-sweep or a
  //     manager already recorded) genuinely need the staff member to ask
  //     someone to look at it.
  //   - it said "today" unconditionally. resolveAttendanceDate() (shared/lib/
  //     attendance.ts) can hold attDate at YESTERDAY's date on a night shift
  //     that's still running past midnight, so the copy has to check attDate
  //     against the wall-clock date rather than assume it.
  //   - the clamp resets late_minutes in the same statement as status, but
  //     the old copy never said so. Only worth naming when the clamped
  //     status is itself 'late' — that's the one case where the minutes
  //     figure is part of what the reader needs to know; the other clamped
  //     statuses carry no late_minutes of their own interest.
  function clockInClampNote(
    actual: { status: AttendanceStatus; late_minutes: number },
    intendedStatus: AttendanceStatus,
  ): string {
    if (actual.status === intendedStatus) return ''
    const label = ATTENDANCE_STATUS_LABELS[actual.status] ?? actual.status
    const subject = attDate === todayStr() ? 'Your attendance today' : 'Your attendance for that shift'
    // on_leave/public_holiday are simply what the day already was — clocking
    // in didn't erase anything and nothing needs correcting, so this must not
    // read like the absent/half_day/late branch below.
    if (actual.status === 'on_leave' || actual.status === 'public_holiday') {
      return ` ${subject} is recorded as ${label} — that's the day's schedule, nothing to fix.`
    }
    const minutesNote = actual.status === 'late' ? ` (${actual.late_minutes} min)` : ''
    return ` ${subject} is still recorded as ${label}${minutesNote} — ask your manager to correct it.`
  }

  // The one and only clock-in write, shared by the punctual and the late path so
  // the two can never drift. `.select()` is not optional: without it a row
  // rejected by RLS is indistinguishable from a successful write — writeOutcome().
  // Returns the row the database actually saved (not just proof one landed) —
  // see clockInClampNote() above for why the caller needs both status AND
  // late_minutes off that row, not just status.
  async function writeClockIn(
    now: Date,
    result: ClockResult,
    lateness: { isLate: boolean; lateMinutes: number },
    reasonCode: LateReasonCode | null,
    reasonNote: string,
  ): Promise<WriteOutcomeWithRow<{ status: AttendanceStatus; late_minutes: number }>> {
    const payload: Record<string, unknown> = {
      staff_id: staff.id,
      date: attDate,
      clock_in: now.toISOString(),
      status: lateness.isLate ? 'late' : 'present',
      late_minutes: lateness.lateMinutes,
      clock_in_photo_url: result.photoUrl,
      clock_in_lat: result.lat,
      clock_in_lng: result.lng,
      clock_in_distance_m: result.distanceM,
    }
    // late_reason_code/late_reason are append-only in the database now —
    // changing a recorded reason raises. Sending explicit nulls here is
    // harmless today because canClockIn only ever lets this run as an
    // INSERT, but a future UI path that re-upserts an existing row would
    // turn a punctual clock-in into a hard "changed the reason to null"
    // failure. Omit the keys outright when there's no reason to record,
    // rather than nulling them.
    if (reasonCode !== null) {
      payload.late_reason_code = reasonCode
      payload.late_reason = reasonNote || null
    }
    return writeOutcomeWithRow<{ status: AttendanceStatus; late_minutes: number }>(await supabase.from('attendance').upsert(
      payload,
      { onConflict: 'staff_id,date' }
    ).select())
  }

  // Writes the held-back late clock-in, reason and all, in that single upsert.
  async function handleLateReason({ code, note }: { code: LateReasonCode; note: string }) {
    if (!pendingLate) return
    const now = pendingLate.at
    setLateError(null)
    setSavingLate(true)
    const lateness = { isLate: true, lateMinutes: pendingLate.lateMinutes }
    const outcome = await writeClockIn(now, pendingLate.result, lateness, code, note)
    setSavingLate(false)
    if (!outcome.ok) {
      setLateError(
        `Clock in FAILED — ${outcome.reason} Nothing was saved. Please try again, ` +
        `and tell your manager if it keeps failing.`
      )
      return   // keep the step open; the typed reason is not thrown away
    }
    // The attendance row is already saved at this point — the staff member is
    // standing at the door and must be clocked in regardless of what happens
    // next. So this is fire-and-forget from the UI's perspective — a failure
    // is reported, never allowed to undo or block the clock-in above.
    //
    // notify_late() returns jsonb — { enabled, staff, supervisor } — not a
    // plain ok/error, so a clean RPC call still has three different stories
    // to tell:
    //   - enabled: false  → an admin turned attendance_late notifications
    //     off (or the settings row is missing). Nothing is broken; say
    //     nothing about a failure.
    //   - enabled: true, supervisor: 0 → the staff-tier row landed but
    //     nobody in the supervisor tier was reached (no supervisor assigned
    //     and no branch manager fallback, or the supervisor toggles are
    //     off). This is the case that used to be invisible — reading
    //     `.error` alone reported it as a success.
    //   - supervisor >= 1 → normal success, nothing to say.
    const notified = await supabase.rpc('notify_late', {
      p_staff_id: staff.id,
      p_date: attDate,
      p_late_minutes: lateness.lateMinutes,
      p_reason_code: code,
      p_reason: note,
    })
    let notifyNote = ''
    if (notified.error) {
      // The RPC call itself failed — we genuinely don't know who, if anyone,
      // was reached.
      notifyNote = ' Your supervisor could not be notified.'
    } else {
      // No `.error`, but the jsonb payload itself might still be missing or
      // the wrong shape (e.g. notify_late returning NULL). A raw destructure
      // here used to throw AFTER the attendance row was already saved, which
      // left this whole dialog stuck open forever with no error and no way
      // forward — worse than any of the branches below, because the clock-in
      // had actually succeeded. Narrow before reading instead of casting.
      const result = notified.data as { enabled?: unknown; supervisor?: unknown } | null
      if (typeof result?.enabled !== 'boolean' || typeof result.supervisor !== 'number') {
        notifyNote = ' Your supervisor may not have been notified — tell your manager directly.'
      } else if (result.enabled && result.supervisor === 0) {
        notifyNote =
          ' No supervisor was notified — either none is assigned to you ' +
          '(with no branch manager fallback), or supervisor notifications ' +
          'are switched off. Tell your manager directly.'
      }
    }
    setPendingLate(null)
    setLateError(null)
    setSuccessMsg(
      `Clocked in at ${fmtTime(now.toISOString())} — late by ${lateness.lateMinutes} min ⚠️` +
      clockInClampNote(outcome.row, 'late') +
      notifyNote
    )
    load()
    setTimeout(() => setSuccessMsg(null), 5000)
  }

  // Every write below ends in `.select()` on purpose: without it a row rejected
  // by RLS is indistinguishable from a successful write. See writeOutcome().
  async function handleClockDone(type: 'in' | 'out', result: ClockResult) {
    const now = new Date()
    setErrorMsg(null)
    let outcome: WriteOutcome
    if (type === 'in') {
      const lateness = todayShift
        ? calcLateness(now.toISOString(), attDate, todayShift.start_time)
        : { isLate: false, lateMinutes: 0 }
      // A late arrival is held, not written: it goes to the database only once
      // the reason is in hand, in the same upsert.
      if (lateness.isLate && todayShift) {
        setPendingLate({
          result,
          at: now,
          lateMinutes: lateness.lateMinutes,
          shiftStart: fmtTime2(todayShift.start_time),
        })
        setClockModal(null)
        return
      }
      const clockInOutcome = await writeClockIn(now, result, { isLate: false, lateMinutes: 0 }, null, '')
      outcome = clockInOutcome
      if (clockInOutcome.ok) {
        setSuccessMsg(
          `Clocked in at ${fmtTime(now.toISOString())} ✓` +
          clockInClampNote(clockInOutcome.row, 'present')
        )
      }
    } else if (!today) {
      // Previously this returned silently, leaving the modal open with no
      // explanation after the staff member had taken the selfie.
      outcome = { ok: false, reason: 'no open shift was found on this device. Reload the page and try again.' }
    } else {
      outcome = writeOutcome(await supabase.from('attendance').update({
        clock_out: now.toISOString(),
        clock_out_photo_url: result.photoUrl,
        clock_out_lat: result.lat,
        clock_out_lng: result.lng,
        clock_out_distance_m: result.distanceM,
      }).eq('id', today.id).select())
      if (outcome.ok) setSuccessMsg(`Clocked out at ${fmtTime(now.toISOString())} ✓`)
    }

    if (!outcome.ok) {
      setErrorMsg(
        `Clock ${type === 'in' ? 'in' : 'out'} FAILED — ${outcome.reason} ` +
        `Nothing was saved. Please try again, and tell your manager if it keeps failing.`
      )
    }
    setClockModal(null)
    load()
    if (outcome.ok) setTimeout(() => setSuccessMsg(null), 5000)
  }

  const present = monthRecords.filter(r => r.status === 'present').length
  // M5: this must agree with Reviews.countLateDays, which excludes an
  // excused lateness from the score — otherwise a staff member sees "Late: 3"
  // here while their review reads late_count: 1, the exact month-end
  // mismatch this whole late-reason/excuse feature exists to prevent. The
  // prominent number is the one that actually drives the score (non-excused);
  // excusedLate keeps the excused days visible rather than dropping them —
  // shown as a small note under the tile below, and per-day in the list.
  const late = monthRecords.filter(r => r.status === 'late' && !r.late_excused).length
  const excusedLate = monthRecords.filter(r => r.status === 'late' && r.late_excused).length
  const absent = monthRecords.filter(r => r.status === 'absent').length

  const canClockIn = !today?.clock_in
  const canClockOut = !!today?.clock_in && !today?.clock_out
  // Past midnight on a night shift: the card is showing yesterday's day, not today's.
  const isCarryover = attDate !== todayStr()

  // Which breaks are available given clock state + shift allowances.
  const clockedInNotOut = !!today?.clock_in && !today?.clock_out
  const break1Complete = !!break1?.clock_in_time
  // Break section shows at all only if this shift has any break, or a row exists.
  const hasAnyBreak = break1Allowed > 0 || break2Allowed > 0 || breaks.length > 0
  // Break 2 only unlocks once break 1 is complete AND the shift defines a break 2.
  const break2Unlocked = break2Allowed > 0 && break1Complete

  const allowedFor = (n: 1 | 2) => (n === 1 ? break1Allowed : break2Allowed)
  const breakDeadlineMs = activeBreak?.clock_out_time
    ? new Date(activeBreak.clock_out_time).getTime() + allowedFor(activeBreak.break_number) * 60000
    : 0
  const breakRemainingMs = breakDeadlineMs - nowMs
  const breakOver = onBreak && breakRemainingMs < 0
  function fmtCountdown(ms: number): string {
    const sign = ms < 0 ? '-' : ''
    const total = Math.floor(Math.abs(ms) / 1000)
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${sign}${m}:${String(s).padStart(2, '0')}`
  }

  return (
    <div className="space-y-5">
      {clockModal && (
        <ClockModal
          type={clockModal}
          staffBranch={staff.branch}
          staffId={staff.id}
          onDone={result => handleClockDone(clockModal, result)}
          onCancel={() => setClockModal(null)}
        />
      )}
      {pendingLate && (
        <LateReasonStep
          lateMinutes={pendingLate.lateMinutes}
          shiftStart={pendingLate.shiftStart}
          thresholdMinutes={threshold}
          saving={savingLate}
          error={lateError}
          onSubmit={handleLateReason}
        />
      )}
      {viewPhoto && <PhotoViewer url={viewPhoto} onClose={() => setViewPhoto(null)} />}

      {/* Today's clock card */}
      <div className="bg-white rounded-2xl border border-[#E8DDD0] overflow-hidden">
        <div className="px-5 pt-5 pb-4">
          <p className="text-xs text-brown-faint uppercase tracking-widest font-semibold mb-1">
            {isCarryover ? 'Current shift' : 'Today'}
          </p>
          <p className="text-lg font-bold text-brown-dark">
            {new Date(`${attDate}T00:00:00`).toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          {todayShift ? (
            <div
              className="inline-flex items-center gap-2 mt-2 px-3 py-1.5 rounded-lg text-xs font-semibold"
              style={{
                background: `${DEPT_SHIFT_COLORS[todayShift.department] ?? todayShift.color}18`,
                border: `1px solid ${DEPT_SHIFT_COLORS[todayShift.department] ?? todayShift.color}50`,
                color: DEPT_SHIFT_COLORS[todayShift.department] ?? todayShift.color,
              }}
            >
              <span>{todayShift.name}</span>
              <span className="opacity-80 font-normal">
                {fmtTime2(todayShift.start_time)} – {fmtTime2(todayShift.end_time)}
              </span>
            </div>
          ) : todayLeave ? (
            <p className="mt-2 text-xs font-semibold" style={{ color: '#8B7355' }}>
              🌴 {SCHEDULE_LEAVE_LABELS[todayLeave] ?? todayLeave}
            </p>
          ) : (
            <p className="mt-2 text-xs text-brown-faint">No shift scheduled today</p>
          )}

          {isCarryover && (
            <p className="mt-2 text-xs font-medium text-[#C4813A]">
              🌙 Night shift running past midnight — clock out here to close it.
            </p>
          )}

          {today?.clock_in ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#3D7A50]" />
                  <span className="text-sm text-brown-medium">
                    Clocked in at <span className="font-semibold text-brown-dark">{fmtTime(today.clock_in)}</span>
                  </span>
                  {today.clock_in_photo_url && (
                    <button onClick={() => setViewPhoto(today.clock_in_photo_url!)} className="relative group">
                      <img src={today.clock_in_photo_url} alt="In" className="w-8 h-8 rounded-lg object-cover border border-[#3D7A50]" />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg transition-colors" />
                    </button>
                  )}
                </div>
                {today.clock_in_distance_m != null && (
                  <span className="text-xs text-[#3D7A50] bg-[#EBF5EE] px-2 py-0.5 rounded-full flex items-center gap-1">
                    <MapPin size={9} />{today.clock_in_distance_m}m from branch
                  </span>
                )}
                {today.status === 'late' && (today.late_minutes ?? 0) > 0 && (
                  <span className="text-xs text-[#9E4A30] bg-[#FCF0EC] px-2 py-0.5 rounded-full font-semibold">
                    Late by {today.late_minutes} min
                  </span>
                )}
              </div>
              {today.clock_out && (
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#C4813A]" />
                    <span className="text-sm text-brown-medium">
                      Clocked out at <span className="font-semibold text-brown-dark">{fmtTime(today.clock_out)}</span>
                    </span>
                    {today.clock_out_photo_url && (
                      <button onClick={() => setViewPhoto(today.clock_out_photo_url!)} className="relative group">
                        <img src={today.clock_out_photo_url} alt="Out" className="w-8 h-8 rounded-lg object-cover border border-[#C4813A]" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 rounded-lg transition-colors" />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-brown-faint">Not clocked in yet.</p>
          )}

          {successMsg && (
            <div className="mt-3 flex items-center gap-2 bg-[#EBF5EE] text-[#2E5E3A] text-sm font-medium px-3 py-2 rounded-xl">
              <CheckCircle size={15} />
              {successMsg}
            </div>
          )}

          {errorMsg && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 bg-[#FCF0EC] text-[#9E4A30] text-sm font-medium px-3 py-2 rounded-xl border border-[#E8BCAE]"
            >
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Clock buttons */}
        <div className="grid grid-cols-2 border-t border-[#F0E8DC]">
          <button
            onClick={() => setClockModal('in')}
            disabled={!canClockIn}
            className="py-4 flex flex-col items-center gap-1 text-sm font-bold text-[#3D7A50] hover:bg-[#EBF5EE] disabled:opacity-35 disabled:cursor-not-allowed transition-colors border-r border-[#F0E8DC]"
          >
            <span className="text-2xl">🕘</span>
            Clock In
          </button>
          <button
            onClick={() => setClockModal('out')}
            disabled={!canClockOut}
            className="py-4 flex flex-col items-center gap-1 text-sm font-bold text-[#C4813A] hover:bg-[#FBF0E6] disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
          >
            <span className="text-2xl">🕔</span>
            Clock Out
          </button>
        </div>

        <div className="px-5 pb-3 pt-1">
          <p className="text-[11px] text-brown-faint text-center">
            Requires GPS location + selfie photo to clock in/out
          </p>
        </div>

        {/* ── Break section (separate from attendance clock) ── */}
        {today?.clock_in && hasAnyBreak && (
          <div className="border-t border-[#F0E8DC] px-5 py-4 space-y-4">
            {([1, 2] as const).map(n => {
              const allowed = allowedFor(n)
              const row = n === 1 ? break1 : break2
              // Skip break 2 entirely if the shift has no break 2 and no row exists.
              if (n === 2 && break2Allowed === 0 && !break2) return null
              // Break 2 is locked until break 1 completes.
              const locked = n === 2 && !break2Unlocked && !break2
              const inProgress = !!row?.clock_out_time && !row?.clock_in_time
              const done = !!row?.clock_in_time
              const canStart = clockedInNotOut && !row && !onBreak && (n === 1 ? break1Allowed > 0 : break2Unlocked)

              return (
                <div key={n}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-brown-faint uppercase tracking-widest font-semibold flex items-center gap-1.5">
                      <Coffee size={13} /> Break {n}
                    </p>
                    {!done && <span className="text-[11px] text-brown-faint">{allowed} min allowed</span>}
                  </div>

                  {locked && (
                    <p className="text-xs text-brown-faint italic px-1">Available after Break 1.</p>
                  )}

                  {inProgress && (
                    <div className={`mb-2 rounded-xl px-4 py-3 text-center ${breakOver ? 'bg-[#FDF3F0]' : 'bg-[#FBF0E6]'}`}>
                      <p className={`text-2xl font-bold tabular-nums ${breakOver ? 'text-[#9E4A30]' : 'text-[#C4813A]'}`}>
                        {fmtCountdown(breakRemainingMs)}
                      </p>
                      <p className={`text-xs mt-0.5 ${breakOver ? 'text-[#9E4A30]' : 'text-brown-faint'}`}>
                        {breakOver ? 'Over allowed break time — please clock back in' : 'Time remaining'}
                      </p>
                    </div>
                  )}

                  {done && (
                    <div className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-xl ${
                      row?.is_overtime ? 'bg-[#FDF3F0] text-[#9E4A30]' : 'bg-[#EBF5EE] text-[#2E5E3A]'
                    }`}>
                      {row?.is_overtime ? <AlertTriangle size={14} /> : <CheckCircle size={14} />}
                      Break {n} taken: {row?.duration_minutes ?? 0} min
                      {row?.is_overtime ? ` · ${row?.overtime_minutes} min over limit` : ' · on time'}
                    </div>
                  )}

                  {!done && !locked && (
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => startBreak(n, allowed)}
                        disabled={!canStart || breakBusy}
                        className="py-3 flex flex-col items-center gap-0.5 rounded-xl border border-[#C4813A40] text-sm font-bold text-[#C4813A] bg-[#FBF0E6] hover:bg-[#F6E6D4] disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
                      >
                        <span className="text-lg">☕</span>
                        Break {n} Clock-Out
                      </button>
                      <button
                        onClick={() => row && endBreak(row, allowed)}
                        disabled={!inProgress || breakBusy}
                        className="py-3 flex flex-col items-center gap-0.5 rounded-xl border border-[#3D7A5040] text-sm font-bold text-[#3D7A50] bg-[#EBF5EE] hover:bg-[#DCEFE2] disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
                      >
                        <span className="text-lg">🔙</span>
                        Break {n} Clock-In
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Monthly stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0] text-center">
          <p className="text-2xl font-bold text-[#3D7A50]">{present}</p>
          <p className="text-xs text-brown-faint mt-0.5">Present</p>
        </div>
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0] text-center">
          <p className="text-2xl font-bold text-[#C4813A]">{late}</p>
          <p className="text-xs text-brown-faint mt-0.5">Late</p>
          {/* Excused days aren't folded into the count above (it must match
              what Reviews.countLateDays feeds into the score), but they
              aren't hidden either — surfaced here, and per-day below. */}
          {excusedLate > 0 && (
            <p className="text-[10px] font-medium text-[#3D7A50] mt-1">+{excusedLate} excused</p>
          )}
        </div>
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0] text-center">
          <p className="text-2xl font-bold text-[#9E4A30]">{absent}</p>
          <p className="text-xs text-brown-faint mt-0.5">Absent</p>
        </div>
      </div>

      {/* Monthly list */}
      <div>
        <p className="text-sm font-semibold text-brown-dark mb-2">This Month</p>
        <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
          {monthRecords.length === 0 ? (
            <p className="px-4 py-6 text-xs text-brown-faint text-center">No attendance records yet this month.</p>
          ) : (
            monthRecords.map(r => (
              <div key={r.id} className="flex items-center justify-between px-4 py-2.5 gap-3">
                <span className="text-xs text-brown-medium w-24 flex-shrink-0">{r.date}</span>
                <span
                  className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: `${ATTENDANCE_STATUS_COLORS[r.status]}20`, color: ATTENDANCE_STATUS_COLORS[r.status] }}
                >
                  {ATTENDANCE_STATUS_LABELS[r.status]}{r.status === 'late' && r.late_minutes ? ` (${r.late_minutes}m)` : ''}
                </span>
                {r.status === 'late' && r.late_excused && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#EEF5EE] text-[#3D7A50] flex-shrink-0">
                    Excused
                  </span>
                )}
                <div className="flex items-center gap-2 ml-auto">
                  {r.clock_in_distance_m != null && (
                    <span className="text-[10px] text-brown-faint flex items-center gap-0.5">
                      <MapPin size={8} />{r.clock_in_distance_m}m
                    </span>
                  )}
                  {r.clock_in_photo_url && (
                    <button onClick={() => setViewPhoto(r.clock_in_photo_url!)} className="flex-shrink-0">
                      <img src={r.clock_in_photo_url} alt="" className="w-7 h-7 rounded object-cover border border-[#E8DDD0]" />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const VIEW_LABELS = { daily: 'Daily', monthly: 'Monthly', report: 'Report' } as const

export default function HrAttendancePage() {
  const { staff } = useAuth()
  const { can, ownBranchOnly } = useCan()
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const [view, setView] = useState<'daily' | 'monthly' | 'report'>('daily')
  const canSeeTeam = can('manage_hr')

  useEffect(() => {
    supabase.from('staff').select('*').order('name').then(({ data }) => { if (data) setAllStaff(data as Staff[]) })
  }, [])

  if (!staff) return null

  // Supervisors (no all_branches capability) only see their own branch's team.
  const scopedStaff = ownBranchOnly && staff.branch_id
    ? allStaff.filter(s => s.branch_id === staff.branch_id)
    : allStaff

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-5xl mx-auto px-4 py-8 lg:px-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Attendance</h1>
          <p className="text-sm text-brown-faint mt-0.5">Clock in/out and track attendance.</p>
        </div>

        <section>
          <h2 className="text-base font-bold text-brown-dark mb-3">My Attendance</h2>
          <MyAttendance staff={staff} />
        </section>

        {canSeeTeam && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-bold text-brown-dark">Team Attendance</h2>
              <div className="flex gap-1 bg-white rounded-lg border border-[#E8DDD0] p-0.5">
                {(['daily', 'monthly', 'report'] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                      view === v ? 'bg-[#C4813A] text-white' : 'text-brown-muted hover:bg-[#F5EDE0]'
                    }`}
                  >
                    {VIEW_LABELS[v]}
                  </button>
                ))}
              </div>
            </div>
            {view === 'daily' ? (
              <DailyRoster allStaff={scopedStaff} managerId={staff.id} />
            ) : view === 'monthly' ? (
              <MonthlyGrid allStaff={scopedStaff} />
            ) : (
              <AttendanceReport allStaff={scopedStaff} />
            )}
          </section>
        )}
      </div>
    </div>
  )
}
