# Schedule Leave Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let managers assign five leave types directly in the schedule's shift picker; the day's attendance syncs to `on_leave`, per `docs/superpowers/specs/2026-07-07-schedule-leave-assignment-design.md`.

**Architecture:** `scheduled_shifts` rows become either a work shift (`shift_type_id`) or a leave marker (`leave_type`) — enforced by a DB check constraint. A small pure helper (`shouldClearLeaveAttendance`, unit-tested) decides when replacing a leave marker may delete the day's auto-created attendance row. All UI changes live in `Schedule.tsx`: the assign modal gains a LEAVE group, `assignShift()` writes the marker + syncs attendance and surfaces errors, and the three render surfaces (manager week grid, day view, staff My Schedule) render leave rows distinctly instead of dropping them.

**Tech Stack:** React 19 + TypeScript, Supabase JS client, Vitest.

## Global Constraints

- Exactly five leave types in the picker, stored with these values and shown with these labels: `medical` "Medical Leave (MC)", `emergency` "Emergency Leave", `unpaid` "Unpaid Leave", `maternity` "Maternity Leave", `public_holiday` "Public Holiday Replacement". NO annual, NO paternity.
- Assigning leave upserts attendance `{ staff_id, date, status: 'on_leave', recorded_by }` on conflict `staff_id,date` — field-for-field identical to HrLeave's `approve()`.
- Replacing a leave marker (with a shift or Off) deletes the day's attendance row ONLY if it exists, has `status === 'on_leave'`, and `clock_in` is null. Never touch rows with clock data.
- Do NOT write `leave_requests`; do NOT touch `leave_entitlements`.
- A `scheduled_shifts` row is shift XOR leave: upserts that assign a shift must explicitly set `leave_type: null`, and leave upserts must set `shift_type_id: null`.
- Supabase errors in `assignShift` must be shown to the user (red banner idiom `text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2`), never swallowed.
- Leave days contribute 0 hours to totals and are excluded from the per-day staffing count.
- The DB migration is an idempotent SQL block appended to `supabase/schema.sql`; it is run BY HAND in the Supabase SQL editor (project convention). Never attempt to run it against a live DB from the sandbox.

---

## File Structure

| File | Change |
|---|---|
| `src/shared/types/index.ts` | `ScheduledShift.shift_type_id` nullable + `leave_type` field; `SCHEDULE_LEAVE_OPTIONS` + `SCHEDULE_LEAVE_LABELS`; `shouldClearLeaveAttendance()` |
| `src/shared/types/schedule-leave.test.ts` | New — Vitest tests for `shouldClearLeaveAttendance` |
| `supabase/schema.sql` | Append "Phase 5 migration" block |
| `src/features/schedule/Schedule.tsx` | AssignModal LEAVE group; `assignShift` rework + attendance sync + error banner; WeekView/DayView/MyScheduleView leave rendering |

---

## Task 1: Types, constants, and `shouldClearLeaveAttendance`

**Files:**
- Modify: `src/shared/types/index.ts` (ScheduledShift interface ~line 717; new exports after it)
- Create: `src/shared/types/schedule-leave.test.ts`

**Interfaces:**
- Consumes: existing `LeaveType`, `Attendance` types in the same file.
- Produces (Tasks 3 relies on these exact names):
  - `ScheduledShift.shift_type_id: string | null`, `ScheduledShift.leave_type: LeaveType | null`
  - `export const SCHEDULE_LEAVE_OPTIONS: { type: LeaveType; label: string }[]`
  - `export const SCHEDULE_LEAVE_LABELS: Partial<Record<LeaveType, string>>`
  - `export function shouldClearLeaveAttendance(att: Pick<Attendance, 'status' | 'clock_in'> | null | undefined): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/types/schedule-leave.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shouldClearLeaveAttendance, SCHEDULE_LEAVE_OPTIONS } from './index'

describe('shouldClearLeaveAttendance', () => {
  it('returns false when there is no attendance row', () => {
    expect(shouldClearLeaveAttendance(null)).toBe(false)
    expect(shouldClearLeaveAttendance(undefined)).toBe(false)
  })

  it('returns true for a pristine on_leave row with no clock data', () => {
    expect(shouldClearLeaveAttendance({ status: 'on_leave', clock_in: null })).toBe(true)
  })

  it('returns false when the row has clock-in data', () => {
    expect(shouldClearLeaveAttendance({ status: 'on_leave', clock_in: '2026-07-07T01:00:00Z' })).toBe(false)
  })

  it('returns false for non-leave statuses', () => {
    expect(shouldClearLeaveAttendance({ status: 'present', clock_in: null })).toBe(false)
  })
})

describe('SCHEDULE_LEAVE_OPTIONS', () => {
  it('offers exactly the five schedule-assignable leave types', () => {
    expect(SCHEDULE_LEAVE_OPTIONS.map(o => o.type)).toEqual([
      'medical', 'emergency', 'unpaid', 'maternity', 'public_holiday',
    ])
  })

  it('labels public_holiday as a replacement day', () => {
    expect(SCHEDULE_LEAVE_OPTIONS.find(o => o.type === 'public_holiday')?.label)
      .toBe('Public Holiday Replacement')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- schedule-leave`
Expected: FAIL — `shouldClearLeaveAttendance` / `SCHEDULE_LEAVE_OPTIONS` not exported from `./index`.

- [ ] **Step 3: Implement**

In `src/shared/types/index.ts`, change the `ScheduledShift` interface (currently ~line 717):

```ts
export interface ScheduledShift {
  id: string
  staff_id: string
  shift_type_id: string | null      // null when the row is a leave marker
  leave_type: LeaveType | null      // null when the row is a work shift
  branch_id: string | null
  date: string
  status: 'scheduled' | 'confirmed' | 'swapped' | 'cancelled'
  notes: string | null
  created_by: string | null
  created_at: string
}
```

Directly below the interface, add:

```ts
/** Leave types a manager may assign straight from the schedule (annual and
 *  paternity intentionally excluded — those go through the request flow). */
export const SCHEDULE_LEAVE_OPTIONS: { type: LeaveType; label: string }[] = [
  { type: 'medical',        label: 'Medical Leave (MC)' },
  { type: 'emergency',      label: 'Emergency Leave' },
  { type: 'unpaid',         label: 'Unpaid Leave' },
  { type: 'maternity',      label: 'Maternity Leave' },
  { type: 'public_holiday', label: 'Public Holiday Replacement' },
]

export const SCHEDULE_LEAVE_LABELS: Partial<Record<LeaveType, string>> =
  Object.fromEntries(SCHEDULE_LEAVE_OPTIONS.map(o => [o.type, o.label]))

/** A schedule-assigned leave writes an attendance row (status on_leave).
 *  When the leave marker is replaced, that row may be deleted — but only
 *  while it is still pristine (no clock data). */
export function shouldClearLeaveAttendance(
  att: Pick<Attendance, 'status' | 'clock_in'> | null | undefined,
): boolean {
  return !!att && att.status === 'on_leave' && att.clock_in == null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- schedule-leave`
Expected: PASS (6/6).

- [ ] **Step 5: Build check**

Run: `npm run build`
Expected: MAY FAIL in `Schedule.tsx` if the stricter `shift_type_id: string | null` breaks existing usages (e.g. `gapMap[date][shift.shift_type_id]` indexing with a possibly-null key, `.find(x => x.id === shift.shift_type_id)` is fine). If the ONLY errors are in `src/features/schedule/Schedule.tsx`, note them in your report and proceed to commit — Task 3 rewrites those exact lines. If errors appear in ANY other file, fix those call sites minimally (usually a null guard) and list them in the report.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/index.ts src/shared/types/schedule-leave.test.ts
git commit -m "feat: schedule leave types, options, and attendance-clear helper"
```

---

## Task 2: Database migration — Phase 5 block

**Files:**
- Modify: `supabase/schema.sql` (append to end of file)

**Interfaces:**
- Consumes: existing `scheduled_shifts` table (schema.sql ~line 682).
- Produces: nullable `shift_type_id`, new `leave_type` column, XOR check constraint. NOT auto-applied — run by hand later; do not attempt from the sandbox.

- [ ] **Step 1: Append the migration block**

Add to the end of `supabase/schema.sql`:

```sql

-- =============================================
-- Phase 5 migration: Schedule leave assignment
-- Idempotent — safe to run on the existing database via the Supabase SQL editor.
-- =============================================

-- A scheduled_shifts row is now either a work shift (shift_type_id) or a
-- manager-assigned leave day (leave_type) — exactly one of the two.
alter table scheduled_shifts alter column shift_type_id drop not null;

alter table scheduled_shifts add column if not exists leave_type text
  check (leave_type in ('medical','emergency','unpaid','maternity','public_holiday'));

alter table scheduled_shifts drop constraint if exists scheduled_shifts_shift_or_leave;
alter table scheduled_shifts add constraint scheduled_shifts_shift_or_leave
  check (
    (shift_type_id is not null and leave_type is null)
    or (shift_type_id is null and leave_type is not null)
  );
```

- [ ] **Step 2: Do NOT run against a live DB**

No DB credentials in this environment and this project applies schema by hand. Report DONE_WITH_CONCERNS noting: the live `scheduled_shifts` still requires `shift_type_id` and lacks `leave_type` until a human runs this block; assigning leave from the deployed UI will show an error banner until then (work-shift assignment keeps working).

- [ ] **Step 3: Commit**

```bash
git add supabase/schema.sql
git commit -m "chore: scheduled_shifts leave_type column and shift-xor-leave constraint"
```

---

## Task 3: Schedule.tsx — picker, assignShift + attendance sync, rendering

**Files:**
- Modify: `src/features/schedule/Schedule.tsx` (AssignModal ~70-159; WeekView gapMap ~186-193 and cell ~257-277; DayView grouping ~328-341 and Unassigned ~416-437; MyScheduleView ~467-556; SchedulePage state ~574-575, `assignShift` ~620-641, error banner + modal render ~640-775)

Match on the quoted snippets, not line numbers. Read the whole file before starting.

**Interfaces:**
- Consumes (from Task 1, exact names): `ScheduledShift.leave_type`, `SCHEDULE_LEAVE_OPTIONS`, `SCHEDULE_LEAVE_LABELS`, `shouldClearLeaveAttendance`.
- Produces: `onAssign` callback type `(a: { shiftTypeId: string | null; leaveType: LeaveType | null }) => void`.

- [ ] **Step 1: Update imports**

The file's type import currently includes `Staff, ShiftType, ScheduledShift` (and possibly others) from `../../shared/types`. Add `LeaveType` to the type import, and add `SCHEDULE_LEAVE_OPTIONS`, `SCHEDULE_LEAVE_LABELS`, `shouldClearLeaveAttendance` to the value import.

- [ ] **Step 2: AssignModal — signature + LEAVE group**

Change the props type (currently):

```ts
  onAssign: (shiftTypeId: string | null) => void
```

to:

```ts
  onAssign: (a: { shiftTypeId: string | null; leaveType: LeaveType | null }) => void
```

Change the shift button's click (currently `onClick={() => onAssign(st.id)}`) to:

```tsx
onClick={() => onAssign({ shiftTypeId: st.id, leaveType: null })}
```

Between the department groups block (`{Object.entries(grouped).map(...)}`) and the `{current && (` Remove button, insert the LEAVE group:

```tsx
          <div>
            <p className="text-[10px] font-bold text-brown-faint uppercase tracking-widest px-1 mb-1.5">
              Leave
            </p>
            <div className="space-y-1">
              {SCHEDULE_LEAVE_OPTIONS.map(opt => {
                const isSelected = current?.leave_type === opt.type
                return (
                  <button
                    key={opt.type}
                    onClick={() => onAssign({ shiftTypeId: null, leaveType: opt.type })}
                    className="w-full text-left px-3 py-2 rounded-xl transition-colors flex items-center justify-between"
                    style={isSelected
                      ? { background: '#8B735518', border: '1px solid #8B735560' }
                      : { background: '#F9F4EE', border: '1px dashed #D4C5B0' }
                    }
                  >
                    <p className="text-sm font-semibold" style={{ color: isSelected ? '#8B7355' : '#3D2410' }}>
                      {opt.label}
                    </p>
                    {isSelected && <span className="text-xs font-bold" style={{ color: '#8B7355' }}>✓</span>}
                  </button>
                )
              })}
            </div>
          </div>
```

Change the Remove button's click (currently `onClick={() => onAssign(null)}`) to:

```tsx
onClick={() => onAssign({ shiftTypeId: null, leaveType: null })}
```

- [ ] **Step 3: `assignShift` rework — leave writes, attendance sync, error surfacing**

In `SchedulePage`, add error state next to `saving` (currently `const [saving, setSaving] = useState(false)`):

```ts
  const [saving, setSaving] = useState(false)
  const [scheduleError, setScheduleError] = useState('')
```

Replace the whole `assignShift` function (currently):

```ts
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
```

with:

```ts
  async function assignShift({ shiftTypeId, leaveType }: { shiftTypeId: string | null; leaveType: LeaveType | null }) {
    if (!assignTarget || !staff) return
    setSaving(true)
    setScheduleError('')
    const staffId = assignTarget.staff.id
    const ds = toDateStr(assignTarget.date)
    const existing = shiftMap[staffId]?.[ds]
    const wasLeave = !!existing?.leave_type

    let error: { message: string } | null = null
    if (shiftTypeId === null && leaveType === null) {
      if (existing) ({ error } = await supabase.from('scheduled_shifts').delete().eq('id', existing.id))
    } else {
      ;({ error } = await supabase.from('scheduled_shifts').upsert({
        staff_id: staffId,
        shift_type_id: shiftTypeId,
        leave_type: leaveType,
        date: ds,
        status: 'scheduled',
        created_by: staff.id,
      }, { onConflict: 'staff_id,date' }))
    }

    if (error) {
      setScheduleError(`Couldn't update the schedule: ${error.message}`)
      setSaving(false)
      return
    }

    if (leaveType !== null) {
      // Mirror HrLeave approve(): the day's attendance becomes on_leave.
      const { error: attErr } = await supabase.from('attendance').upsert(
        { staff_id: staffId, date: ds, status: 'on_leave' as const, recorded_by: staff.id },
        { onConflict: 'staff_id,date' },
      )
      if (attErr) setScheduleError(`Schedule saved, but attendance sync failed: ${attErr.message}`)
    } else if (wasLeave) {
      // The leave marker was replaced — remove its auto-created attendance
      // row, but only while it is still pristine (on_leave, never clocked in).
      const { data: att } = await supabase
        .from('attendance')
        .select('id, status, clock_in')
        .eq('staff_id', staffId)
        .eq('date', ds)
        .maybeSingle()
      if (shouldClearLeaveAttendance(att as Pick<Attendance, 'status' | 'clock_in'> | null)) {
        const { error: delErr } = await supabase.from('attendance').delete().eq('id', (att as { id: string }).id)
        if (delErr) setScheduleError(`Schedule saved, but couldn't clear the leave attendance: ${delErr.message}`)
      }
    }

    setSaving(false)
    setAssignTarget(null)
    loadShifts()
  }
```

Also add `Attendance` to the type import (used in the cast above).

- [ ] **Step 4: Error banner in the page render**

`SchedulePage`'s manager section renders the view toggle then `WeekView`/`DayView`. Directly above the view toggle block (or, simplest, immediately inside the manager branch's outer container before the toggle), add:

```tsx
        {scheduleError && (
          <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{scheduleError}</p>
        )}
```

- [ ] **Step 5: WeekView — leave badge + staffing count guard**

In the `gapMap` build (currently):

```ts
  Object.values(shiftMap).forEach(byDate => {
    Object.entries(byDate).forEach(([date, shift]) => {
      if (!gapMap[date]) gapMap[date] = {}
      gapMap[date][shift.shift_type_id] = (gapMap[date][shift.shift_type_id] ?? 0) + 1
    })
  })
```

skip leave rows (they are not working staff):

```ts
  Object.values(shiftMap).forEach(byDate => {
    Object.entries(byDate).forEach(([date, shift]) => {
      if (!shift.shift_type_id) return
      if (!gapMap[date]) gapMap[date] = {}
      gapMap[date][shift.shift_type_id] = (gapMap[date][shift.shift_type_id] ?? 0) + 1
    })
  })
```

In the grid cell (currently):

```tsx
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
```

render a leave badge for leave rows:

```tsx
                  const ds = toDateStr(d)
                  const shift = shiftMap[s.id]?.[ds]
                  const st = shift?.shift_type_id ? shiftTypes.find(x => x.id === shift.shift_type_id) : null
                  const leave = shift?.leave_type ?? null
                  return (
                    <td key={di} className="px-1.5 py-1.5 align-top">
                      <button
                        onClick={() => onCellClick(s, d)}
                        className={`w-full min-h-[52px] rounded-lg transition-colors text-left ${
                          st || leave ? 'hover:opacity-80' : 'hover:bg-[#F5EDE0] border border-dashed border-[#E0D4C0]'
                        }`}
                      >
                        {st ? (
                          <ShiftBadge shiftType={st} />
                        ) : leave ? (
                          <div
                            className="rounded-lg leading-tight px-2 py-1"
                            style={{ background: '#8B735515', border: '1px dashed #8B735560', color: '#8B7355' }}
                          >
                            <p className="font-semibold text-[10px]">🌴 {SCHEDULE_LEAVE_LABELS[leave]}</p>
                          </div>
                        ) : (
                          <span className="text-[10px] text-brown-faint p-2 block">Off</span>
                        )}
                      </button>
                    </td>
                  )
```

- [ ] **Step 6: DayView — leave group so staff don't vanish**

In the grouping (currently):

```ts
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
```

collect leave rows separately (a leave row would otherwise disappear from both the shift groups and Unassigned):

```ts
  const grouped: Record<string, Staff[]> = {}
  const unassigned: Staff[] = []
  const onLeave: { staff: Staff; leave: LeaveType }[] = []

  allStaff.forEach(s => {
    const shift = dayShifts[s.id]?.[ds]
    if (shift?.leave_type) {
      onLeave.push({ staff: s, leave: shift.leave_type })
    } else if (shift?.shift_type_id) {
      const key = shift.shift_type_id
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(s)
    } else {
      unassigned.push(s)
    }
  })
```

Directly BEFORE the `{/* Unassigned */}` block, add an On Leave card (same structure as Unassigned):

```tsx
      {/* On leave */}
      {onLeave.length > 0 && (
        <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-hidden">
          <div className="px-4 py-3" style={{ background: '#8B735512' }}>
            <p className="text-sm font-bold" style={{ color: '#8B7355' }}>On Leave ({onLeave.length})</p>
          </div>
          <div className="divide-y divide-[#F0E8DC]">
            {onLeave.map(({ staff: s, leave }) => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <Avatar name={s.name} avatar={s.avatar} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-brown-dark">{s.name}</p>
                  <p className="text-xs" style={{ color: '#8B7355' }}>🌴 {SCHEDULE_LEAVE_LABELS[leave]}</p>
                </div>
                <button
                  onClick={() => onCellClick(s, selectedDay)}
                  className="text-xs text-brown-faint hover:text-brown-dark transition-colors px-2 py-1 rounded"
                >
                  Change
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
```

- [ ] **Step 7: MyScheduleView — render leave rows**

The weekly list row (currently):

```tsx
                const st = shiftTypes.find(x => x.id === s.shift_type_id)
                const d = new Date(s.date + 'T00:00:00')
                const color = st ? (DEPT_SHIFT_COLORS[st.department] ?? st.color) : '#8B7355'
```

and its body (currently):

```tsx
                      {st ? (
                        <p className="text-xs mt-0.5" style={{ color }}>
                          {st.name} · {fmtTime(st.start_time)} – {fmtTime(st.end_time)}
                          {' · '}{shiftHours(st).toFixed(1)}h
                        </p>
                      ) : (
                        <p className="text-xs text-brown-faint mt-0.5">Unknown shift</p>
                      )}
```

become:

```tsx
                const st = s.shift_type_id ? shiftTypes.find(x => x.id === s.shift_type_id) : null
                const d = new Date(s.date + 'T00:00:00')
                const color = st ? (DEPT_SHIFT_COLORS[st.department] ?? st.color) : '#8B7355'
```

```tsx
                      {st ? (
                        <p className="text-xs mt-0.5" style={{ color }}>
                          {st.name} · {fmtTime(st.start_time)} – {fmtTime(st.end_time)}
                          {' · '}{shiftHours(st).toFixed(1)}h
                        </p>
                      ) : s.leave_type ? (
                        <p className="text-xs mt-0.5" style={{ color: '#8B7355' }}>
                          🌴 {SCHEDULE_LEAVE_LABELS[s.leave_type]}
                        </p>
                      ) : (
                        <p className="text-xs text-brown-faint mt-0.5">Unknown shift</p>
                      )}
```

The summary cards (currently `{myShifts.length}` "Upcoming shifts") should not count leave days as shifts:

```tsx
          <p className="text-2xl font-bold text-[#C4813A]">{myShifts.filter(s => s.shift_type_id).length}</p>
```

`totalHours` needs no change (`shiftTypes.find` on a null id returns undefined → adds 0), but verify it compiles with the nullable type; if TypeScript complains about `s.shift_type_id` being null in the `.find`, use `const st = s.shift_type_id ? shiftTypes.find(x => x.id === s.shift_type_id) : null` there too.

- [ ] **Step 8: Fix the modal call site**

`SchedulePage` renders `<AssignModal ... onAssign={assignShift} ... />` (~line 769). The signature change compiles as-is since `assignShift` now takes the object parameter. Verify the `current={...}` prop still passes the existing `ScheduledShift | null` — no change needed there.

- [ ] **Step 9: Build + stale-check**

Run: `npm run build`
Expected: exits 0.
Run: `grep -n "onAssign(st.id)\|onAssign(null)" src/features/schedule/Schedule.tsx`
Expected: no matches (all call sites migrated to the object form).

- [ ] **Step 10: Run full test suite**

Run: `npm test`
Expected: all pass (Task 1's 6 tests + break 4 + probation 8 + any others).

- [ ] **Step 11: Commit**

```bash
git add src/features/schedule/Schedule.tsx
git commit -m "feat: assign leave types from the schedule picker with attendance sync"
```

---

## Task 4: Final verification (controller)

**Files:** none (verification only)

- [ ] **Step 1:** `npm test` — all pass.
- [ ] **Step 2:** `npm run build` — exit 0.
- [ ] **Step 3:** Dev-server smoke check (login page renders, no console errors). A logged-in walkthrough needs the Phase 5 migration on prod first.
- [ ] **Step 4:** Merge to main (if worked in a branch/worktree), deploy via `vercel deploy --prod --yes`, verify the live bundle hash matches the local build.
- [ ] **Step 5:** Hand the user the Phase 5 SQL block to run in the Supabase SQL editor, with verification queries, and note the order: SQL first, then the feature is fully usable (deploying code first is safe — leave assignment shows an error banner until the SQL runs).
