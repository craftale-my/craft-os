# Attendance Shift Display + Auto Late Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff see today's assigned shift on the Attendance page (and their 4-week My Schedule); clocking in after the shift's start time auto-marks the attendance `late` with `late_minutes`, per `docs/superpowers/specs/2026-07-08-attendance-shift-late-design.md`.

**Architecture:** A pure, unit-tested `calcLateness()` in a new `src/shared/lib/attendance.ts` decides lateness (strict, no grace; sub-minute rounds UP). `MyAttendance` (HrAttendance.tsx) extends its existing today-shift query (`loadBreakAllowance`, which already fetches the row for break allowances) to capture the full shift + leave marker, renders it on the TODAY card, and uses it at clock-in to write `status`/`late_minutes`. Route + sidebar open the existing staff `MyScheduleView` to non-managers. Manager-side display needs NO changes (DailyRoster already has a late-minutes input; monthly history already renders `Late (Xm)`). Zero SQL — `attendance.late_minutes` and the `late` status already exist.

**Tech Stack:** React 19 + TypeScript, Supabase, Vitest.

## Global Constraints

- Strict lateness: clock-in > shift `start_time` ⇒ late, even by 1 second; `lateMinutes = Math.ceil(diffMs/60000)` (30s late ⇒ 1). No shift today ⇒ always `present`, `late_minutes: 0`.
- Lateness baseline built as `new Date(\`${dateStr}T${startTime}\`)` — device-local time, consistent with `todayStr()`/`fmtTime` usage app-wide.
- Do NOT touch: GPS/selfie flow, clock-out logic, manager manual status editing / Mark-all-present, monthly review `late_count`, DailyRoster/MonthlyGrid rendering.
- Existing behavior preserved: break-allowance derivation still works from the same query; leave-marker day with no shift ⇒ no late detection.
- Sidebar must not show a duplicate schedule entry for managers (staff "My Schedule" hidden when user has `manage_schedule`).
- All errors from the extended query surface no worse than today (query already ignores errors; do not add new silent writes — clock-in upsert keeps its current error behavior).

---

## File Structure

| File | Change |
|---|---|
| `src/shared/lib/attendance.ts` | New — `calcLateness` |
| `src/shared/lib/attendance.test.ts` | New — Vitest |
| `src/features/hr/HrAttendance.tsx` | `MyAttendance`: today-shift state + TODAY card line + late-aware clock-in + late chip |
| `src/App.tsx` | `/schedule` route: drop `requireCap` |
| `src/shared/components/Sidebar.tsx` | `hideWithCap` NavItem field + staff "My Schedule" item + STAFF_NAV filtering |

---

## Task 1: `calcLateness` (TDD)

**Files:** Create `src/shared/lib/attendance.ts`, `src/shared/lib/attendance.test.ts`

**Interfaces (Task 2 consumes exactly):**
`export function calcLateness(clockInIso: string, dateStr: string, startTime: string): { isLate: boolean; lateMinutes: number }`

- [ ] **Step 1: Failing tests** — create `src/shared/lib/attendance.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { calcLateness } from './attendance'

// Build ISO strings in LOCAL time so tests are timezone-independent.
const localIso = (dateStr: string, time: string) => new Date(`${dateStr}T${time}`).toISOString()

describe('calcLateness', () => {
  it('is not late when clocking in exactly on time', () => {
    const r = calcLateness(localIso('2026-07-08', '09:30:00'), '2026-07-08', '09:30:00')
    expect(r).toEqual({ isLate: false, lateMinutes: 0 })
  })

  it('is not late when early', () => {
    const r = calcLateness(localIso('2026-07-08', '09:15:00'), '2026-07-08', '09:30:00')
    expect(r).toEqual({ isLate: false, lateMinutes: 0 })
  })

  it('rounds a 30-second lateness up to 1 minute', () => {
    const r = calcLateness(localIso('2026-07-08', '09:30:30'), '2026-07-08', '09:30:00')
    expect(r).toEqual({ isLate: true, lateMinutes: 1 })
  })

  it('reports 12 minutes when 12 minutes late', () => {
    const r = calcLateness(localIso('2026-07-08', '09:42:00'), '2026-07-08', '09:30:00')
    expect(r).toEqual({ isLate: true, lateMinutes: 12 })
  })

  it('handles HH:MM start times (no seconds part)', () => {
    const r = calcLateness(localIso('2026-07-08', '09:31:00'), '2026-07-08', '09:30')
    expect(r).toEqual({ isLate: true, lateMinutes: 1 })
  })
})
```

- [ ] **Step 2:** `npm test -- attendance.test` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/shared/lib/attendance.ts`:

```ts
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
```

- [ ] **Step 4:** `npm test -- attendance.test` → 5/5 PASS; `npm run build` exits 0.
- [ ] **Step 5: Commit** — `git add src/shared/lib/attendance.ts src/shared/lib/attendance.test.ts && git commit -m "feat: calcLateness helper for strict shift-start lateness"`

---

## Task 2: `MyAttendance` — today's shift + late-aware clock-in

**Files:** Modify `src/features/hr/HrAttendance.tsx` only.

**Interfaces:** Consumes `calcLateness` (Task 1), `SCHEDULE_LEAVE_LABELS` + `LeaveType` + `ShiftType` (existing in shared/types), `DEPT_SHIFT_COLORS`.

- [ ] **Step 1: Imports** — add `calcLateness` from `'../../shared/lib/attendance'`; ensure the value import from shared/types includes `SCHEDULE_LEAVE_LABELS` and `DEPT_SHIFT_COLORS`, and the type import includes `LeaveType` (`ShiftType` is already imported).

- [ ] **Step 2: State + query.** In `MyAttendance`, next to the break-allowance state add:

```ts
  const [todayShift, setTodayShift] = useState<ShiftType | null>(null)
  const [todayLeave, setTodayLeave] = useState<LeaveType | null>(null)
```

Replace `loadBreakAllowance()`'s query/derivation (currently selecting `shift_type:shift_types(break1_duration_minutes,break2_duration_minutes)`):

```ts
  async function loadBreakAllowance() {
    const { data: shiftRow } = await supabase
      .from('scheduled_shifts')
      .select('leave_type, shift_type:shift_types(*)')
      .eq('staff_id', staff.id)
      .eq('date', todayStr())
      .maybeSingle()
    const row = shiftRow as { leave_type: LeaveType | null; shift_type: ShiftType | null } | null
    const st = row?.shift_type ?? null
    setTodayShift(st)
    setTodayLeave(row?.leave_type ?? null)
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
```

- [ ] **Step 3: TODAY card shift line.** Directly under the date `<p className="text-lg font-bold text-brown-dark">…toLocaleDateString…</p>`, insert:

```tsx
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
              🌴 {SCHEDULE_LEAVE_LABELS[todayLeave]}
            </p>
          ) : (
            <p className="mt-2 text-xs text-brown-faint">No shift scheduled today</p>
          )}
```

`fmtTime2` formats a `time` column value (`HH:MM[:SS]`) to `9:30am` style. Add near the file's other helpers (the existing `fmtTime` takes an ISO timestamp — check first; if a suitable time-of-day formatter already exists in the file, reuse it instead):

```ts
function fmtTime2(t: string): string {
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`
}
```

- [ ] **Step 4: Late-aware clock-in.** In `handleClockDone`, `type === 'in'` branch, replace the hardcoded status:

```ts
    if (type === 'in') {
      const lateness = todayShift
        ? calcLateness(now.toISOString(), todayStr(), todayShift.start_time)
        : { isLate: false, lateMinutes: 0 }
      await supabase.from('attendance').upsert({
        staff_id: staff.id,
        date: todayStr(),
        clock_in: now.toISOString(),
        status: lateness.isLate ? 'late' : 'present',
        late_minutes: lateness.lateMinutes,
        clock_in_photo_url: result.photoUrl,
        clock_in_lat: result.lat,
        clock_in_lng: result.lng,
        clock_in_distance_m: result.distanceM,
      }, { onConflict: 'staff_id,date' })
      setSuccessMsg(
        lateness.isLate
          ? `Clocked in at ${fmtTime(now.toISOString())} — late by ${lateness.lateMinutes} min ⚠️`
          : `Clocked in at ${fmtTime(now.toISOString())} ✓`
      )
    }
```

- [ ] **Step 5: Late chip on the clocked-in row.** Next to the `{today.clock_in_distance_m != null && (…)}` chip in the clocked-in block, add:

```tsx
                {today.status === 'late' && (today.late_minutes ?? 0) > 0 && (
                  <span className="text-xs text-[#9E4A30] bg-[#FCF0EC] px-2 py-0.5 rounded-full font-semibold">
                    Late by {today.late_minutes} min
                  </span>
                )}
```

- [ ] **Step 6:** `npm run build` exits 0; `npm test` all pass. Hand-trace in the report: on-time clock-in with shift → present/0; 12-min-late → late/12; no shift → present/0; break allowances still derive correctly for shift and no-shift days.
- [ ] **Step 7: Commit** — `git commit -m "feat: show today's shift on attendance; auto-detect late clock-ins"` (only HrAttendance.tsx).

---

## Task 3: Open My Schedule to staff

**Files:** Modify `src/App.tsx` (route), `src/shared/components/Sidebar.tsx`.

- [ ] **Step 1: Route.** In `src/App.tsx`, the `/schedule` route currently:

```tsx
          <ProtectedRoute requireCap="manage_schedule">
            <AppLayout><SchedulePage /></AppLayout>
          </ProtectedRoute>
```

becomes (match the plain logged-in pattern used by `/hr/*` routes — check one for the exact prop shape):

```tsx
          <ProtectedRoute>
            <AppLayout><SchedulePage /></AppLayout>
          </ProtectedRoute>
```

- [ ] **Step 2: Sidebar.** In `Sidebar.tsx`:
  - `NavItem` gains: `/** Hide this item when the user HAS this capability (avoids duplicates with MGMT items). */ hideWithCap?: Capability`
  - `STAFF_NAV` gains, after the missions item:

```ts
  { id: 'my-schedule', label: 'My Schedule', to: '/schedule', icon: CalendarDays, activePaths: ['/schedule'], hideWithCap: 'manage_schedule' },
```

  - In `SidebarContent`, filter staff items and render the filtered list (currently `STAFF_NAV.map(...)` at ~line 139):

```ts
  const staffItems = STAFF_NAV.filter(i => (!i.cap || can(i.cap)) && (!i.hideWithCap || !can(i.hideWithCap)))
```

  and change `{STAFF_NAV.map(item => (` to `{staffItems.map(item => (`.

- [ ] **Step 3:** `npm run build` exits 0; `npm test` pass. Hand-trace: manager → MGMT "Schedule" only (staff item hidden by cap); staff → "My Schedule" visible, `/schedule` reachable and renders `MyScheduleView` (SchedulePage's non-manager branch — verify the page's own `isManager` logic gates manager-only sections, and note what a staff user sees).
- [ ] **Step 4: Commit** — `git commit -m "feat: staff can view their own schedule"` (App.tsx + Sidebar.tsx only).

---

## Task 4: Controller — verify, ship

- Full `npm test` + build; final whole-branch review (opus); merge → `vercel deploy --prod --yes` → bundle-hash check → `git push origin main` → confirm 0 ahead.
- User acceptance: NO 2 clocks in late against a scheduled shift → TODAY card shows shift badge + Late chip; staff sidebar shows My Schedule.
