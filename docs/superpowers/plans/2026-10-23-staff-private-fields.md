# Staff Private Fields Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `ic_number`, `date_of_birth`, `contact_number`, `address` out of `staff` into `staff_private` (self + hr/manager/admin/owner), and `manager_notes` into `staff_manager_notes` (hr/manager/admin/owner only), so ordinary logged-in staff can no longer read colleagues' personal data.

**Architecture:** Two new RLS-protected tables keyed by `staff_id`, gated by one SQL function `can_read_staff_private()` and its frontend mirror `canReadStaffPrivate()`. All frontend reads/writes of these fields go through one small module `src/features/staff/privateApi.ts`. Rollout is two-phase: create + backfill while the old columns still exist, deploy, backfill again, then drop the old columns.

**Tech Stack:** React 19 + TypeScript + Vite, Tailwind, Supabase (Postgres + RLS + Edge Functions on Deno), vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-10-23-staff-private-fields-design.md`

## Global Constraints

- Readers of the four private fields: the staff member themselves, plus `current_rank() = 'manager' or current_system_role() in ('hr','manager','admin','owner')`. Supervisors are NOT readers, not even for their own branch.
- `manager_notes`: readable/writable only by `hr`/`manager`/`admin`/`owner` (or rank `manager`). The subject of the note can NOT read it.
- All UI labels, copy, placeholders and error strings are **English**. Comments may be Chinese or English.
- Placeholder for hidden fields: exactly `Restricted`.
- Work only in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/staff-private` on branch `feature/staff-private`. Never `git checkout` another branch in `/Users/USER/Desktop/Craft_OS` itself — that working tree is shared with other live sessions. `git add` only the exact paths each task names.
- Tasks 1–7 never touch production. Only Task 8 does, and Task 8's column drop needs an explicit one-line confirmation to the user first.
- Test command: `npx vitest run`. Typecheck: `npx tsc -b`. Build: `npm run build`.
- Prod project ref: `yfsoesxzurzjdwstszru`. Never print the anon/publishable key or any token in output.

## File Map

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-23-staff-private.sql` (create) | Phase 1: function, two tables, RLS, ensure-row trigger, idempotent backfill |
| `supabase/VERIFY-2026-10-23-staff-private.sql` (create) | Role-simulation check: rows visible per persona, write probe rolled back |
| `supabase/migration-2026-10-23-staff-private-drop-columns.sql` (create) | Phase 2: loss check query + drop of the five old columns |
| `supabase/schema.sql`, `supabase/FRESH_BUILD_full.sql` (modify) | Remove the five `add column` lines, point to the new migration |
| `src/shared/types/index.ts` (modify) | Add `StaffPrivate`; later remove the five fields from `Staff` |
| `src/shared/lib/permissions.ts` (modify) | Add `canReadStaffPrivate()` |
| `src/features/staff/privateApi.ts` (create) | `fetchStaffPrivate`, `saveStaffPrivate`, `fetchManagerNotes`, `saveManagerNotes` |
| `src/features/staff/StaffProfile.tsx` (modify) | Load private row, `Restricted` display, notes card on new table |
| `src/features/onboarding/submitOnboarding.ts` (create) | Ordered two-write onboarding submit |
| `src/features/onboarding/Onboarding.tsx` (modify) | Use `submitOnboarding`, prefill from `staff_private` |
| `supabase/functions/provision-staff/index.ts` (modify) | Approve path writes phone to `staff_private` |
| `supabase/migration-2026-10-23-staff-authority-guard.sql` (create, final review) | Replaces `staff_guard_authority_update()`: owner-only system_role, rank cap for non-manager-tier, BEFORE INSERT OR UPDATE |

**One deliberate refinement over the spec:** the spec has `provision-staff` guarantee a `staff_private` row for each new staff member. This plan guarantees it in the database instead, with an `after insert on staff` trigger (Task 1). That covers every insert path, including the manager "create" action and any hand-written SQL. The Edge Function then only has to write the phone number.

**One deliberate deviation for the schema files:** `schema.sql` / `FRESH_BUILD_full.sql` do not define `current_system_role()` (that lives in `migration-2026-07-06-rbac.sql`, which runs after them). So the new function and tables stay in their migration file, and the schema files only drop the five `add column` lines and add a pointer comment (Task 7).

**Final-review refinements (2026-10-23, after Tasks 1–7; user decisions D1–D3):**
- **D1 — escalation closed in this branch.** New `supabase/migration-2026-10-23-staff-authority-guard.sql` replaces `staff_guard_authority_update()` and runs it BEFORE INSERT OR UPDATE on `staff`: `system_role` is owner-only (change, or insert anything but `staff`); non-manager-tier callers (supervisor, hr) may only move ranks within trainee/junior/senior and only insert rows at those ranks; own-row rank/system_role/status protection is unchanged; `auth.uid() is null` passes. provision-staff `create` returns 403 "Only a manager can create staff at supervisor rank or above." for the same case. Without this, a supervisor could promote anyone to manager and so into the `staff_private` reader set.
- **D2 — temporary sync trigger** (`staff_private_sync_legacy_trg`, phase 1) copies old-bundle writes of the five columns into the new tables during the deploy window, only when a value actually changed and only for writers the new tables' rules allow. Phase 2 drops it before the columns. This reverses the spec's "不额外加同步 trigger".
- **D3 — `registration_requests.phone` is kept only while a request is pending.** provision-staff approve and Directory reject clear it; phase 1 clears existing non-pending rows without ever destroying the only copy: approved phones are first copied into empty `staff_private.contact_number`, and a phone is cleared only when it is in staff_private or belongs to a rejected request with no staff row (it runs twice, so it also catches old-function approvals in the window).
- **Notes subject exclusion.** `staff_manager_notes_all` adds `staff_id <> auth.uid()` to USING and WITH CHECK, so an hr/manager/admin/owner never reads or writes notes about themselves.
- **Approve without rollback.** If the `staff_private` phone write fails, approve returns 400 and leaves the request pending (auth user and staff row are kept); approving again repairs it. A null phone skips that write entirely (the insert trigger guarantees the row).
- **Phase 1 runs on any state** (fresh build, after phase 2): every read of the old columns is dynamic SQL behind an `information_schema` check. **Phase 2 is self-gating:** it locks `staff`, drops the sync trigger, and raises before the drop on any loss-check hit or remaining dependency. **VERIFY is a go/no-go gate** with a `pass` column per persona and `all_pass`.
- **Rollout order:** phase 1 + authority guard + VERIFY run on prod before the merge, then the new provision-staff is deployed, still before the merge (Task 8).

---

### Task 1: Phase-1 migration and its verification script

**Files:**
- Create: `supabase/migration-2026-10-23-staff-private.sql`
- Create: `supabase/VERIFY-2026-10-23-staff-private.sql`

**Interfaces:**
- Produces (DB): function `can_read_staff_private() returns boolean`; table `staff_private(staff_id uuid pk, ic_number text, date_of_birth date, contact_number text, address text, updated_at timestamptz)`; table `staff_manager_notes(staff_id uuid pk, notes text, updated_by uuid, updated_at timestamptz)`; trigger `staff_private_ensure_row_trg` on `staff`.

- [ ] **Step 1: Write the migration**

Create `supabase/migration-2026-10-23-staff-private.sql`:

```sql
-- 2026-10-23 — Phase 1 of the staff private-fields split (PDPA, second tier)
--
-- staff_select is `to authenticated using (true)`, so every logged-in staff
-- member could read every colleague's IC number, address, date of birth,
-- phone and the manager's private notes. This moves them to two tables:
--   staff_private        self + hr/manager/admin/owner
--   staff_manager_notes  hr/manager/admin/owner only (not the subject)
--
-- The old staff columns are NOT dropped here — the deployed bundle still
-- reads and writes them until the new frontend ships. Phase 2
-- (migration-2026-10-23-staff-private-drop-columns.sql) drops them.
--
-- Requires: migration-2026-07-06-rbac.sql (current_system_role()).
-- Idempotent: safe to re-run; re-running is also how the post-deploy
-- backfill (rollout step 3) is done.

begin;

-- ── Who may read private fields ──────────────────────────────────────────────
-- Same set as the salary tier in migration-2026-07-08-rls-system-role.sql.
create or replace function can_read_staff_private() returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce(current_rank() = 'manager', false)
      or coalesce(current_system_role() in ('hr','manager','admin','owner'), false);
$$;

-- ── staff_private ────────────────────────────────────────────────────────────
create table if not exists staff_private (
  staff_id       uuid primary key references staff(id) on delete cascade,
  ic_number      text,
  date_of_birth  date,
  contact_number text,
  address        text,
  updated_at     timestamptz not null default now()
);
alter table staff_private enable row level security;
revoke all on staff_private from anon;

drop policy if exists "staff_private_select" on staff_private;
create policy "staff_private_select" on staff_private for select to authenticated
  using (staff_id = auth.uid() or can_read_staff_private());

drop policy if exists "staff_private_insert" on staff_private;
create policy "staff_private_insert" on staff_private for insert to authenticated
  with check (staff_id = auth.uid() or can_read_staff_private());

drop policy if exists "staff_private_update" on staff_private;
create policy "staff_private_update" on staff_private for update to authenticated
  using (staff_id = auth.uid() or can_read_staff_private())
  with check (staff_id = auth.uid() or can_read_staff_private());
-- No delete policy: rows go away with their staff row (on delete cascade).

-- ── staff_manager_notes ──────────────────────────────────────────────────────
create table if not exists staff_manager_notes (
  staff_id    uuid primary key references staff(id) on delete cascade,
  notes       text,
  updated_by  uuid references staff(id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table staff_manager_notes enable row level security;
revoke all on staff_manager_notes from anon;

drop policy if exists "staff_manager_notes_all" on staff_manager_notes;
create policy "staff_manager_notes_all" on staff_manager_notes for all to authenticated
  using (can_read_staff_private())
  with check (can_read_staff_private());

-- ── Every staff row has a staff_private row ──────────────────────────────────
-- The frontend reads "no row" as "no permission" (RLS hides the row), so a
-- missing row would show a reader "Restricted". Guarantee the row at insert,
-- whatever path inserted the staff row (provision-staff create/approve, SQL).
create or replace function staff_private_ensure_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into staff_private (staff_id) values (new.id)
  on conflict (staff_id) do nothing;
  return new;
end $$;

drop trigger if exists staff_private_ensure_row_trg on staff;
create trigger staff_private_ensure_row_trg
  after insert on staff
  for each row execute function staff_private_ensure_row();

-- ── Backfill (idempotent) ────────────────────────────────────────────────────
-- coalesce keeps the new table's value: anything the new frontend already
-- wrote wins; only cells still empty in the new table are filled from staff.
insert into staff_private (staff_id, ic_number, date_of_birth, contact_number, address)
select id, ic_number, date_of_birth, contact_number, address from staff
on conflict (staff_id) do update set
  ic_number      = coalesce(staff_private.ic_number,      excluded.ic_number),
  date_of_birth  = coalesce(staff_private.date_of_birth,  excluded.date_of_birth),
  contact_number = coalesce(staff_private.contact_number, excluded.contact_number),
  address        = coalesce(staff_private.address,        excluded.address);

insert into staff_manager_notes (staff_id, notes)
select id, manager_notes from staff where manager_notes is not null
on conflict (staff_id) do update
  set notes = coalesce(staff_manager_notes.notes, excluded.notes);

commit;

-- Sanity (expect private_rows = staff_rows):
select (select count(*) from staff) as staff_rows,
       (select count(*) from staff_private) as private_rows,
       (select count(*) from staff_manager_notes) as notes_rows;
```

- [ ] **Step 2: Write the verification script**

Create `supabase/VERIFY-2026-10-23-staff-private.sql`:

```sql
-- Verify migration-2026-10-23-staff-private.sql as different personas.
-- Read-only in effect: the write probe runs inside a sub-block that is
-- always rolled back. Run as postgres (SQL Editor or Management API).
--
-- Expected:
--   persona     private_rows  notes_rows  others_private_update
--   trainee     1             0           0
--   supervisor  1             0           0
--   hr          total_staff   all notes   total_staff - 1
--   owner       total_staff   all notes   total_staff - 1
-- A persona with no matching staff row shows "(no such staff)" — fine.

create temp table if not exists _sp_verify (
  persona text, private_rows int, notes_rows int, others_private_update int
);
truncate _sp_verify;

do $$
declare
  p      record;
  v_priv int;
  v_notes int;
  v_upd  int;
begin
  for p in
    select 'trainee' as persona,
           (select id from staff where rank = 'trainee' and coalesce(system_role, 'staff') = 'staff'
              and status = 'active' limit 1) as uid
    union all
    select 'supervisor', (select id from staff where system_role = 'supervisor' and rank <> 'manager' limit 1)
    union all
    select 'hr', (select id from staff where system_role = 'hr' and rank <> 'manager' limit 1)
    union all
    select 'owner', (select id from staff where system_role = 'owner' limit 1)
  loop
    if p.uid is null then
      insert into _sp_verify values (p.persona || ' (no such staff)', null, null, null);
      continue;
    end if;

    perform set_config('request.jwt.claims',
      json_build_object('sub', p.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    select count(*) into v_priv  from staff_private;
    select count(*) into v_notes from staff_manager_notes;

    -- Write probe on OTHER people's rows, always rolled back.
    begin
      update staff_private set updated_at = updated_at where staff_id <> p.uid;
      get diagnostics v_upd = row_count;
      raise exception using errcode = 'P0001', message = 'rollback-probe';
    exception when sqlstate 'P0001' then
      null;
    end;

    execute 'reset role';
    insert into _sp_verify values (p.persona, v_priv, v_notes, v_upd);
  end loop;
end $$;

select v.*, (select count(*) from staff) as total_staff,
       (select count(*) from staff_manager_notes) as total_notes
from _sp_verify v;
```

- [ ] **Step 3: Self-check the SQL**

Run: `grep -n "drop column\|delete from\|truncate staff" supabase/migration-2026-10-23-staff-private.sql`
Expected: no output. Phase 1 must not remove anything.

- [ ] **Step 4: Commit**

```bash
git add supabase/migration-2026-10-23-staff-private.sql supabase/VERIFY-2026-10-23-staff-private.sql
git commit -m "feat(db): staff_private and staff_manager_notes tables with RLS (phase 1)"
```

---

### Task 2: `StaffPrivate` type, `canReadStaffPrivate`, `privateApi`

**Files:**
- Modify: `src/shared/types/index.ts` (add `StaffPrivate` right after `interface Staff`, which ends at line 137)
- Modify: `src/shared/lib/permissions.ts` (append a function)
- Create: `src/features/staff/privateApi.ts`
- Test: `src/features/staff/privateApi.test.ts`
- Test: `src/shared/lib/permissions.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `writeOutcome(res: WriteResponse): WriteOutcome` from `src/shared/lib/db-write.ts`; `supabase` from `src/shared/lib/supabase.ts`.
- Produces:
  - `interface StaffPrivate { staff_id: string; ic_number: string | null; date_of_birth: string | null; contact_number: string | null; address: string | null; updated_at: string }`
  - `type StaffPrivatePatch = Partial<Pick<StaffPrivate, 'ic_number' | 'date_of_birth' | 'contact_number' | 'address'>>`
  - `canReadStaffPrivate(staff: Pick<Staff, 'rank' | 'system_role'> | null | undefined): boolean`
  - `fetchStaffPrivate(staffId: string): Promise<StaffPrivate | null>`, which returns `null` when RLS hides the row and throws on a real error
  - `saveStaffPrivate(staffId: string, patch: StaffPrivatePatch): Promise<void>`, which throws on an error or on 0 rows
  - `fetchManagerNotes(staffId: string): Promise<string | null>`, which throws on error
  - `saveManagerNotes(staffId: string, notes: string | null, actorId: string): Promise<void>`, which throws on an error or on 0 rows

- [ ] **Step 1: Add the type**

In `src/shared/types/index.ts`, directly after the closing `}` of `export interface Staff` (line 137), insert:

```ts
/** staff_private row — IC, DOB, phone, address. RLS: self + hr/manager/admin/owner.
 *  A reader without permission gets no row at all (not nulls). */
export interface StaffPrivate {
  staff_id: string
  ic_number: string | null
  date_of_birth: string | null
  contact_number: string | null
  address: string | null
  updated_at: string
}
```

- [ ] **Step 2: Write the failing permissions test**

Append to `src/shared/lib/permissions.test.ts` (and change its import line to `import { canReviewStaff, canReadStaffPrivate } from './permissions'`):

```ts
describe('canReadStaffPrivate', () => {
  const who = (rank: Rank, system_role: SystemRole) => ({ rank, system_role })

  it('allows hr, manager, admin and owner system roles regardless of rank', () => {
    expect(canReadStaffPrivate(who('trainee', 'hr'))).toBe(true)
    expect(canReadStaffPrivate(who('trainee', 'manager'))).toBe(true)
    expect(canReadStaffPrivate(who('junior', 'admin'))).toBe(true)
    expect(canReadStaffPrivate(who('senior', 'owner'))).toBe(true)
  })

  it('allows rank manager even when system_role lags behind', () => {
    expect(canReadStaffPrivate(who('manager', 'staff'))).toBe(true)
  })

  it('denies supervisors and plain staff', () => {
    expect(canReadStaffPrivate(who('supervisor', 'supervisor'))).toBe(false)
    expect(canReadStaffPrivate(who('senior', 'staff'))).toBe(false)
  })

  it('denies when there is no signed-in staff', () => {
    expect(canReadStaffPrivate(null)).toBe(false)
    expect(canReadStaffPrivate(undefined)).toBe(false)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/shared/lib/permissions.test.ts`
Expected: FAIL, with an error that `canReadStaffPrivate` is not a function / not exported.

- [ ] **Step 4: Implement `canReadStaffPrivate`**

Append to `src/shared/lib/permissions.ts`:

```ts
/**
 * Frontend mirror of SQL can_read_staff_private(): who may read colleagues'
 * IC / DOB / phone / address (staff_private) and manager notes
 * (staff_manager_notes). Same set as the salary tier. Supervisors are
 * deliberately excluded. UI gate only — RLS is the real boundary.
 */
export function canReadStaffPrivate(
  staff: Pick<Staff, 'rank' | 'system_role'> | null | undefined,
): boolean {
  if (!staff) return false
  if (staff.rank === 'manager') return true
  return staff.system_role === 'hr' || staff.system_role === 'manager'
      || staff.system_role === 'admin' || staff.system_role === 'owner'
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run src/shared/lib/permissions.test.ts`
Expected: PASS (all old `canReviewStaff` tests plus the 4 new ones).

- [ ] **Step 6: Write the failing privateApi test**

Create `src/features/staff/privateApi.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Minimal supabase fake: records every call on the chain and resolves with
// whatever h.result holds. maybeSingle() and the thenable share the result.
const h = vi.hoisted(() => {
  const calls: { method: string; args: unknown[] }[] = []
  const state = { result: { data: null as unknown, error: null as { message: string } | null } }
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'eq', 'upsert']) {
    chain[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return chain }
  }
  chain.maybeSingle = () => { calls.push({ method: 'maybeSingle', args: [] }); return Promise.resolve(state.result) }
  chain.then = (onOk: (v: unknown) => unknown) => Promise.resolve(state.result).then(onOk)
  return { calls, state, chain }
})

vi.mock('../../shared/lib/supabase', () => ({ supabase: { from: (t: string) => (h.chain.from as (t: string) => unknown)(t) } }))

const api = await import('./privateApi')

beforeEach(() => {
  h.calls.length = 0
  h.state.result = { data: null, error: null }
})

const call = (m: string) => h.calls.find(c => c.method === m)

describe('fetchStaffPrivate', () => {
  it('reads staff_private for one staff id', async () => {
    h.state.result = { data: { staff_id: 's1', contact_number: '012' }, error: null }
    const row = await api.fetchStaffPrivate('s1')
    expect(call('from')?.args).toEqual(['staff_private'])
    expect(call('eq')?.args).toEqual(['staff_id', 's1'])
    expect(row?.contact_number).toBe('012')
  })

  it('returns null when RLS hides the row', async () => {
    h.state.result = { data: null, error: null }
    expect(await api.fetchStaffPrivate('s1')).toBeNull()
  })

  it('throws on a real error instead of pretending there is no row', async () => {
    h.state.result = { data: null, error: { message: 'network down' } }
    await expect(api.fetchStaffPrivate('s1')).rejects.toThrow('network down')
  })
})

describe('saveStaffPrivate', () => {
  it('upserts only the patched columns, keyed on staff_id', async () => {
    h.state.result = { data: [{ staff_id: 's1' }], error: null }
    await api.saveStaffPrivate('s1', { contact_number: '012', address: null })
    const [payload, opts] = call('upsert')!.args as [Record<string, unknown>, Record<string, unknown>]
    expect(payload).toMatchObject({ staff_id: 's1', contact_number: '012', address: null })
    expect(payload).not.toHaveProperty('ic_number')
    expect(opts).toEqual({ onConflict: 'staff_id' })
    expect(call('select')?.args).toEqual(['staff_id'])
  })

  it('throws when the write comes back with no rows (RLS filtered it)', async () => {
    h.state.result = { data: [], error: null }
    await expect(api.saveStaffPrivate('s1', { address: 'x' })).rejects.toThrow()
  })

  it('throws the database message on error', async () => {
    h.state.result = { data: null, error: { message: 'new row violates row-level security policy' } }
    await expect(api.saveStaffPrivate('s1', { address: 'x' })).rejects.toThrow('row-level security')
  })
})

describe('manager notes', () => {
  it('fetchManagerNotes returns the notes text or null', async () => {
    h.state.result = { data: { notes: 'Great with customers' }, error: null }
    expect(await api.fetchManagerNotes('s1')).toBe('Great with customers')
    h.state.result = { data: null, error: null }
    expect(await api.fetchManagerNotes('s1')).toBeNull()
    expect(call('from')?.args).toEqual(['staff_manager_notes'])
  })

  it('saveManagerNotes records who wrote it and throws on 0 rows', async () => {
    h.state.result = { data: [{ staff_id: 's1' }], error: null }
    await api.saveManagerNotes('s1', 'note', 'mgr-1')
    const [payload] = call('upsert')!.args as [Record<string, unknown>]
    expect(payload).toMatchObject({ staff_id: 's1', notes: 'note', updated_by: 'mgr-1' })

    h.state.result = { data: [], error: null }
    await expect(api.saveManagerNotes('s1', 'note', 'mgr-1')).rejects.toThrow()
  })
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/features/staff/privateApi.test.ts`
Expected: FAIL, with an error that `./privateApi` cannot be resolved.

- [ ] **Step 8: Implement privateApi**

Create `src/features/staff/privateApi.ts`:

```ts
import { supabase } from '../../shared/lib/supabase'
import { writeOutcome } from '../../shared/lib/db-write'
import type { StaffPrivate } from '../../shared/types'

/** The four private columns; any subset may be written. */
export type StaffPrivatePatch = Partial<Pick<StaffPrivate, 'ic_number' | 'date_of_birth' | 'contact_number' | 'address'>>

/** One staff member's private row, or null when RLS hides it from the caller
 *  (they are neither the staff member nor hr/manager/admin/owner). A real
 *  failure throws — never conflate "can't see" with "couldn't load". */
export async function fetchStaffPrivate(staffId: string): Promise<StaffPrivate | null> {
  const { data, error } = await supabase
    .from('staff_private').select('*').eq('staff_id', staffId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data ?? null) as StaffPrivate | null
}

/** Upserts only the columns present in `patch`. Throws when the database
 *  rejects the write or RLS silently filters it (0 rows back). */
export async function saveStaffPrivate(staffId: string, patch: StaffPrivatePatch): Promise<void> {
  const res = await supabase
    .from('staff_private')
    .upsert({ staff_id: staffId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'staff_id' })
    .select('staff_id')
  const outcome = writeOutcome(res)
  if (!outcome.ok) throw new Error(`Personal details were not saved: ${outcome.reason}`)
}

/** Manager notes about one staff member, or null (none written, or not allowed). */
export async function fetchManagerNotes(staffId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('staff_manager_notes').select('notes').eq('staff_id', staffId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as { notes: string | null } | null)?.notes ?? null
}

export async function saveManagerNotes(staffId: string, notes: string | null, actorId: string): Promise<void> {
  const res = await supabase
    .from('staff_manager_notes')
    .upsert({ staff_id: staffId, notes, updated_by: actorId, updated_at: new Date().toISOString() }, { onConflict: 'staff_id' })
    .select('staff_id')
  const outcome = writeOutcome(res)
  if (!outcome.ok) throw new Error(`Notes were not saved: ${outcome.reason}`)
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run src/features/staff/privateApi.test.ts src/shared/lib/permissions.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/shared/types/index.ts src/shared/lib/permissions.ts src/shared/lib/permissions.test.ts src/features/staff/privateApi.ts src/features/staff/privateApi.test.ts
git commit -m "feat(staff): privateApi and canReadStaffPrivate for the split private fields"
```

---

### Task 3: StaffProfile reads private fields and notes from the new tables

**Files:**
- Modify: `src/features/staff/StaffProfile.tsx`
- Modify: `src/features/staff/StaffProfile.supervisor.test.tsx` (pass the new `priv` prop)
- Test: `src/features/staff/StaffProfile.private.test.tsx` (create)

**Interfaces:**
- Consumes: `fetchStaffPrivate`, `saveStaffPrivate`, `fetchManagerNotes`, `saveManagerNotes` (Task 2); `canReadStaffPrivate` (Task 2); `StaffPrivate` type.
- Produces: `PersonalInfoTab` gains a required prop `priv: StaffPrivate | null`. `null` means the viewer may not see the private fields.

- [ ] **Step 1: Write the failing test**

Create `src/features/staff/StaffProfile.private.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// The Personal tab must only show IC / DOB / phone / address from the
// staff_private row. A viewer RLS hides that row from (priv === null) sees
// "Restricted", and saving the form must send phone/address to staff_private
// rather than to staff.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import type { Staff, StaffPrivate } from '../../shared/types'

const h = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {}
  const writes: { table: string; payload: Record<string, unknown> }[] = []
  const makeQuery = (table: string, rows: unknown[]) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order']) q[m] = () => q
    q.update = (payload: Record<string, unknown>) => { writes.push({ table, payload }); return q }
    q.then = (onOk: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows.slice(), error: null }).then(onOk)
    return q
  }
  return {
    tables, writes, makeQuery,
    saveStaffPrivate: vi.fn(async () => {}),
  }
})

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: (table: string) => h.makeQuery(table, h.tables[table] ?? []),
    rpc: () => Promise.resolve({ data: 1, error: null }),
  },
}))

vi.mock('./privateApi', () => ({
  fetchStaffPrivate: vi.fn(async () => null),
  saveStaffPrivate: h.saveStaffPrivate,
  fetchManagerNotes: vi.fn(async () => null),
  saveManagerNotes: vi.fn(async () => {}),
}))

const { PersonalInfoTab } = await import('./StaffProfile')
const { LookupsProvider } = await import('../../shared/lib/lookups')

const STAFF = { id: 'staff-1', name: 'Ali', status: 'active', supervisor_id: null,
  rank: 'junior', level: 1, xp: 0, department: null, branch: null, employment_type: null,
  working_experience: null, education: null, nickname: null, gender: null,
  job_title_id: null, confirmation_date: null,
} as unknown as Staff

const PRIV: StaffPrivate = {
  staff_id: 'staff-1', ic_number: '900101-14-5555', date_of_birth: '1990-01-01',
  contact_number: '012-3456789', address: '1 Jalan Test', updated_at: '2026-10-23T00:00:00Z',
}

function renderTab(props: { priv: StaffPrivate | null; isSelf: boolean; isManager: boolean }) {
  return render(
    <LookupsProvider>
      <PersonalInfoTab staff={STAFF} email="ali@x.com" authEmail="ali@x.com" onSaved={() => {}} {...props} />
    </LookupsProvider>
  )
}

beforeEach(() => {
  h.writes.length = 0
  h.saveStaffPrivate.mockClear()
  h.tables.staff = [STAFF]
  h.tables.roles = []
  h.tables.departments = []
  h.tables.employment_types = []
  h.tables.system_role_permissions = []
})
afterEach(() => cleanup())

describe('PersonalInfoTab private fields', () => {
  it('shows Restricted for all four fields when the private row is hidden', async () => {
    renderTab({ priv: null, isSelf: false, isManager: false })
    await waitFor(() => expect(screen.getAllByText('Restricted')).toHaveLength(4))
    expect(screen.queryByText('900101-14-5555')).toBeNull()
  })

  it('shows the values when the private row is visible', async () => {
    renderTab({ priv: PRIV, isSelf: true, isManager: false })
    await waitFor(() => expect(screen.getByText('900101-14-5555')).toBeTruthy())
    expect(screen.getByText('012-3456789')).toBeTruthy()
    expect(screen.getByText('1 Jalan Test')).toBeTruthy()
    expect(screen.queryByText('Restricted')).toBeNull()
  })

  it('saves a changed phone to staff_private, not to staff', async () => {
    renderTab({ priv: PRIV, isSelf: true, isManager: false })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const phone = screen.getByDisplayValue('012-3456789')
    fireEvent.change(phone, { target: { value: '019-0000000' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }))

    await waitFor(() => expect(h.saveStaffPrivate).toHaveBeenCalledTimes(1))
    expect(h.saveStaffPrivate).toHaveBeenCalledWith('staff-1', { contact_number: '019-0000000', address: '1 Jalan Test' })
    const staffWrite = h.writes.find(w => w.table === 'staff')!
    expect(staffWrite.payload).not.toHaveProperty('contact_number')
    expect(staffWrite.payload).not.toHaveProperty('address')
  })

  it('does not touch staff_private when phone and address are unchanged', async () => {
    renderTab({ priv: PRIV, isSelf: true, isManager: false })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }))
    await waitFor(() => expect(h.writes.some(w => w.table === 'staff')).toBe(true))
    expect(h.saveStaffPrivate).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/staff/StaffProfile.private.test.tsx`
Expected: FAIL. With no `priv` support, `Restricted` is never rendered, and the values come from `staff.*` (undefined → `—`).

- [ ] **Step 3: Imports and page-level state**

In `src/features/staff/StaffProfile.tsx`:

Change the type import line to also import `StaffPrivate`:

```ts
import type { Staff, StaffPrivate, Mission, MissionCompletion, SkillRating, VerificationType, MonthlyReview, ProbationReview, Role } from '../../shared/types'
```

Change the permissions import and add the privateApi import:

```ts
import { canReviewStaff, canReadStaffPrivate } from '../../shared/lib/permissions'
import { fetchStaffPrivate, saveStaffPrivate, fetchManagerNotes, saveManagerNotes } from './privateApi'
```

After `const [staff, setStaff] = useState<Staff | null>(null)`, add:

```ts
  const [priv, setPriv]             = useState<StaffPrivate | null>(null)
```

After `const isManager = currentStaff?.rank === 'manager'`, add:

```ts
  // hr/manager/admin/owner (or rank manager): may read staff_private and manager notes.
  const canSeePrivate = canReadStaffPrivate(currentStaff)
```

- [ ] **Step 4: Load the private row with the profile**

In `load()`, extend the `Promise.all` destructure and array (add the 7th element at the end):

```ts
        const [staffRes, missionRes, completionRes, skillRes, reviewRes, probationRes, privRow] = await Promise.all([
          supabase.from('staff').select('*').eq('id', staffId!).single(),
          supabase.from('missions').select('*').order('created_at'),
          supabase.from('mission_completions').select('*, mission:missions(*)').eq('staff_id', staffId!),
          supabase.from('skill_ratings').select('*').eq('staff_id', staffId!).order('rated_at', { ascending: false }),
          supabase.from('monthly_reviews').select('status')
            .eq('staff_id', staffId!).eq('month', CURRENT_MONTH).eq('year', CURRENT_YEAR)
            .maybeSingle(),
          supabase.from('probation_reviews').select('*')
            .eq('staff_id', staffId!).is('overall_result', null)
            .order('created_at', { ascending: false }).limit(1).maybeSingle(),
          fetchStaffPrivate(staffId!),
        ])
```

and after `setProbation(...)` add `setPriv(privRow)`.

In `refreshAll()`, same pattern:

```ts
      const [staffRes, completionRes, reviewRes, privRow] = await Promise.all([
        supabase.from('staff').select('*').eq('id', staffId).single(),
        supabase.from('mission_completions').select('*, mission:missions(*)').eq('staff_id', staffId),
        supabase.from('monthly_reviews').select('status')
          .eq('staff_id', staffId).eq('month', CURRENT_MONTH).eq('year', CURRENT_YEAR).maybeSingle(),
        fetchStaffPrivate(staffId),
      ])
      if (staffRes.data) setStaff(staffRes.data as Staff)
      setPriv(privRow)
```

(Keep the remaining lines of `refreshAll` as they are.)

- [ ] **Step 5: Pass `priv` to the tab and re-gate the management cards**

In the `<PersonalInfoTab ... />` JSX, add the prop `priv={priv}`.

Replace the whole manager-only block:

```tsx
        {/* Manager-only sections */}
        {isManager && !isSelf && (
          <div className="mt-6 space-y-4">
            <ManagerNotesCard staff={staff} onSaved={refreshAll} />
            <EmploymentStatusCard staff={staff} onSetStatus={handleSetStatus} />
            <DangerZoneCard staff={staff} onReset={handleReset} />
          </div>
        )}
```

with:

```tsx
        {/* Notes: hr/manager/admin/owner. Status + danger zone: rank manager (unchanged). */}
        {(canSeePrivate || isManager) && !isSelf && (
          <div className="mt-6 space-y-4">
            {canSeePrivate && currentStaff && (
              <ManagerNotesCard staffId={staff.id} actorId={currentStaff.id} />
            )}
            {isManager && <EmploymentStatusCard staff={staff} onSetStatus={handleSetStatus} />}
            {isManager && <DangerZoneCard staff={staff} onReset={handleReset} />}
          </div>
        )}
```

- [ ] **Step 6: Rewrite `ManagerNotesCard` on the new table**

Replace the whole `function ManagerNotesCard ... }` with:

```tsx
function ManagerNotesCard({ staffId, actorId }: { staffId: string; actorId: string }) {
  const [notes, setNotes]   = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
  const [error, setError]   = useState('')

  useEffect(() => {
    let cancelled = false
    fetchManagerNotes(staffId)
      .then(n => { if (!cancelled) { setNotes(n ?? ''); setLoaded(true) } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load notes.') })
    return () => { cancelled = true }
  }, [staffId])

  async function save() {
    setSaving(true); setError('')
    try {
      await saveManagerNotes(staffId, notes || null, actorId)
      setSaved(true); setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save notes.')
    } finally { setSaving(false) }
  }

  return (
    <div className="bg-white rounded-xl shadow-card p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest">Manager Notes</p>
        <span className="text-xs text-brown-faint italic">Private — only visible to HR and managers</span>
      </div>
      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">{error}</p>}
      <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} disabled={!loaded}
        placeholder="Performance notes, observations, development feedback…"
        className={`${inputCls} resize-none mb-3`} />
      <button onClick={save} disabled={saving || !loaded}
        className={`text-xs px-3 py-1.5 rounded-lg border transition-colors font-medium ${
          saved ? 'bg-[#EBF5EE] text-[#3D7A50] border-[#5B9E6A30]'
                : 'border-[#8B634440] text-[#8B6344] bg-[#8B634408] hover:bg-[#8B634418]'
        }`}>
        {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save Notes'}
      </button>
    </div>
  )
}
```

- [ ] **Step 7: `PersonalInfoTab` reads and writes through `priv`**

Change the signature:

```tsx
export function PersonalInfoTab({
  staff, priv, isSelf, isManager, email, authEmail, onSaved,
}: {
  staff: Staff; priv: StaffPrivate | null; isSelf: boolean; isManager: boolean; email: string; authEmail: string; onSaved: () => void
}) {
```

Right after `const canEdit = ...` add:

```tsx
  // null ⇒ RLS hid this staff member's private row from the viewer.
  const restricted = priv === null
  const privValue = (v: string | null | undefined) => (restricted ? 'Restricted' : (v ?? '—'))
```

In the initial `useState<PersonalFormData>({...})`, replace
`contactNumber: staff.contact_number ?? '', address: staff.address ?? '',`
with
`contactNumber: priv?.contact_number ?? '', address: priv?.address ?? '',`.

In `cancel()`, make the same replacement in its `setForm({...})`.

In `save()`, delete `contact_number: form.contactNumber || null, address: form.address || null,` from `payload`. Then, directly after `if (error) throw error`, insert:

```ts
      const nextContact = form.contactNumber || null
      const nextAddress = form.address || null
      if (priv && (nextContact !== priv.contact_number || nextAddress !== priv.address)) {
        await saveStaffPrivate(staff.id, { contact_number: nextContact, address: nextAddress })
      }
```

In the Personal section's **edit** branch, replace

```tsx
            <InfoRow label="IC Number"     value={staff.ic_number ?? '—'}    note="Cannot be changed" />
            <InfoRow label="Date of Birth" value={staff.date_of_birth ?? '—'} note="Cannot be changed" />
```

with

```tsx
            <InfoRow label="IC Number"     value={privValue(priv?.ic_number)}     note="Cannot be changed" />
            <InfoRow label="Date of Birth" value={privValue(priv?.date_of_birth)} note="Cannot be changed" />
```

Wrap the `Contact Number` input so it only renders when the row is visible:

```tsx
              {!restricted && (
                <PIInputRow label="Contact Number" type="tel" value={form.contactNumber} onChange={v => update('contactNumber', v)} />
              )}
```

and the address textarea likewise:

```tsx
            {!restricted && (
              <PITextareaRow label="Address" value={form.address} onChange={v => update('address', v)} />
            )}
```

In the **view** branch, replace the four rows:

```tsx
            <InfoRow label="IC Number"     value={privValue(priv?.ic_number)} />
            <InfoRow label="Date of Birth" value={privValue(priv?.date_of_birth)} />
            <InfoRow label="Gender"        value={staff.gender ?? '—'} />
            <InfoRow label="Contact"       value={privValue(priv?.contact_number)} />
            <InfoRow label="Email"         value={email} />
            <InfoRow label="Address"       value={privValue(priv?.address)} multiline />
```

(Full Name / Nickname rows above them stay as they are.)

- [ ] **Step 8: Update the existing supervisor test for the new prop**

In `src/features/staff/StaffProfile.supervisor.test.tsx`, add `priv={null}` to all three `<PersonalInfoTab ... />` renders: the one in `renderTab` (line 57) and the two in the read-only describe (lines 159 and 170). Also add this mock below the existing `vi.mock('../../shared/lib/supabase', ...)`:

```ts
vi.mock('./privateApi', () => ({
  fetchStaffPrivate: async () => null,
  saveStaffPrivate: async () => {},
  fetchManagerNotes: async () => null,
  saveManagerNotes: async () => {},
}))
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run src/features/staff`
Expected: PASS. That covers the new private test (4), the supervisor test (unchanged count) and privateApi.

- [ ] **Step 10: Typecheck**

Run: `npx tsc -b`
Expected: no errors. (`Staff` still has the old fields until Task 5, so nothing else breaks yet.)

- [ ] **Step 11: Commit**

```bash
git add src/features/staff/StaffProfile.tsx src/features/staff/StaffProfile.private.test.tsx src/features/staff/StaffProfile.supervisor.test.tsx
git commit -m "feat(staff): profile reads private fields and notes from the new tables"
```

---

### Task 4: Onboarding writes private fields first, then staff

**Files:**
- Create: `src/features/onboarding/submitOnboarding.ts`
- Test: `src/features/onboarding/submitOnboarding.test.ts`
- Modify: `src/features/onboarding/Onboarding.tsx`

**Interfaces:**
- Consumes: `saveStaffPrivate`, `fetchStaffPrivate` (Task 2).
- Produces: `interface OnboardingForm` (moved from `Onboarding.tsx`, same 12 string fields); `submitOnboarding(userId: string, form: OnboardingForm): Promise<void>`, which throws and leaves `onboarding_completed` false whenever the private write fails.

- [ ] **Step 1: Write the failing test**

Create `src/features/onboarding/submitOnboarding.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  order: [] as string[],
  saveStaffPrivate: vi.fn(),
  staffUpdate: vi.fn(),
  staffResult: { data: [{ id: 'u1' }], error: null as { message: string } | null },
}))

vi.mock('../staff/privateApi', () => ({
  saveStaffPrivate: (...a: unknown[]) => { h.order.push('private'); return h.saveStaffPrivate(...a) },
}))

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => {
        h.order.push(table); h.staffUpdate(payload)
        const q = { eq: () => q, select: () => Promise.resolve(h.staffResult) }
        return q
      },
    }),
  },
}))

const { submitOnboarding } = await import('./submitOnboarding')

const FORM = {
  branch: 'Cheras', department: 'barista', employmentType: 'full_time', nickname: '',
  fullName: 'Ali Bin Abu', icNumber: '900101-14-5555', address: '1 Jalan Test', gender: 'Male',
  dateOfBirth: '1990-01-01', contactNumber: '012-3456789', workingExperience: 'None', education: 'SPM',
}

beforeEach(() => {
  h.order.length = 0
  h.saveStaffPrivate.mockReset().mockResolvedValue(undefined)
  h.staffUpdate.mockReset()
  h.staffResult = { data: [{ id: 'u1' }], error: null }
})

describe('submitOnboarding', () => {
  it('writes the private row first, then staff', async () => {
    await submitOnboarding('u1', FORM)
    expect(h.order).toEqual(['private', 'staff'])
    expect(h.saveStaffPrivate).toHaveBeenCalledWith('u1', {
      ic_number: '900101-14-5555', address: '1 Jalan Test',
      date_of_birth: '1990-01-01', contact_number: '012-3456789',
    })
  })

  it('never sends private fields to staff, and marks onboarding complete', async () => {
    await submitOnboarding('u1', FORM)
    const payload = h.staffUpdate.mock.calls[0][0] as Record<string, unknown>
    for (const k of ['ic_number', 'address', 'date_of_birth', 'contact_number']) {
      expect(payload).not.toHaveProperty(k)
    }
    expect(payload).toMatchObject({ name: 'Ali Bin Abu', onboarding_completed: true })
  })

  it('does not mark onboarding complete when the private write fails', async () => {
    h.saveStaffPrivate.mockRejectedValue(new Error('Personal details were not saved: x'))
    await expect(submitOnboarding('u1', FORM)).rejects.toThrow('Personal details were not saved')
    expect(h.staffUpdate).not.toHaveBeenCalled()
  })

  it('throws when the staff write is filtered out', async () => {
    h.staffResult = { data: [], error: null }
    await expect(submitOnboarding('u1', FORM)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/onboarding/submitOnboarding.test.ts`
Expected: FAIL, with an error that `./submitOnboarding` cannot be resolved.

- [ ] **Step 3: Implement**

Create `src/features/onboarding/submitOnboarding.ts`:

```ts
import { supabase } from '../../shared/lib/supabase'
import { writeOutcome } from '../../shared/lib/db-write'
import { saveStaffPrivate } from '../staff/privateApi'

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

  const res = await supabase.from('staff').update({
    name:                 form.fullName,
    nickname:             form.nickname || null,
    department:           form.department || null,   // already a department slug
    branch:               form.branch,
    employment_type:      form.employmentType,
    gender:               form.gender,
    working_experience:   form.workingExperience,
    education:            form.education,
    onboarding_completed: true,
  }).eq('id', userId).select('id')
  const outcome = writeOutcome(res)
  if (!outcome.ok) throw new Error(`Your profile was not saved: ${outcome.reason}`)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/features/onboarding/submitOnboarding.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into `Onboarding.tsx`**

1. Change the first import to `import { useEffect, useState } from 'react'`, and add:

```ts
import { fetchStaffPrivate } from '../staff/privateApi'
import { submitOnboarding, type OnboardingForm } from './submitOnboarding'
```

2. Delete the local `interface FormData { ... }` block. Replace every remaining `FormData` type reference in the file with `OnboardingForm`. `type FormErrors = Partial<Record<keyof OnboardingForm, string>>` and any step component props typed with `FormData` are among them. Run `grep -n "FormData" src/features/onboarding/Onboarding.tsx` afterwards; the only remaining hits should be the state variable names `formData` / `setFormData`.

3. In the initial `useState<OnboardingForm>({...})`, set the four private fields to empty strings:

```ts
    icNumber: '',
    address: '',
    gender: staff?.gender ?? '',
    dateOfBirth: '',
    contactNumber: '',
```

4. Directly after that `useState`, add the prefill:

```ts
  // Prefill from staff_private (a manager-approved registration already has
  // the phone there). Only fills fields the user hasn't typed into yet.
  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    fetchStaffPrivate(user.id).then(p => {
      if (cancelled || !p) return
      setFormData(prev => ({
        ...prev,
        icNumber:      prev.icNumber      || p.ic_number      || '',
        address:       prev.address       || p.address        || '',
        dateOfBirth:   prev.dateOfBirth   || p.date_of_birth  || '',
        contactNumber: prev.contactNumber || p.contact_number || '',
      }))
    }).catch(() => { /* prefill is a convenience; the form still works empty */ })
    return () => { cancelled = true }
  }, [user?.id])
```

5. Replace the body of `handleSubmit` with:

```ts
  async function handleSubmit() {
    if (!user) return
    setSaving(true)
    setSubmitError('')
    try {
      await submitOnboarding(user.id, formData)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not save your details.')
      setSaving(false)
      return
    }
    await refreshStaff()
    navigate('/profile', { replace: true })
  }
```

6. If `supabase` is now unused in `Onboarding.tsx`, remove its import. Check with `grep -n "supabase" src/features/onboarding/Onboarding.tsx`.

- [ ] **Step 6: Typecheck and test**

Run: `npx tsc -b && npx vitest run src/features/onboarding`
Expected: no type errors; 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/onboarding/submitOnboarding.ts src/features/onboarding/submitOnboarding.test.ts src/features/onboarding/Onboarding.tsx
git commit -m "feat(onboarding): write private fields to staff_private before completing"
```

---

### Task 5: Remove the five fields from the `Staff` type

**Files:**
- Modify: `src/shared/types/index.ts:104-137`

**Interfaces:**
- Produces: `Staff` without `ic_number`, `address`, `date_of_birth`, `contact_number`, `manager_notes`. After this, any code still reading them fails `tsc`.

- [ ] **Step 1: Delete the fields**

In `export interface Staff`, delete these five lines:

```ts
  ic_number: string | null
  address: string | null
  date_of_birth: string | null
  contact_number: string | null
```

and

```ts
  manager_notes: string | null
```

If the `// management fields` comment now heads only `last_level_up_at`, leave it.

- [ ] **Step 2: Typecheck — this is the leftover-usage detector**

Run: `npx tsc -b`
Expected: no errors. If any error names one of the five fields, the file it points at still reads the old column. Change it to go through `privateApi` the same way Task 3/4 did, and re-run until clean.

- [ ] **Step 3: Grep for untyped leftovers**

Run: `grep -rn -E "staff\??\.(ic_number|date_of_birth|contact_number|manager_notes|address)\b|from\('staff'\).*(ic_number|contact_number|manager_notes)" src --include='*.ts' --include='*.tsx' | grep -v -E "\.test\.tsx?:"`
Expected: no output. (`tsc` in Step 2 is the authoritative check; this only catches casts to `any`.)

- [ ] **Step 4: Full test run and build**

Run: `npx vitest run && npm run build`
Expected: all tests pass; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/index.ts
git commit -m "refactor(types): drop private fields from Staff now that they live in staff_private"
```

---

### Task 6: provision-staff writes the phone to `staff_private`

**Files:**
- Modify: `supabase/functions/provision-staff/index.ts` (approve action, the `admin.from('staff').upsert({...})` near line 254)

**Interfaces:**
- Consumes: table `staff_private` and trigger `staff_private_ensure_row_trg` (Task 1). The service-role client bypasses RLS.

- [ ] **Step 1: Remove the phone from the staff upsert**

In the approve action's `admin.from('staff').upsert({ ... })`, delete the line `contact_number: phone,`.

- [ ] **Step 2: Write the phone to staff_private**

Directly after the existing `if (profileErr) { ... }` block in the approve action (and before `await assignJobTitle(...)`), insert:

```ts
    // 电话属于 staff_private(本人 + hr/manager/admin/owner 可读),不再写进 staff。
    // staff_private 那一行由 staff insert trigger 保证存在;这里 upsert 只为写入电话,
    // 重复审批同一位也安全。失败时不回滚 auth/staff —— 帐号本身是好的,
    // 经理重新按一次审批就会补上电话。
    const { error: privErr } = await admin.from('staff_private')
      .upsert({ staff_id: userId, contact_number: phone }, { onConflict: 'staff_id' })
    if (privErr) {
      return json({ error: `Staff created, but the phone number was not saved: ${privErr.message}` }, 400)
    }
```

The create action needs no change: the trigger creates its `staff_private` row, and that action never had a phone field.

- [ ] **Step 3: Static check**

Run: `grep -n "contact_number" supabase/functions/provision-staff/index.ts`
Expected: exactly one hit, the `staff_private` upsert line.
If `deno` is installed, also run `deno check supabase/functions/provision-staff/index.ts` and expect no errors. It is not installed on this machine as of 2026-10-23, so in that case record "deno check skipped (not installed)" in the task report.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/provision-staff/index.ts
git commit -m "feat(provision-staff): store the approved phone in staff_private"
```

---

### Task 7: Phase-2 drop migration and schema files

**Files:**
- Create: `supabase/migration-2026-10-23-staff-private-drop-columns.sql`
- Modify: `supabase/schema.sql:174-178,193`
- Modify: `supabase/FRESH_BUILD_full.sql:173-177,192`

- [ ] **Step 1: Write the phase-2 migration**

Create `supabase/migration-2026-10-23-staff-private-drop-columns.sql`:

```sql
-- 2026-10-23 — Phase 2 of the staff private-fields split.
--
-- Run ONLY after:
--   1. migration-2026-10-23-staff-private.sql ran on this database,
--   2. the new frontend and provision-staff are deployed,
--   3. migration-2026-10-23-staff-private.sql was re-run (catch-up backfill),
--   4. the LOSS CHECK below returned 0.
--
-- Irreversible: drops five staff columns. Their data lives in staff_private
-- and staff_manager_notes by now.

-- ── LOSS CHECK (run alone first; must return lost = 0) ───────────────────────
-- A value is "lost" if staff still holds it but the new table has nothing.
-- A different non-null value in the new table is fine: it is a newer edit.
--
-- select count(*) as lost
-- from staff s
-- left join staff_private p        on p.staff_id = s.id
-- left join staff_manager_notes n  on n.staff_id = s.id
-- where p.staff_id is null
--    or (s.ic_number      is not null and p.ic_number      is null)
--    or (s.date_of_birth  is not null and p.date_of_birth  is null)
--    or (s.contact_number is not null and p.contact_number is null)
--    or (s.address        is not null and p.address        is null)
--    or (s.manager_notes  is not null and n.notes          is null);

begin;
alter table staff
  drop column if exists ic_number,
  drop column if exists address,
  drop column if exists date_of_birth,
  drop column if exists contact_number,
  drop column if exists manager_notes;
commit;
```

- [ ] **Step 2: Update `schema.sql`**

Delete exactly these five lines (currently 174, 175, 177, 178 and 193). The `gender` line at 176 stays where it is:

```sql
alter table staff add column if not exists ic_number          text;
alter table staff add column if not exists address            text;
alter table staff add column if not exists date_of_birth      date;
alter table staff add column if not exists contact_number     text;
alter table staff add column if not exists manager_notes    text;
```

Then, in place of the deleted `ic_number` line, add:

```sql
-- IC number, address, date of birth, phone and manager notes are NOT staff
-- columns: they live in staff_private / staff_manager_notes with their own
-- RLS. See migration-2026-10-23-staff-private.sql (run after
-- migration-2026-07-06-rbac.sql, which it depends on).
```

- [ ] **Step 3: Same edit in `FRESH_BUILD_full.sql`**

Apply the identical deletion (lines 173, 174, 176, 177 and 192; keep `gender` at 175) and add the same comment.

- [ ] **Step 4: Check**

Run: `grep -n -E "ic_number|date_of_birth|contact_number|manager_notes" supabase/schema.sql supabase/FRESH_BUILD_full.sql`
Expected: only the pointer comment lines.

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-10-23-staff-private-drop-columns.sql supabase/schema.sql supabase/FRESH_BUILD_full.sql
git commit -m "feat(db): phase-2 drop of staff private columns; schema points to staff_private"
```

---

### Task 8: Production rollout and verification

This task touches production and must be run by the main session, not a subagent. Every SQL step uses one of these routes, whichever works:
- Management API: `curl -s -X POST https://api.supabase.com/v1/projects/yfsoesxzurzjdwstszru/database/query -H "Authorization: Bearer $(cat ~/.supabase-access-token)" -H "Content-Type: application/json" -d @<json-file>`. Build the JSON with `python3 -c 'import json,sys; print(json.dumps({"query": open(sys.argv[1]).read()}))' <sql-file>`.
- Or the Supabase dashboard SQL editor in the user's Chrome. Set the SQL via `monaco.editor.getModels()[0].setValue(...)`, click Run, and confirm the "Potential issue detected" modal for DDL.

**Prerequisites (ask the user if missing):** a valid `~/.supabase-access-token`, or a signed-in Supabase tab in Chrome. A Supabase CLI login to the Craft-OS account, for deploying the Edge Function. A Vercel CLI login to scope `craftalemy-4209s-projects`.

Order (revised 2026-10-23, final review F9): the database changes go to prod **before** the merge. Phase 1 is additive and safe with the old bundle still live, and the authority guard only blocks writes the old bundle never makes legitimately, so the new frontend ships onto a database that already has its tables, its policies and a passing VERIFY. The new provision-staff is deployed right after VERIFY, before the merge (fix round 2): it closes the old function's create escalation as early as possible, and it is safe with the old frontend (see Step 5).

- [ ] **Step 1: Pre-flight on the branch (do not merge yet)**

Open the PR from `feature/staff-private` to `main` for review, but do not merge. On the branch: `npx vitest run && npx tsc -b && npm run build`, all clean.

- [ ] **Step 2: Phase 1 and the authority guard on prod**

Run `supabase/migration-2026-10-23-staff-private.sql`.
Expected last result: `staff_rows = private_rows` (61 at the time of writing), and `notes_rows` equal to the number of staff with notes. The registration_requests phone cleanup first copies approved requests' phones into empty `staff_private.contact_number`, then clears only numbers that are safely in staff_private (or rejected requests with no staff row). If it raises a NOTICE that some requests keep their phone, review those rows by hand; nothing was lost.

This also creates the TEMPORARY sync trigger `staff_private_sync_legacy_trg`, which copies old-bundle writes of the five columns into the new tables until phase 2 drops it.

Then run `supabase/migration-2026-10-23-staff-authority-guard.sql` (independent of phase 1; either order).
Expected last result: two rows, `INSERT` and `UPDATE`, both `BEFORE`.

Until Step 5 deploys the new provision-staff, the OLD function still lets a supervisor create a supervisor/manager account through `create` (it writes as service role, which the guard lets through). Go straight on to Steps 3–5.

- [ ] **Step 3: VERIFY by persona — go/no-go**

Run `supabase/VERIFY-2026-10-23-staff-private.sql`.
Expected: `all_pass = true` on every row. trainee, supervisor and owner must be `ok` (missing = FAIL); hr, rank-manager and admin may be `SKIPPED`. If `all_pass` is false, stop: read the failing row's columns against the table at the top of the file, fix, re-run. Do not deploy the function or merge.

Then the anon probe from a shell:

```bash
KEY=$(grep '^VITE_SUPABASE_ANON_KEY=' /Users/USER/Desktop/Craft_OS/.env.local | cut -d= -f2- | tr -d '"'); for t in staff_private staff_manager_notes; do printf "%-20s " $t; curl -s -o /dev/null -w "%{http_code} " "https://yfsoesxzurzjdwstszru.supabase.co/rest/v1/$t?select=staff_id&limit=1" -H "apikey: $KEY"; curl -s "https://yfsoesxzurzjdwstszru.supabase.co/rest/v1/$t?select=staff_id&limit=1" -H "apikey: $KEY" | head -c 120; echo; done
```

Expected: each returns `[]`, or a 401/403 permission error (anon has no grant). Neither may return any row.

- [ ] **Step 4: Exercise the four approve branches on the dev project first**

On the dev project `egznnbjmicebbhwasloy`, if it has this app's schema (`staff`, `registration_requests`, `system_role_permissions`, and phase 1's `staff_private`; run phase 1 there first if only the last is missing). Deploy the branch's provision-staff there (`supabase functions deploy provision-staff --project-ref egznnbjmicebbhwasloy`), then approve test registrations ([TEST]-prefixed) as a supervisor and as a manager:
1. **New email** → "Account Created" with the password; staff row trainee/staff; phone in `staff_private`; request approved with phone null.
2. **Interrupted orphan of this request** → create the auth user through a failed first attempt (or by hand with `app_metadata.registration_request_id` = the request id) and no staff row; approving adopts it, resets the password, and succeeds. An auth user WITHOUT that metadata must get 409 "This email belongs to an existing login that is not a staff account. Ask an admin."
3. **Existing staff email** → "Account Already Existed"; that user's password still works unchanged; their staff row is untouched; the phone is filled only when the approver is HR/manager (a supervisor gets the "phone number was not copied" note).
4. **Non-pending request** (approve one that was already rejected or approved) → 409 "This registration request is already …"; two approvals at once → one 409 "already being processed".

If the dev project does not have this schema, say so in the session log and record that the four branches were verified only by reading the code, then continue.

- [ ] **Step 5: Deploy the new provision-staff (before the merge)**

From this worktree at the reviewed branch head: `supabase functions deploy provision-staff --project-ref yfsoesxzurzjdwstszru`. If the PR changes `supabase/functions/provision-staff/` after this, deploy again after the merge.

Why this is safe now: the new function depends only on `staff_private` and `staff_private_ensure_row_trg`, both created by phase 1 in Step 2 (the authority guard does not affect it: it writes as service role). The old frontend calls it with the same request bodies (this branch only added optional response fields to `src/shared/lib/provision.ts`) and reads the same `staffId`; error bodies are shown as before. Behaviour differences with the old frontend still live:
Follow it promptly with Steps 6–7: the OLD frontend shows its "Account Created" credentials modal even when approve reports `alreadyExisted` (the password shown was not applied — the account was untouched), until the new frontend is live.
- create: a supervisor/hr asking for supervisor or manager rank gets a 403 with "Only a manager can create staff at supervisor rank or above.", which the old Directory shows as the error (that is the point).
- approve: the phone goes to `staff_private` only, and the request's phone is cleared. The old bundle reads `staff.contact_number`, so a staff member approved in this window shows an empty phone in the old UI until Step 7. Nothing is lost: the number is in `staff_private`, and the sync trigger only copies old-column changes old → new, so an old-bundle save that resends the empty value is not a change and copies nothing.

- [ ] **Step 6: Merge to main**

Merge the PR. Run `npx vitest run && npm run build` on the merged main.

- [ ] **Step 7: Deploy the frontend (promptly after Step 5)**

From a detached worktree of `origin/main` with `.vercel/` copied in: `vercel deploy --prod --yes`. Confirm the live bundle hash matches the local build: `curl -s https://craft-os-tale.vercel.app/ | grep -oE 'assets/index-[^"]+\.js'`.

- [ ] **Step 8: Catch-up backfill**

Re-run `supabase/migration-2026-10-23-staff-private.sql`. It is idempotent. It fills anything the sync trigger could not copy, and handles phones on registration requests decided by the old frontend between Step 2 and Step 7.

- [ ] **Step 9: Drop old columns (confirm first)**

Optionally run the commented LOSS CHECK in `migration-2026-10-23-staff-private-drop-columns.sql` on its own first (expect `lost = 0`). The file enforces it anyway.

Tell the user in one line: "Dropping staff.ic_number, address, date_of_birth, contact_number, manager_notes on prod. Their data is in staff_private / staff_manager_notes; the drop file re-checks for loss and dependencies and aborts if either fails." Then run the whole file. It locks `staff`, drops the sync trigger, raises (and rolls back everything) if the loss check is not 0 or anything still depends on the columns, and only then drops them. If it raises: stop and investigate; do not edit the checks to get past them.
Verify with the phase-2 queries at the bottom of `VERIFY-2026-10-23-staff-private.sql`: no old columns, no sync trigger.

- [ ] **Step 10: Live walkthrough on craft-os-tale.vercel.app**

- Own profile → Personal: IC / DOB / phone / address visible. Edit the phone, save, reload: the new value persists.
- A supervisor account opens a colleague's profile: the four rows show `Restricted`, and there is no Manager Notes card.
- An HR or owner account opens a colleague: the four values are visible, and the Manager Notes card loads, saves and survives a reload.
- If a test registration is available, approve it and check that its phone appears in `staff_private` and is cleared from `registration_requests`.
- If a supervisor login is available: Directory → Add Staff offers only Trainee / Junior / Senior in the Rank list.

If no supervisor login is available, record that these steps were covered by the SQL persona check in Step 3 and the dev-project checks in Step 4 instead.

- [ ] **Step 11: Push and record**

`git push origin main`. Update memory `staff-table-public-read.md` to mark the second tier resolved, with the commit hash.
