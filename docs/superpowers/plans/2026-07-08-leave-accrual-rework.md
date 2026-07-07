# Leave Accrual Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **STAGE GATES:** the user verifies locally after each stage (per their explicit requirement). Execution order: Task 1 → USER GATE (runs SQL Part 1, then Part 2) → Tasks 2+3 → deploy → USER GATE → Task 4 → deploy → USER GATE → Task 5 → deploy → USER GATE → Task 6 (ops). Do not run ahead of a gate.

**Goal:** AL becomes monthly accrual from `confirmation_date` (pg_cron engine, calendar-year accrual cap, Jan-1 carryover forfeit), Emergency Leave is retired from the UI, PH Replacement credits (manual grant, expiry, FIFO consumption on approval) are added, all parameters configurable in Settings — per `docs/superpowers/specs/2026-07-08-leave-accrual-rework-design.md`.

**Architecture:** One idempotent SQL migration file (`supabase/migration-2026-07-08-leave-accrual.sql`, run by hand in two parts) creates `staff.confirmation_date` (+hired backfill), `leave_accrual_log` (unique-keyed ledger), `ph_replacements`, RLS, five `system_rules` seeds, the `process_leave_accruals()` security-definer catch-up function, and the `cron.schedule` line. The client computes AL balance as ledger-sum minus approved annual days (pure helpers in `src/shared/lib/leave.ts`, unit-tested). UI work is confined to `HrLeave.tsx` (cards, apply validation, grant modal, FIFO consumption on approve), `Settings.tsx` (Leave Settings block + Recalculate RPC + missing-confirmation list), and `StaffProfile.tsx` (confirmation date field).

**Tech Stack:** React 19 + TypeScript, Supabase (Postgres + pg_cron), Vitest.

## Global Constraints

- AL accrues per completed month from `confirmation_date` (month-anniversary; anchor arithmetic `confirmation_date + n * interval '1 month'`, NOT cumulative adds). Monthly rate default `0.667`; calendar-year accrual cap default `8` (per-year sum of accrual entries never exceeds it); carryover cap default `4` forfeited via a negative `forfeit` entry keyed to Jan 1.
- AL available (client) = `Σ leave_accrual_log.amount` − `Σ approved annual total_days` − `Σ pending annual total_days` (pending counted so double-applying can't overspend); displayed balance rounds to 1 decimal.
- Idempotency is structural: `unique (staff_id, entry_type, period_month)` on the ledger; running the function twice changes nothing.
- Emergency Leave: removed from cards, apply options, and the manager table. DB columns and historical rows untouched; `leave_requests.leave_type` check keeps `'emergency'`.
- PH Replacement: credits consumed ONLY on approval, FIFO by `expires_at`; insufficient credits at approval time blocks the approval with a visible error. Reject/cancel consumes nothing. Expiry default 3 months, marked `expired` by the daily job.
- Settings keys (exact): `leave_al_monthly_rate` '0.667', `leave_al_annual_cap` '8', `leave_al_carryover_cap` '4', `leave_ph_expiry_months` '3', `leave_medical_annual` '14'.
- `leave_entitlements.annual_*` and `emergency_*` become read-only legacy: `ensureEntitlement` stops writing a computed annual figure; `approve()` updates entitlement counters only for `medical` and `unpaid`.
- All new Supabase errors surface visibly (red banner idiom / modal error text); nothing swallowed.
- SQL is run BY HAND by the user in the Supabase SQL editor (never from the sandbox). Deploys via `vercel deploy --prod --yes` (git push does not deploy).
- `calcAnnualEntitlement()` is deleted (its only consumer is `ensureEntitlement`).

---

## File Structure

| File | Change |
|---|---|
| `supabase/migration-2026-07-08-leave-accrual.sql` | New — Part 1 schema/RLS/seeds, Part 2 engine + cron |
| `src/shared/types/index.ts` | `Staff.confirmation_date`; `AccrualEntry`, `PhReplacement` types; delete `calcAnnualEntitlement` |
| `src/shared/lib/leave.ts` | New — `calcAlBalance`, `pickPhGrantsFifo` (pure, tested) |
| `src/shared/lib/leave.test.ts` | New — Vitest |
| `src/features/hr/HrLeave.tsx` | EL removal, AL accrual card + validation, PH card + grant modal + apply option + FIFO approve |
| `src/features/settings/Settings.tsx` | Leave Settings block (5 keys, Recalculate, missing-confirmation list) |
| `src/features/staff/StaffProfile.tsx` | Confirmation Date field in manager edit |

---

## Task 1: Migration SQL file (Stage 1 + Stage 2 content)

**Files:**
- Create: `supabase/migration-2026-07-08-leave-accrual.sql`

**Interfaces:**
- Produces: tables/columns/function/cron exactly as below; Tasks 2-5 depend on the names `leave_accrual_log(staff_id, entry_type, amount, period_month)`, `ph_replacements(staff_id, granted_by, granted_at, expires_at, reason, status, used_in_leave_request_id)`, `staff.confirmation_date`, RPC `process_leave_accruals`, and the five system_rules keys.

- [ ] **Step 1: Write the file**

Create `supabase/migration-2026-07-08-leave-accrual.sql` with EXACTLY:

```sql
-- ============================================================================
-- Leave accrual rework (2026-07-08) — run BY HAND in the Supabase SQL editor.
-- PART 1 (schema) first; verify; then PART 2 (engine + cron).
-- Both parts are idempotent — safe to re-run.
-- Prereq for PART 2: Dashboard → Database → Extensions → enable pg_cron.
-- ============================================================================

-- ───────────────────────────── PART 1: SCHEMA ─────────────────────────────

-- 1) Confirmation date (accrual anchor) + backfill from probation hires
alter table staff add column if not exists confirmation_date date;

update staff s set confirmation_date = sub.d
from (
  select staff_id, min(day3_completed_at)::date as d
  from probation_reviews
  where overall_result = 'hired'
  group by staff_id
) sub
where s.id = sub.staff_id and s.confirmation_date is null;

-- 2) AL ledger — the single source of truth for accrued annual leave
create table if not exists leave_accrual_log (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  leave_type text not null default 'annual' check (leave_type = 'annual'),
  entry_type text not null default 'accrual'
    check (entry_type in ('accrual','forfeit','adjustment')),
  amount numeric not null,
  period_month date,              -- accrual: covered month-anniversary; forfeit: Jan 1
  accrued_at timestamptz not null default now(),
  note text,
  unique (staff_id, entry_type, period_month)
);

alter table leave_accrual_log enable row level security;

drop policy if exists "accrual_log_select" on leave_accrual_log;
create policy "accrual_log_select" on leave_accrual_log for select to authenticated
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));
-- No insert/update/delete policies: clients cannot write; only the
-- security-definer function below writes.

-- 3) PH Replacement credits
create table if not exists ph_replacements (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  granted_by uuid references staff(id),
  granted_at timestamptz not null default now(),
  expires_at date not null,
  reason text,                    -- which public holiday (name/date)
  status text not null default 'available'
    check (status in ('available','used','expired')),
  used_in_leave_request_id uuid references leave_requests(id),
  created_at timestamptz not null default now()
);

alter table ph_replacements enable row level security;

drop policy if exists "ph_select" on ph_replacements;
create policy "ph_select" on ph_replacements for select to authenticated
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));

drop policy if exists "ph_manage" on ph_replacements;
create policy "ph_manage" on ph_replacements for all to authenticated
  using (current_rank() in ('supervisor','manager'));

-- 4) Leave settings (edited in Settings → Leave Settings)
insert into system_rules (key, value, label, description) values
  ('leave_al_monthly_rate',  '0.667', 'AL monthly accrual (days)',   'Annual leave accrued per completed month since confirmation date'),
  ('leave_al_annual_cap',    '8',     'AL yearly accrual cap (days)','Maximum annual leave accrued within one calendar year'),
  ('leave_al_carryover_cap', '4',     'AL carryover cap (days)',     'Balance above this is forfeited every 1 January'),
  ('leave_ph_expiry_months', '3',     'PH replacement validity (months)', 'Months before a granted PH replacement day expires'),
  ('leave_medical_annual',   '14',    'Medical leave per year (days)',    'Yearly medical leave entitlement for new entitlement rows')
on conflict (key) do nothing;

-- ─────────────────────── PART 2: ENGINE + SCHEDULE ───────────────────────

create or replace function process_leave_accruals()
returns void language plpgsql security definer as $$
declare
  v_rate  numeric;
  v_cap   numeric;
  v_carry numeric;
  v_rank  text;
  r       record;
  n       int;
  d       date;
  y_sum   numeric;
  amt     numeric;
  jan1    date;
  bal     numeric;
  used    numeric;
begin
  -- Callable by cron (no auth context) or supervisors/managers only.
  if auth.uid() is not null then
    select rank into v_rank from staff where id = auth.uid();
    if v_rank is null or v_rank not in ('supervisor','manager') then
      raise exception 'process_leave_accruals: not allowed';
    end if;
  end if;

  select coalesce((select value::numeric from system_rules where key = 'leave_al_monthly_rate'),  0.667) into v_rate;
  select coalesce((select value::numeric from system_rules where key = 'leave_al_annual_cap'),    8)     into v_cap;
  select coalesce((select value::numeric from system_rules where key = 'leave_al_carryover_cap'), 4)     into v_carry;

  for r in
    select id, confirmation_date from staff
    where status = 'active' and is_active and confirmation_date is not null
  loop
    -- 1) Monthly accruals: anchor arithmetic avoids month-end drift
    n := 1;
    d := (r.confirmation_date + (n * interval '1 month'))::date;
    while d <= current_date loop
      if not exists (
        select 1 from leave_accrual_log
        where staff_id = r.id and entry_type = 'accrual' and period_month = d
      ) then
        select coalesce(sum(amount), 0) into y_sum from leave_accrual_log
        where staff_id = r.id and entry_type = 'accrual'
          and extract(year from period_month) = extract(year from d);
        amt := least(v_rate, greatest(0, v_cap - y_sum));
        if amt > 0 then
          insert into leave_accrual_log (staff_id, leave_type, entry_type, amount, period_month, note)
          values (r.id, 'annual', 'accrual', round(amt, 3), d, 'monthly accrual');
        end if;
      end if;
      n := n + 1;
      d := (r.confirmation_date + (n * interval '1 month'))::date;
    end loop;

    -- 2) Jan-1 carryover forfeit (once per year per staff)
    jan1 := date_trunc('year', current_date)::date;
    if not exists (
      select 1 from leave_accrual_log
      where staff_id = r.id and entry_type = 'forfeit' and period_month = jan1
    ) then
      select coalesce(sum(amount), 0) into bal from leave_accrual_log
      where staff_id = r.id and period_month < jan1;
      select coalesce(sum(total_days), 0) into used from leave_requests
      where staff_id = r.id and leave_type = 'annual' and status = 'approved'
        and start_date < jan1;
      bal := bal - used;
      if bal > v_carry then
        insert into leave_accrual_log (staff_id, leave_type, entry_type, amount, period_month, note)
        values (r.id, 'annual', 'forfeit', -(round(bal - v_carry, 3)), jan1,
                'forfeited ' || extract(year from jan1)::text || ' carryover');
      end if;
    end if;
  end loop;

  -- 3) Expire PH replacements
  update ph_replacements set status = 'expired'
  where status = 'available' and expires_at < current_date;
end;
$$;

grant execute on function process_leave_accruals() to authenticated;

-- Daily at 20:00 UTC (= 04:00 MYT). Re-running replaces the same-named job.
select cron.schedule('leave-daily', '0 20 * * *', $$select process_leave_accruals()$$);
```

- [ ] **Step 2: Do NOT run it** (no DB access from the sandbox; the user runs Part 1, verifies, then Part 2). Report DONE_WITH_CONCERNS noting exactly that.

- [ ] **Step 3: Commit**

```bash
git add supabase/migration-2026-07-08-leave-accrual.sql
git commit -m "chore: leave accrual migration — confirmation date, AL ledger, PH credits, engine + cron"
```

---

## Task 2: Types + pure helpers (TDD)

**Files:**
- Modify: `src/shared/types/index.ts`
- Create: `src/shared/lib/leave.ts`
- Create: `src/shared/lib/leave.test.ts`

**Interfaces:**
- Produces (Tasks 3-5 rely on exact names):
  - `Staff.confirmation_date: string | null` (add after `joined_at`)
  - `export interface AccrualEntry { id: string; staff_id: string; entry_type: 'accrual' | 'forfeit' | 'adjustment'; amount: number; period_month: string | null; accrued_at: string; note: string | null }`
  - `export interface PhReplacement { id: string; staff_id: string; granted_by: string | null; granted_at: string; expires_at: string; reason: string | null; status: 'available' | 'used' | 'expired'; used_in_leave_request_id: string | null; created_at: string }`
  - `calcAlBalance(entries: { amount: number }[], approvedDays: number, pendingDays: number): { balance: number; available: number }` — `balance` = round1(Σamount − approved); `available` = round1(balance − pending)
  - `pickPhGrantsFifo<G extends { id: string; expires_at: string }>(grants: G[], days: number): G[] | null` — earliest-expiring `days` grants, or null if not enough
  - DELETE `calcAnnualEntitlement` from types/index.ts (Task 3 removes its only import).

- [ ] **Step 1: Write the failing tests**

Create `src/shared/lib/leave.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { calcAlBalance, pickPhGrantsFifo } from './leave'

describe('calcAlBalance', () => {
  it('sums the ledger and subtracts approved days', () => {
    const entries = [{ amount: 0.667 }, { amount: 0.667 }, { amount: 0.667 }]
    const { balance, available } = calcAlBalance(entries, 1, 0)
    expect(balance).toBe(1.0)   // 2.001 - 1 = 1.001 → round1 = 1.0
    expect(available).toBe(1.0)
  })

  it('subtracts pending days from available but not from balance', () => {
    const { balance, available } = calcAlBalance([{ amount: 4 }], 0, 2)
    expect(balance).toBe(4.0)
    expect(available).toBe(2.0)
  })

  it('handles forfeits (negative entries)', () => {
    const { balance } = calcAlBalance([{ amount: 8 }, { amount: -4 }], 0, 0)
    expect(balance).toBe(4.0)
  })

  it('returns zeros for an empty ledger', () => {
    expect(calcAlBalance([], 0, 0)).toEqual({ balance: 0, available: 0 })
  })
})

describe('pickPhGrantsFifo', () => {
  const g = (id: string, expires_at: string) => ({ id, expires_at })

  it('picks the earliest-expiring grants first', () => {
    const grants = [g('late', '2026-12-01'), g('soon', '2026-08-01'), g('mid', '2026-10-01')]
    expect(pickPhGrantsFifo(grants, 2)?.map(x => x.id)).toEqual(['soon', 'mid'])
  })

  it('returns null when there are not enough grants', () => {
    expect(pickPhGrantsFifo([g('a', '2026-08-01')], 2)).toBeNull()
  })

  it('does not mutate the input order', () => {
    const grants = [g('late', '2026-12-01'), g('soon', '2026-08-01')]
    pickPhGrantsFifo(grants, 1)
    expect(grants[0].id).toBe('late')
  })
})
```

- [ ] **Step 2: Run to verify FAIL** — `npm test -- leave.test` → module not found.

- [ ] **Step 3: Implement**

Create `src/shared/lib/leave.ts`:

```ts
const round1 = (n: number) => Math.round(n * 10) / 10

/** AL balance from the accrual ledger. `balance` ignores pending requests;
 *  `available` also reserves pending annual days so double-applying can't
 *  overspend. */
export function calcAlBalance(
  entries: { amount: number }[],
  approvedDays: number,
  pendingDays: number,
): { balance: number; available: number } {
  const accrued = entries.reduce((sum, e) => sum + e.amount, 0)
  const balance = round1(accrued - approvedDays)
  return { balance, available: round1(balance - pendingDays) }
}

/** Earliest-expiring `days` grants (FIFO by expiry), or null if not enough. */
export function pickPhGrantsFifo<G extends { id: string; expires_at: string }>(
  grants: G[],
  days: number,
): G[] | null {
  if (grants.length < days) return null
  return [...grants].sort((a, b) => a.expires_at.localeCompare(b.expires_at)).slice(0, days)
}
```

In `src/shared/types/index.ts`: add `confirmation_date: string | null` to `Staff` (after `joined_at`); add the `AccrualEntry` and `PhReplacement` interfaces (after `LeaveRequest`); delete the `calcAnnualEntitlement` function entirely.

- [ ] **Step 4: Run to verify PASS** — `npm test -- leave.test` → 7/7.

- [ ] **Step 5: Build** — `npm run build`. Expected: FAILS only in `HrLeave.tsx` (imports the deleted `calcAnnualEntitlement`) — Task 3 fixes it; note it and commit. Errors anywhere else: fix minimally and list.

- [ ] **Step 6: Commit** — `git add src/shared/types/index.ts src/shared/lib/leave.ts src/shared/lib/leave.test.ts && git commit -m "feat: leave accrual types and balance/FIFO helpers"`

---

## Task 3: HrLeave — EL removal + accrued AL (Stage 3)

**Files:**
- Modify: `src/features/hr/HrLeave.tsx`

**Interfaces:**
- Consumes: `calcAlBalance`, `AccrualEntry` (Task 2); `system_rules` key `leave_al_monthly_rate`, `leave_medical_annual`.
- Produces: `ApplyLeaveModal` gains prop `availableAnnualDays: number`.

Key edits (match snippets, the file is `src/features/hr/HrLeave.tsx`, 466 lines):

- [ ] **Step 1: Imports & constants**
  - Line 5 import: drop `calcAnnualEntitlement`; add `calcAlBalance` from `'../../shared/lib/leave'` and `AccrualEntry` to the type import.
  - `const LEAVE_TYPES: LeaveType[] = ['annual', 'medical', 'emergency', 'unpaid', 'maternity', 'paternity']` → remove `'emergency'`.

- [ ] **Step 2: `ensureEntitlement`** — replace the `calcAnnualEntitlement` call: fetch `leave_medical_annual` rule (default 14) and insert `{ staff_id, year, annual_entitled: 0, medical_entitled: rule }`; annual columns are legacy.

```ts
async function ensureEntitlement(staffMember: Staff, year: number): Promise<LeaveEntitlement> {
  const { data } = await supabase.from('leave_entitlements').select('*').eq('staff_id', staffMember.id).eq('year', year).maybeSingle()
  if (data) return data as LeaveEntitlement
  const { data: rule } = await supabase.from('system_rules').select('value').eq('key', 'leave_medical_annual').maybeSingle()
  const medical_entitled = rule ? parseInt((rule as { value: string }).value) || 14 : 14
  const { data: created } = await supabase
    .from('leave_entitlements')
    .insert({ staff_id: staffMember.id, year, annual_entitled: 0, medical_entitled })
    .select('*')
    .single()
  return created as LeaveEntitlement
}
```

- [ ] **Step 3: `MyLeaveView`** — load ledger + rate; replace Annual & remove Emergency cards.

State/additions inside `MyLeaveView`:

```ts
  const [alInfo, setAlInfo] = useState<{ balance: number; available: number } | null>(null)
  const [alRate, setAlRate] = useState('0.667')
```

In `load()` after requests are fetched (keep `reqs` in a local const):

```ts
    const { data: logs } = await supabase.from('leave_accrual_log').select('amount').eq('staff_id', staffMember.id)
    const approved = reqs.filter(r => r.leave_type === 'annual' && r.status === 'approved').reduce((s, r) => s + r.total_days, 0)
    const pending  = reqs.filter(r => r.leave_type === 'annual' && r.status === 'pending').reduce((s, r) => s + r.total_days, 0)
    setAlInfo(calcAlBalance((logs as { amount: number }[]) ?? [], approved, pending))
    const { data: rateRow } = await supabase.from('system_rules').select('value').eq('key', 'leave_al_monthly_rate').maybeSingle()
    if (rateRow) setAlRate((rateRow as { value: string }).value)
```

Cards grid: Annual card becomes:

```tsx
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
          <p className="text-xs text-brown-faint mb-1">Annual Leave</p>
          {staffMember.confirmation_date ? (
            <>
              <p className="text-xl font-bold text-brown-dark">{alInfo ? alInfo.available.toFixed(1) : '—'}</p>
              <p className="text-xs text-brown-faint">days available</p>
              <p className="text-[10px] text-brown-faint mt-1">
                accruing {Number(alRate).toFixed(2)}/month since {new Date(staffMember.confirmation_date).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}
              </p>
            </>
          ) : (
            <p className="text-xs text-brown-faint">Awaiting confirmation date — not accruing yet</p>
          )}
        </div>
```

DELETE the Emergency card div entirely (grid stays `grid-cols-3`; Task 4 adds the PH card as the third).

- [ ] **Step 4: `ApplyLeaveModal` hard cap** — add prop `availableAnnualDays: number`; compute `const overLimit = form.leave_type === 'annual' && totalDays > availableAnnualDays`; when `leave_type === 'annual'` show `Available: {availableAnnualDays.toFixed(1)} days` (red + bold when over); block in `handleSubmit` (`if (overLimit) { setError(...); return }`) and disable the submit button (`disabled={saving || overLimit}`). `MyLeaveView` passes `availableAnnualDays={alInfo?.available ?? 0}`.

- [ ] **Step 5: `ManagerLeaveView`** — drop the Emergency column; Annual column becomes computed balance.

In `load()` add: `const { data: logs } = await supabase.from('leave_accrual_log').select('staff_id, amount')` and store in state `const [accrualLogs, setAccrualLogs] = useState<{ staff_id: string; amount: number }[]>([])`. Add helper inside the component:

```ts
  function alBalanceFor(staffId: string): number {
    const entries = accrualLogs.filter(l => l.staff_id === staffId)
    const approved = requests.filter(r => r.staff_id === staffId && r.leave_type === 'annual' && r.status === 'approved').reduce((s, r) => s + r.total_days, 0)
    return calcAlBalance(entries, approved, 0).balance
  }
```

Table header `Annual / Medical / Emergency / Unpaid` → `Annual / Medical / Unpaid` (Task 4 adds `PH`); Annual cell: `{alBalanceFor(s.id).toFixed(1)}`; DELETE the Emergency cell; Medical/Unpaid cells unchanged.

- [ ] **Step 6: `approve()`** — entitlement counter update now only for medical/unpaid:

Replace the `if (req.leave_type === 'annual' || ...)` block with:

```ts
    if (req.leave_type === 'medical' || req.leave_type === 'unpaid') {
      const ent = await ensureEntitlement(allStaff.find(s => s.id === req.staff_id) ?? { id: req.staff_id, joined_at: null } as Staff, new Date().getFullYear())
      const field = req.leave_type === 'unpaid' ? 'unpaid_used' : 'medical_used'
      await supabase.from('leave_entitlements').update({ [field]: (ent[field as keyof LeaveEntitlement] as number) + req.total_days }).eq('id', ent.id)
    }
```

- [ ] **Step 7: Build + tests** — `npm run build` exits 0 (the Task-2 break is now fixed); `npm test` all pass; `grep -n "emergency" src/features/hr/HrLeave.tsx` → no functional matches (label map in types may keep the word; HrLeave itself should be clean).

- [ ] **Step 8: Commit** — `git commit -m "feat: accrued AL balance from ledger; retire Emergency Leave from UI"`

---

## Task 4: HrLeave — PH Replacement (Stage 4)

**Files:**
- Modify: `src/features/hr/HrLeave.tsx`

**Interfaces:**
- Consumes: `PhReplacement`, `pickPhGrantsFifo` (Task 2); `system_rules` key `leave_ph_expiry_months`.

- [ ] **Step 1: Staff card + apply option**
  - `MyLeaveView`: load `const { data: ph } = await supabase.from('ph_replacements').select('*').eq('staff_id', staffMember.id).eq('status', 'available').order('expires_at')`; state `phGrants: PhReplacement[]`. Third card:

```tsx
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
          <p className="text-xs text-brown-faint mb-1">PH Replacement</p>
          <p className="text-xl font-bold text-brown-dark">{phGrants.length}</p>
          <p className="text-xs text-brown-faint">days available</p>
          {phGrants.slice(0, 3).map(g => {
            const soon = (new Date(g.expires_at).getTime() - Date.now()) < 30 * 86400000
            return (
              <p key={g.id} className={`text-[10px] mt-0.5 ${soon ? 'text-[#C4813A] font-semibold' : 'text-brown-faint'}`}>
                1 day · expires {new Date(g.expires_at).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })}{soon ? ' ⚠️' : ''}
              </p>
            )
          })}
        </div>
```

  - `LEAVE_TYPES` array: append `'public_holiday'` (label already "Public Holiday" via `LEAVE_TYPE_LABELS`; override option text to `PH Replacement` in the select: render `{t === 'public_holiday' ? 'PH Replacement' : LEAVE_TYPE_LABELS[t]}`).
  - `ApplyLeaveModal` new props `phAvailable: number`, `phEarliestExpiry: string | null`; when `leave_type === 'public_holiday'`: show `Available: {phAvailable} day(s){phEarliestExpiry ? `, earliest expiry ${...}` : ''}`; block submit if `totalDays > phAvailable` (same pattern as the AL cap). `MyLeaveView` passes `phAvailable={phGrants.length}` and `phEarliestExpiry={phGrants[0]?.expires_at ?? null}`.

- [ ] **Step 2: Grant modal (manager)** — new component `GrantPhModal({ allStaff, granterId, onClose, onDone })`: checkbox multi-select of active staff, `reason` text input ("e.g. Hari Raya 2026-03-31"), on save: fetch `leave_ph_expiry_months` rule (default 3), compute `expires_at = today + months`, bulk `insert` one row per selected staff `{ staff_id, granted_by: granterId, expires_at, reason }`; surface insert errors in the modal (red text); on success call `onDone()` + close. Button `+ Grant PH Replacement` sits in the `Team Leave Management` header area of `ManagerLeaveView`. Expiry date math: `const d = new Date(); d.setMonth(d.getMonth() + months); const expires_at = d.toISOString().split('T')[0]`.

- [ ] **Step 3: FIFO consumption in `approve()`** — BEFORE the status update, add:

```ts
    if (req.leave_type === 'public_holiday') {
      const { data: grants } = await supabase
        .from('ph_replacements').select('*')
        .eq('staff_id', req.staff_id).eq('status', 'available')
      const picked = pickPhGrantsFifo((grants as PhReplacement[]) ?? [], req.total_days)
      if (!picked) {
        setApproveError(`${req.staff?.name ?? 'Staff'} has insufficient PH replacement credits (${(grants ?? []).length} available, ${req.total_days} needed).`)
        setApproving(null)
        return
      }
      for (const g of picked) {
        const { error: useErr } = await supabase.from('ph_replacements')
          .update({ status: 'used', used_in_leave_request_id: req.id }).eq('id', g.id)
        if (useErr) { setApproveError(`Couldn't consume PH credit: ${useErr.message}`); setApproving(null); return }
      }
    }
```

with `const [approveError, setApproveError] = useState('')` rendered above Pending Approvals via the red-banner idiom (`text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3`), cleared at the start of `approve()`.

- [ ] **Step 4: Manager table PH column** — load counts `const { data: phAll } = await supabase.from('ph_replacements').select('staff_id').eq('status', 'available')`; column `PH` cell = count for that staff.

- [ ] **Step 5: Build + tests + commit** — `npm run build` 0; `npm test` pass; `git commit -m "feat: PH replacement credits — grant, apply, FIFO consumption on approval"`

---

## Task 5: Settings Leave block + StaffProfile confirmation date (Stage 5)

**Files:**
- Modify: `src/features/settings/Settings.tsx`, `src/features/staff/StaffProfile.tsx`

**Interfaces:**
- Consumes: the five `system_rules` keys; RPC `process_leave_accruals`; `staff.confirmation_date`.

- [ ] **Step 1: Leave Settings section** in Settings (manager-visible, near the System Rules/rules tab following the file's existing tab/section pattern):
  - Edit the 5 keys (read `system_rules` where key like 'leave_%'; number inputs; save = `update system_rules set value where key`) reusing the file's existing rules-editing UI if one exists — follow its idiom; otherwise a simple card of 5 labelled inputs + Save.
  - **Recalculate All AL Balances** button: `const { error } = await supabase.rpc('process_leave_accruals')`; success toast "Recalculated ✓" / error shown in red. Note text: "Runs the same job as the nightly cron — safe to run anytime."
  - **Missing confirmation dates** list: `staff` where `status='active' and is_active and confirmation_date is null` → row per staff with inline `<input type="date">`; on change `update staff set confirmation_date`. Errors surfaced.
- [ ] **Step 2: StaffProfile** — in the manager-editable fields area, add "Confirmation Date" `<input type="date">` bound to `confirmation_date`, saved with the existing profile-save path (follow the file's existing editable-field idiom).
- [ ] **Step 3: Build + tests + commit** — `git commit -m "feat: leave settings, AL recalculate, confirmation date editing"`

---

## Task 6: Verification + staged deploy runbook (controller)

- Stage gates (user verifies after each): Part 1 SQL → Part 2 SQL (enable pg_cron first; verify: run `select process_leave_accruals()` twice, second run adds 0 rows; `select * from cron.job`) → deploy after Task 3 (EL gone, AL card accrues) → after Task 4 (grant → apply → approve consumes FIFO) → after Task 5 (settings edit, recalculate, fill manager confirmation dates) → final REST verification of ledger rows.
- Deploys: merge worktree → `vercel deploy --prod --yes` → bundle-hash check.
- Update memory: old accrued-annual-leave worktree is superseded → delete it (`git worktree remove`), remove its Phase 3 pending note.
