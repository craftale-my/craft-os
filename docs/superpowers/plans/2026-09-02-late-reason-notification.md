# Late Reason & Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staff member who clocks in late must state why before the clock-in completes; their supervisor and they themselves get an in-app notification; the supervisor can excuse the lateness without erasing it, and excused days stop costing attendance score.

**Architecture:** Lateness is already decided client-side by `calcLateness()` at clock-in (`HrAttendance.tsx:839`), immediately before the attendance upsert — the reason step slots in there, and the reason lands in the *same* write, so a row can never exist without its reason. Delivery goes through a new `notifications` table written by a `security definer` function (a staff member has no RLS rights to write into a supervisor's inbox). That table is the shared spine: any future channel (email, push, WhatsApp) changes only the sender, never the detection.

**Tech Stack:** React 18 + TypeScript + Vite, Supabase (Postgres, RLS, Realtime), Vitest + @testing-library/react (jsdom), Tailwind.

## Global Constraints

- **All UI copy, labels, table/column names and notification text in English.** The conversation and these docs are Chinese; the product is not.
- **Every write whose success is shown to a user goes through `writeOutcome()`** (`src/shared/lib/db-write.ts`) and must be built with `.select()`. An RLS-rejected write returns no error and no rows — `error === null` does not mean it landed.
- **Every UI permission gate must match its RLS predicate word for word.** A button that RLS will reject is the defect commit `0ccfda3` already fixed once.
- **All SQL must be idempotent and re-runnable.** There is no local Supabase and no CLI migration flow — migrations are pasted into the production SQL editor by hand (`PROJECT_NOTES.md`).
- **Times are MYT (UTC+8).** `clock_in` is `timestamptz`; the scheduled baseline is a MYT wall clock (`scheduled_shifts.date + shift_types.start_time`). Convert with `at time zone 'Asia/Kuala_Lumpur'`, never with `::date` on a raw timestamptz.
- **Lateness rule (shipped 2026-09-02):** the scheduled start minute is on time; late begins at the next whole minute.
- Spec: `docs/superpowers/specs/2026-09-02-late-reason-notification-design.md`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-09-02-late-reason-notifications.sql` (new) | Schema only: columns, `notifications` table, RLS, seeds, realtime publication |
| `supabase/migration-2026-09-02-notify-late-fn.sql` (new) | `notify_late()` + `supervisor_id` backfill |
| `src/shared/lib/lateReason.ts` (new) | Pure reason codes + completeness rules. No React, no Supabase |
| `src/shared/lib/lateReason.test.ts` (new) | Unit tests for the above |
| `src/shared/types/index.ts` (modify) | `Staff.supervisor_id`, `Attendance` reason/excuse fields, `AppNotification` |
| `src/features/hr/LateReasonStep.tsx` (new) | The blocking reason UI. Presentational — takes values, emits a result |
| `src/features/hr/HrAttendance.tsx` (modify) | Wire the step into `handleClockDone`; `Excuse` action in `DailyRoster` |
| `src/features/notifications/useNotifications.ts` (new) | Fetch + realtime + mark-read hook |
| `src/features/notifications/NotificationBell.tsx` (new) | Bell, unread badge, dropdown list |
| `src/shared/components/Sidebar.tsx` (modify) | Mount the bell in the header |
| `src/features/team/Reviews.tsx` (modify) | Exclude excused days from the late count |

`LateReasonStep` is deliberately split out of `HrAttendance.tsx` — that file is already 1247 lines, and the step is the one piece with its own tests.

---

### Task 1: Schema migration

**Files:**
- Create: `supabase/migration-2026-09-02-late-reason-notifications.sql`

**Interfaces:**
- Produces: `staff.supervisor_id`; `attendance.late_reason_code|late_reason|late_excused|late_excused_by|late_excused_at`; table `notifications`; `notification_settings` row `attendance_late`; `system_rules` row `late_reason_written_threshold`.

- [ ] **Step 1: Write the migration**

```sql
-- Late reason + notifications, schema only (2026-09-02). Idempotent.
alter table staff add column if not exists supervisor_id uuid references staff(id) on delete set null;

alter table attendance add column if not exists late_reason_code text;
alter table attendance add column if not exists late_reason      text;
alter table attendance add column if not exists late_excused     boolean not null default false;
alter table attendance add column if not exists late_excused_by  uuid references staff(id);
alter table attendance add column if not exists late_excused_at  timestamptz;

do $$ begin
  alter table attendance add constraint attendance_late_reason_code_check
    check (late_reason_code is null or late_reason_code in
      ('traffic','transport','medical','work_errand','personal','other'));
exception when duplicate_object then null; end $$;

create table if not exists notifications (
  id               uuid primary key default gen_random_uuid(),
  recipient_id     uuid not null references staff(id) on delete cascade,
  event_type       text not null,
  title            text not null,
  body             text,
  link             text,
  subject_staff_id uuid references staff(id) on delete cascade,
  subject_date     date,
  read_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (recipient_id, event_type, subject_staff_id, subject_date)
);

create index if not exists notifications_inbox_idx
  on notifications (recipient_id, read_at, created_at desc);

alter table notifications enable row level security;

drop policy if exists "notifications_select_own" on notifications;
create policy "notifications_select_own" on notifications for select
  using (recipient_id = auth.uid());

-- Only the read flag is user-writable; the row itself is written by notify_late().
drop policy if exists "notifications_update_own_read" on notifications;
create policy "notifications_update_own_read" on notifications for update
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- Excusing is limited to the staff member's own supervisor and the manager tier.
drop policy if exists "attendance_update_excuse" on attendance;
create policy "attendance_update_excuse" on attendance for update
  using (
    exists (
      select 1 from staff me, staff t
      where me.id = auth.uid() and t.id = attendance.staff_id
        and (me.system_role in ('manager','admin','owner') or me.rank = 'manager'
             or t.supervisor_id = me.id)
    )
  );

insert into notification_settings (event_type, label, notify_staff, notify_supervisor, notify_manager)
values ('attendance_late', 'Late Arrival', true, true, false)
on conflict (event_type) do nothing;

insert into system_rules (key, value, label, description) values
  ('late_reason_written_threshold', '15', 'Late reason: written explanation above (min)',
   'Lateness above this many minutes requires a typed explanation, not just a reason code')
on conflict (key) do nothing;

do $$ begin
  alter publication supabase_realtime add table notifications;
exception when duplicate_object then null; end $$;
```

- [ ] **Step 2: Confirm the settings table name before pasting**

The key/value settings table is `system_rules` (confirmed in Task 1). Verify and correct if it differs:

Run: `grep -n "late_deduction" supabase/schema.sql`
Expected: the `insert into <table> (key, value, label, description)` block that seeds `late_deduction`. Use that exact table name in Step 1's second `insert`.

- [ ] **Step 3: Apply it twice**

Paste into the Supabase SQL editor and run. Then run the identical script a second time.
Expected: both runs succeed with no error. Any error on the second run means something is not idempotent — fix it before continuing.

- [ ] **Step 4: Verify the shape**

```sql
select column_name from information_schema.columns
where table_name = 'attendance' and column_name like 'late_%' order by 1;
select count(*) from notifications;
select event_type from notification_settings where event_type = 'attendance_late';
```
Expected: five `late_*` columns (`late_excused`, `late_excused_at`, `late_excused_by`, `late_minutes`, `late_reason`, `late_reason_code` — six including the pre-existing `late_minutes`); `0`; one row.

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-09-02-late-reason-notifications.sql
git commit -m "feat(attendance): schema for late reasons, excuses and notifications"
```

---

### Task 2: notify_late() and the supervisor backfill

**Files:**
- Create: `supabase/migration-2026-09-02-notify-late-fn.sql`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `notify_late(p_staff_id uuid, p_date date, p_late_minutes int, p_reason_code text, p_reason text) returns int` — the number of notification rows written. Callable by the staff member themselves and by the manager tier.

- [ ] **Step 1: Write the function and backfill**

```sql
-- notify_late() + supervisor_id backfill (2026-09-02). Idempotent.
create or replace function notify_late(
  p_staff_id     uuid,
  p_date         date,
  p_late_minutes int,
  p_reason_code  text,
  p_reason       text
) returns int language plpgsql security definer as $$
declare
  v_settings  notification_settings%rowtype;
  v_staff     staff%rowtype;
  v_shift     text;
  v_reason    text;
  v_orphan    boolean;
  v_count     int := 0;
begin
  -- A staff member may only announce their own lateness; managers may do it for anyone.
  if auth.uid() is not null and auth.uid() <> p_staff_id then
    if not exists (
      select 1 from staff where id = auth.uid()
        and (system_role in ('manager','admin','owner') or rank = 'manager')
    ) then
      raise exception 'notify_late: not allowed';
    end if;
  end if;

  select * into v_settings from notification_settings where event_type = 'attendance_late';
  if v_settings.event_type is null or not v_settings.enabled then return 0; end if;

  select * into v_staff from staff where id = p_staff_id;
  if v_staff.id is null then return 0; end if;

  select to_char(st.start_time, 'HH12:MIam') into v_shift
  from scheduled_shifts ss join shift_types st on st.id = ss.shift_type_id
  where ss.staff_id = p_staff_id and ss.date = p_date;

  v_reason := coalesce(
    nullif(initcap(replace(p_reason_code, '_', ' ')), ''), 'Not given')
    || coalesce(' — "' || nullif(btrim(p_reason), '') || '"', '');

  v_orphan := v_staff.supervisor_id is null;

  -- The staff member themselves.
  if v_settings.notify_staff then
    insert into notifications (recipient_id, event_type, title, body, link, subject_staff_id, subject_date)
    values (p_staff_id, 'attendance_late', 'You were marked late today',
      'Clocked in ' || p_late_minutes || ' min late for the ' || coalesce(v_shift, 'scheduled') ||
      ' shift. Reason recorded: ' || v_reason || '.',
      '/hr/attendance', p_staff_id, p_date)
    on conflict (recipient_id, event_type, subject_staff_id, subject_date)
      do update set title = excluded.title, body = excluded.body, created_at = now(), read_at = null;
    v_count := v_count + 1;
  end if;

  -- The supervisor, or — when none is assigned — the branch manager tier, told why.
  if v_settings.notify_supervisor then
    insert into notifications (recipient_id, event_type, title, body, link, subject_staff_id, subject_date)
    select r.id, 'attendance_late', 'Late arrival — ' || v_staff.name,
      'Clocked in ' || p_late_minutes || ' min late for the ' || coalesce(v_shift, 'scheduled') ||
      ' shift. Reason: ' || v_reason || '.' ||
      case when v_orphan then ' No supervisor is assigned to this staff member.' else '' end,
      case when v_orphan then '/staff/' || p_staff_id else '/hr/attendance' end,
      p_staff_id, p_date
    from (
      select v_staff.supervisor_id as id where not v_orphan
      union
      select s.id from staff s
      where v_orphan and s.status = 'active'
        and (s.system_role in ('manager','admin','owner') or s.rank = 'manager')
        and (s.branch_id is not distinct from v_staff.branch_id)
    ) r
    where r.id is not null and r.id <> p_staff_id
    on conflict (recipient_id, event_type, subject_staff_id, subject_date)
      do update set title = excluded.title, body = excluded.body, created_at = now(), read_at = null;
    get diagnostics v_count = row_count;
  end if;

  return v_count;
end $$;

-- Backfill: most recent reviewer, then the branch person-in-charge.
update staff s set supervisor_id = r.reviewer_id
from (
  select distinct on (staff_id) staff_id, reviewer_id
  from monthly_reviews where reviewer_id is not null
  order by staff_id, year desc, month desc
) r
where r.staff_id = s.id and s.supervisor_id is null and r.reviewer_id <> s.id;

update staff s set supervisor_id = b.pic_staff_id
from branches b
where b.id = s.branch_id and s.supervisor_id is null
  and b.pic_staff_id is not null and b.pic_staff_id <> s.id;
```

- [ ] **Step 2: Apply and check coverage**

Paste and run, then run it a second time (idempotency). Then:

```sql
select count(*) filter (where supervisor_id is null) as no_supervisor,
       count(*) as active_staff
from staff where status = 'active';
```
Expected: `no_supervisor` well under `active_staff`. Whatever remains is covered by the manager fallback and will announce itself in the notification body — record the number in the commit message so the gap is visible.

- [ ] **Step 3: Smoke-test the function**

Pick a real staff id and a date with a scheduled shift:

```sql
select notify_late('<staff-uuid>'::uuid, current_date, 12, 'traffic', 'Jam on the Federal Highway');
select recipient_id, title, body from notifications where subject_date = current_date;
```
Expected: a positive return; one row addressed to the staff member and one to their supervisor (or to the branch managers, with the "No supervisor is assigned" sentence). Run the same call again — expected: still one row per recipient, `body` refreshed, not duplicated.

```sql
delete from notifications where subject_date = current_date;  -- clean up the smoke test
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migration-2026-09-02-notify-late-fn.sql
git commit -m "feat(attendance): notify_late() fan-out and supervisor backfill"
```

---

### Task 3: Pure reason module and types

**Files:**
- Create: `src/shared/lib/lateReason.ts`, `src/shared/lib/lateReason.test.ts`
- Modify: `src/shared/types/index.ts`

**Interfaces:**
- Produces: `LATE_REASON_CODES`, `LateReasonCode`, `LATE_REASON_LABELS`, `DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES`, `requiresWrittenExplanation(lateMinutes, thresholdMinutes)`, `isLateReasonComplete({code, note, lateMinutes, thresholdMinutes})`; types `AppNotification`, `Staff.supervisor_id`, the `Attendance` late fields.

- [ ] **Step 1: Write the failing test**

Create `src/shared/lib/lateReason.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES,
  isLateReasonComplete,
  requiresWrittenExplanation,
} from './lateReason'

const T = DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES

describe('requiresWrittenExplanation', () => {
  it('does not ask for writing at the threshold itself', () => {
    expect(requiresWrittenExplanation(15, T)).toBe(false)
  })

  it('asks for writing one minute past the threshold', () => {
    expect(requiresWrittenExplanation(16, T)).toBe(true)
  })

  it('defaults to 15 minutes when no threshold is configured', () => {
    expect(T).toBe(15)
  })
})

describe('isLateReasonComplete', () => {
  it('is incomplete with no reason code at all', () => {
    expect(isLateReasonComplete({ code: null, note: '', lateMinutes: 5, thresholdMinutes: T })).toBe(false)
  })

  it('is complete with just a code under the threshold', () => {
    expect(isLateReasonComplete({ code: 'traffic', note: '', lateMinutes: 5, thresholdMinutes: T })).toBe(true)
  })

  it('is incomplete over the threshold when nothing is typed', () => {
    expect(isLateReasonComplete({ code: 'traffic', note: '   ', lateMinutes: 40, thresholdMinutes: T })).toBe(false)
  })

  it('is complete over the threshold once something is typed', () => {
    expect(isLateReasonComplete({ code: 'traffic', note: 'Accident on the LDP', lateMinutes: 40, thresholdMinutes: T })).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/shared/lib/lateReason.test.ts`
Expected: FAIL — `Failed to resolve import "./lateReason"`.

- [ ] **Step 3: Write the module**

Create `src/shared/lib/lateReason.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/shared/lib/lateReason.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Extend the types**

In `src/shared/types/index.ts`, add to `interface Attendance` (after `late_minutes: number`):

```ts
  late_reason_code: string | null
  late_reason: string | null
  late_excused: boolean
  late_excused_by: string | null
  late_excused_at: string | null
```

Add to `interface Staff`:

```ts
  supervisor_id: string | null
```

Add a new interface next to `Attendance`:

```ts
export interface AppNotification {
  id: string
  recipient_id: string
  event_type: string
  title: string
  body: string | null
  link: string | null
  subject_staff_id: string | null
  subject_date: string | null
  read_at: string | null
  created_at: string
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no output.

```bash
git add src/shared/lib/lateReason.ts src/shared/lib/lateReason.test.ts src/shared/types/index.ts
git commit -m "feat(attendance): late reason codes, threshold rule and types"
```

---

### Task 4: The blocking reason step

**Files:**
- Create: `src/features/hr/LateReasonStep.tsx`
- Modify: `src/features/hr/HrAttendance.tsx` (`handleClockDone` at :834, the render at :917)
- Test: `src/features/hr/HrAttendance.late-reason.test.tsx` (new)

**Interfaces:**
- Consumes: `calcLateness`, `isLateReasonComplete`, `LATE_REASON_CODES`, `LATE_REASON_LABELS`, `requiresWrittenExplanation`, `writeOutcome`.
- Produces: `LateReasonStep` with props `{ lateMinutes: number; shiftStart: string; thresholdMinutes: number; saving: boolean; onSubmit: (r: { code: LateReasonCode; note: string }) => void }`; a `MyAttendance` clock-in that carries `late_reason_code` / `late_reason` into the same upsert; and `src/features/hr/ClockModal.tsx` exporting `ClockModal` and `ClockResult`.

- [ ] **Step 1: Write the failing test**

Create `src/features/hr/HrAttendance.late-reason.test.tsx`. It reuses the mock harness from `HrAttendance.write-failure.test.tsx` — copy that file's `vi.hoisted` block verbatim, then:

```tsx
// @vitest-environment jsdom
//
// Clocking in late must not complete until the staff member says why. The
// reason travels in the SAME upsert as the attendance row, so a late row can
// never exist without its reason.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { Staff } from '../../shared/types'

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {}
  const writes: Record<string, unknown>[] = []
  const rpcs: { fn: string; args: unknown }[] = []
  const makeQuery = (rows: unknown[]) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte', 'in', 'order', 'limit', 'update']) q[m] = () => q
    q.upsert = (row: Record<string, unknown>) => { writes.push(row); return q }
    q.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
    q.single = q.maybeSingle
    q.then = (onOk: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(onOk)
    return q
  }
  return { tables, writes, rpcs, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: (table: string) => h.makeQuery(h.tables[table] ?? []),
    rpc: (fn: string, args: unknown) => { h.rpcs.push({ fn, args }); return Promise.resolve({ data: 1, error: null }) },
  },
}))

const { MyAttendance } = await import('./HrAttendance')
const STAFF = { id: 'staff-1', branch: 'HQ' } as unknown as Staff
const DAY_SHIFT = { name: 'Day', department: 'barista', color: '#8B6344', start_time: '09:30:00', end_time: '18:00:00', break1_duration_minutes: 0, break2_duration_minutes: 0 }

beforeEach(() => {
  h.writes.length = 0
  h.rpcs.length = 0
  h.tables.attendance = []
  h.tables.scheduled_shifts = [{ date: '2026-09-02', leave_type: null, shift_type: DAY_SHIFT }]
  h.tables.system_rules = []
  vi.setSystemTime(new Date(2026, 8, 2, 9, 42, 0))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('迟到必须说明原因', () => {
  it('asks why before the clock-in is written', async () => {
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => screen.getByText(/Clock In/i))
    fireEvent.click(screen.getByText(/Clock In/i))
    // The camera/GPS modal resolves through onDone in the component; drive the
    // reason step directly once it appears.
    await waitFor(() => expect(screen.getByText(/12 minutes late/i)).toBeTruthy())
    expect(h.writes).toHaveLength(0)
  })

  it('carries the reason into the same write', async () => {
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => screen.getByText(/Clock In/i))
    fireEvent.click(screen.getByText(/Clock In/i))
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    fireEvent.click(screen.getByText(/Submit/i))
    await waitFor(() => expect(h.writes).toHaveLength(1))
    expect(h.writes[0]).toMatchObject({ status: 'late', late_minutes: 12, late_reason_code: 'traffic' })
  })

  it('does not ask a punctual staff member anything', async () => {
    vi.setSystemTime(new Date(2026, 8, 2, 9, 30, 40))
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => screen.getByText(/Clock In/i))
    fireEvent.click(screen.getByText(/Clock In/i))
    await waitFor(() => expect(h.writes).toHaveLength(1))
    expect(h.writes[0]).toMatchObject({ status: 'present', late_minutes: 0 })
    expect(screen.queryByText(/late/i)).toBeNull()
  })
})
```

The camera/GPS modal cannot run in jsdom, so stub it. Add this above the `MyAttendance` import in the test file:

```tsx
vi.mock('./ClockModal', () => ({ ClockModal: () => null }))
```

That only works once `ClockModal` lives in its own module. It does not today — so as the first implementation step, move `ClockModal` (and its `ClockResult`/`ClockModalProps` interfaces and the `ClockStep` type, `HrAttendance.tsx:104-361`) verbatim into `src/features/hr/ClockModal.tsx`, export them, and import them back. Move only; change no behaviour. This also takes 250 lines out of a 1247-line file.

With the stub in place the test drives `onDone` itself:

```tsx
vi.mock('./ClockModal', () => ({
  ClockModal: ({ onDone }: { onDone: (r: unknown) => void }) => {
    useEffect(() => { onDone({ photoUrl: 'x', lat: 0, lng: 0, distanceM: 0 }) }, [onDone])
    return null
  },
}))
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/features/hr/HrAttendance.late-reason.test.tsx`
Expected: FAIL — no "12 minutes late" text exists yet.

- [ ] **Step 3: Write the step component**

Create `src/features/hr/LateReasonStep.tsx`:

```tsx
import { useState } from 'react'
import {
  LATE_REASON_CODES, LATE_REASON_LABELS, isLateReasonComplete, requiresWrittenExplanation,
  type LateReasonCode,
} from '../../shared/lib/lateReason'

/** Shown after a late clock-in and before it is written. Deliberately has no
 *  close control: the shift is already recorded as late, the only way out is to
 *  say why. */
export function LateReasonStep({
  lateMinutes, shiftStart, thresholdMinutes, saving, onSubmit,
}: {
  lateMinutes: number
  shiftStart: string
  thresholdMinutes: number
  saving: boolean
  onSubmit: (r: { code: LateReasonCode; note: string }) => void
}) {
  const [code, setCode] = useState<LateReasonCode | null>(null)
  const [note, setNote] = useState('')
  const mustWrite = requiresWrittenExplanation(lateMinutes, thresholdMinutes)
  const complete = isLateReasonComplete({ code, note, lateMinutes, thresholdMinutes })

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md p-5 space-y-4">
        <div>
          <p className="font-semibold text-brown-dark">
            You are {lateMinutes} minutes late for your {shiftStart} shift
          </p>
          <p className="text-sm text-brown-faint mt-1">
            Please tell your supervisor why. This will be recorded.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {LATE_REASON_CODES.map(c => (
            <button
              key={c}
              onClick={() => setCode(c)}
              className="px-3 py-2 rounded-xl text-sm font-semibold border transition-colors"
              style={code === c
                ? { background: '#FBF0E6', color: '#8B5A2B', borderColor: '#C4813A' }
                : { background: '#F5EDE0', color: '#8B7355', borderColor: 'transparent' }}
            >
              {LATE_REASON_LABELS[c]}
            </button>
          ))}
        </div>

        {mustWrite && (
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={3}
            placeholder={`Explain what happened (required for lateness over ${thresholdMinutes} min)`}
            className="w-full px-3 py-2 rounded-xl border border-[#D4C5B0] text-sm text-brown-dark"
          />
        )}

        <button
          disabled={!complete || saving}
          onClick={() => code && onSubmit({ code, note: note.trim() })}
          className="w-full py-3 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Submit'}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Wire it into the clock-in**

In `HrAttendance.tsx`, import `LateReasonStep`, `DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES` and `LateReasonCode`. Add state in `MyAttendance` beside `clockModal` (:676):

```tsx
  const [pendingLate, setPendingLate] = useState<
    { result: ClockResult; lateMinutes: number; shiftStart: string } | null
  >(null)
```

Split `handleClockDone`'s clock-in branch (:839-852) so the reason is collected first:

```tsx
    if (type === 'in') {
      const lateness = todayShift
        ? calcLateness(now.toISOString(), attDate, todayShift.start_time)
        : { isLate: false, lateMinutes: 0 }
      if (lateness.isLate) {
        setPendingLate({
          result,
          lateMinutes: lateness.lateMinutes,
          shiftStart: fmtTime2(todayShift!.start_time),
        })
        setClockModal(null)
        return
      }
      outcome = await writeClockIn(now, result, { isLate: false, lateMinutes: 0 }, null, '')
      if (outcome.ok) setSuccessMsg(`Clocked in at ${fmtTime(now.toISOString())} ✓`)
    } else if (!today) {
```

Add the shared writer next to `handleClockDone` — one upsert, used by both the punctual and the late path, so the two can never drift:

```tsx
  async function writeClockIn(
    now: Date,
    result: ClockResult,
    lateness: { isLate: boolean; lateMinutes: number },
    reasonCode: LateReasonCode | null,
    reasonNote: string,
  ): Promise<WriteOutcome> {
    return writeOutcome(await supabase.from('attendance').upsert({
      staff_id: staff.id,
      date: attDate,
      clock_in: now.toISOString(),
      status: lateness.isLate ? 'late' : 'present',
      late_minutes: lateness.lateMinutes,
      late_reason_code: reasonCode,
      late_reason: reasonNote || null,
      clock_in_photo_url: result.photoUrl,
      clock_in_lat: result.lat,
      clock_in_lng: result.lng,
      clock_in_distance_m: result.distanceM,
    }, { onConflict: 'staff_id,date' }).select())
  }
```

And the submit handler:

```tsx
  async function handleLateReason({ code, note }: { code: LateReasonCode; note: string }) {
    if (!pendingLate) return
    const now = new Date()
    setSavingLate(true)
    const lateness = { isLate: true, lateMinutes: pendingLate.lateMinutes }
    const outcome = await writeClockIn(now, pendingLate.result, lateness, code, note)
    setSavingLate(false)
    if (!outcome.ok) {
      setErrorMsg(
        `Clock in FAILED — ${outcome.reason} Nothing was saved. Please try again, ` +
        `and tell your manager if it keeps failing.`
      )
      return   // keep the step open; the typed reason is not thrown away
    }
    setPendingLate(null)
    setSuccessMsg(
      `Clocked in at ${fmtTime(now.toISOString())} — late by ${lateness.lateMinutes} min ⚠️`
    )
    load()
    setTimeout(() => setSuccessMsg(null), 5000)
  }
```

Render it beside `ClockModal` (:920):

```tsx
      {pendingLate && (
        <LateReasonStep
          lateMinutes={pendingLate.lateMinutes}
          shiftStart={pendingLate.shiftStart}
          thresholdMinutes={DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES}
          saving={savingLate}
          onSubmit={handleLateReason}
        />
      )}
```

Add `const [savingLate, setSavingLate] = useState(false)` beside `pendingLate`.

Task 1 seeds `late_reason_written_threshold` so HR can tune it, so read it rather than hardcoding. Add beside the other `MyAttendance` state:

```tsx
  const [threshold, setThreshold] = useState(DEFAULT_WRITTEN_EXPLANATION_THRESHOLD_MINUTES)

  useEffect(() => {
    supabase.from('system_rules').select('value').eq('key', 'late_reason_written_threshold')
      .maybeSingle()
      .then(({ data }) => {
        const n = Number((data as { value?: string } | null)?.value)
        if (Number.isFinite(n) && n >= 0) setThreshold(n)
      })
  }, [])
```

and pass `thresholdMinutes={threshold}` to `LateReasonStep` instead of the constant. The constant stays as the fallback for a missing or malformed row — a bad settings value must never make the step unanswerable. Use the same table name confirmed in Task 1 Step 2.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/features/hr/`
Expected: PASS — the new file plus the existing `HrAttendance.write-failure` and `night-shift` suites, all green. The punctual path must still write in one step.

- [ ] **Step 6: Commit**

```bash
git add src/features/hr/LateReasonStep.tsx src/features/hr/HrAttendance.tsx src/features/hr/HrAttendance.late-reason.test.tsx
git commit -m "feat(attendance): require a reason before a late clock-in is saved"
```

---

### Task 5: Fire the notification

**Files:**
- Modify: `src/features/hr/HrAttendance.tsx` (`handleLateReason`)
- Test: `src/features/hr/HrAttendance.late-reason.test.tsx`

**Interfaces:**
- Consumes: `notify_late` from Task 2, `handleLateReason` from Task 4.

- [ ] **Step 1: Write the failing test**

Append to `HrAttendance.late-reason.test.tsx`:

```tsx
describe('通知发送', () => {
  it('tells notify_late after the attendance row lands', async () => {
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => screen.getByText(/Clock In/i))
    fireEvent.click(screen.getByText(/Clock In/i))
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    fireEvent.click(screen.getByText(/Submit/i))
    await waitFor(() => expect(h.rpcs).toHaveLength(1))
    expect(h.rpcs[0].fn).toBe('notify_late')
    expect(h.rpcs[0].args).toMatchObject({
      p_staff_id: 'staff-1', p_late_minutes: 12, p_reason_code: 'traffic',
    })
  })

  it('still counts the clock-in as successful when the notification fails', async () => {
    const { supabase } = await import('../../shared/lib/supabase')
    vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({ data: null, error: { message: 'boom' } } as never)
    render(<MyAttendance staff={STAFF} />)
    await waitFor(() => screen.getByText(/Clock In/i))
    fireEvent.click(screen.getByText(/Clock In/i))
    await waitFor(() => screen.getByText(/12 minutes late/i))
    fireEvent.click(screen.getByText('Traffic jam'))
    fireEvent.click(screen.getByText(/Submit/i))
    await waitFor(() => expect(screen.getByText(/Clocked in at/i)).toBeTruthy())
    expect(screen.getByText(/supervisor could not be notified/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/features/hr/HrAttendance.late-reason.test.tsx -t "notify_late"`
Expected: FAIL — `h.rpcs` stays empty.

- [ ] **Step 3: Call it, and never let it block the clock-in**

In `handleLateReason`, after the `outcome.ok` check and before `setPendingLate(null)`:

```tsx
    const notified = await supabase.rpc('notify_late', {
      p_staff_id: staff.id,
      p_date: attDate,
      p_late_minutes: lateness.lateMinutes,
      p_reason_code: code,
      p_reason: note,
    })
```

and make the success message reflect it:

```tsx
    setSuccessMsg(
      `Clocked in at ${fmtTime(now.toISOString())} — late by ${lateness.lateMinutes} min ⚠️` +
      (notified.error ? ' Your supervisor could not be notified.' : '')
    )
```

The clock-in is already saved at this point; a failed notification must never undo it or block the staff member.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/features/hr/`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/features/hr/HrAttendance.tsx src/features/hr/HrAttendance.late-reason.test.tsx
git commit -m "feat(attendance): notify staff and supervisor on a late clock-in"
```

---

### Task 6: Notification bell

**Files:**
- Create: `src/features/notifications/useNotifications.ts`, `src/features/notifications/NotificationBell.tsx`, `src/features/notifications/useNotifications.test.tsx`
- Modify: `src/shared/components/Sidebar.tsx` (header block at :83-93)

**Interfaces:**
- Consumes: `AppNotification` (Task 3), the `notifications` table (Task 1).
- Produces: `useNotifications(staffId)` → `{ items: AppNotification[]; unread: number; markRead(id: string): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

Create `src/features/notifications/useNotifications.test.tsx`. Model the realtime mock on `src/features/tasks/useBoardTasks.realtime.test.tsx` — read that file first and copy its channel stub, so both tests describe realtime the same way.

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'

const h = vi.hoisted(() => {
  const rows: unknown[] = []
  const handlers: ((p: unknown) => void)[] = []
  const channel = {
    on: (_e: string, _f: unknown, cb: (p: unknown) => void) => { handlers.push(cb); return channel },
    subscribe: (cb?: (s: string) => void) => { cb?.('SUBSCRIBED'); return channel },
  }
  const makeQuery = () => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update']) q[m] = () => q
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok)
    return q
  }
  return { rows, handlers, channel, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: () => h.makeQuery(),
    channel: () => h.channel,
    removeChannel: vi.fn(),
  },
}))

const { useNotifications } = await import('./useNotifications')

beforeEach(() => { h.rows.length = 0; h.handlers.length = 0 })
afterEach(() => cleanup())

describe('useNotifications', () => {
  it('counts only the unread ones', async () => {
    h.rows.push(
      { id: 'n1', title: 'Late arrival — Ali', read_at: null },
      { id: 'n2', title: 'Late arrival — Siti', read_at: '2026-09-02T01:00:00Z' },
    )
    const { result } = renderHook(() => useNotifications('sup-1'))
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(result.current.unread).toBe(1)
  })

  it('reloads when a notification arrives over realtime', async () => {
    const { result } = renderHook(() => useNotifications('sup-1'))
    await waitFor(() => expect(h.handlers.length).toBeGreaterThan(0))
    h.rows.push({ id: 'n3', title: 'Late arrival — Ahmad', read_at: null })
    h.handlers[0]({ eventType: 'INSERT' })
    await waitFor(() => expect(result.current.unread).toBe(1))
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/features/notifications/`
Expected: FAIL — cannot resolve `./useNotifications`.

- [ ] **Step 3: Write the hook**

Create `src/features/notifications/useNotifications.ts`:

```ts
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../shared/lib/supabase'
import type { AppNotification } from '../../shared/types'

/** The signed-in user's inbox. RLS already limits rows to the recipient, so no
 *  filter is needed here — and a filtered subscription would silently miss
 *  rows, the same trap the task board hit. */
export function useNotifications(staffId: string | undefined) {
  const [items, setItems] = useState<AppNotification[]>([])

  const load = useCallback(async () => {
    if (!staffId) return
    const { data } = await supabase
      .from('notifications').select('*')
      .order('created_at', { ascending: false }).limit(30)
    setItems((data as AppNotification[]) ?? [])
  }, [staffId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!staffId) return
    const channel = supabase
      .channel(`notifications:${staffId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => load())
      .subscribe(status => { if (status === 'SUBSCRIBED') load() })
    return () => { supabase.removeChannel(channel) }
  }, [staffId, load])

  const markRead = useCallback(async (id: string) => {
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id)
    setItems(prev => prev.map(n => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)))
  }, [])

  return { items, unread: items.filter(n => !n.read_at).length, markRead }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/features/notifications/`
Expected: PASS, 2 tests.

- [ ] **Step 5: Write the bell and mount it**

Create `src/features/notifications/NotificationBell.tsx`:

```tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import { useNotifications } from './useNotifications'

export function NotificationBell() {
  const { staff } = useAuth()
  const { items, unread, markRead } = useNotifications(staff?.id)
  const [open, setOpen] = useState(false)
  if (!staff) return null

  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} className="relative text-[#D4C4B0] hover:text-[#F5F0E8] p-1" aria-label="Notifications">
        <Bell size={20} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-[#C4813A] text-[10px] font-bold text-white flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 max-h-80 overflow-y-auto bg-white rounded-xl shadow-lg border border-[#E8DDD0] z-50">
          {items.length === 0 && <p className="p-4 text-sm text-brown-faint">Nothing new.</p>}
          {items.map(n => (
            <Link
              key={n.id}
              to={n.link ?? '#'}
              onClick={() => { markRead(n.id); setOpen(false) }}
              className={`block px-4 py-3 border-b border-[#F0E8DC] last:border-0 ${n.read_at ? 'opacity-60' : ''}`}
            >
              <p className="text-sm font-semibold text-brown-dark">{n.title}</p>
              {n.body && <p className="text-xs text-brown-faint mt-0.5">{n.body}</p>}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
```

In `Sidebar.tsx`, import it and put it in the logo row (:83-93), left of the existing close button:

```tsx
        <div className="flex items-center gap-1">
          <NotificationBell />
          {onClose && (
            <button onClick={onClose} className="text-[#D4C4B0] hover:text-[#F5F0E8] p-1">
              <X size={20} />
            </button>
          )}
        </div>
```

- [ ] **Step 6: Verify in the browser**

Start the dev server via the preview tool, sign in, and confirm the bell renders with no console errors. Insert one row by hand and confirm the badge appears without a reload:

```sql
select notify_late('<your-own-staff-uuid>'::uuid, current_date, 12, 'traffic', 'test');
```
Expected: badge count goes to 1 live; clicking the item navigates and clears the badge. Then `delete from notifications where subject_date = current_date;`.

- [ ] **Step 7: Commit**

```bash
git add src/features/notifications src/shared/components/Sidebar.tsx
git commit -m "feat(notifications): inbox hook and sidebar bell"
```

---

### Task 7: Excuse a lateness

**Files:**
- Modify: `src/features/hr/HrAttendance.tsx` (`DailyRoster`, the status row at :465-500)
- Test: `src/features/hr/HrAttendance.excuse.test.tsx` (new)

**Interfaces:**
- Consumes: `attendance.late_excused*` (Task 1), `Staff.supervisor_id` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `src/features/hr/HrAttendance.excuse.test.tsx`, reusing the harness block from `HrAttendance.late-reason.test.tsx`:

```tsx
describe('豁免的按钮只给真正有权限的人看', () => {
  it('shows Excuse to the staff member’s own supervisor', async () => {
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-1', rank: 'junior' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_reason_code: 'traffic', late_excused: false }]
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="sup-1" />)
    await waitFor(() => expect(screen.getByText('Excuse')).toBeTruthy())
  })

  it('hides Excuse from a supervisor who is not theirs, because RLS would reject it', async () => {
    h.tables.staff = [{ id: 'staff-1', name: 'Ali', supervisor_id: 'sup-9', rank: 'junior' }]
    h.tables.attendance = [{ id: 'a1', staff_id: 'staff-1', date: '2026-09-02', status: 'late', late_minutes: 12, late_excused: false }]
    render(<DailyRoster allStaff={h.tables.staff as never} managerId="sup-1" />)
    await waitFor(() => screen.getByText('Ali'))
    expect(screen.queryByText('Excuse')).toBeNull()
  })
})
```

`DailyRoster` is not exported today — add `export` to its declaration at `HrAttendance.tsx:365` so the test can mount it directly.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/features/hr/HrAttendance.excuse.test.tsx`
Expected: FAIL — `DailyRoster` is not exported / no `Excuse` control.

- [ ] **Step 3: Implement**

In `DailyRoster`, add the action beside the late-minutes input (:492-500):

```tsx
  const isManagerTier = (me: Staff | undefined) =>
    !!me && (me.rank === 'manager' || me.system_role === 'manager' ||
             me.system_role === 'admin' || me.system_role === 'owner')

  // Mirrors the attendance_update_excuse RLS policy exactly. Showing this button
  // to anyone else would give them a click that the database silently rejects.
  function canExcuse(target: Staff): boolean {
    const me = allStaff.find(s => s.id === managerId)
    return isManagerTier(me) || target.supervisor_id === managerId
  }

  // `saving` holds a STAFF id everywhere else in this component (`saving === s.id`);
  // keep that, or the disabled states stop matching.
  async function excuse(staffId: string, attendanceId: string) {
    setSaving(staffId)
    const outcome = writeOutcome(await supabase.from('attendance').update({
      late_excused: true,
      late_excused_by: managerId ?? null,
      late_excused_at: new Date().toISOString(),
    }).eq('id', attendanceId).select())
    setSaving(null)
    if (!outcome.ok) setRosterError(`Could not excuse this lateness — ${outcome.reason}`)
    else load()
  }
```

and in the row, after the minutes input:

```tsx
                  {rec?.status === 'late' && rec.late_reason_code && (
                    <span className="px-2 py-1 rounded-lg text-xs bg-[#F5EDE0] text-brown-muted">
                      {LATE_REASON_LABELS[rec.late_reason_code as LateReasonCode]}
                      {rec.late_reason ? ` — ${rec.late_reason}` : ''}
                    </span>
                  )}
                  {rec?.status === 'late' && !rec.late_excused && canExcuse(s) && (
                    <button
                      disabled={saving === s.id}
                      onClick={() => excuse(s.id, rec.id)}
                      className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-[#EEF5EF] text-[#3D7A50] border border-[#A8C5AE]"
                    >
                      Excuse
                    </button>
                  )}
                  {rec?.late_excused && (
                    <span className="px-2 py-1 rounded-lg text-xs font-semibold bg-[#EEF5EF] text-[#3D7A50]">
                      Excused
                    </span>
                  )}
```

Add `const [rosterError, setRosterError] = useState<string | null>(null)` and render it above the roster list so a rejected excuse is visible rather than silent.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/features/hr/`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/features/hr/HrAttendance.tsx src/features/hr/HrAttendance.excuse.test.tsx
git commit -m "feat(attendance): supervisors can excuse a lateness without erasing it"
```

---

### Task 8: Excused days stop costing score

**Files:**
- Modify: `src/features/team/Reviews.tsx` (`SupervisorReviewCard` effect at :383-399)
- Test: `src/features/team/Reviews.lateCount.test.ts` (new)

**Interfaces:**
- Consumes: `attendance.late_excused` (Task 1).
- Produces: `countLateDays(staffId: string, year: number, month: number): Promise<number>`, exported from `Reviews.tsx`.

The count currently lives inline in a `useEffect` that only fires when the card is
expanded, which is untestable without driving the whole card. Lift it into an
exported async function first — the same move this codebase already makes for
`nav.ts`, `leave.ts` and `probation.ts` — then the behaviour is a two-line test.

- [ ] **Step 1: Write the failing test**

Create `src/features/team/Reviews.lateCount.test.ts`:

```ts
// An excused lateness must not cost attendance score. attendance_score is
// generated from late_count (schema.sql:209), and this query is the only place
// that count is derived.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const filters: { m: string; args: unknown[] }[] = []
  const makeQuery = () => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'gte', 'lte']) {
      q[m] = (...args: unknown[]) => { filters.push({ m, args }); return q }
    }
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ count: 3 }).then(ok)
    return q
  }
  return { filters, makeQuery }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: { from: () => h.makeQuery() } }))

const { countLateDays } = await import('./Reviews')

beforeEach(() => { h.filters.length = 0 })

describe('countLateDays', () => {
  it('excludes excused days', async () => {
    await countLateDays('staff-1', 2026, 9)
    expect(h.filters).toContainEqual({ m: 'eq', args: ['late_excused', false] })
  })

  it('still only counts late days', async () => {
    await countLateDays('staff-1', 2026, 9)
    expect(h.filters).toContainEqual({ m: 'eq', args: ['status', 'late'] })
  })

  it('covers the whole month, including a 30-day one', async () => {
    await countLateDays('staff-1', 2026, 9)
    expect(h.filters).toContainEqual({ m: 'gte', args: ['date', '2026-09-01'] })
    expect(h.filters).toContainEqual({ m: 'lte', args: ['date', '2026-09-30'] })
  })

  it('handles February in a leap year', async () => {
    await countLateDays('staff-1', 2028, 2)
    expect(h.filters).toContainEqual({ m: 'lte', args: ['date', '2028-02-29'] })
  })

  it('returns the count', async () => {
    expect(await countLateDays('staff-1', 2026, 9)).toBe(3)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run src/features/team/Reviews.lateCount.test.ts`
Expected: FAIL — `countLateDays is not a function`.

- [ ] **Step 3: Extract the function and add the condition**

In `src/features/team/Reviews.tsx`, above `SupervisorReviewCard`:

```tsx
/** Late days that count against a monthly review. An excused lateness stays on
 *  the record as `late` but must not cost attendance score. */
export async function countLateDays(staffId: string, year: number, month: number): Promise<number> {
  const start = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const { count } = await supabase
    .from('attendance')
    .select('id', { count: 'exact', head: true })
    .eq('staff_id', staffId)
    .eq('status', 'late')
    .eq('late_excused', false)
    .gte('date', start)
    .lte('date', end)
  return count ?? 0
}
```

Replace the effect body at :383-399 with:

```tsx
  useEffect(() => {
    if (!expanded || autoLateCount != null) return
    countLateDays(review.staff_id, review.year, review.month).then(count => {
      setAutoLateCount(count)
      if (!lateOverridden) setLateCount(count)
    })
  }, [expanded])
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run`
Expected: PASS — the whole suite, 380+ tests.

- [ ] **Step 5: Typecheck, then commit**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no output.

```bash
git add src/features/team/Reviews.tsx src/features/team/Reviews.lateCount.test.ts
git commit -m "fix(reviews): excused lateness no longer costs attendance score"
```

---

### Task 9: Assign a supervisor from the staff profile

The backfill in Task 2 leaves gaps, and people change reporting lines. Without
this, a missing `supervisor_id` can only be fixed with hand-written SQL.

**Files:**
- Modify: `src/features/staff/StaffProfile.tsx` (the personal-info rows at :1267-1268)

**Interfaces:**
- Consumes: `Staff.supervisor_id` (Task 3).

- [ ] **Step 1: Read the surrounding pattern**

Run: `sed -n '1255,1280p' src/features/staff/StaffProfile.tsx`
Expected: a run of `PISelectRow` / `PISelectRowKV` rows for Branch and Department, each `value` / `options` / `onChange={v => update('<field>', v)}`. The new row copies that shape exactly — do not invent a different control.

- [ ] **Step 2: Add the picker**

Immediately after the Department row, add:

```tsx
            <PISelectRowKV
              label="Supervisor"
              value={form.supervisor_id ?? ''}
              options={allStaff
                .filter(s => s.id !== staff.id && s.status === 'active')
                .map(s => ({ key: s.id, label: s.name }))}
              onChange={v => update('supervisor_id', v || null)}
            />
```

If `allStaff` is not already in scope in this component, load it beside the existing
lookups with `supabase.from('staff').select('id, name, status').eq('status', 'active').order('name')`.
Check the exact `options` shape `PISelectRowKV` expects (`{ key, label }` vs `{ value, label }`)
by reading its definition before writing this, and match it.

- [ ] **Step 3: Verify by hand**

Open a staff member with no supervisor, pick one, save, reload.
Expected: the choice persists. Then:

```sql
select name, supervisor_id from staff where id = '<that-staff-uuid>';
```
Expected: the chosen id. Self-selection must not be offered in the list.

- [ ] **Step 4: Commit**

```bash
git add src/features/staff/StaffProfile.tsx
git commit -m "feat(staff): assign a supervisor from the profile page"
```

---

## Done when

- A staff member clocking in at 09:31 for a 09:30 shift cannot finish until they tap a reason; at 09:45 they must also type one.
- A staff member clocking in at 09:30:40 sees no change at all from today's behaviour.
- Both they and their supervisor have a notification; a staff member with no supervisor sends it to the branch managers *with* the "No supervisor is assigned" sentence.
- The supervisor can excuse it; the row still reads `late`, and that month's `late_count` drops by one.
- Changing `late_reason_written_threshold` in `system_rules` changes when the typed explanation is demanded, with no code change.
- A staff member with no supervisor can be given one from their profile page.
- `npx vitest run` and `npx tsc --noEmit -p tsconfig.app.json` are both clean.
