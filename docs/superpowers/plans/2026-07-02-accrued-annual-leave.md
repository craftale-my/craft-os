# Accrued Annual Leave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat yearly annual-leave grant with monthly accrual (tenure-tiered rate ÷ 12, carried forward indefinitely, hard-capped at apply time), per `docs/superpowers/specs/2026-07-02-accrued-annual-leave-design.md`.

**Architecture:** Two new pure, unit-tested functions in `src/shared/types/index.ts` (`calcAccruedAnnual`, `calcAnnualBalance`) compute accrual and available balance from data the UI already loads (or loads with one extra unfiltered query). `HrLeave.tsx` wires those functions into the staff view (balance display), the apply modal (hard cap), and the manager view (balance table + editable opening-balance column). A `staff.annual_leave_opening` column plus a broadened RLS policy ship as a manual Supabase migration appended to `supabase/schema.sql`, following the existing "Phase 2 migration" pattern in that file.

**Tech Stack:** React 19 + TypeScript, Supabase JS client, Vitest (new — this repo has no test runner yet).

## Global Constraints

- Accrual start date: `2026-01-01` (tenure before this date is not retroactively accrued; it's covered by the manual `annual_leave_opening` field).
- Accrual rate tiers (unchanged from existing `calcAnnualEntitlement`): tenure < 2 years → 8 days/year (÷12 per month); 2–5 years → 12 days/year; ≥ 5 years → 16 days/year. Tier is evaluated per month-anniversary using the tenure as of that anniversary.
- Annual leave accrues on the employee's monthly join-date anniversary, not on a fixed calendar day.
- Annual leave never expires/resets at year-end; it carries forward indefinitely.
- Applying for annual leave must be hard-blocked (submit button disabled) when requested days exceed available balance. Other leave types are unaffected.
- Only `manager` and `supervisor` ranks may edit `staff.annual_leave_opening`.
- Resigned staff (`status = 'resigned'`) are excluded from the manager balance overview.
- No new tables, no cron jobs, no year-end batch jobs.

---

## File Structure

| File | Change |
|---|---|
| `package.json` | Add `vitest` devDependency + `test` script |
| `vitest.config.ts` | New — minimal Node-environment Vitest config |
| `src/shared/types/index.ts` | Remove `calcAnnualEntitlement`; add `annual_leave_opening` to `Staff`; add `calcAccruedAnnual`, `annualRateForTenureYears`, `calcAnnualBalance`, `AnnualBalance`, `AnnualBalanceInputs` |
| `src/shared/types/leave.test.ts` | New — Vitest unit tests for the functions above |
| `src/features/hr/HrLeave.tsx` | `ensureEntitlement` (stop writing `annual_entitled` from the removed function); `MyLeaveView` (load + display accrued balance); `ApplyLeaveModal` (hard cap on submit); `ManagerLeaveView` (balance table column, editable opening balance, over-limit approval warning); `HrLeavePage` (load only active staff, wire refresh callback) |
| `supabase/schema.sql` | Append "Phase 3 migration" block: `annual_leave_opening` column + broadened `staff_update` policy |

---

## Task 1: Add Vitest tooling

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/shared/types/leave.test.ts`

**Interfaces:**
- Produces: `npm test` command that runs Vitest once and exits; a test file at `src/shared/types/leave.test.ts` that later tasks append to (do not recreate the file in later tasks — extend it).

- [ ] **Step 1: Install Vitest**

Run:
```bash
npm install -D vitest@^2.1.8
```

- [ ] **Step 2: Add the test script to `package.json`**

Modify the `"scripts"` block:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview",
    "test": "vitest run"
  },
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
  },
})
```

- [ ] **Step 4: Write a smoke test**

Create `src/shared/types/leave.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('vitest setup', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

- [ ] **Step 5: Run the test suite and verify it passes**

Run: `npm test`
Expected: `1 passed` (the `vitest setup > runs` test), exit code 0.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/shared/types/leave.test.ts
git commit -m "chore: add vitest for unit-testing pure leave-accrual functions"
```

---

## Task 2: `calcAccruedAnnual` — monthly accrual by tenure tier

**Files:**
- Modify: `src/shared/types/index.ts:596-602` (delete `calcAnnualEntitlement`, add new functions in its place)
- Modify: `src/features/hr/HrLeave.tsx:1-51` (stop importing/using the removed function)
- Test: `src/shared/types/leave.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function annualRateForTenureYears(years: number): number` — returns 8, 12, or 16.
  - `export function calcAccruedAnnual(joinedAt: string | null, asOf?: Date): number` — returns accrued days as a float, no rounding. `asOf` defaults to `new Date()`.
  - `export const ACCRUAL_START = '2026-01-01'` (exported so tests can reference it if needed; not required outside this file otherwise).

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/types/leave.test.ts` (replace the smoke test's content is NOT needed — just add below it, keep the existing `describe('vitest setup', ...)` block):

```ts
import { annualRateForTenureYears, calcAccruedAnnual } from './index'

describe('annualRateForTenureYears', () => {
  it('returns 8 for tenure under 2 years', () => {
    expect(annualRateForTenureYears(0)).toBe(8)
    expect(annualRateForTenureYears(1.99)).toBe(8)
  })

  it('returns 12 for tenure 2 to under 5 years', () => {
    expect(annualRateForTenureYears(2)).toBe(12)
    expect(annualRateForTenureYears(4.99)).toBe(12)
  })

  it('returns 16 for tenure 5+ years', () => {
    expect(annualRateForTenureYears(5)).toBe(16)
    expect(annualRateForTenureYears(10)).toBe(16)
  })
})

describe('calcAccruedAnnual', () => {
  it('returns 0 when joinedAt is null', () => {
    expect(calcAccruedAnnual(null, new Date('2026-06-01'))).toBe(0)
  })

  it('returns 0 before the first month anniversary', () => {
    const result = calcAccruedAnnual('2026-02-15', new Date('2026-03-14'))
    expect(result).toBe(0)
  })

  it('accrues one month worth (8/12) at the first month anniversary', () => {
    const result = calcAccruedAnnual('2026-02-15', new Date('2026-03-15'))
    expect(result).toBeCloseTo(8 / 12, 3)
  })

  it('accrues exactly 8 days after 12 months in the under-2-year tier', () => {
    const result = calcAccruedAnnual('2026-01-01', new Date('2027-01-01'))
    expect(result).toBeCloseTo(8, 2)
  })

  it('returns 0 when asOf is entirely before the accrual start date', () => {
    const result = calcAccruedAnnual('2025-01-01', new Date('2025-12-31'))
    expect(result).toBe(0)
  })

  it('accrues at the higher tier once tenure already exceeds 2 years by the accrual start date', () => {
    // joined 2024-01-15, so by 2026-01-15 (the accrual start's first anniversary in range)
    // tenure is already ~2 years -> rate 12/year -> 12/12 = 1/month
    const result = calcAccruedAnnual('2024-01-15', new Date('2026-02-15'))
    expect(result).toBeCloseTo(2, 2) // two month-anniversaries (2026-01-15, 2026-02-15) at 12/12 each
  })

  it('accrues at the 5-year tier once tenure already exceeds 5 years by the accrual start date', () => {
    const result = calcAccruedAnnual('2015-06-01', new Date('2026-08-01'))
    expect(result).toBeCloseTo(4, 2) // three month-anniversaries (06-01, 07-01, 08-01) at 16/12 each
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `annualRateForTenureYears` and `calcAccruedAnnual` are not exported from `./index` (module has no export named ...).

- [ ] **Step 3: Replace `calcAnnualEntitlement` with the new functions**

In `src/shared/types/index.ts`, replace lines 596-602 (the entire `calcAnnualEntitlement` function) with:

```ts
const ACCRUAL_START = '2026-01-01'

export function annualRateForTenureYears(years: number): number {
  if (years >= 5) return 16
  if (years >= 2) return 12
  return 8
}

export function calcAccruedAnnual(joinedAt: string | null, asOf: Date = new Date()): number {
  if (!joinedAt) return 0
  const joined = new Date(joinedAt)
  const start = new Date(Math.max(joined.getTime(), new Date(ACCRUAL_START).getTime()))
  if (start > asOf) return 0

  let accrued = 0
  const cursor = new Date(joined)
  cursor.setMonth(cursor.getMonth() + 1)
  while (cursor <= asOf) {
    if (cursor >= start) {
      const tenureYears = (cursor.getTime() - joined.getTime()) / (1000 * 60 * 60 * 24 * 365.25)
      accrued += annualRateForTenureYears(tenureYears) / 12
    }
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return accrued
}
```

- [ ] **Step 4: Fix the now-broken import and call site in `HrLeave.tsx`**

In `src/features/hr/HrLeave.tsx`, line 5, remove `calcAnnualEntitlement` from the import:

```ts
import { LEAVE_TYPE_LABELS, MONTHS_FULL } from '../../shared/types'
```

In the same file, `ensureEntitlement` (currently lines 41-51), replace:

```ts
  const annual_entitled = calcAnnualEntitlement(staffMember.joined_at)
  const { data: created } = await supabase
    .from('leave_entitlements')
    .insert({ staff_id: staffMember.id, year, annual_entitled })
    .select('*')
    .single()
```

with:

```ts
  const { data: created } = await supabase
    .from('leave_entitlements')
    .insert({ staff_id: staffMember.id, year, annual_entitled: 0 })
    .select('*')
    .single()
```

(`annual_entitled` is no longer read anywhere for annual-leave math after Task 5-7 land; it's written as `0` here purely to keep the not-null column populated. `medical_entitled`/`emergency_entitled` still use their table defaults since they're omitted from the insert.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass (`annualRateForTenureYears` × 3, `calcAccruedAnnual` × 7, plus the Task 1 smoke test).

- [ ] **Step 6: Verify the app still builds**

Run: `npm run build`
Expected: exits 0, no TypeScript errors (confirms no other file imports the removed `calcAnnualEntitlement`).

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/index.ts src/shared/types/leave.test.ts src/features/hr/HrLeave.tsx
git commit -m "feat: replace flat annual-leave grant with monthly tenure-tiered accrual"
```

---

## Task 3: `calcAnnualBalance` — available balance from opening + accrued − used − pending

**Files:**
- Modify: `src/shared/types/index.ts` (add `annual_leave_opening` to `Staff`; add `AnnualBalanceInputs`, `AnnualBalance`, `calcAnnualBalance`)
- Test: `src/shared/types/leave.test.ts` (append)

**Interfaces:**
- Consumes: `calcAccruedAnnual` from Task 2; `LeaveEntitlement`, `LeaveRequest` types already defined in this file.
- Produces:
  - `Staff.annual_leave_opening: number` (new field on the existing `Staff` interface).
  - `export interface AnnualBalanceInputs { joinedAt: string | null; openingBalance: number; entitlements: Pick<LeaveEntitlement, 'annual_used'>[]; requests: Pick<LeaveRequest, 'leave_type' | 'status' | 'total_days'>[]; asOf?: Date }`
  - `export interface AnnualBalance { accrued: number; usedTotal: number; pendingTotal: number; available: number }`
  - `export function calcAnnualBalance(inputs: AnnualBalanceInputs): AnnualBalance`

- [ ] **Step 1: Write the failing test**

Append to `src/shared/types/leave.test.ts`:

```ts
import { calcAnnualBalance } from './index'

describe('calcAnnualBalance', () => {
  it('combines opening balance, accrual, used, and pending into an available total', () => {
    const balance = calcAnnualBalance({
      joinedAt: '2026-01-01',
      openingBalance: 3,
      entitlements: [{ annual_used: 1 }, { annual_used: 2 }],
      requests: [
        { leave_type: 'annual', status: 'pending', total_days: 1 },
        { leave_type: 'annual', status: 'approved', total_days: 5 },
        { leave_type: 'medical', status: 'pending', total_days: 2 },
      ],
      asOf: new Date('2027-01-01'),
    })
    expect(balance.accrued).toBeCloseTo(8, 2)
    expect(balance.usedTotal).toBe(3)
    expect(balance.pendingTotal).toBe(1)
    expect(balance.available).toBeCloseTo(7, 2)
  })

  it('defaults openingBalance and empty arrays to a balance equal to accrued only', () => {
    const balance = calcAnnualBalance({
      joinedAt: '2026-01-01',
      openingBalance: 0,
      entitlements: [],
      requests: [],
      asOf: new Date('2026-02-01'),
    })
    expect(balance.usedTotal).toBe(0)
    expect(balance.pendingTotal).toBe(0)
    expect(balance.available).toBeCloseTo(balance.accrued, 3)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `calcAnnualBalance` is not exported from `./index`.

- [ ] **Step 3: Implement**

In `src/shared/types/index.ts`, add `annual_leave_opening: number` to the `Staff` interface — insert it right after `joined_at: string | null` (around line 18):

```ts
  joined_at: string | null
  annual_leave_opening: number
  created_at: string
```

Then, directly below the `calcAccruedAnnual` function added in Task 2, add:

```ts
export interface AnnualBalanceInputs {
  joinedAt: string | null
  openingBalance: number
  entitlements: Pick<LeaveEntitlement, 'annual_used'>[]
  requests: Pick<LeaveRequest, 'leave_type' | 'status' | 'total_days'>[]
  asOf?: Date
}

export interface AnnualBalance {
  accrued: number
  usedTotal: number
  pendingTotal: number
  available: number
}

export function calcAnnualBalance(inputs: AnnualBalanceInputs): AnnualBalance {
  const accrued = calcAccruedAnnual(inputs.joinedAt, inputs.asOf ?? new Date())
  const usedTotal = inputs.entitlements.reduce((sum, e) => sum + e.annual_used, 0)
  const pendingTotal = inputs.requests
    .filter(r => r.leave_type === 'annual' && r.status === 'pending')
    .reduce((sum, r) => sum + r.total_days, 0)
  const available = inputs.openingBalance + accrued - usedTotal - pendingTotal
  return { accrued, usedTotal, pendingTotal, available }
}
```

Note: `calcAnnualBalance` is defined below `LeaveEntitlement`/`LeaveRequest` in the file (those interfaces are declared earlier, around lines 497-525) — since `calcAccruedAnnual` sits after `DEPT_SHIFT_COLORS` (after line 594, i.e. after `LeaveRequest`), this ordering already works with no forward-reference issues.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Verify the app still builds**

Run: `npm run build`
Expected: exits 0. (`Staff.annual_leave_opening` is a new required field — this will surface any place that constructs a `Staff` object literal without it. If the build fails here, find that call site and add `annual_leave_opening: 0` to the literal before proceeding.)

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/index.ts src/shared/types/leave.test.ts
git commit -m "feat: add calcAnnualBalance combining opening balance, accrual, used, and pending days"
```

---

## Task 4: Database migration — `annual_leave_opening` column + RLS

**Files:**
- Modify: `supabase/schema.sql` (append to the end of the file)

**Interfaces:**
- Consumes: nothing.
- Produces: `staff.annual_leave_opening numeric not null default 0` column that Task 3's `Staff` type and Tasks 5-7's queries assume exists. This migration is **not** auto-applied — it must be run by hand in the Supabase SQL editor, matching this project's existing convention (see the "Phase 2 migration" block already in this file).

- [ ] **Step 1: Append the migration block**

Add to the end of `supabase/schema.sql`:

```sql

-- =============================================
-- Phase 3 migration: Accrued annual leave
-- Idempotent — safe to run on the existing database via the Supabase SQL editor.
-- =============================================

-- 1) Opening balance for pre-2026 tenure -------------------------------------
-- Manually-entered carry-forward balance (in days) for annual leave accrued
-- before the 2026-01-01 accrual start date. Editable by supervisor/manager.
alter table staff add column if not exists annual_leave_opening numeric not null default 0;

-- 2) Allow supervisors (not just managers) to update staff rows -------------
-- Needed so supervisors can edit annual_leave_opening from the HR Leave page,
-- consistent with other supervisor-manageable resources (e.g. scheduled_shifts).
drop policy if exists "staff_update" on staff;
create policy "staff_update" on staff for update
  using (id = auth.uid() or current_rank() in ('supervisor','manager'));
```

- [ ] **Step 2: Run the migration against the live database**

Open the Supabase SQL editor for this project and run the block added in Step 1. Confirm it completes without error.

Verify the column exists:
```sql
select column_name, data_type, column_default from information_schema.columns
where table_name = 'staff' and column_name = 'annual_leave_opening';
```
Expected: one row, `numeric`, default `0`.

- [ ] **Step 3: Commit**

```bash
git add supabase/schema.sql
git commit -m "chore: add annual_leave_opening column and broaden staff_update RLS to supervisors"
```

---

## Task 5: Staff view — show accrued balance on the Annual Leave card

**Files:**
- Modify: `src/features/hr/HrLeave.tsx` (imports at top; `MyLeaveView`, currently lines 199-278)

**Interfaces:**
- Consumes: `calcAnnualBalance`, `AnnualBalance` from Task 3.
- Produces: `MyLeaveView` renders an `AnnualBalance | null` in a new `annualBalance` state variable, computed inside its existing `load()` function. Later tasks (6, 7) read `annualBalance.available` from this component's render output (Task 6 as a prop passed to `ApplyLeaveModal`).

- [ ] **Step 1: Update the import**

In `src/features/hr/HrLeave.tsx`, line 5 (as left by Task 2), add `calcAnnualBalance` and the `AnnualBalance` type:

```ts
import { LEAVE_TYPE_LABELS, MONTHS_FULL, calcAnnualBalance } from '../../shared/types'
import type { Staff, LeaveRequest, LeaveEntitlement, LeaveType, AnnualBalance } from '../../shared/types'
```

(This replaces the existing `import type { Staff, LeaveRequest, LeaveEntitlement, LeaveType } from '../../shared/types'` on line 4 — merge `AnnualBalance` into that same type-only import line, and keep `calcAnnualBalance` in the value import on line 5.)

- [ ] **Step 2: Add `annualBalance` state and compute it in `load()`**

In `MyLeaveView` (currently lines 199-211), replace:

```tsx
function MyLeaveView({ staffMember }: { staffMember: Staff }) {
  const [entitlement, setEntitlement] = useState<LeaveEntitlement | null>(null)
  const [requests, setRequests] = useState<LeaveRequest[]>([])
  const [showApply, setShowApply] = useState(false)

  async function load() {
    const ent = await ensureEntitlement(staffMember, new Date().getFullYear())
    setEntitlement(ent)
    const { data } = await supabase.from('leave_requests').select('*').eq('staff_id', staffMember.id).order('created_at', { ascending: false })
    setRequests((data as LeaveRequest[]) ?? [])
  }

  useEffect(() => { load() }, [])
```

with:

```tsx
function MyLeaveView({ staffMember }: { staffMember: Staff }) {
  const [entitlement, setEntitlement] = useState<LeaveEntitlement | null>(null)
  const [requests, setRequests] = useState<LeaveRequest[]>([])
  const [annualBalance, setAnnualBalance] = useState<AnnualBalance | null>(null)
  const [showApply, setShowApply] = useState(false)

  async function load() {
    const ent = await ensureEntitlement(staffMember, new Date().getFullYear())
    setEntitlement(ent)
    const { data } = await supabase.from('leave_requests').select('*').eq('staff_id', staffMember.id).order('created_at', { ascending: false })
    const reqs = (data as LeaveRequest[]) ?? []
    setRequests(reqs)
    const { data: allEnts } = await supabase.from('leave_entitlements').select('annual_used').eq('staff_id', staffMember.id)
    setAnnualBalance(calcAnnualBalance({
      joinedAt: staffMember.joined_at,
      openingBalance: staffMember.annual_leave_opening,
      entitlements: (allEnts as Pick<LeaveEntitlement, 'annual_used'>[]) ?? [],
      requests: reqs,
    }))
  }

  useEffect(() => { load() }, [])
```

- [ ] **Step 3: Replace the Annual Leave card**

In the same component's render (currently lines 220-227), replace:

```tsx
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
          <p className="text-xs text-brown-faint mb-1">Annual Leave</p>
          <p className="text-xl font-bold text-brown-dark">
            {entitlement ? entitlement.annual_entitled - entitlement.annual_used : '—'} / {entitlement?.annual_entitled ?? '—'}
          </p>
          <p className="text-xs text-brown-faint">days remaining</p>
        </div>
```

with:

```tsx
        <div className="bg-white rounded-xl p-4 border border-[#E8DDD0]">
          <p className="text-xs text-brown-faint mb-1">Annual Leave</p>
          {staffMember.joined_at ? (
            <>
              <p className="text-xl font-bold text-brown-dark">
                {annualBalance ? annualBalance.available.toFixed(2) : '—'} / {annualBalance ? annualBalance.accrued.toFixed(2) : '—'}
              </p>
              <p className="text-xs text-brown-faint">days accrued</p>
              <p className="text-[10px] text-brown-faint mt-1">Accrues monthly based on tenure</p>
            </>
          ) : (
            <p className="text-xs text-brown-faint">— set joined date to accrue</p>
          )}
        </div>
```

- [ ] **Step 4: Verify the app builds**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Manually verify in the dev server**

Run: `npm run dev`, log in as a staff member with a `joined_at` set, open the Leave page.
Expected: the "Annual Leave" card shows `X.XX / Y.YY` with "days accrued" and the tenure hint, instead of the old integer entitlement.

- [ ] **Step 6: Commit**

```bash
git add src/features/hr/HrLeave.tsx
git commit -m "feat: show accrued annual leave balance on the staff Leave page"
```

---

## Task 6: Apply Leave modal — hard cap on annual leave submission

**Files:**
- Modify: `src/features/hr/HrLeave.tsx` (`ApplyLeaveModal`, currently lines 55-101 + its render 103-151; `MyLeaveView`'s render of the modal, currently lines 273-275)

**Interfaces:**
- Consumes: `annualBalance` from Task 5 (`MyLeaveView`'s state), passed down as a new prop.
- Produces: `ApplyLeaveModal` gains a required `availableAnnualDays: number` prop.

- [ ] **Step 1: Add the `availableAnnualDays` prop and the over-limit check**

Replace the `ApplyLeaveModal` function signature and `handleSubmit` (currently lines 55-101):

```tsx
function ApplyLeaveModal({ staffId, availableAnnualDays, onClose, onSubmitted }: {
  staffId: string
  availableAnnualDays: number
  onClose: () => void
  onSubmitted: () => void
}) {
  const [form, setForm] = useState({ leave_type: 'annual' as LeaveType, start_date: '', end_date: '', reason: '' })
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const totalDays = form.start_date && form.end_date ? Math.max(1, daysBetween(form.start_date, form.end_date)) : 0
  const overAnnualLimit = form.leave_type === 'annual' && totalDays > availableAnnualDays

  async function handleSubmit() {
    if (!form.start_date || !form.end_date || !form.reason.trim()) {
      setError('Start date, end date, and reason are required.')
      return
    }
    if (form.leave_type === 'medical' && !file) {
      setError('Please upload an MC for medical leave.')
      return
    }
    if (overAnnualLimit) {
      setError(`Exceeds available annual leave balance (${availableAnnualDays.toFixed(2)} days available).`)
      return
    }
    setSaving(true)
    setError('')
    let attachment_url: string | null = null
    if (file) {
      const ext = file.name.split('.').pop() ?? 'jpg'
      const filePath = `${staffId}/${Date.now()}.${ext}`
      const { error: uploadErr } = await supabase.storage.from('leave-attachments').upload(filePath, file, { contentType: file.type })
      if (!uploadErr) attachment_url = supabase.storage.from('leave-attachments').getPublicUrl(filePath).data.publicUrl
    }
    const { error: err } = await supabase.from('leave_requests').insert({
      staff_id: staffId,
      leave_type: form.leave_type,
      start_date: form.start_date,
      end_date: form.end_date,
      total_days: totalDays,
      reason: form.reason.trim(),
      attachment_url,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    onSubmitted()
    onClose()
  }
```

- [ ] **Step 2: Show the available balance and disable submit when over limit**

In the same component's render, replace the `{totalDays > 0 && ...}` line (currently line 128):

```tsx
          {totalDays > 0 && <p className="text-xs text-brown-faint">Total: {totalDays} day{totalDays > 1 ? 's' : ''}</p>}
```

with:

```tsx
          {totalDays > 0 && <p className="text-xs text-brown-faint">Total: {totalDays} day{totalDays > 1 ? 's' : ''}</p>}
          {form.leave_type === 'annual' && (
            <p className={`text-xs ${overAnnualLimit ? 'text-[#9E4A30] font-semibold' : 'text-brown-faint'}`}>
              Available annual leave: {availableAnnualDays.toFixed(2)} days
            </p>
          )}
```

Then replace the submit button (currently lines 143-145):

```tsx
            <button onClick={handleSubmit} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60">
              {saving ? 'Submitting...' : 'Submit Request'}
            </button>
```

with:

```tsx
            <button onClick={handleSubmit} disabled={saving || overAnnualLimit} className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60">
              {saving ? 'Submitting...' : 'Submit Request'}
            </button>
```

- [ ] **Step 3: Pass the new prop from `MyLeaveView`**

In `MyLeaveView`'s render (currently lines 273-275), replace:

```tsx
      {showApply && (
        <ApplyLeaveModal staffId={staffMember.id} onClose={() => setShowApply(false)} onSubmitted={load} />
      )}
```

with:

```tsx
      {showApply && (
        <ApplyLeaveModal
          staffId={staffMember.id}
          availableAnnualDays={annualBalance?.available ?? 0}
          onClose={() => setShowApply(false)}
          onSubmitted={load}
        />
      )}
```

- [ ] **Step 4: Verify the app builds**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Manually verify in the dev server**

With `npm run dev` running, open Apply Leave as a staff member with a known accrued balance (e.g. 2.00 days):
- Select "Annual Leave", set a date range totaling more days than available → submit button becomes disabled, red text shows the available balance.
- Reduce the range to within the available balance → submit button re-enables.
- Select "Medical Leave" → the annual-balance line disappears and the button is not gated by it.

- [ ] **Step 6: Commit**

```bash
git add src/features/hr/HrLeave.tsx
git commit -m "feat: hard-cap annual leave applications at the accrued available balance"
```

---

## Task 7: Manager view — balance overview, editable opening balance, over-limit warning

**Files:**
- Modify: `src/features/hr/HrLeave.tsx` (`ManagerLeaveView`, currently lines 322-432; `HrLeavePage`, currently lines 436-466)

**Interfaces:**
- Consumes: `calcAnnualBalance`, `AnnualBalance` from Task 3; `Staff.annual_leave_opening` from Task 3; the `staff_update` RLS policy from Task 4.
- Produces: `ManagerLeaveView` gains a new required prop `onStaffChanged: () => void`. `HrLeavePage` gains a `loadStaff` function used both on mount and as that callback.

- [ ] **Step 1: Change the `leave_entitlements` query to fetch all years**

In `ManagerLeaveView`'s `load()` function (currently lines 328-333), replace:

```tsx
  async function load() {
    const { data } = await supabase.from('leave_requests').select('*, staff:staff!leave_requests_staff_id_fkey(id,name,avatar)').order('created_at', { ascending: false })
    setRequests((data as LeaveRequest[]) ?? [])
    const { data: ents } = await supabase.from('leave_entitlements').select('*').eq('year', new Date().getFullYear())
    setEntitlements((ents as LeaveEntitlement[]) ?? [])
  }
```

with:

```tsx
  async function load() {
    const { data } = await supabase.from('leave_requests').select('*, staff:staff!leave_requests_staff_id_fkey(id,name,avatar)').order('created_at', { ascending: false })
    setRequests((data as LeaveRequest[]) ?? [])
    const { data: ents } = await supabase.from('leave_entitlements').select('*')
    setEntitlements((ents as LeaveEntitlement[]) ?? [])
  }
```

(This now fetches all years, needed to sum lifetime `annual_used` per staff. The Medical/Emergency columns below will filter back down to the current year at render time.)

- [ ] **Step 2: Add a per-staff annual balance helper and an over-limit confirmation in `approve()`**

Directly above the `return (` in `ManagerLeaveView` (after the `approve` function, currently ending at line 360), add:

```tsx
  function annualBalanceFor(s: Staff): AnnualBalance {
    return calcAnnualBalance({
      joinedAt: s.joined_at,
      openingBalance: s.annual_leave_opening,
      entitlements: entitlements.filter(e => e.staff_id === s.id),
      requests: requests.filter(r => r.staff_id === s.id),
    })
  }
```

Then update `approve()` (currently lines 340-360) to warn before approving an annual request that would leave the balance negative. Replace:

```tsx
  async function approve(req: LeaveRequest) {
    setApproving(req.id)
    await supabase.from('leave_requests').update({
      status: 'approved', reviewed_by: managerId ?? null, reviewed_at: new Date().toISOString(),
    }).eq('id', req.id)
```

with:

```tsx
  async function approve(req: LeaveRequest) {
    if (req.leave_type === 'annual') {
      const target = allStaff.find(s => s.id === req.staff_id)
      if (target) {
        const bal = annualBalanceFor(target)
        if (bal.available < 0) {
          const proceed = window.confirm(
            `${target.name}'s annual leave balance is already over the accrued limit (${bal.available.toFixed(2)} days). Approve anyway?`
          )
          if (!proceed) return
        }
      }
    }
    setApproving(req.id)
    await supabase.from('leave_requests').update({
      status: 'approved', reviewed_by: managerId ?? null, reviewed_at: new Date().toISOString(),
    }).eq('id', req.id)
```

- [ ] **Step 3: Add the `OpeningBalanceCell` component**

Above `function ManagerLeaveView` (currently line 322), add:

```tsx
function OpeningBalanceCell({ staffMember, onSaved }: { staffMember: Staff; onSaved: () => void }) {
  const [value, setValue] = useState(String(staffMember.annual_leave_opening))
  const [saving, setSaving] = useState(false)

  async function save() {
    const num = Number(value)
    if (Number.isNaN(num) || num === staffMember.annual_leave_opening) return
    setSaving(true)
    await supabase.from('staff').update({ annual_leave_opening: num }).eq('id', staffMember.id)
    setSaving(false)
    onSaved()
  }

  return (
    <input
      type="number"
      step="0.01"
      value={value}
      disabled={saving}
      onChange={e => setValue(e.target.value)}
      onBlur={save}
      className="w-20 px-2 py-1 rounded-lg border border-[#D4C5B0] bg-white text-xs text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]"
    />
  )
}
```

- [ ] **Step 4: Update the function signature to accept `onStaffChanged`**

Replace the `ManagerLeaveView` signature (currently line 322):

```tsx
function ManagerLeaveView({ allStaff, managerId }: { allStaff: Staff[]; managerId: string | undefined }) {
```

with:

```tsx
function ManagerLeaveView({ allStaff, managerId, onStaffChanged }: { allStaff: Staff[]; managerId: string | undefined; onStaffChanged: () => void }) {
```

- [ ] **Step 5: Replace the Leave Balance Overview table**

Replace the table (currently lines 396-425):

```tsx
      <section>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Leave Balance Overview</h3>
        <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
          <table className="w-full text-xs min-w-[600px]">
            <thead>
              <tr className="border-b border-[#EDE5D8]">
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Staff</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Annual</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Medical</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Emergency</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Unpaid</th>
              </tr>
            </thead>
            <tbody>
              {allStaff.map((s, i) => {
                const ent = entitlements.find(e => e.staff_id === s.id)
                return (
                  <tr key={s.id} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                    <td className="px-3 py-2 font-medium text-brown-dark">{s.name}</td>
                    <td className="px-3 py-2">{ent ? `${ent.annual_entitled - ent.annual_used}/${ent.annual_entitled}` : '—'}</td>
                    <td className="px-3 py-2">{ent ? `${ent.medical_entitled - ent.medical_used}/${ent.medical_entitled}` : '—'}</td>
                    <td className="px-3 py-2">{ent ? `${ent.emergency_entitled - ent.emergency_used}/${ent.emergency_entitled}` : '—'}</td>
                    <td className="px-3 py-2">{ent?.unpaid_used ?? 0}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
```

with:

```tsx
      <section>
        <h3 className="text-sm font-bold text-brown-dark mb-3">Leave Balance Overview</h3>
        <div className="bg-white rounded-xl border border-[#E8DDD0] overflow-x-auto">
          <table className="w-full text-xs min-w-[700px]">
            <thead>
              <tr className="border-b border-[#EDE5D8]">
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Staff</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Annual (avail/accrued)</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Opening</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Medical</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Emergency</th>
                <th className="text-left px-3 py-2.5 font-semibold text-brown-faint">Unpaid</th>
              </tr>
            </thead>
            <tbody>
              {allStaff.map((s, i) => {
                const currentYear = new Date().getFullYear()
                const ent = entitlements.find(e => e.staff_id === s.id && e.year === currentYear)
                const bal = annualBalanceFor(s)
                return (
                  <tr key={s.id} className={i > 0 ? 'border-t border-[#F0E8DC]' : ''}>
                    <td className="px-3 py-2 font-medium text-brown-dark">{s.name}</td>
                    <td className={`px-3 py-2 ${bal.available < 0 ? 'text-[#9E4A30] font-semibold' : ''}`}>
                      {bal.available.toFixed(2)}/{bal.accrued.toFixed(2)}
                    </td>
                    <td className="px-3 py-2"><OpeningBalanceCell staffMember={s} onSaved={onStaffChanged} /></td>
                    <td className="px-3 py-2">{ent ? `${ent.medical_entitled - ent.medical_used}/${ent.medical_entitled}` : '—'}</td>
                    <td className="px-3 py-2">{ent ? `${ent.emergency_entitled - ent.emergency_used}/${ent.emergency_entitled}` : '—'}</td>
                    <td className="px-3 py-2">{ent?.unpaid_used ?? 0}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
```

- [ ] **Step 6: Update imports and `HrLeavePage` to load only active staff and pass the refresh callback**

In `src/features/hr/HrLeave.tsx`, ensure the type-only import (from Task 5, Step 1) includes `AnnualBalance` (already added in Task 5 — no change needed here).

Replace `HrLeavePage` (currently lines 436-466):

```tsx
export default function HrLeavePage() {
  const { staff } = useAuth()
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const isManager = staff?.rank === 'supervisor' || staff?.rank === 'manager'

  useEffect(() => {
    if (isManager) supabase.from('staff').select('*').order('name').then(({ data }) => { if (data) setAllStaff(data as Staff[]) })
  }, [isManager])

  if (!staff) return null

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-5xl mx-auto px-4 py-8 lg:px-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Leave</h1>
          <p className="text-sm text-brown-faint mt-0.5">Apply for leave and track your balance.</p>
        </div>

        <MyLeaveView staffMember={staff} />

        {isManager && (
          <section>
            <h2 className="text-base font-bold text-brown-dark mb-4">Team Leave Management</h2>
            <ManagerLeaveView allStaff={allStaff} managerId={staff.id} />
          </section>
        )}
      </div>
    </div>
  )
}
```

with:

```tsx
export default function HrLeavePage() {
  const { staff } = useAuth()
  const [allStaff, setAllStaff] = useState<Staff[]>([])
  const isManager = staff?.rank === 'supervisor' || staff?.rank === 'manager'

  async function loadStaff() {
    const { data } = await supabase.from('staff').select('*').eq('status', 'active').order('name')
    if (data) setAllStaff(data as Staff[])
  }

  useEffect(() => {
    if (isManager) loadStaff()
  }, [isManager])

  if (!staff) return null

  return (
    <div className="min-h-screen bg-cream-light">
      <div className="max-w-5xl mx-auto px-4 py-8 lg:px-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-brown-dark">Leave</h1>
          <p className="text-sm text-brown-faint mt-0.5">Apply for leave and track your balance.</p>
        </div>

        <MyLeaveView staffMember={staff} />

        {isManager && (
          <section>
            <h2 className="text-base font-bold text-brown-dark mb-4">Team Leave Management</h2>
            <ManagerLeaveView allStaff={allStaff} managerId={staff.id} onStaffChanged={loadStaff} />
          </section>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Verify the app builds**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 8: Manually verify in the dev server**

With `npm run dev` running and logged in as a manager or supervisor:
- Open the Leave page → "Leave Balance Overview" table shows an "Annual (avail/accrued)" column and an editable "Opening" input per row.
- Edit an Opening value, blur the input → the Annual column updates after the table reloads.
- Resigned staff do not appear in the table or the Team Calendar.
- Approve a pending annual-leave request for a staff member whose resulting balance would go negative → confirm the browser `window.confirm` warning appears; cancelling it leaves the request pending, confirming it approves as before.

- [ ] **Step 9: Commit**

```bash
git add src/features/hr/HrLeave.tsx
git commit -m "feat: add annual leave balance overview, editable opening balance, and over-limit approval warning"
```

---

## Task 8: Final end-to-end verification

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass (Tasks 1-3's suite, unchanged by Tasks 5-7 since those had no new pure functions).

- [ ] **Step 2: Run the production build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: exits 0 (fix any new lint errors introduced by Tasks 5-7 before proceeding — e.g. unused `entitlement` variable in `MyLeaveView` if it's no longer read anywhere; check `entitlement` is still used by the Medical/Emergency cards further down in that component's render before removing it).

- [ ] **Step 4: Full manual walkthrough on the dev server**

Run: `npm run dev` and, as a staff member:
1. Confirm the Annual Leave card shows an accrued balance matching `calcAccruedAnnual` given that staff member's `joined_at` (spot-check the math by hand for one test account).
2. Apply for annual leave within balance → succeeds, appears in "My Leave History" as pending.
3. Apply for annual leave exceeding balance → submit button stays disabled with the over-limit message.

As a manager/supervisor:
4. Approve the pending request from step 2 → balance overview updates, available balance drops by the approved days.
5. Edit an Opening balance for a different staff member → their Annual column updates on reload.

- [ ] **Step 5: Report the pending manual migration**

If Task 4's migration has not yet been run against the live Supabase database in this environment, tell the user explicitly: annual leave will error until the `annual_leave_opening` column and broadened `staff_update` policy from `supabase/schema.sql`'s "Phase 3 migration" block are applied by hand in the Supabase SQL editor.
