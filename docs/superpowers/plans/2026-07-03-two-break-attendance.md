# Two-Break Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single per-shift break with two independent breaks (Break 1 / Break 2), each with its own configurable allowance, clock-out/in flow, live countdown, and overtime record, per `docs/superpowers/specs/2026-07-03-two-break-attendance-design.md`.

**Architecture:** A new `attendance_breaks` table stores one row per (attendance, break_number). Shift types gain `break1_duration_minutes` / `break2_duration_minutes`. A pure `computeBreakOvertime()` helper (unit-tested) centralizes the overtime math. The staff clock UI (`MyAttendance`) reads today's shift allowances + today's break rows, and renders Break 1's flow, then Break 2's flow only after Break 1 completes and only if `break2 > 0`. Writes go to `attendance_breaks` (upsert on `attendance_id,break_number`), never to the legacy `attendance.break_*` columns. Manager views read `attendance_breaks` and show per-break overtime badges. Overtime is recorded for reference only — it never changes `attendance.status` or deducts pay.

**Tech Stack:** React 19 + TypeScript, Supabase JS client, Vitest (already present from the annual-leave work; if the test runner is somehow absent in this branch, Task 1 adds it).

## Global Constraints

- Two breaks maximum, fixed. Break durations are integers; `0` means that break does not exist for the shift.
- `break1_duration_minutes` and `break2_duration_minutes` are `int not null default 0` on `shift_types`.
- Break 2's UI and clock-out button appear ONLY when `break2_duration_minutes > 0` AND Break 1 is complete (has a `clock_in_time`).
- Overtime = actual duration > allowed duration. Record `duration_minutes`, `overtime_minutes = max(0, actual - allowed)`, `is_overtime = overtime_minutes > 0`. NEVER auto-change `attendance.status`. NEVER deduct pay.
- Do NOT touch clock-in/clock-out (attendance) logic, GPS, or selfie flow.
- Do NOT write to the legacy `attendance.break_start / break_end / break_minutes / break_late / break_overrun_minutes` columns from new code; leave existing historical rows untouched (no backfill).
- All break writes target `attendance_breaks`, upserting on the `(attendance_id, break_number)` unique key.
- The DB migration is idempotent SQL appended to `supabase/schema.sql` and is run BY HAND in the Supabase SQL editor (project convention — no automated runner). Do not attempt to run it against a live DB in a sandbox.
- Countdown-red-when-over and the existing `fmtCountdown` behavior are preserved; only the data source changes.

---

## File Structure

| File | Change |
|---|---|
| `src/shared/types/index.ts` | Add `break1_duration_minutes`/`break2_duration_minutes` to `ShiftType`; add `AttendanceBreak` interface; add pure `computeBreakOvertime()` |
| `src/shared/types/leave.test.ts` (or a new `src/shared/types/break.test.ts`) | Vitest unit tests for `computeBreakOvertime` |
| `supabase/schema.sql` | Append "Phase 4 migration": `shift_types` columns + backfill + `attendance_breaks` table + RLS |
| `src/features/settings/Settings.tsx` | `ShiftTypesTab`: two break inputs, `save()` writes both columns, list preview shows both |
| `src/features/schedule/Schedule.tsx` | `shiftHours()` subtracts both breaks; badge/picker text shows both |
| `src/features/hr/HrAttendance.tsx` | `MyAttendance`: two-break clock flow against `attendance_breaks`; `DailyRoster`: per-break overtime badges |

Test file decision: put the new unit test in a NEW file `src/shared/types/break.test.ts` (keeps break tests separate from the leave tests; Vitest picks up any `*.test.ts`).

---

## Task 1: `computeBreakOvertime` pure helper + tests

**Files:**
- Modify: `src/shared/types/index.ts` (add the helper near the other exported functions, e.g. after `calcAnnualBalance` / near the bottom before any trailing exports)
- Create: `src/shared/types/break.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface BreakOvertimeResult { durationMinutes: number; overtimeMinutes: number; isOvertime: boolean }`
  - `export function computeBreakOvertime(clockOutIso: string, clockInIso: string, allowedMinutes: number): BreakOvertimeResult`

- [ ] **Step 1: Confirm Vitest is available**

Run: `npm test -- --run 2>/dev/null; echo "exit=$?"`
Expected: a Vitest run (pass or "no test files" is fine) — NOT a "vitest: command not found". If Vitest is missing (exit indicates command not found), STOP and report NEEDS_CONTEXT; the controller will add Vitest first. (It should already be present from prior work in this repo.)

- [ ] **Step 2: Write the failing tests**

Create `src/shared/types/break.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeBreakOvertime } from './index'

describe('computeBreakOvertime', () => {
  it('reports no overtime when actual equals allowed', () => {
    const out = '2026-07-03T04:00:00.000Z'
    const back = '2026-07-03T05:00:00.000Z' // exactly 60 min
    const r = computeBreakOvertime(out, back, 60)
    expect(r.durationMinutes).toBe(60)
    expect(r.overtimeMinutes).toBe(0)
    expect(r.isOvertime).toBe(false)
  })

  it('reports overtime when actual exceeds allowed', () => {
    const out = '2026-07-03T04:00:00.000Z'
    const back = '2026-07-03T05:05:00.000Z' // 65 min
    const r = computeBreakOvertime(out, back, 60)
    expect(r.durationMinutes).toBe(65)
    expect(r.overtimeMinutes).toBe(5)
    expect(r.isOvertime).toBe(true)
  })

  it('reports no overtime when actual is under allowed', () => {
    const out = '2026-07-03T04:00:00.000Z'
    const back = '2026-07-03T04:30:00.000Z' // 30 min
    const r = computeBreakOvertime(out, back, 60)
    expect(r.durationMinutes).toBe(30)
    expect(r.overtimeMinutes).toBe(0)
    expect(r.isOvertime).toBe(false)
  })

  it('rounds duration to the nearest minute', () => {
    const out = '2026-07-03T04:00:00.000Z'
    const back = '2026-07-03T04:00:40.000Z' // 40s -> rounds to 1 min
    const r = computeBreakOvertime(out, back, 0)
    expect(r.durationMinutes).toBe(1)
    expect(r.overtimeMinutes).toBe(1) // allowed 0 -> 1 over
    expect(r.isOvertime).toBe(true)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --run break.test`
Expected: FAIL — `computeBreakOvertime` is not exported from `./index`.

- [ ] **Step 4: Implement the helper**

In `src/shared/types/index.ts`, add:

```ts
export interface BreakOvertimeResult {
  durationMinutes: number
  overtimeMinutes: number
  isOvertime: boolean
}

/** Compute a break's actual length and overtime against the allowed minutes. */
export function computeBreakOvertime(
  clockOutIso: string,
  clockInIso: string,
  allowedMinutes: number,
): BreakOvertimeResult {
  const durationMinutes = Math.round(
    (new Date(clockInIso).getTime() - new Date(clockOutIso).getTime()) / 60000,
  )
  const overtimeMinutes = Math.max(0, durationMinutes - allowedMinutes)
  return { durationMinutes, overtimeMinutes, isOvertime: overtimeMinutes > 0 }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --run break.test`
Expected: PASS (4/4).

- [ ] **Step 6: Build check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/index.ts src/shared/types/break.test.ts
git commit -m "feat: add computeBreakOvertime helper for two-break attendance"
```

---

## Task 2: Types — `ShiftType` break columns + `AttendanceBreak`

**Files:**
- Modify: `src/shared/types/index.ts` (`ShiftType` interface ~line 558-570; add `AttendanceBreak` interface after it)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ShiftType.break1_duration_minutes: number`, `ShiftType.break2_duration_minutes: number` (added; existing `break_minutes` kept, comment updated to "legacy").
  - `export interface AttendanceBreak { id: string; attendance_id: string; break_number: 1 | 2; clock_out_time: string | null; clock_in_time: string | null; duration_minutes: number | null; overtime_minutes: number; is_overtime: boolean; created_at: string }`

- [ ] **Step 1: Update `ShiftType` and add `AttendanceBreak`**

In `src/shared/types/index.ts`, change the `ShiftType` interface (currently):

```ts
export interface ShiftType {
  id: string
  department: string
  name: string
  start_time: string
  end_time: string
  break_start: string | null   // legacy — no longer used, kept for back-compat
  break_end: string | null     // legacy — no longer used, kept for back-compat
  break_minutes: number        // allowed break duration per shift, in minutes
  color: string
  is_active: boolean
  created_at: string
}
```

to:

```ts
export interface ShiftType {
  id: string
  department: string
  name: string
  start_time: string
  end_time: string
  break_start: string | null   // legacy — no longer used, kept for back-compat
  break_end: string | null     // legacy — no longer used, kept for back-compat
  break_minutes: number        // legacy single-break duration — superseded by break1/break2
  break1_duration_minutes: number // allowed duration of break 1 (0 = no break 1)
  break2_duration_minutes: number // allowed duration of break 2 (0 = no break 2)
  color: string
  is_active: boolean
  created_at: string
}

export interface AttendanceBreak {
  id: string
  attendance_id: string
  break_number: 1 | 2
  clock_out_time: string | null
  clock_in_time: string | null
  duration_minutes: number | null
  overtime_minutes: number
  is_overtime: boolean
  created_at: string
}
```

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: exits 0 UNLESS a `ShiftType` object literal somewhere omits the two new required fields. If the build errors on a missing property in a `ShiftType` literal, that's expected in Tasks 4/5's files — but if it errors NOW (before those tasks), find the offending literal and note it; the most likely place is `Settings.tsx`'s `setEditing({...})` calls, which use `Partial<ShiftType>` (so they won't error). If the build is clean, proceed.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/index.ts
git commit -m "feat: add break1/break2 duration to ShiftType and AttendanceBreak type"
```

---

## Task 3: Database migration — shift break columns + `attendance_breaks`

**Files:**
- Modify: `supabase/schema.sql` (append to end of file)

**Interfaces:**
- Consumes: nothing.
- Produces: `shift_types.break1_duration_minutes`, `shift_types.break2_duration_minutes`, and the `attendance_breaks` table with RLS — all assumed by Tasks 4-6. NOT auto-applied; run by hand later.

- [ ] **Step 1: Append the migration block**

Add to the end of `supabase/schema.sql`:

```sql

-- =============================================
-- Phase 4 migration: Two-break attendance
-- Idempotent — safe to run on the existing database via the Supabase SQL editor.
-- =============================================

-- 1) Two independent break durations per shift ------------------------------
-- 0 means that break does not exist for the shift. The legacy single
-- break_minutes column is kept but no longer written by the app.
alter table shift_types add column if not exists break1_duration_minutes int not null default 0;
alter table shift_types add column if not exists break2_duration_minutes int not null default 0;

-- One-time migration of the old single break into break 1 (only where break 1
-- is still the default 0 and a legacy value exists).
update shift_types set break1_duration_minutes = break_minutes
  where break1_duration_minutes = 0 and coalesce(break_minutes, 0) > 0;

-- 2) Per-break clock records -------------------------------------------------
create table if not exists attendance_breaks (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references attendance(id) on delete cascade,
  break_number int not null check (break_number in (1, 2)),
  clock_out_time timestamptz,          -- staff started the break
  clock_in_time  timestamptz,          -- staff ended the break
  duration_minutes int,                -- actual minutes taken
  overtime_minutes int not null default 0,
  is_overtime boolean not null default false,
  created_at timestamptz not null default now(),
  unique (attendance_id, break_number)
);

alter table attendance_breaks enable row level security;

-- Staff can read their own break rows; supervisors/managers read all.
drop policy if exists "attendance_breaks_select" on attendance_breaks;
create policy "attendance_breaks_select" on attendance_breaks for select to authenticated
  using (
    exists (
      select 1 from attendance a
      where a.id = attendance_id
        and (a.staff_id = auth.uid() or current_rank() in ('supervisor','manager'))
    )
  );

-- Staff can insert/update break rows for their own attendance day.
drop policy if exists "attendance_breaks_self_insert" on attendance_breaks;
create policy "attendance_breaks_self_insert" on attendance_breaks for insert to authenticated
  with check (
    exists (select 1 from attendance a where a.id = attendance_id and a.staff_id = auth.uid())
  );

drop policy if exists "attendance_breaks_self_update" on attendance_breaks;
create policy "attendance_breaks_self_update" on attendance_breaks for update to authenticated
  using (
    exists (select 1 from attendance a where a.id = attendance_id and a.staff_id = auth.uid())
  );

-- Supervisors/managers may manage all break rows.
drop policy if exists "attendance_breaks_manage" on attendance_breaks;
create policy "attendance_breaks_manage" on attendance_breaks for all to authenticated
  using (current_rank() in ('supervisor','manager'));
```

- [ ] **Step 2: Do NOT run against a live DB**

Skip running this against Supabase — no credentials in this environment, and this project applies schema by hand. Report this as a concern (DONE_WITH_CONCERNS): the columns/table do not exist on the live DB until a human runs the appended "Phase 4 migration" block in the Supabase SQL editor; Tasks 4-6's code will error at runtime until then.

- [ ] **Step 3: Commit**

```bash
git add supabase/schema.sql
git commit -m "chore: add two-break shift columns and attendance_breaks table migration"
```

---

## Task 4: Shift settings — two break inputs

**Files:**
- Modify: `src/features/settings/Settings.tsx` (`ShiftTypesTab`, ~lines 783-960)

**Interfaces:**
- Consumes: `ShiftType.break1_duration_minutes`/`break2_duration_minutes` from Task 2.
- Produces: shift types are created/edited with both break durations; list preview shows both.

- [ ] **Step 1: Update the "Add Shift" default**

In `ShiftTypesTab`, the `+ Add Shift` button's `setEditing({...})` call (currently):

```tsx
onClick={() => setEditing({ department: 'barista', name: '', start_time: '09:00', end_time: '17:00', break_minutes: 60, is_active: true })}
```

change to:

```tsx
onClick={() => setEditing({ department: 'barista', name: '', start_time: '09:00', end_time: '17:00', break1_duration_minutes: 60, break2_duration_minutes: 0, is_active: true })}
```

- [ ] **Step 2: Update `save()` (both insert and update paths)**

Replace the update path's field block (currently):

```tsx
      await supabase.from('shift_types').update({
        name: editing.name,
        start_time: editing.start_time,
        end_time: editing.end_time,
        break_minutes: editing.break_minutes ?? 0,
        department: editing.department,
        is_active: editing.is_active,
      }).eq('id', editing.id)
```

with:

```tsx
      await supabase.from('shift_types').update({
        name: editing.name,
        start_time: editing.start_time,
        end_time: editing.end_time,
        break1_duration_minutes: editing.break1_duration_minutes ?? 0,
        break2_duration_minutes: editing.break2_duration_minutes ?? 0,
        department: editing.department,
        is_active: editing.is_active,
      }).eq('id', editing.id)
```

Replace the insert path's field block (currently):

```tsx
      await supabase.from('shift_types').insert({
        department: editing.department ?? 'barista',
        name: editing.name ?? 'New Shift',
        start_time: editing.start_time ?? '09:00',
        end_time: editing.end_time ?? '17:00',
        break_minutes: editing.break_minutes ?? 0,
        color: DEPT_SHIFT_COLORS[editing.department ?? 'barista'] ?? '#8B6344',
      })
```

with:

```tsx
      await supabase.from('shift_types').insert({
        department: editing.department ?? 'barista',
        name: editing.name ?? 'New Shift',
        start_time: editing.start_time ?? '09:00',
        end_time: editing.end_time ?? '17:00',
        break1_duration_minutes: editing.break1_duration_minutes ?? 0,
        break2_duration_minutes: editing.break2_duration_minutes ?? 0,
        color: DEPT_SHIFT_COLORS[editing.department ?? 'barista'] ?? '#8B6344',
      })
```

- [ ] **Step 3: Update the list preview text**

Replace the shift preview line (currently):

```tsx
                    <p className="text-xs text-brown-faint">
                      {st.start_time.slice(0,5)} – {st.end_time.slice(0,5)}
                      {st.break_minutes > 0 && ` · Break ${st.break_minutes}min`}
                    </p>
```

with:

```tsx
                    <p className="text-xs text-brown-faint">
                      {st.start_time.slice(0,5)} – {st.end_time.slice(0,5)}
                      {st.break1_duration_minutes > 0 && ` · Break 1 ${st.break1_duration_minutes}min`}
                      {st.break2_duration_minutes > 0 && ` · Break 2 ${st.break2_duration_minutes}min`}
                    </p>
```

- [ ] **Step 4: Replace the single break input with two inputs**

Replace the whole break-duration `<div>` block in the edit modal (currently):

```tsx
              <div>
                <label className="block text-xs font-semibold text-brown-medium mb-1">Break Duration (minutes)</label>
                <input
                  type="number"
                  min={0}
                  step={5}
                  className={inputCls2}
                  value={editing.break_minutes ?? 60}
                  onChange={e => setEditing(p => ({ ...p, break_minutes: Math.max(0, Number(e.target.value)) }))}
                  placeholder="e.g. 60"
                />
                <p className="text-xs text-brown-faint mt-1">How long staff may rest per shift. Used for the break countdown when clocking out for a break.</p>
              </div>
```

with:

```tsx
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-brown-medium mb-1">Break 1 Duration (min)</label>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    className={inputCls2}
                    value={editing.break1_duration_minutes ?? 0}
                    onChange={e => setEditing(p => ({ ...p, break1_duration_minutes: Math.max(0, Number(e.target.value)) }))}
                    placeholder="e.g. 60"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-brown-medium mb-1">Break 2 Duration (min)</label>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    className={inputCls2}
                    value={editing.break2_duration_minutes ?? 0}
                    onChange={e => setEditing(p => ({ ...p, break2_duration_minutes: Math.max(0, Number(e.target.value)) }))}
                    placeholder="e.g. 60"
                  />
                </div>
                <p className="text-xs text-brown-faint mt-1 col-span-2">Allowed rest per break. 0 = no break. Used for the break countdown when clocking out.</p>
              </div>
```

- [ ] **Step 5: Build check**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/features/settings/Settings.tsx
git commit -m "feat: configure two break durations per shift type"
```

---

## Task 5: Schedule — subtract both breaks from worked hours

**Files:**
- Modify: `src/features/schedule/Schedule.tsx` (`shiftHours()` ~line 41-46; picker preview text ~line 134)

**Interfaces:**
- Consumes: `ShiftType.break1_duration_minutes`/`break2_duration_minutes` from Task 2.
- Produces: worked-hours math and shift picker text reflect the sum of both breaks.

- [ ] **Step 1: Update `shiftHours()`**

Replace (currently):

```tsx
function shiftHours(st: ShiftType): number {
  const [sh, sm] = st.start_time.split(':').map(Number)
  const [eh, em] = st.end_time.split(':').map(Number)
  const breakMins = st.break_minutes ?? 0
  return ((eh * 60 + em) - (sh * 60 + sm) - breakMins) / 60
}
```

with:

```tsx
function shiftHours(st: ShiftType): number {
  const [sh, sm] = st.start_time.split(':').map(Number)
  const [eh, em] = st.end_time.split(':').map(Number)
  const breakMins = (st.break1_duration_minutes ?? 0) + (st.break2_duration_minutes ?? 0)
  return ((eh * 60 + em) - (sh * 60 + sm) - breakMins) / 60
}
```

- [ ] **Step 2: Update the shift picker preview text**

Replace (currently, in the picker modal ~line 132-135):

```tsx
                        <p className="text-xs text-brown-faint">
                          {fmtTime(st.start_time)} – {fmtTime(st.end_time)}
                          {st.break_minutes > 0 && ` · Break ${st.break_minutes}min`}
                        </p>
```

with:

```tsx
                        <p className="text-xs text-brown-faint">
                          {fmtTime(st.start_time)} – {fmtTime(st.end_time)}
                          {st.break1_duration_minutes > 0 && ` · B1 ${st.break1_duration_minutes}min`}
                          {st.break2_duration_minutes > 0 && ` · B2 ${st.break2_duration_minutes}min`}
                        </p>
```

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: exits 0. (If any other `st.break_minutes` reference remains in this file, grep and confirm it's not in a worked-hours or display path that the spec requires updating — `grep -n "break_minutes" src/features/schedule/Schedule.tsx` should return no results after this task.)

- [ ] **Step 4: Commit**

```bash
git add src/features/schedule/Schedule.tsx
git commit -m "feat: subtract both breaks from scheduled worked hours"
```

---

## Task 6: Staff clock UI — two-break flow against `attendance_breaks`

**Files:**
- Modify: `src/features/hr/HrAttendance.tsx` (`MyAttendance`, ~lines 631-979; imports ~line 4-5)

**Interfaces:**
- Consumes: `computeBreakOvertime`, `AttendanceBreak`, `ShiftType` break fields from Tasks 1-2; the `attendance_breaks` table from Task 3.
- Produces: staff can run Break 1 then (conditionally) Break 2, each writing to `attendance_breaks`.

This is the largest task. Read the whole existing `MyAttendance` component first. The existing single-break code (state `breakAllowed`, `breakBusy`, `nowMs`; functions `loadBreakAllowance`, `handleBreakOut`, `handleBreakIn`; the `onBreak`/`breakDone`/`canBreakOut`/`breakDeadlineMs`/... derived values; and the whole "Break section" JSX block ~lines 870-925) is being REPLACED by the two-break version below. The clock-in/out card, monthly stats, and monthly list are unchanged.

- [ ] **Step 1: Update imports**

In `src/features/hr/HrAttendance.tsx`:
- Add `AttendanceBreak`, `ShiftType`, and `computeBreakOvertime` to the imports. The current type import (line 4) is:
  `import type { Staff, Attendance, AttendanceStatus } from '../../shared/types'`
  change to:
  `import type { Staff, Attendance, AttendanceStatus, AttendanceBreak, ShiftType } from '../../shared/types'`
- The current value import (line 5) is:
  `import { ATTENDANCE_STATUS_LABELS, ATTENDANCE_STATUS_COLORS, BRANCHES, DEPT_LABELS, MONTHS_FULL, DEFAULT_BREAK_MINUTES } from '../../shared/types'`
  change to add `computeBreakOvertime`:
  `import { ATTENDANCE_STATUS_LABELS, ATTENDANCE_STATUS_COLORS, BRANCHES, DEPT_LABELS, MONTHS_FULL, DEFAULT_BREAK_MINUTES, computeBreakOvertime } from '../../shared/types'`

- [ ] **Step 2: Replace `MyAttendance`'s break state + data loading**

Replace the state block (currently):

```tsx
  const [breakAllowed, setBreakAllowed] = useState(DEFAULT_BREAK_MINUTES)
  const [breakBusy, setBreakBusy] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
```

with:

```tsx
  const [break1Allowed, setBreak1Allowed] = useState(0)
  const [break2Allowed, setBreak2Allowed] = useState(0)
  const [breaks, setBreaks] = useState<AttendanceBreak[]>([])
  const [breakBusy, setBreakBusy] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())
```

Replace `loadBreakAllowance` (currently):

```tsx
  // Determine how many break minutes are allowed today: from today's scheduled
  // shift if any, otherwise the company default rule, otherwise the hard default.
  async function loadBreakAllowance() {
    const { data: shiftRow } = await supabase
      .from('scheduled_shifts')
      .select('shift_type:shift_types(break_minutes)')
      .eq('staff_id', staff.id)
      .eq('date', todayStr())
      .maybeSingle()
    const shiftBreak = (shiftRow as { shift_type?: { break_minutes?: number } } | null)?.shift_type?.break_minutes
    if (shiftBreak != null) { setBreakAllowed(shiftBreak); return }

    const { data: ruleRow } = await supabase
      .from('system_rules')
      .select('value')
      .eq('key', 'default_break_minutes')
      .maybeSingle()
    const ruleVal = ruleRow ? parseInt((ruleRow as { value: string }).value) : NaN
    setBreakAllowed(Number.isFinite(ruleVal) ? ruleVal : DEFAULT_BREAK_MINUTES)
  }
```

with:

```tsx
  // Determine today's break allowances from the scheduled shift (break 1 & 2).
  // With no shift, fall back to the company default rule for break 1 only.
  async function loadBreakAllowance() {
    const { data: shiftRow } = await supabase
      .from('scheduled_shifts')
      .select('shift_type:shift_types(break1_duration_minutes,break2_duration_minutes)')
      .eq('staff_id', staff.id)
      .eq('date', todayStr())
      .maybeSingle()
    const st = (shiftRow as { shift_type?: Pick<ShiftType, 'break1_duration_minutes' | 'break2_duration_minutes'> } | null)?.shift_type
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
```

- [ ] **Step 3: Wire `loadBreaks` into the load lifecycle**

The existing `load()` sets `today`. After `today` is known, break rows must load. Update the mount effect (currently):

```tsx
  useEffect(() => { load(); loadBreakAllowance() }, [])
```

to also react to `today?.id`:

```tsx
  useEffect(() => { load(); loadBreakAllowance() }, [])
  useEffect(() => { loadBreaks(today?.id) }, [today?.id])
```

- [ ] **Step 4: Replace the `onBreak` tick effect and break derived state**

Replace the tick effect + break handlers + derived values. Currently the block is (from `const onBreak = ...` through the end of `fmtCountdown`, i.e. the `onBreak` effect, `handleBreakOut`, `handleBreakIn`, and the derived `breakDone`/`canBreakOut`/`breakDeadlineMs`/`breakRemainingMs`/`breakOver`/`fmtCountdown` — note `handleClockDone` sits between them; keep `handleClockDone` intact and unchanged).

First, replace the `onBreak` tick effect (currently):

```tsx
  // Tick every second while on break so the countdown stays live.
  const onBreak = !!today?.break_start && !today?.break_end
  useEffect(() => {
    if (!onBreak) return
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [onBreak])

  async function handleBreakOut() {
    if (!today) return
    setBreakBusy(true)
    const nowIso = new Date().toISOString()
    await supabase.from('attendance').update({ break_start: nowIso }).eq('id', today.id)
    setBreakBusy(false)
    setNowMs(Date.now())
    setSuccessMsg(`Break started — ${breakAllowed} min allowed ☕`)
    load()
    setTimeout(() => setSuccessMsg(null), 5000)
  }

  async function handleBreakIn() {
    if (!today?.break_start) return
    setBreakBusy(true)
    const end = new Date()
    const takenMin = Math.round((end.getTime() - new Date(today.break_start).getTime()) / 60000)
    const overrun = Math.max(0, takenMin - breakAllowed)
    await supabase.from('attendance').update({
      break_end: end.toISOString(),
      break_minutes: takenMin,
      break_late: overrun > 0,
      break_overrun_minutes: overrun,
    }).eq('id', today.id)
    setBreakBusy(false)
    setSuccessMsg(
      overrun > 0
        ? `Back from break — ${takenMin} min (${overrun} min over) ⚠️`
        : `Back from break — ${takenMin} min ✓`
    )
    load()
    setTimeout(() => setSuccessMsg(null), 6000)
  }
```

with:

```tsx
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
    const nowIso = new Date().toISOString()
    await supabase.from('attendance_breaks').upsert({
      attendance_id: today.id,
      break_number: breakNumber,
      clock_out_time: nowIso,
    }, { onConflict: 'attendance_id,break_number' })
    setBreakBusy(false)
    setNowMs(Date.now())
    setSuccessMsg(`Break ${breakNumber} started — ${allowed} min allowed ☕`)
    loadBreaks(today.id)
    setTimeout(() => setSuccessMsg(null), 5000)
  }

  async function endBreak(row: AttendanceBreak, allowed: number) {
    if (!row.clock_out_time) return
    setBreakBusy(true)
    const endIso = new Date().toISOString()
    const { durationMinutes, overtimeMinutes, isOvertime } =
      computeBreakOvertime(row.clock_out_time, endIso, allowed)
    await supabase.from('attendance_breaks').update({
      clock_in_time: endIso,
      duration_minutes: durationMinutes,
      overtime_minutes: overtimeMinutes,
      is_overtime: isOvertime,
    }).eq('id', row.id)
    setBreakBusy(false)
    setSuccessMsg(
      isOvertime
        ? `Back from break ${row.break_number} — ${durationMinutes} min (${overtimeMinutes} min over) ⚠️`
        : `Back from break ${row.break_number} — ${durationMinutes} min ✓`
    )
    loadBreaks(row.attendance_id)
    setTimeout(() => setSuccessMsg(null), 6000)
  }
```

Then replace the derived break-state block (currently):

```tsx
  // Break state
  const breakDone = !!today?.break_end
  const canBreakOut = !!today?.clock_in && !today?.clock_out && !today?.break_start
  const breakDeadlineMs = today?.break_start
    ? new Date(today.break_start).getTime() + breakAllowed * 60000
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
```

with:

```tsx
  // Which breaks are available given clock state + shift allowances.
  const clockedInNotOut = !!today?.clock_in && !today?.clock_out
  const break1Complete = !!break1?.clock_in_time
  const break2Complete = !!break2?.clock_in_time
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
```

- [ ] **Step 5: Replace the Break section JSX**

Replace the whole break section block (currently the `{today?.clock_in && ( <div className="border-t border-[#F0E8DC] px-5 py-4"> ... </div> )}` that renders the single break, ~lines 870-925) with a helper-driven two-break renderer. Replace from the comment `{/* ── Break section (separate from attendance clock) ── */}` through its closing `)}` with:

```tsx
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
                    <span className="text-[11px] text-brown-faint">{allowed} min allowed</span>
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
                      Break {n} taken: {row?.duration_minutes} min
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
```

- [ ] **Step 6: Build check + stale-reference check**

Run: `npm run build`
Expected: exits 0.

Then run: `grep -n "breakAllowed\|breakDone\|canBreakOut\|handleBreakOut\|handleBreakIn\|today?.break_start\|today?.break_end" src/features/hr/HrAttendance.tsx`
Expected: NO results inside `MyAttendance` (all replaced). (The `DailyRoster` still references `rec.break_minutes`/`rec.break_late` at this point — that's Task 7's job, so matches there are expected and fine. The grep above intentionally does not include those field names.)

- [ ] **Step 7: Commit**

```bash
git add src/features/hr/HrAttendance.tsx
git commit -m "feat: two-break clock-out/in flow writing to attendance_breaks"
```

---

## Task 7: Manager daily roster — per-break overtime badges

**Files:**
- Modify: `src/features/hr/HrAttendance.tsx` (`DailyRoster`, ~lines 355-541)

**Interfaces:**
- Consumes: `AttendanceBreak` from Task 2; the `attendance_breaks` table.
- Produces: the daily roster shows Break 1 / Break 2 badges (with overtime highlight) sourced from `attendance_breaks` instead of the legacy `attendance.break_*` columns.

- [ ] **Step 1: Load break rows in `DailyRoster.load()`**

Add break state near the other `DailyRoster` state (after `const [records, setRecords] = useState<Record<string, Attendance>>({})`):

```tsx
  const [breaksByAtt, setBreaksByAtt] = useState<Record<string, AttendanceBreak[]>>({})
```

Replace `DailyRoster`'s `load()` (currently):

```tsx
  async function load() {
    const { data } = await supabase.from('attendance').select('*').eq('date', date)
    const map: Record<string, Attendance> = {}
    ;(data as Attendance[] | null)?.forEach(r => { map[r.staff_id] = r })
    setRecords(map)
  }
```

with:

```tsx
  async function load() {
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
```

- [ ] **Step 2: Replace the single break badge with per-break badges**

In the roster row rendering, replace the `{/* Break */}` block (currently):

```tsx
                  {/* Break */}
                  {rec.break_minutes != null && (
                    <span className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                      rec.break_late ? 'bg-[#FDF3F0] text-[#9E4A30]' : 'bg-[#FBF0E6] text-[#8B5E2E]'
                    }`}>
                      <Coffee size={10} />
                      Break {rec.break_minutes}m
                      {rec.break_late ? ` (+${rec.break_overrun_minutes}m ⚠️)` : ' ✓'}
                    </span>
                  )}
```

with:

```tsx
                  {/* Breaks (per-break from attendance_breaks) */}
                  {(breaksByAtt[rec.id] ?? [])
                    .filter(b => b.clock_in_time != null)
                    .sort((a, b) => a.break_number - b.break_number)
                    .map(b => (
                      <span key={b.id} className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                        b.is_overtime ? 'bg-[#FDF3F0] text-[#9E4A30]' : 'bg-[#FBF0E6] text-[#8B5E2E]'
                      }`}>
                        <Coffee size={10} />
                        B{b.break_number} {b.duration_minutes}m
                        {b.is_overtime ? ` (+${b.overtime_minutes}m ⚠️)` : ' ✓'}
                      </span>
                    ))}
```

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: exits 0.

Then run: `grep -n "break_minutes\|break_late\|break_overrun_minutes\|break_start\|break_end" src/features/hr/HrAttendance.tsx`
Expected: NO results (all legacy `attendance.break_*` usages in this file are now gone). If any remain, they are stale and must be removed or migrated.

- [ ] **Step 4: Commit**

```bash
git add src/features/hr/HrAttendance.tsx
git commit -m "feat: show per-break overtime badges in manager daily roster"
```

---

## Task 8: Final verification

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Full test suite**

Run: `npm test -- --run`
Expected: all tests pass (annual-leave tests if present on this branch, plus `computeBreakOvertime` ×4).

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Repo-wide stale-reference sweep**

Run: `grep -rn "break_minutes" src/` and `grep -rn "\.break_start\|\.break_end\|break_late\|break_overrun" src/`
Expected: `break_minutes` appears ONLY as the legacy field in the `ShiftType` interface / `Attendance` interface comments in `src/shared/types/index.ts` (type definitions may keep the legacy fields), and NOT in any `.from('shift_types')` write, `shiftHours()`, or UI display path. `break_start`/`break_end`/`break_late`/`break_overrun` appear ONLY in the `Attendance` interface definition (legacy fields kept for historical rows), not in any new read/write logic. Report any other occurrence.

- [ ] **Step 4: Dev-server smoke check**

Start the dev server (preview tooling or `npm run dev`) and confirm the app's login page renders with zero console errors. A full logged-in walkthrough requires the Phase 4 migration to be applied to the live DB and real credentials — defer that to the user (see Step 5).

- [ ] **Step 5: Report the pending manual migration**

Tell the user explicitly: the two-break feature will error at runtime until the "Phase 4 migration" block in `supabase/schema.sql` (the `shift_types` break columns + `attendance_breaks` table + RLS) is run by hand in the Supabase SQL editor. List this as the one required manual follow-up.

---

## Self-Review Notes

- **Spec coverage:** shift config two inputs (Task 4), separate clock groups (Task 6), sequential Break 1 → Break 2 gating (Task 6 `break2Unlocked`), overtime record in new table (Tasks 1/3/6), countdown red on overrun (Task 6), manager overtime badges (Task 7), worked-hours subtract both breaks (Task 5), no auto status change / no backfill (enforced by never writing `attendance.status` or the legacy columns). All covered.
- **No auto-status:** confirmed — no task writes `attendance.status` from break logic.
- **Type consistency:** `computeBreakOvertime(clockOutIso, clockInIso, allowedMinutes)` signature is identical in Task 1 (definition) and Task 6 (call site: `computeBreakOvertime(row.clock_out_time, endIso, allowed)`). `AttendanceBreak` fields used in Tasks 6/7 match the Task 2 definition. `break1_duration_minutes`/`break2_duration_minutes` names identical across Tasks 2, 3, 4, 5, 6.
