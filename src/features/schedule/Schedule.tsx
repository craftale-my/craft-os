import { useState, useEffect } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import type { Staff, ShiftType, ScheduledShift } from '../../shared/types'
import { BRANCHES, DEPT_LABELS, DEPT_SHIFT_COLORS } from '../../shared/types'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Avatar } from '../../shared/components/Avatar'

// ─── Date utilities ───────────────────────────────────────────────────────────

function getWeekStart(d: Date): Date {
  const date = new Date(d)
  const day = date.getDay()
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1))
  date.setHours(0, 0, 0, 0)
  return date
}

function getWeekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    return d
  })
}

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0]
}

function isToday(d: Date): boolean {
  return toDateStr(d) === toDateStr(new Date())
}

function fmtTime(t: string): string {
  const [h, m] = t.split(':')
  const hour = parseInt(h)
  return `${hour % 12 || 12}:${m}${hour >= 12 ? 'pm' : 'am'}`
}

function shiftHours(st: ShiftType): number {
  const [sh, sm] = st.start_time.split(':').map(Number)
  const [eh, em] = st.end_time.split(':').map(Number)
  const breakMins = st.break_minutes ?? 0
  return ((eh * 60 + em) - (sh * 60 + sm) - breakMins) / 60
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// ─── Shift badge ──────────────────────────────────────────────────────────────

function ShiftBadge({ shiftType, size = 'sm' }: { shiftType: ShiftType; size?: 'sm' | 'md' }) {
  const color = DEPT_SHIFT_COLORS[shiftType.department] ?? shiftType.color
  return (
    <div
      className={`rounded-lg leading-tight ${size === 'md' ? 'px-3 py-1.5' : 'px-2 py-1'}`}
      style={{ background: `${color}18`, border: `1px solid ${color}50`, color }}
    >
      <p className={`font-semibold ${size === 'md' ? 'text-xs' : 'text-[10px]'}`}>{shiftType.name}</p>
      <p className={`opacity-80 ${size === 'md' ? 'text-xs' : 'text-[10px]'}`}>
        {fmtTime(shiftType.start_time)}–{fmtTime(shiftType.end_time)}
      </p>
    </div>
  )
}

// ─── Assign shift modal ───────────────────────────────────────────────────────

function AssignModal({
  staff,
  date,
  shiftTypes,
  current,
  onAssign,
  onClose,
}: {
  staff: Staff
  date: Date
  shiftTypes: ShiftType[]
  current: ScheduledShift | null
  onAssign: (shiftTypeId: string | null) => void
  onClose: () => void
}) {
  const active = shiftTypes.filter(st => st.is_active)

  // Group by department
  const grouped: Record<string, ShiftType[]> = {}
  active.forEach(st => {
    if (!grouped[st.department]) grouped[st.department] = []
    grouped[st.department].push(st)
  })

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50">
      <div className="w-full sm:max-w-sm bg-white rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#F0E8DC]">
          <div>
            <p className="font-bold text-brown-dark text-sm">{staff.name}</p>
            <p className="text-xs text-brown-faint">
              {date.toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'short' })}
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-brown-faint hover:text-brown-dark">
            <X size={20} />
          </button>
        </div>

        <div className="px-4 py-4 max-h-[60vh] overflow-y-auto space-y-4">
          {Object.entries(grouped).map(([dept, shifts]) => (
            <div key={dept}>
              <p className="text-[10px] font-bold text-brown-faint uppercase tracking-widest px-1 mb-1.5">
                {DEPT_LABELS[dept] ?? dept}
              </p>
              <div className="space-y-1">
                {shifts.map(st => {
                  const isSelected = current?.shift_type_id === st.id
                  const color = DEPT_SHIFT_COLORS[st.department] ?? st.color
                  return (
                    <button
                      key={st.id}
                      onClick={() => onAssign(st.id)}
                      className="w-full text-left px-3 py-2 rounded-xl transition-colors flex items-center justify-between"
                      style={isSelected
                        ? { background: `${color}18`, border: `1px solid ${color}60` }
                        : { background: '#F9F4EE', border: '1px solid transparent' }
                      }
                    >
                      <div>
                        <p className="text-sm font-semibold" style={{ color: isSelected ? color : '#3D2410' }}>
                          {st.name}
                        </p>
                        <p className="text-xs text-brown-faint">
                          {fmtTime(st.start_time)} – {fmtTime(st.end_time)}
                          {st.break_minutes > 0 && ` · Break ${st.break_minutes}min`}
                        </p>
                      </div>
                      {isSelected && <span className="text-xs font-bold" style={{ color }}>✓</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}

          {current && (
            <button
              onClick={() => onAssign(null)}
              className="w-full py-2.5 text-sm text-[#9E4A30] font-medium border border-[#F0C5B8] bg-[#FDF3F0] rounded-xl hover:bg-[#FCE8E3] transition-colors"
            >
              Remove shift (mark as Off)
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Week view ────────────────────────────────────────────────────────────────

function WeekView({
  allStaff,
  shiftTypes,
  weekDays,
  shiftMap,
  filterBranch,
  filterDept,
  setFilterBranch,
  setFilterDept,
  onCellClick,
  saving,
}: {
  allStaff: Staff[]
  shiftTypes: ShiftType[]
  weekDays: Date[]
  shiftMap: Record<string, Record<string, ScheduledShift>>
  filterBranch: string
  filterDept: string
  setFilterBranch: (v: string) => void
  setFilterDept: (v: string) => void
  onCellClick: (staff: Staff, date: Date) => void
  saving: boolean
}) {
  // Gap detection: count scheduled per shiftType per day
  const gapMap: Record<string, Record<string, number>> = {}
  Object.values(shiftMap).forEach(byDate => {
    Object.entries(byDate).forEach(([date, shift]) => {
      if (!gapMap[date]) gapMap[date] = {}
      gapMap[date][shift.shift_type_id] = (gapMap[date][shift.shift_type_id] ?? 0) + 1
    })
  })

  const visibleStaff = allStaff.filter(s => {
    if (filterBranch && s.branch !== filterBranch) return false
    if (filterDept && s.department !== filterDept) return false
    return true
  })

  const selectCls = 'px-3 py-1.5 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <select className={selectCls} value={filterBranch} onChange={e => setFilterBranch(e.target.value)}>
          <option value="">All branches</option>
          {BRANCHES.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className={selectCls} value={filterDept} onChange={e => setFilterDept(e.target.value)}>
          <option value="">All departments</option>
          {Object.entries(DEPT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {saving && <span className="text-xs text-brown-faint self-center">Saving…</span>}
      </div>

      <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
        <table className="min-w-max w-full text-xs">
          <thead>
            <tr className="border-b border-[#EDE5D8]">
              <th className="text-left px-3 py-2.5 font-semibold text-brown-faint sticky left-0 bg-white min-w-[140px]">
                Staff
              </th>
              {weekDays.map((d, i) => (
                <th
                  key={i}
                  className={`px-2 py-2.5 text-center font-semibold min-w-[110px] ${
                    isToday(d) ? 'text-[#C4813A]' : 'text-brown-faint'
                  }`}
                >
                  <div>{DAY_LABELS[i]}</div>
                  <div className={`text-[11px] font-normal ${isToday(d) ? 'text-[#C4813A]' : 'text-brown-faint'}`}>
                    {d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })}
                    {isToday(d) && ' •'}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleStaff.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center py-8 text-brown-faint">No staff found.</td>
              </tr>
            )}
            {visibleStaff.map((s, i) => (
              <tr key={s.id} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                <td className="px-3 py-2 sticky left-0 bg-white">
                  <div className="flex items-center gap-2">
                    <Avatar name={s.name} avatar={s.avatar} size="sm" />
                    <div className="min-w-0">
                      <p className="font-medium text-brown-dark truncate max-w-[90px]">{s.name}</p>
                      <p className="text-[10px] text-brown-faint truncate">{s.branch?.split(' ')[0] ?? '—'}</p>
                    </div>
                  </div>
                </td>
                {weekDays.map((d, di) => {
                  const ds = toDateStr(d)
                  const shift = shiftMap[s.id]?.[ds]
                  const st = shift ? shiftTypes.find(x => x.id === shift.shift_type_id) : null
                  return (
                    <td key={di} className="px-1.5 py-1.5 align-top">
                      <button
                        onClick={() => onCellClick(s, d)}
                        className={`w-full min-h-[52px] rounded-lg transition-colors text-left ${
                          st ? 'hover:opacity-80' : 'hover:bg-[#F5EDE0] border border-dashed border-[#E0D4C0]'
                        }`}
                      >
                        {st ? (
                          <ShiftBadge shiftType={st} />
                        ) : (
                          <span className="text-[10px] text-brown-faint p-2 block">Off</span>
                        )}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Staffing summary per day */}
      <div className="grid grid-cols-7 gap-1">
        {weekDays.map((d, i) => {
          const ds = toDateStr(d)
          const dayCount = Object.values(gapMap[ds] ?? {}).reduce((a, b) => a + b, 0)
          return (
            <div
              key={i}
              className={`text-center p-2 rounded-lg text-[10px] ${
                isToday(d) ? 'bg-[#FBF0E6] border border-[#C4813A40]' : 'bg-white border border-[#E8DDD0]'
              }`}
            >
              <p className="font-bold text-brown-dark">{dayCount}</p>
              <p className="text-brown-faint">staff</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Day view ─────────────────────────────────────────────────────────────────

function DayView({
  allStaff,
  shiftTypes,
  selectedDay,
  setSelectedDay,
  weekDays,
  shiftMap,
  onCellClick,
}: {
  allStaff: Staff[]
  shiftTypes: ShiftType[]
  selectedDay: Date
  setSelectedDay: (d: Date) => void
  weekDays: Date[]
  shiftMap: Record<string, Record<string, ScheduledShift>>
  onCellClick: (staff: Staff, date: Date) => void
}) {
  const ds = toDateStr(selectedDay)
  const dayShifts = shiftMap

  // Group staff by shift type for this day
  const grouped: Record<string, Staff[]> = {}
  const unassigned: Staff[] = []

  allStaff.forEach(s => {
    const shift = dayShifts[s.id]?.[ds]
    if (shift) {
      const key = shift.shift_type_id
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(s)
    } else {
      unassigned.push(s)
    }
  })

  return (
    <div className="space-y-4">
      {/* Day picker */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {weekDays.map((d, i) => (
          <button
            key={i}
            onClick={() => setSelectedDay(d)}
            className={`flex-shrink-0 px-3 py-2 rounded-xl text-xs font-semibold transition-colors ${
              toDateStr(d) === ds
                ? 'bg-[#C4813A] text-white'
                : isToday(d)
                ? 'bg-[#FBF0E6] text-[#C4813A] border border-[#C4813A40]'
                : 'bg-white border border-[#E8DDD0] text-brown-medium hover:bg-[#F5EDE0]'
            }`}
          >
            <div>{DAY_LABELS[i]}</div>
            <div className="font-normal">{d.getDate()}</div>
          </button>
        ))}
      </div>

      <h3 className="text-sm font-bold text-brown-dark">
        {selectedDay.toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long' })}
      </h3>

      {/* Shifts */}
      {shiftTypes.filter(st => st.is_active).map(st => {
        const staffOnShift = grouped[st.id] ?? []
        const color = DEPT_SHIFT_COLORS[st.department] ?? st.color
        return (
          <div key={st.id} className="bg-white rounded-xl border border-[#E8DDD0] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3" style={{ background: `${color}10` }}>
              <div>
                <p className="text-sm font-bold" style={{ color }}>
                  {DEPT_LABELS[st.department] ?? st.department} — {st.name}
                </p>
                <p className="text-xs text-brown-faint mt-0.5">
                  {fmtTime(st.start_time)} – {fmtTime(st.end_time)}
                  {st.break_start && ` · Break ${fmtTime(st.break_start)}–${fmtTime(st.break_end!)}`}
                  {' · '}{shiftHours(st).toFixed(1)}h
                </p>
              </div>
              <span className="text-sm font-bold" style={{ color }}>
                {staffOnShift.length} staff
              </span>
            </div>
            <div className="divide-y divide-[#F0E8DC]">
              {staffOnShift.length === 0 ? (
                <p className="px-4 py-3 text-xs text-brown-faint italic">No staff assigned</p>
              ) : (
                staffOnShift.map(s => (
                  <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Avatar name={s.name} avatar={s.avatar} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-brown-dark">{s.name}</p>
                      <p className="text-xs text-brown-faint">{s.branch?.split(' ')[0]}</p>
                    </div>
                    <button
                      onClick={() => onCellClick(s, selectedDay)}
                      className="text-xs text-brown-faint hover:text-brown-dark transition-colors px-2 py-1 rounded"
                    >
                      Change
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      })}

      {/* Unassigned */}
      {unassigned.length > 0 && (
        <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-hidden">
          <div className="px-4 py-3 bg-[#F5EDE0]">
            <p className="text-sm font-bold text-brown-medium">Unassigned ({unassigned.length})</p>
          </div>
          <div className="divide-y divide-[#F0E8DC]">
            {unassigned.map(s => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <Avatar name={s.name} avatar={s.avatar} size="sm" />
                <p className="text-sm text-brown-medium flex-1">{s.name}</p>
                <button
                  onClick={() => onCellClick(s, selectedDay)}
                  className="text-xs text-[#C4813A] font-medium hover:underline"
                >
                  Assign
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── My schedule view (staff) ─────────────────────────────────────────────────

function MyScheduleView({
  staffId,
  shiftTypes,
}: {
  staffId: string
  shiftTypes: ShiftType[]
}) {
  const [myShifts, setMyShifts] = useState<ScheduledShift[]>([])

  useEffect(() => {
    const today = toDateStr(new Date())
    const future = new Date()
    future.setDate(future.getDate() + 28)
    supabase
      .from('scheduled_shifts')
      .select('*')
      .eq('staff_id', staffId)
      .gte('date', today)
      .lte('date', toDateStr(future))
      .order('date')
      .then(({ data }) => setMyShifts((data as ScheduledShift[]) ?? []))
  }, [staffId])

  const totalHours = myShifts.reduce((sum, s) => {
    const st = shiftTypes.find(x => x.id === s.shift_type_id)
    return sum + (st ? shiftHours(st) : 0)
  }, 0)

  // Group by week
  const weeks: Record<string, ScheduledShift[]> = {}
  myShifts.forEach(s => {
    const d = new Date(s.date)
    const ws = getWeekStart(d)
    const key = toDateStr(ws)
    if (!weeks[key]) weeks[key] = []
    weeks[key].push(s)
  })

  if (myShifts.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-[#E8DDD0] p-8 text-center">
        <p className="text-3xl mb-2">📅</p>
        <p className="text-sm font-semibold text-brown-dark">No upcoming shifts scheduled</p>
        <p className="text-xs text-brown-faint mt-1">Check back later or contact your supervisor.</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-[#E8DDD0] p-4 text-center">
          <p className="text-2xl font-bold text-[#C4813A]">{myShifts.length}</p>
          <p className="text-xs text-brown-faint mt-0.5">Upcoming shifts</p>
        </div>
        <div className="bg-white rounded-xl border border-[#E8DDD0] p-4 text-center">
          <p className="text-2xl font-bold text-[#3D7A50]">{totalHours.toFixed(0)}h</p>
          <p className="text-xs text-brown-faint mt-0.5">Total hours</p>
        </div>
      </div>

      {/* Shifts by week */}
      {Object.entries(weeks).map(([weekKey, shifts]) => {
        const ws = new Date(weekKey)
        const we = new Date(weekKey)
        we.setDate(we.getDate() + 6)
        return (
          <div key={weekKey}>
            <p className="text-xs font-bold text-brown-faint uppercase tracking-widest mb-2">
              {ws.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })} –{' '}
              {we.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })}
            </p>
            <div className="bg-white rounded-xl border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
              {shifts.map(s => {
                const st = shiftTypes.find(x => x.id === s.shift_type_id)
                const d = new Date(s.date + 'T00:00:00')
                const color = st ? (DEPT_SHIFT_COLORS[st.department] ?? st.color) : '#8B7355'
                const today = toDateStr(new Date()) === s.date
                return (
                  <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <div className={`w-1 self-stretch rounded-full flex-shrink-0`} style={{ background: color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-brown-dark">
                          {d.toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short' })}
                        </p>
                        {today && (
                          <span className="text-[10px] font-bold text-white bg-[#C4813A] px-1.5 py-0.5 rounded-full">TODAY</span>
                        )}
                      </div>
                      {st ? (
                        <p className="text-xs mt-0.5" style={{ color }}>
                          {st.name} · {fmtTime(st.start_time)} – {fmtTime(st.end_time)}
                          {' · '}{shiftHours(st).toFixed(1)}h
                        </p>
                      ) : (
                        <p className="text-xs text-brown-faint mt-0.5">Unknown shift</p>
                      )}
                    </div>
                    <span
                      className="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                      style={{ background: `${color}15`, color }}
                    >
                      {s.status}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SchedulePage() {
  const { staff } = useAuth()
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const [shiftTypes, setShiftTypes] = useState<ShiftType[]>([])
  const [weekShifts, setWeekShifts] = useState<ScheduledShift[]>([])
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()))
  const [view, setView] = useState<'week' | 'day'>('week')
  const [selectedDay, setSelectedDay] = useState(new Date())
  const [filterBranch, setFilterBranch] = useState('')
  const [filterDept, setFilterDept] = useState('')
  const [assignTarget, setAssignTarget] = useState<{ staff: Staff; date: Date } | null>(null)
  const [saving, setSaving] = useState(false)

  const weekDays = getWeekDays(weekStart)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekEnd.getDate() + 6)

  const isManager = staff?.rank === 'supervisor' || staff?.rank === 'manager'

  useEffect(() => {
    supabase.from('staff').select('*').order('name').then(({ data }) => {
      // Resigned staff are excluded from scheduling (their historical data is retained elsewhere)
      if (data) setAllStaff((data as Staff[]).filter(s => s.status !== 'resigned'))
    })
    supabase.from('shift_types').select('*').eq('is_active', true).order('department').order('start_time').then(({ data }) => {
      if (data) setShiftTypes(data as ShiftType[])
    })
  }, [])

  useEffect(() => {
    loadShifts()
  }, [weekStart])

  async function loadShifts() {
    const start = toDateStr(weekStart)
    const end = toDateStr(weekEnd)
    const { data } = await supabase
      .from('scheduled_shifts')
      .select('*')
      .gte('date', start)
      .lte('date', end)
    setWeekShifts((data as ScheduledShift[]) ?? [])
  }

  // Build map: staffId → dateStr → ScheduledShift
  const shiftMap: Record<string, Record<string, ScheduledShift>> = {}
  weekShifts.forEach(s => {
    if (!shiftMap[s.staff_id]) shiftMap[s.staff_id] = {}
    shiftMap[s.staff_id][s.date] = s
  })

  async function assignShift(shiftTypeId: string | null) {
    if (!assignTarget || !staff) return
    setSaving(true)
    const ds = toDateStr(assignTarget.date)
    const existing = shiftMap[assignTarget.staff.id]?.[ds]

    if (shiftTypeId === null) {
      if (existing) await supabase.from('scheduled_shifts').delete().eq('id', existing.id)
    } else {
      await supabase.from('scheduled_shifts').upsert({
        staff_id: assignTarget.staff.id,
        shift_type_id: shiftTypeId,
        date: ds,
        status: 'scheduled',
        created_by: staff.id,
      }, { onConflict: 'staff_id,date' })
    }

    setSaving(false)
    setAssignTarget(null)
    loadShifts()
  }

  function prevWeek() {
    const d = new Date(weekStart)
    d.setDate(d.getDate() - 7)
    setWeekStart(d)
  }

  function nextWeek() {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + 7)
    setWeekStart(d)
  }

  function goToday() {
    setWeekStart(getWeekStart(new Date()))
    setSelectedDay(new Date())
  }

  if (!staff) return null

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-6xl mx-auto px-4 py-8 lg:px-8 space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-brown-dark">Schedule</h1>
            <p className="text-sm text-brown-faint mt-0.5">Manage staff shifts for the week.</p>
          </div>

          {isManager && (
            <div className="flex gap-1 bg-white rounded-xl border border-[#E8DDD0] p-0.5">
              {(['week', 'day'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-colors capitalize ${
                    view === v ? 'bg-[#C4813A] text-white' : 'text-brown-muted hover:bg-[#F5EDE0]'
                  }`}
                >
                  {v === 'week' ? 'Week' : 'Day'}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* My schedule (all staff see this) */}
        {!isManager && (
          <section>
            <h2 className="text-base font-bold text-brown-dark mb-3">My Upcoming Schedule</h2>
            <MyScheduleView staffId={staff.id} shiftTypes={shiftTypes} />
          </section>
        )}

        {/* Manager views */}
        {isManager && (
          <>
            {/* My own schedule card */}
            <div className="bg-white rounded-xl border border-[#E8DDD0] px-4 py-3">
              <p className="text-xs font-bold text-brown-faint uppercase tracking-widest mb-2">My Upcoming Shifts</p>
              <MyScheduleView staffId={staff.id} shiftTypes={shiftTypes} />
            </div>

            {/* Week navigation */}
            <div className="flex items-center gap-3">
              <button
                onClick={prevWeek}
                className="p-2 rounded-lg border border-[#E8DDD0] bg-white hover:bg-[#F5EDE0] transition-colors"
              >
                <ChevronLeft size={16} className="text-brown-medium" />
              </button>
              <div className="flex-1 text-center">
                <p className="text-sm font-bold text-brown-dark">
                  {weekStart.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })} –{' '}
                  {weekEnd.toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
              </div>
              <button
                onClick={nextWeek}
                className="p-2 rounded-lg border border-[#E8DDD0] bg-white hover:bg-[#F5EDE0] transition-colors"
              >
                <ChevronRight size={16} className="text-brown-medium" />
              </button>
              <button
                onClick={goToday}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-[#D4C5B0] bg-white text-brown-medium hover:bg-[#F5EDE0] transition-colors"
              >
                Today
              </button>
            </div>

            {view === 'week' ? (
              <WeekView
                allStaff={allStaff}
                shiftTypes={shiftTypes}
                weekDays={weekDays}
                shiftMap={shiftMap}
                filterBranch={filterBranch}
                filterDept={filterDept}
                setFilterBranch={setFilterBranch}
                setFilterDept={setFilterDept}
                onCellClick={(s, d) => setAssignTarget({ staff: s, date: d })}
                saving={saving}
              />
            ) : (
              <DayView
                allStaff={allStaff}
                shiftTypes={shiftTypes}
                selectedDay={selectedDay}
                setSelectedDay={setSelectedDay}
                weekDays={weekDays}
                shiftMap={shiftMap}
                onCellClick={(s, d) => setAssignTarget({ staff: s, date: d })}
              />
            )}
          </>
        )}
      </div>

      {/* Assign modal */}
      {assignTarget && (
        <AssignModal
          staff={assignTarget.staff}
          date={assignTarget.date}
          shiftTypes={shiftTypes}
          current={shiftMap[assignTarget.staff.id]?.[toDateStr(assignTarget.date)] ?? null}
          onAssign={assignShift}
          onClose={() => setAssignTarget(null)}
        />
      )}
    </div>
  )
}
