# POS · Outlets (Sub-plan A of devices, PIN login and outlets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn branches into **outlets** of three kinds (Branch, Kiosk, Pop-up with its first and last day, an optional bill prefix such as `PJ-261029-001`), let a manager give a staff member **extra outlets** besides their home branch, add the **"Sign in to the POS"** permission (`pos_login`), make approvers follow "may work at this outlet", and let **POS settings** work on any outlet in the user's scope through an outlet picker.

**Architecture:** One idempotent migration, `supabase/migration-2026-10-29-pos-outlets.sql` (sections `O1`–`O7` after the spec's §1), with its rolled-back self-check. An outlet stays a `branches` row with four new columns. The scope rules are in SQL helpers (`pos_outlet_open`, `staff_outlet_scope`, `pos_staff_may_work`, `pos_manages_outlet`, `my_outlets`). Back-office writes go through `pos_manages_outlet` (RLS policies and the three settings RPCs, which now take `p_branch_id`). On the client, the pure rules are in `src/features/pos/outlets/outlet.ts` (tested), with API calls in `outletsApi.ts`. `OutletsSection` and an outlet picker go on `/pos/settings`, and `ExtraOutletsCard` goes on the staff profile.

**Tech Stack:** React 19, Vite 6, TypeScript, Tailwind, Supabase (Postgres RLS, plpgsql `security definer` RPCs), Vitest. No ESLint config is in force; the gates are `npx tsc -b` and `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md` (commit `6676196`, approved by the owner 2026-10-29). This plan implements its §1 and the outlet parts of §5. It builds on the Feedme-layout front end (head `6676196` on `feature/pos-demo`).

## Where this sits

The spec's build order has four parts. Each part gets its own plan, written once the previous part is live on dev, because later parts re-create functions whose live text the earlier parts change:

- **A — Outlets (this plan).**
- **B — Devices and PIN login:**
  - device tables and the `pos-device-activation` Edge Function;
  - the Craft OS Devices page;
  - staff sessions and the PIN login with its lockout;
  - `pos_ctx()` replacing `pos_my_branch()` across the front-of-house RPCs;
  - read-policy scoping, audit `device_id` columns and the offline queue `staffId`;
  - per-outlet auto-lock minutes.
- **C — The POS as its own app:** the `pos/` Vite entry, its own Supabase client, the manifest and service worker, the `craft-pos` Vercel project, and the Craft OS `/pos` "moved" notice.
- **D — Print agent pairing.**

Until B lands, the POS front of house still uses the signed-in staff login and that login's **home** branch (`pos_my_branch()`). Plan A changes three things on the POS:
- who may approve;
- the bill number prefix;
- which outlets the back office can edit.

Signing in at an extra outlet comes with B.

## Resolutions (decided while planning, 2026-10-29)

- **HQ = `all_branches` + `access_settings`.**
  - `save_outlet` and the guard on direct writes need both. `/pos/settings` already requires `access_settings`, and hr holds `all_branches` without `access_settings`.
  - **By the code defaults, `all_branches` is on for owner, admin, hr and manager.** So every manager counts as HQ, and every manager's scope is every outlet, unless the Owner switches "All Branches" off for Manager in Settings → System Roles.
  - Task 1's pre-check reads the live matrix on dev and reports it to the owner. The same rule decides who approves device activations in Sub-plan B.
- **`all_branches` exists in SQL from now on.** Before this plan only the client knew it. Its SQL defaults mirror `DEFAULT_SYSTEM_ROLE_CAPS` (owner, admin, hr, manager), and so do those of `pos_login` (every role but hr). `has_menu_cap` and `staff_has_cap` are re-created here and are canonical in this file.
- **Scope** (`staff_outlet_scope`):
  - the home branch plus `staff_outlets` rows, or every outlet with `all_branches`;
  - live staff only (`is_active and status = 'active'`).
- **May work** (`pos_staff_may_work`) means `pos_login` and the outlet is in the person's scope. It does not test whether the outlet is open; Sub-plan B's `pos_ctx()` adds that check.
- **An extra outlet also gives its back office.** A manager (`access_settings`) whose scope includes an outlet edits its POS settings. This is the spec's "outlets in their scope".
- **POS settings get an outlet picker.**
  - The chosen outlet is in the URL (`/pos/settings?outlet=<id>`). The default is the home branch, else the first outlet.
  - `save_receipt_settings`, `save_shift_settings` and `save_branch_catalogs` take `p_branch_id` first, and their old one-argument versions are dropped.
  - `insert_test_print(p_route, p_branch_id default null)`: null means the caller's home branch, which is what the POS print host sends. Otherwise the outlet must be one the caller manages.
  - The write policies of `print_routes`, `dining_tables` (insert and delete), `branch_catalogs`, `service_charge_rules`, `payment_methods` and `reason_templates`, and the trigger `dining_tables_guard`, use `pos_manages_outlet(branch_id)`.
  - `print_routes` and `dining_tables` were limited only by `access_settings` before (any branch); they are now scoped too.
- **Approvers:**
  - `pos_approvers()` (POS) and `pos_check_approver` use "may work at the outlet + `pos_supervise`".
  - New message: "The approver cannot work at this outlet".
  - The settings page lists approvers with `pos_outlet_approvers(p_branch_id)`.
  - `clear_pos_pin` works on anyone who may work at one of the caller's outlets, with the new message "This person does not work at your outlets".
  - **Amended during execution (owner, 2026-10-29, commit 14d369b):** a caller without `all_branches` cannot clear the PIN of staff who hold `all_branches` ("Only HQ can clear the PIN of HQ staff"). The code blocks in Task 1 below show the pre-fix text; the committed files are canonical.
  - With the default matrix the owner can clear anyone's PIN; the checkout verify's old "another branch" refusal therefore moves to the outlets verify, where the managers are made branch-only.
- **Outlet form rules** (`save_outlet`):
  - the name is trimmed, 1–60 characters, and unique ignoring case;
  - the kind is one of Branch, Kiosk or Pop-up;
  - a pop-up needs both days, the last day not before the first; a Branch or Kiosk keeps no dates;
  - the prefix is trimmed, upper-cased, 1–4 of A–Z and 0–9, and unique ("The bill prefix ZQ8 is used by VERIFY O POP").
  - The client mirrors these words in `parseOutletDraft`. A new outlet is created active. Deactivating, address, geofence and PIC stay in Settings → Branches, and this plan does not touch `Settings.tsx`, so the geofence commits on `main` merge without conflict.
- **Direct writes to `branches`** (Settings → Branches, policy `branches_manage`) cannot set the kind, dates or prefix unless HQ makes them. This is the trigger `branches_outlet_guard`. A session with no signed-in user (the SQL editor or the service role) passes.
- **Open for POS** (`pos_outlet_open`):
  - the outlet is active and, for a pop-up, today's Malaysia date is between the first and last day, both days included;
  - `my_outlets()` returns it as `open_now`;
  - the client's `outletNote` shows "Opens on 1 Dec" / "Closed on 31 Dec" / "Inactive".
- **Bill prefix:**
  - It applies to bills created after it is set; existing numbers stay.
  - The per-outlet daily counter is unchanged, so a prefix set mid-day continues the day's count.
  - Nothing on the client parses bill numbers (checked: no `\d{6}`, split or slice of `bill_no`).
- **`staff_outlets` reads and writes:**
  - Any signed-in staff member can read it (it is not sensitive).
  - Writes go only through `set_staff_outlet(p_staff_id, p_branch_id, p_on)`: `access_settings` and an outlet in the caller's scope; adding needs live staff whose home branch is not that outlet. A repeat add is a no-op.
- **The staff profile card** "POS outlets" shows for `access_settings` holders on someone else's profile. It lists the caller's outlets except the person's home branch, with a checkbox each.

## Global Constraints

- **Dev database first.**
  - The SQL is applied on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) by the controller, from the owner's Chrome tab on the dashboard SQL editor.
  - Prod (`yfsoesxzurzjdwstszru`) is a later step that the owner decides. On prod this migration runs after the whole POS chain including `migration-2026-10-26-pos-frontend.sql`, and right before the first deploy that carries Task 4.
  - The verify scripts are dev-only.
- Every step that reads or writes the dev database is marked **(controller; the implementer does not touch the database)**. Implementers run only local commands (`grep`, `npx tsc -b`, `npx vitest run`) and commit.
- **All UI copy, field names and error messages are in English** (`english-product-copy` rule). The exact strings are the ones in this plan's code. Code comments match the surrounding file.
- **Every new or re-created function:**
  - pins `set search_path = public, pg_temp`;
  - revokes execute from `public, anon`;
  - is granted to `authenticated` only where staff call it. The internal ones (`staff_has_cap`, `pos_outlet_open`, `staff_outlet_scope`, `pos_staff_may_work`, `pos_check_approver`, `pos_next_bill_no`) are revoked from `authenticated` too.
- **pg-safeupdate:** every DELETE or UPDATE inside a function has a WHERE. `src/features/pos/sqlSafeUpdate.test.ts` scans the new file.
- **Migrations are idempotent** and end with `notify pgrst, 'reload schema';` before the final `select`. The STOP guard needs `pos_set_bill_pax` (the front-end migration).
- **Re-run hazards** (listed in the migration header): re-running `-pos-catalogs.sql`, `-pos-checkout-fixes.sql`, `-pos-ordering.sql`, `-pos-bill-actions-fn.sql` or `-pos-frontend.sql` brings back older policies or functions. Re-run this file afterwards.
- **Verify fixtures.** Staff are created after `request.jwt.claims` is set to the dev owner `76cbcf9f-905e-450d-9f5e-1c9e72a9373d`, inserted as `staff` and promoted by the owner. A function called for its side effect is called on its own line before a condition checks the effect: PostgreSQL may run a condition's subqueries first.
- **UI rules (from M1/M2):**
  - each action shows its outcome next to its control;
  - write buttons are disabled while they run, and a ref refuses a second tap;
  - a failed load locks the writes;
  - a load keyed by a selection drops a stale reply (sequence ref);
  - every input has a visible label;
  - no `.ts` or `.tsx` file this plan creates or edits is over ~250 lines, except `StaffProfile.tsx`, which already has 1,867 lines and only gains an import and a card mount.
- `tsconfig` has `noUnusedLocals` and `noUnusedParameters`: remove an import as soon as it is unused.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Worktree.** Work in `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`. Never use a bare `git stash`. Every replacement below quotes its old text; if one does not match exactly once, another session changed the file since `6676196`: read it and apply the same change to what is there.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-29-pos-outlets.sql` | O1–O7: outlet columns and guard, `staff_outlets`, capabilities, scope helpers, approvers, bill numbers, settings on a chosen outlet (Task 1) |
| `supabase/migration-2026-10-29-pos-outlets-verify.sql` | Self-check, rolled back (Task 1) |
| `supabase/migration-2026-10-24-pos-checkout-verify.sql`, `-catalogs-verify.sql`, `-shifts-verify.sql` | Regression scripts follow the new signatures, policies and messages (Task 1) |
| `src/features/pos/sqlSafeUpdate.test.ts` | Scans the new migration (Task 1) |
| `src/shared/types/index.ts`, `capabilities.test.ts` | `pos_login` "Sign in to the POS"; defaults (Task 2) |
| `src/features/pos/outlets/outlet.ts` (+test), `outletsApi.ts` | Pure outlet rules; API calls (Task 3) |
| `src/features/pos/outlets/OutletsSection.tsx`, `src/features/pos/order/PosSettingsPage.tsx` | Outlets list and form; outlet picker (Task 4) |
| `src/features/pos/order/posApi.ts`, `MenuCatalogsSection.tsx`, `src/features/pos/shift/shiftApi.ts`, `ShiftSettingsSection.tsx`, `src/features/pos/checkout/checkoutApi.ts`, `CheckoutSettings.tsx` | Settings saves take the chosen outlet; approvers per outlet (Task 4) |
| `src/features/pos/outlets/ExtraOutletsCard.tsx`, `src/features/staff/StaffProfile.tsx` | Extra outlets on the staff profile (Task 5) |

**Test counts.** These were checked while planning on a scratch copy of the worktree at `6676196`, by applying this document task by task.
- Baseline: 128 files / 1044 tests.
- After Task 1: 128 / 1046.
- After Task 2: 128 / 1049.
- After Task 3: 129 / 1060.
- After Tasks 4 and 5: 129 / 1060.
- `npx tsc -b` prints nothing after every task.

**SQL checks.** The SQL was replayed on a scratch PostgreSQL 18 with Supabase stand-ins (auth, storage, roles), built from `schema.sql`, `catchup-2026-07-02.sql`, the HR migrations and the whole POS chain:
- The migration applies twice.
- The new verify and all nine POS regression verify scripts print `VERIFY OK`: menu, ordering, catalogs, menu editor, slots and photos, checkout, shifts, hardening and front end, with Task 1's edits to three of them.
- The new verify fails for each of eight deliberate faults:
  - may-work ignoring `pos_login`;
  - scope ignoring `staff_outlets`;
  - a bill number without its prefix;
  - an unscoped `print_routes` policy;
  - a pop-up open outside its days;
  - a guard that lets anyone set the kind;
  - the old same-branch approver rule;
  - `all_branches` missing from the SQL defaults.

---

### Task 1: The outlets migration, its verify, the regression updates — and applying it on craft-os-dev (implementer + controller)

**Model tier:** cheap (the plan carries every line). The controller runs Steps 1 and 7.

**Files:**
- Create: `supabase/migration-2026-10-29-pos-outlets.sql`, `supabase/migration-2026-10-29-pos-outlets-verify.sql`
- Modify: `supabase/migration-2026-10-24-pos-checkout-verify.sql`, `supabase/migration-2026-10-24-pos-catalogs-verify.sql`, `supabase/migration-2026-10-24-pos-shifts-verify.sql`, `src/features/pos/sqlSafeUpdate.test.ts`

**Interfaces:**
- Produces (SQL, for Tasks 3–5 and Sub-plan B):
  - `my_outlets() → table(id, name, kind, opens_on, closes_on, bill_prefix, is_active, is_home, open_now)`
  - `save_outlet(p_id uuid, p_name text, p_kind text, p_opens_on date, p_closes_on date, p_bill_prefix text) → uuid`
  - `set_staff_outlet(p_staff_id uuid, p_branch_id uuid, p_on boolean) → void`
  - `pos_outlet_approvers(p_branch_id uuid) → table(staff_id, name, has_pin)`
  - `save_receipt_settings(p_branch_id uuid, p jsonb)`, `save_shift_settings(p_branch_id uuid, p_cash_variance_limit_sen integer)`, `save_branch_catalogs(p_branch_id uuid, p jsonb)`, `insert_test_print(p_route text, p_branch_id uuid default null) → uuid`
  - Internal: `pos_outlet_open(uuid)`, `staff_outlet_scope(uuid)`, `pos_staff_may_work(uuid, uuid)`; for RLS: `pos_manages_outlet(uuid)`
  - Table `staff_outlets(staff_id, branch_id, added_by, added_at)`

- [ ] **Step 1: Pre-check on dev (controller; the implementer does not touch the database)**

Run read-only in the dev SQL editor:

```sql
select system_role, permissions->'all_branches' as all_branches, permissions->'access_settings' as access_settings,
       permissions->'pos_login' as pos_login
  from system_role_permissions order by system_role;
select lower(name) as name, count(*) from branches group by 1 having count(*) > 1;
```

Report both results to the owner:
- The first shows who counts as HQ. A null value means the code default, and Manager defaults to All Branches on.
- The second lists duplicate branch names. `save_outlet` refuses to save an outlet under a duplicate name, so rename one in Settings → Branches first.

Neither result blocks the migration.

- [ ] **Step 2: Name the new file in the pg-safeupdate scan (the failing test)**

Replacement 1 in `src/features/pos/sqlSafeUpdate.test.ts` — replace:

```ts
      'migration-2026-10-26-pos-frontend.sql',
    ]))
```

with:

```ts
      'migration-2026-10-26-pos-frontend.sql',
      'migration-2026-10-29-pos-outlets.sql',
    ]))
```

Replacement 2 in `src/features/pos/sqlSafeUpdate.test.ts` — replace:

```ts
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
})
```

with:

```ts
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })

  it('scans the outlets migration: its write functions, the STOP guard, a rolled-back verify', () => {
    const sql = readFileSync(new URL('migration-2026-10-29-pos-outlets.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual(expect.arrayContaining([
      'branches_outlet_guard', 'save_outlet', 'set_staff_outlet', 'clear_pos_pin', 'pos_next_bill_no',
      'save_receipt_settings', 'save_shift_settings', 'save_branch_catalogs', 'insert_test_print', 'dining_tables_guard',
    ]))
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-10-26-pos-frontend\.sql first/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-10-29-pos-outlets-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
})
```


Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL. The new scan test cannot read `migration-2026-10-29-pos-outlets.sql` (ENOENT), and the file list misses it.

- [ ] **Step 3: Write the migration**

Create `supabase/migration-2026-10-29-pos-outlets.sql`:

```sql
-- ============================================================================
-- Craft OS — POS outlets (2026-10-29): outlet kinds, extra outlets, the POS login
-- capability, and the back office acting on a chosen outlet.
-- Run on craft-os-dev after migration-2026-10-26-pos-frontend.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-29-pos-outlets.md
-- Design: docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md (§1)
--
-- O1  branches.kind (branch | kiosk | popup), opens_on / closes_on (a pop-up's first and last
--     day), bill_prefix (1–4 of A–Z 0–9, unique). Only HQ (all_branches + access_settings)
--     sets them: save_outlet, and the trigger branches_outlet_guard for direct writes.
-- O2  staff_outlets: the outlets a staff member may work at besides their home branch.
--     set_staff_outlet adds or removes one; readable by every signed-in staff member.
-- O3  Capability pos_login ("Sign in to the POS"): on for every role except hr. has_menu_cap
--     and staff_has_cap are canonical here now, with the SQL defaults of all_branches and
--     pos_login added (they mirror DEFAULT_SYSTEM_ROLE_CAPS in src/shared/types/index.ts).
-- O4  pos_outlet_open, staff_outlet_scope, pos_staff_may_work, pos_manages_outlet, my_outlets.
-- O5  Approvers: anyone who may work at the outlet and holds pos_supervise (pos_approvers,
--     pos_check_approver); pos_outlet_approvers lists them for POS settings; clear_pos_pin
--     acts on staff who work at one of the caller's outlets.
-- O6  Bill numbers: pos_next_bill_no puts the outlet's prefix in front (PJ-261029-001).
-- O7  POS settings act on a chosen outlet in the caller's scope: save_receipt_settings,
--     save_shift_settings and save_branch_catalogs take p_branch_id first (the old
--     signatures are dropped), insert_test_print takes an optional p_branch_id (null = the
--     caller's home branch, as the POS sends it); the write policies of print_routes,
--     dining_tables, branch_catalogs, service_charge_rules, payment_methods and
--     reason_templates and dining_tables_guard use pos_manages_outlet.
-- Re-run hazards: re-running migration-2026-10-24-pos-catalogs.sql (has_menu_cap,
-- staff_has_cap, branch_catalogs_manage), migration-2026-10-24-pos-checkout-fixes.sql (the
-- three settings policies), migration-2026-10-23-pos-ordering.sql (print_routes and
-- dining_tables policies), migration-2026-10-24-pos-bill-actions-fn.sql (pos_approvers,
-- pos_check_approver, clear_pos_pin) or migration-2026-10-26-pos-frontend.sql
-- (dining_tables_guard) puts the older versions back — re-run this file afterwards.
-- Re-running catalogs-fn, shifts-fn or ordering-fn re-creates an old one-argument settings
-- function next to the new one; it acts on the caller's home branch only and the app no
-- longer calls it.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_set_bill_pax(uuid,integer)') is null or to_regprocedure('staff_has_cap(uuid,text)') is null then
    raise exception 'STOP: run migration-2026-10-26-pos-frontend.sql first (pos_set_bill_pax is missing)';
  end if;
end $$;

-- ── O3. Capabilities: pos_login, and all_branches in SQL ─────────────────────
-- The checkout-fixes / catalogs rule (live staff only; the Owner's setting in
-- system_role_permissions wins over the default) plus two capabilities. Mirrors
-- buildRoleCaps (src/shared/lib/lookups.tsx) over DEFAULT_SYSTEM_ROLE_CAPS — change the three together.
create or replace function has_menu_cap(p_cap text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> p_cap)::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      case p_cap
        when 'access_settings' then s.system_role in ('owner','admin','manager')
        when 'pos_supervise'   then s.system_role in ('owner','admin','manager','supervisor')
        when 'manage_menu'     then s.system_role in ('owner','admin')
        when 'all_branches'    then s.system_role in ('owner','admin','hr','manager')                  -- O3
        when 'pos_login'       then s.system_role in ('owner','admin','manager','supervisor','staff')  -- O3
        else false
      end)
    from staff s
    where s.id = auth.uid() and s.is_active and s.status = 'active'
  ), false)
$$;

create or replace function staff_has_cap(p_staff_id uuid, p_cap text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> p_cap)::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      case p_cap
        when 'access_settings' then s.system_role in ('owner','admin','manager')
        when 'pos_supervise'   then s.system_role in ('owner','admin','manager','supervisor')
        when 'manage_menu'     then s.system_role in ('owner','admin')
        when 'all_branches'    then s.system_role in ('owner','admin','hr','manager')                  -- O3
        when 'pos_login'       then s.system_role in ('owner','admin','manager','supervisor','staff')  -- O3
        else false
      end)
    from staff s
    where s.id = p_staff_id and s.is_active and s.status = 'active'
  ), false)
$$;
revoke all on function staff_has_cap(uuid, text) from public, anon, authenticated;

-- ── O1. Outlet columns on branches ──────────────────────────────────────────
alter table branches add column if not exists kind        text not null default 'branch';
alter table branches add column if not exists opens_on    date;
alter table branches add column if not exists closes_on   date;
alter table branches add column if not exists bill_prefix text;
alter table branches drop constraint if exists branches_kind_check;
alter table branches add constraint branches_kind_check check (kind in ('branch', 'kiosk', 'popup'));
alter table branches drop constraint if exists branches_outlet_dates_check;
alter table branches add constraint branches_outlet_dates_check check (
  case when kind = 'popup' then opens_on is not null and closes_on is not null and closes_on >= opens_on
       else opens_on is null and closes_on is null end);
alter table branches drop constraint if exists branches_bill_prefix_check;
alter table branches add constraint branches_bill_prefix_check check (bill_prefix is null or bill_prefix ~ '^[A-Z0-9]{1,4}$');
create unique index if not exists branches_bill_prefix_key on branches (bill_prefix) where bill_prefix is not null;

-- Direct writes (Settings → Branches) may not set an outlet's kind, dates or prefix unless
-- HQ makes them. No signed-in user (the SQL editor, the service role) passes.
create or replace function branches_outlet_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null and not (has_menu_cap('all_branches') and has_menu_cap('access_settings')) and (
       (tg_op = 'INSERT' and (new.kind <> 'branch' or new.opens_on is not null or new.closes_on is not null or new.bill_prefix is not null))
    or (tg_op = 'UPDATE' and (new.kind, new.opens_on, new.closes_on, new.bill_prefix)
                              is distinct from (old.kind, old.opens_on, old.closes_on, old.bill_prefix))) then
    raise exception 'Only HQ can change an outlet''s kind, dates or bill prefix';
  end if;
  return new;
end $$;
drop trigger if exists branches_outlet_guard on branches;
create trigger branches_outlet_guard before insert or update on branches
  for each row execute function branches_outlet_guard();

-- ── O2. Extra outlets ───────────────────────────────────────────────────────
create table if not exists staff_outlets (
  staff_id  uuid not null references staff(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  added_by  uuid references staff(id) on delete set null,
  added_at  timestamptz not null default now(),
  primary key (staff_id, branch_id)
);
alter table staff_outlets enable row level security;
drop policy if exists staff_outlets_read on staff_outlets;
create policy staff_outlets_read on staff_outlets for select to authenticated using (true);
revoke all on staff_outlets from anon, authenticated;
grant select on staff_outlets to authenticated;

-- ── O4. Where an outlet is open, who may work where, whose back office covers what ──
-- Open for POS: active and, for a pop-up, today (Malaysia) between its first and last day.
create or replace function pos_outlet_open(p_branch_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(b.is_active, false)
           and (b.kind <> 'popup'
                or (now() at time zone 'Asia/Kuala_Lumpur')::date between b.opens_on and b.closes_on)
      from branches b where b.id = p_branch_id), false)
$$;
revoke all on function pos_outlet_open(uuid) from public, anon, authenticated;

-- The home branch, the extra outlets, or every outlet with all_branches. Live staff only.
create or replace function staff_outlet_scope(p_staff_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id from branches b where staff_has_cap(p_staff_id, 'all_branches')
  union
  select s.branch_id from staff s
   where s.id = p_staff_id and s.is_active and s.status = 'active' and s.branch_id is not null
  union
  select o.branch_id from staff_outlets o join staff s on s.id = o.staff_id
   where o.staff_id = p_staff_id and s.is_active and s.status = 'active'
$$;
revoke all on function staff_outlet_scope(uuid) from public, anon, authenticated;

create or replace function pos_staff_may_work(p_staff_id uuid, p_branch_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_branch_id is not null and staff_has_cap(p_staff_id, 'pos_login')
         and p_branch_id in (select staff_outlet_scope(p_staff_id))
$$;
revoke all on function pos_staff_may_work(uuid, uuid) from public, anon, authenticated;

-- The caller holds access_settings and the outlet is in their scope. Used by RLS policies.
create or replace function pos_manages_outlet(p_branch_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_branch_id is not null and has_menu_cap('access_settings')
         and p_branch_id in (select staff_outlet_scope(auth.uid()))
$$;
revoke all on function pos_manages_outlet(uuid) from public, anon;
grant execute on function pos_manages_outlet(uuid) to authenticated;

-- The caller's outlets for the back office: home branch first, then branches, kiosks, pop-ups.
create or replace function my_outlets()
returns table (id uuid, name text, kind text, opens_on date, closes_on date, bill_prefix text,
               is_active boolean, is_home boolean, open_now boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.name, b.kind, b.opens_on, b.closes_on, b.bill_prefix, coalesce(b.is_active, false),
         coalesce(b.id = (select s.branch_id from staff s where s.id = auth.uid()), false),
         pos_outlet_open(b.id)
    from branches b
   where b.id in (select staff_outlet_scope(auth.uid()))
   order by 8 desc, array_position(array['branch', 'kiosk', 'popup'], b.kind), b.name
$$;
revoke all on function my_outlets() from public, anon;
grant execute on function my_outlets() to authenticated;

-- ── O1. HQ adds or changes an outlet ────────────────────────────────────────
-- p_id null = a new outlet (active). Name, kind, a pop-up's dates and the bill prefix only;
-- everything else stays in POS settings and Settings → Branches.
create or replace function save_outlet(p_id uuid, p_name text, p_kind text, p_opens_on date, p_closes_on date,
                                       p_bill_prefix text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name   text := nullif(btrim(p_name), '');
  v_prefix text := nullif(upper(btrim(p_bill_prefix)), '');
  v_open   date := case when p_kind = 'popup' then p_opens_on end;
  v_close  date := case when p_kind = 'popup' then p_closes_on end;
  v_other  text;
  v_id     uuid;
begin
  if not (has_menu_cap('all_branches') and has_menu_cap('access_settings')) then
    raise exception 'Only HQ can add or change outlets';
  end if;
  if v_name is null then raise exception 'Enter the outlet name'; end if;
  if char_length(v_name) > 60 then raise exception 'The outlet name is longer than 60 characters'; end if;
  if p_kind is null or p_kind not in ('branch', 'kiosk', 'popup') then
    raise exception 'Choose Branch, Kiosk or Pop-up';
  end if;
  if p_kind = 'popup' and (v_open is null or v_close is null) then
    raise exception 'A pop-up needs its first and last day';
  end if;
  if v_close < v_open then raise exception 'The last day is before the first day'; end if;
  if v_prefix is not null and v_prefix !~ '^[A-Z0-9]{1,4}$' then
    raise exception 'The bill prefix is 1 to 4 letters or digits';
  end if;
  if exists (select 1 from branches b where lower(b.name) = lower(v_name) and b.id is distinct from p_id) then
    raise exception 'An outlet named % already exists', v_name;
  end if;
  select b.name into v_other from branches b where b.bill_prefix = v_prefix and b.id is distinct from p_id;
  if found then raise exception 'The bill prefix % is used by %', v_prefix, v_other; end if;
  begin
    if p_id is null then
      insert into branches(name, kind, opens_on, closes_on, bill_prefix, is_active)
      values (v_name, p_kind, v_open, v_close, v_prefix, true)
      returning id into v_id;
    else
      update branches
         set name = v_name, kind = p_kind, opens_on = v_open, closes_on = v_close, bill_prefix = v_prefix
       where id = p_id
      returning id into v_id;
      if v_id is null then raise exception 'Outlet not found'; end if;
    end if;
  exception when unique_violation then
    raise exception 'The bill prefix % is used by another outlet', v_prefix;
  end;
  return v_id;
end $$;
revoke all on function save_outlet(uuid, text, text, date, date, text) from public, anon;
grant execute on function save_outlet(uuid, text, text, date, date, text) to authenticated;

-- ── O2. A manager adds or removes an extra outlet of a staff member ──────────
create or replace function set_staff_outlet(p_staff_id uuid, p_branch_id uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_home uuid;
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can change where staff may work'; end if;
  if p_on is null then raise exception 'Invalid request'; end if;
  if not pos_manages_outlet(p_branch_id) then raise exception 'This outlet is not one of yours'; end if;
  if p_on then
    select s.branch_id into v_home from staff s where s.id = p_staff_id and s.is_active and s.status = 'active';
    if not found then raise exception 'Staff member not found'; end if;
    if v_home = p_branch_id then raise exception 'This is their home branch already'; end if;
    insert into staff_outlets(staff_id, branch_id, added_by) values (p_staff_id, p_branch_id, auth.uid())
    on conflict (staff_id, branch_id) do nothing;
  else
    delete from staff_outlets where staff_id = p_staff_id and branch_id = p_branch_id;
  end if;
end $$;
revoke all on function set_staff_outlet(uuid, uuid, boolean) from public, anon;
grant execute on function set_staff_outlet(uuid, uuid, boolean) to authenticated;

-- ── O5. Approvers ───────────────────────────────────────────────────────────
-- Who may approve at the caller's outlet: may work there and holds pos_supervise.
create or replace function pos_approvers() returns table (staff_id uuid, name text, has_pin boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.name, exists (select 1 from staff_pos_pins p where p.staff_id = s.id)
    from staff s
   where pos_staff_may_work(s.id, pos_my_branch()) and staff_has_cap(s.id, 'pos_supervise')   -- O5
   order by s.name
$$;
revoke all on function pos_approvers() from public, anon;
grant execute on function pos_approvers() to authenticated;

-- The same list for an outlet the caller manages (POS settings → Approvers).
create or replace function pos_outlet_approvers(p_branch_id uuid) returns table (staff_id uuid, name text, has_pin boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not pos_manages_outlet(p_branch_id) then raise exception 'This outlet is not one of yours'; end if;
  return query
    select s.id, s.name, exists (select 1 from staff_pos_pins p where p.staff_id = s.id)
      from staff s
     where pos_staff_may_work(s.id, p_branch_id) and staff_has_cap(s.id, 'pos_supervise')
     order by s.name;
end $$;
revoke all on function pos_outlet_approvers(uuid) from public, anon;
grant execute on function pos_outlet_approvers(uuid) to authenticated;

create or replace function pos_check_approver(p_branch_id uuid, p_approver_id uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_approver_id is null then raise exception 'Choose who approves'; end if;
  if not pos_staff_may_work(p_approver_id, p_branch_id) then                                  -- O5
    raise exception 'The approver cannot work at this outlet';
  end if;
  if not staff_has_cap(p_approver_id, 'pos_supervise') then
    raise exception 'This person cannot approve voids or refunds';
  end if;
  return pos_pin_attempt(p_approver_id, p_pin);
end $$;
revoke all on function pos_check_approver(uuid, uuid, text) from public, anon, authenticated;

create or replace function clear_pos_pin(p_staff_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can clear a PIN'; end if;
  if not exists (select 1 from staff_outlet_scope(p_staff_id) t(id) where pos_manages_outlet(t.id)) then   -- O5
    raise exception 'This person does not work at your outlets';
  end if;
  delete from staff_pos_pins where staff_id = p_staff_id;
end $$;
revoke all on function clear_pos_pin(uuid) from public, anon;
grant execute on function clear_pos_pin(uuid) to authenticated;

-- ── O6. Bill numbers: [PREFIX-]YYMMDD-NNN per outlet per Malaysia day ───────
create or replace function pos_next_bill_no(p_branch_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_day    date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_prefix text := (select b.bill_prefix || '-' from branches b where b.id = p_branch_id);   -- O6
  v_n      integer;
begin
  insert into bill_counters(branch_id, day, next_no) values (p_branch_id, v_day, 2)
  on conflict (branch_id, day) do update set next_no = bill_counters.next_no + 1
  returning next_no - 1 into v_n;
  return coalesce(v_prefix, '') || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, greatest(3, length(v_n::text)), '0');
end $$;
revoke all on function pos_next_bill_no(uuid) from public, anon, authenticated;

-- ── O7. POS settings act on a chosen outlet ─────────────────────────────────
drop function if exists save_receipt_settings(jsonb);
drop function if exists save_shift_settings(integer);
drop function if exists save_branch_catalogs(jsonb);
drop function if exists insert_test_print(text);

-- Same as migration-2026-10-24-pos-checkout-fn.sql except the outlet: p_branch_id, in scope.
create or replace function save_receipt_settings(p_branch_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := p_branch_id;                                                              -- O7
  v_route  text;
  v_round  text;
  v_footer constant text := 'This is an official receipt. Thank you for visiting us.';
begin
  if not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change the receipt settings';
  end if;
  if not pos_manages_outlet(v_branch) then raise exception 'This outlet is not one of yours'; end if;   -- O7
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid settings'; end if;
  if nullif(trim(p->>'receiptTitle'), '') is null then raise exception 'Enter the receipt title'; end if;
  v_route := nullif(trim(p->>'receiptRoute'), '');
  v_round := coalesce(p->>'cashRounding', 'nearest_5_sen');
  if v_round not in ('none', 'nearest_5_sen') then raise exception 'Invalid rounding setting'; end if;
  if v_route is not null and not exists (select 1 from print_routes where branch_id = v_branch and name = v_route) then
    raise exception 'No printer is set for route %', v_route;
  end if;
  -- a key that is absent leaves its column as it is (branches.address is shown all over Craft OS)
  update branches
     set receipt_title   = trim(p->>'receiptTitle'),
         legal_name      = case when p ? 'legalName'      then nullif(trim(p->>'legalName'), '')      else legal_name end,
         registration_no = case when p ? 'registrationNo' then nullif(trim(p->>'registrationNo'), '') else registration_no end,
         sst_no          = case when p ? 'sstNo'          then nullif(trim(p->>'sstNo'), '')          else sst_no end,
         address         = case when p ? 'address'        then nullif(trim(p->>'address'), '')        else address end,
         phone           = case when p ? 'phone'          then nullif(trim(p->>'phone'), '')          else phone end,
         email           = case when p ? 'email'          then nullif(trim(p->>'email'), '')          else email end
   where id = v_branch;
  insert into branch_pos_settings(branch_id) values (v_branch) on conflict (branch_id) do nothing;
  update branch_pos_settings
     set sst_registered        = case when p ? 'sstRegistered' then coalesce((p->>'sstRegistered')::boolean, sst_registered) else sst_registered end,
         cash_rounding         = case when p ? 'cashRounding' then v_round else cash_rounding end,
         receipt_route         = case when p ? 'receiptRoute' then v_route else receipt_route end,
         receipt_footer        = case when p ? 'footer' then coalesce(nullif(trim(left(p->>'footer', 300)), ''), v_footer) else receipt_footer end,
         qr_requires_open_bill = case when p ? 'qrRequiresOpenBill' then coalesce((p->>'qrRequiresOpenBill')::boolean, qr_requires_open_bill) else qr_requires_open_bill end,
         updated_at            = now()
   where branch_id = v_branch;
end $$;
revoke all on function save_receipt_settings(uuid, jsonb) from public, anon;
grant execute on function save_receipt_settings(uuid, jsonb) to authenticated;

-- Same as migration-2026-10-24-pos-shifts-fn.sql except the outlet.
create or replace function save_shift_settings(p_branch_id uuid, p_cash_variance_limit_sen integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := p_branch_id;                                                              -- O7
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can change the shift settings'; end if;
  if not pos_manages_outlet(v_branch) then raise exception 'This outlet is not one of yours'; end if;   -- O7
  if p_cash_variance_limit_sen is null or p_cash_variance_limit_sen < 0 or p_cash_variance_limit_sen > 1000000 then
    raise exception 'Enter a cash variance limit between RM 0.00 and RM 10000.00';
  end if;
  insert into branch_pos_settings(branch_id) values (v_branch) on conflict (branch_id) do nothing;
  update branch_pos_settings
     set cash_variance_limit_sen = p_cash_variance_limit_sen, updated_at = now()
   where branch_id = v_branch;
end $$;
revoke all on function save_shift_settings(uuid, integer) from public, anon;
grant execute on function save_shift_settings(uuid, integer) to authenticated;

-- Same as migration-2026-10-24-pos-catalogs-fn.sql except the outlet.
create or replace function save_branch_catalogs(p_branch_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := p_branch_id;                                                              -- O7
  v_uuid   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_role   record;
  v_add    uuid[];
begin
  if not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change the menu catalogs';
  end if;
  if not pos_manages_outlet(v_branch) then raise exception 'This outlet is not one of yours'; end if;   -- O7
  if jsonb_typeof(p) is distinct from 'object'
     or jsonb_typeof(coalesce(p->'additional', '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid catalog settings';
  end if;
  for v_role in select * from (values ('dineIn', 'dine-in'), ('takeaway', 'takeaway'), ('qr', 'QR')) as x(key, label) loop
    if jsonb_typeof(p->v_role.key) is distinct from 'string' then
      raise exception 'Choose the % catalog', v_role.label;
    end if;
    if (p->>v_role.key) !~* v_uuid then raise exception 'Invalid catalog settings'; end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(coalesce(p->'additional', '[]'::jsonb)) e
              where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* v_uuid) then
    raise exception 'Invalid catalog settings';
  end if;
  select coalesce(array_agg(distinct x.v::uuid), '{}') into v_add
    from jsonb_array_elements_text(coalesce(p->'additional', '[]'::jsonb)) as x(v);
  if exists (select 1 from unnest(array[(p->>'dineIn')::uuid, (p->>'takeaway')::uuid, (p->>'qr')::uuid] || v_add) as c(id)
              where not exists (select 1 from menu_catalogs m where m.id = c.id and m.is_active)) then
    raise exception 'This catalog is not available — refresh and try again';
  end if;
  delete from branch_catalogs where branch_id = v_branch;
  insert into branch_catalogs(branch_id, role, catalog_id)
  select v_branch, r.role, r.id
    from (values ('dine_in', (p->>'dineIn')::uuid), ('takeaway', (p->>'takeaway')::uuid), ('qr', (p->>'qr')::uuid)) as r(role, id)
  union all
  select v_branch, 'additional', a.id from unnest(v_add) as a(id);
end $$;
revoke all on function save_branch_catalogs(uuid, jsonb) from public, anon;
grant execute on function save_branch_catalogs(uuid, jsonb) to authenticated;

-- Same as migration-2026-10-23-pos-ordering-fn.sql except the outlet: null = the caller's
-- home branch (the POS print host), otherwise an outlet the caller manages (POS settings).
create or replace function insert_test_print(p_route text, p_branch_id uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_branch_id is null then                                                                -- O7
    select branch_id into v_branch from staff where id = auth.uid() and is_active;
    if v_branch is null then raise exception 'Your account has no branch'; end if;
  elsif pos_manages_outlet(p_branch_id) then
    v_branch := p_branch_id;
  else
    raise exception 'This outlet is not one of yours';
  end if;
  if not exists (select 1 from print_routes where branch_id = v_branch and name = p_route) then
    raise exception 'No printer is set for route %', p_route;
  end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (v_branch, p_route, 'ticket', jsonb_build_object(
    'kind', 'ticket', 'route', p_route, 'tableLabel', 'TEST', 'orderNo', 'TEST01', 'source', 'test',
    'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lines', jsonb_build_array(jsonb_build_object('qty', 1, 'name', 'Test print — ' || p_route, 'note', null, 'mods', '[]'::jsonb))))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function insert_test_print(text, uuid) from public, anon;
grant execute on function insert_test_print(text, uuid) to authenticated;

-- The settings tables: a manager writes the outlets in their scope.
drop policy if exists print_routes_manage on print_routes;
create policy print_routes_manage on print_routes for all to authenticated
  using (pos_manages_outlet(branch_id)) with check (pos_manages_outlet(branch_id));
drop policy if exists dining_tables_insert on dining_tables;
create policy dining_tables_insert on dining_tables for insert to authenticated with check (pos_manages_outlet(branch_id));
drop policy if exists dining_tables_delete on dining_tables;
create policy dining_tables_delete on dining_tables for delete to authenticated using (pos_manages_outlet(branch_id));
drop policy if exists branch_catalogs_manage on branch_catalogs;
create policy branch_catalogs_manage on branch_catalogs for all to authenticated
  using (pos_manages_outlet(branch_id)) with check (pos_manages_outlet(branch_id));
drop policy if exists service_charge_rules_manage on service_charge_rules;
create policy service_charge_rules_manage on service_charge_rules for all to authenticated
  using (pos_manages_outlet(branch_id)) with check (pos_manages_outlet(branch_id));
drop policy if exists payment_methods_manage on payment_methods;
create policy payment_methods_manage on payment_methods for all to authenticated
  using (pos_manages_outlet(branch_id)) with check (pos_manages_outlet(branch_id));
drop policy if exists reason_templates_manage on reason_templates;
create policy reason_templates_manage on reason_templates for all to authenticated
  using (pos_manages_outlet(branch_id)) with check (pos_manages_outlet(branch_id));

-- Same as migration-2026-10-26-pos-frontend.sql except who passes: a manager of both the
-- table's old and new outlet.
create or replace function dining_tables_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if (new.qr_token, new.branch_id, new.is_active, new.sort_order, new.area)
     is distinct from (old.qr_token, old.branch_id, old.is_active, old.sort_order, old.area)
     and not (pos_manages_outlet(old.branch_id) and pos_manages_outlet(new.branch_id)) then   -- O7
    raise exception 'Only a manager can change this table''s QR code, branch or status';
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
select 'pos outlets applied' as result;
```


- [ ] **Step 4: Write the self-check**

Create `supabase/migration-2026-10-29-pos-outlets-verify.sql`:

```sql
-- Self-check for POS outlets. Run on craft-os-dev after migration-2026-10-29-pos-outlets.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK". Sections follow the
-- migration: A schema, grants and search_path; O3 the capabilities; O1 outlets and their
-- guard; O4 open outlets, scope and who may work where; O2 extra outlets; O5 approvers and
-- PINs; O6 bill numbers; O7 POS settings on a chosen outlet.
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- act(staff id): the next calls run as this signed-in staff member
create function pg_temp.act(p_staff uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_staff, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_mgr   uuid := 'eeeeeeee-0000-0000-0000-000000000071';   -- manager of VERIFY O A
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-000000000072';   -- cashier of VERIFY O A
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-000000000073';   -- supervisor of VERIFY O B
  v_hr    uuid := 'eeeeeeee-0000-0000-0000-000000000074';   -- hr, home VERIFY O A
  v_a uuid; v_b uuid; v_pop uuid; v_kiosk uuid; v_id uuid;
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_cat uuid;
  n integer; r record; v_text text;
begin
  -- ── A. schema, grants, search_path ────────────────────────────────────────
  for r in select c from unnest(array['kind', 'opens_on', 'closes_on', 'bill_prefix']) as c loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'branches'
                    and column_name = r.c) then
      raise exception 'FAIL O1 schema: branches.% is missing', r.c;
    end if;
  end loop;
  for r in select c from unnest(array['branches_kind_check', 'branches_outlet_dates_check', 'branches_bill_prefix_check']) as c loop
    if not exists (select 1 from pg_constraint where conname = r.c) then raise exception 'FAIL O1 schema: % is missing', r.c; end if;
  end loop;
  if not exists (select 1 from pg_indexes where indexname = 'branches_bill_prefix_key') then
    raise exception 'FAIL O1 schema: bill prefixes are not unique';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.staff_outlets'::regclass) then
    raise exception 'FAIL O2: staff_outlets has no RLS';
  end if;
  if has_table_privilege('anon', 'staff_outlets', 'select') or has_table_privilege('authenticated', 'staff_outlets', 'insert')
     or has_table_privilege('authenticated', 'staff_outlets', 'delete') or not has_table_privilege('authenticated', 'staff_outlets', 'select') then
    raise exception 'FAIL O2: staff_outlets privileges (staff read only, writes through set_staff_outlet)';
  end if;
  for r in select f from unnest(array['my_outlets()', 'save_outlet(uuid,text,text,date,date,text)', 'set_staff_outlet(uuid,uuid,boolean)',
                                      'pos_manages_outlet(uuid)', 'pos_outlet_approvers(uuid)', 'pos_approvers()', 'clear_pos_pin(uuid)',
                                      'save_receipt_settings(uuid,jsonb)', 'save_shift_settings(uuid,integer)',
                                      'save_branch_catalogs(uuid,jsonb)', 'insert_test_print(text,uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array['staff_outlet_scope(uuid)', 'pos_staff_may_work(uuid,uuid)', 'pos_outlet_open(uuid)',
                                      'pos_next_bill_no(uuid)', 'pos_check_approver(uuid,uuid,text)', 'staff_has_cap(uuid,text)']) as f loop
    if has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL grants: % is internal but callable', r.f;
    end if;
  end loop;
  for r in select f from unnest(array['save_receipt_settings(jsonb)', 'save_shift_settings(integer)', 'save_branch_catalogs(jsonb)',
                                      'insert_test_print(text)']) as f loop
    if to_regprocedure(r.f) is not null then raise exception 'FAIL O7: the old % is still there', r.f; end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public'
              and p.proname = any (array['has_menu_cap', 'staff_has_cap', 'branches_outlet_guard', 'pos_outlet_open',
                                         'staff_outlet_scope', 'pos_staff_may_work', 'pos_manages_outlet', 'my_outlets',
                                         'save_outlet', 'set_staff_outlet', 'pos_approvers', 'pos_outlet_approvers',
                                         'pos_check_approver', 'clear_pos_pin', 'pos_next_bill_no', 'save_receipt_settings',
                                         'save_shift_settings', 'save_branch_catalogs', 'insert_test_print', 'dining_tables_guard'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  for r in select t from unnest(array['print_routes', 'branch_catalogs', 'service_charge_rules', 'payment_methods', 'reason_templates']) as t loop
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = r.t || '_manage' and cmd = 'ALL'
                    and qual like '%pos_manages_outlet(branch_id)%' and with_check like '%pos_manages_outlet(branch_id)%') then
      raise exception 'FAIL O7 rls: %_manage is not limited to the caller''s outlets', r.t;
    end if;
  end loop;
  if pg_get_functiondef('dining_tables_guard()'::regprocedure) not like '%pos_manages_outlet(old.branch_id)%' then
    raise exception 'FAIL O7: dining_tables_guard does not check the outlet — re-run migration-2026-10-29-pos-outlets.sql';
  end if;

  -- ── B. fixture: outlets A, B, a pop-up and a kiosk; a manager, a cashier, a supervisor, hr ──
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;                                                                         -- code defaults
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';
  insert into branches(name, address) values ('VERIFY O A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY O B', 'b') returning id into v_b;
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_mgr), (v_cash), (v_sup), (v_hr);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_mgr,  'Verify O Manager',    'trainee', true, current_date, 'staff', v_a),
    (v_cash, 'Verify O Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify O Supervisor', 'trainee', true, current_date, 'staff', v_b),
    (v_hr,   'Verify O HR',         'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'manager' where id = v_mgr;
  update staff set system_role = 'supervisor' where id = v_sup;
  update staff set system_role = 'hr' where id = v_hr;

  -- ── O3. capabilities ──────────────────────────────────────────────────────
  if not staff_has_cap(v_cash, 'pos_login') or not staff_has_cap(v_sup, 'pos_login') or not staff_has_cap(v_mgr, 'pos_login')
     or staff_has_cap(v_hr, 'pos_login') then
    raise exception 'FAIL O3: pos_login defaults (every role but hr)';
  end if;
  if not staff_has_cap(v_owner, 'all_branches') or not staff_has_cap(v_hr, 'all_branches') or staff_has_cap(v_cash, 'all_branches')
     or staff_has_cap(v_sup, 'all_branches') or staff_has_cap(v_mgr, 'all_branches') then
    raise exception 'FAIL O3: all_branches (owner and hr by default; managers switched off for this run)';
  end if;
  update system_role_permissions set permissions = permissions || '{"pos_login": false}' where system_role = 'staff';
  if staff_has_cap(v_cash, 'pos_login') then raise exception 'FAIL O3: the Owner''s setting does not win'; end if;
  update system_role_permissions set permissions = permissions - 'pos_login' where system_role = 'staff';

  -- ── O1. outlets: HQ only, validated, prefixes unique ──────────────────────
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O POP', 'popup', current_date, current_date, null)$q$,
                               'Only HQ can add or change outlets', 'O1 a branch manager');
  perform pg_temp.expect_error(format('update branches set kind = %L where id = %L', 'kiosk', v_a),
                               'Only HQ can change an outlet''s kind, dates or bill prefix', 'O1 direct write by a branch manager');
  perform pg_temp.act(v_owner);
  perform pg_temp.expect_error($q$select save_outlet(null, '  ', 'branch', null, null, null)$q$, 'Enter the outlet name', 'O1 no name');
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'stall', null, null, null)$q$,
                               'Choose Branch, Kiosk or Pop-up', 'O1 bad kind');
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'popup', current_date, null, null)$q$,
                               'A pop-up needs its first and last day', 'O1 pop-up without its last day');
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'popup', current_date, current_date - 1, null)$q$,
                               'The last day is before the first day', 'O1 pop-up dates reversed');
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'kiosk', null, null, 'TOOLONG')$q$,
                               'The bill prefix is 1 to 4 letters or digits', 'O1 long prefix');
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'kiosk', null, null, 'P-1')$q$,
                               'The bill prefix is 1 to 4 letters or digits', 'O1 prefix with a dash');
  perform pg_temp.expect_error($q$select save_outlet(null, 'verify o a', 'branch', null, null, null)$q$,
                               'An outlet named verify o a already exists', 'O1 duplicate name');
  v_pop := save_outlet(null, ' VERIFY O POP ', 'popup', v_today - 1, v_today + 1, ' zq8 ');
  if (select name || '|' || kind || '|' || opens_on || '|' || closes_on || '|' || bill_prefix || '|' || is_active from branches where id = v_pop)
       is distinct from format('VERIFY O POP|popup|%s|%s|ZQ8|true', v_today - 1, v_today + 1) then
    raise exception 'FAIL O1 pop-up saved: %', (select row_to_json(b) from branches b where id = v_pop);
  end if;
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'kiosk', null, null, 'ZQ8')$q$,
                               'The bill prefix ZQ8 is used by VERIFY O POP', 'O1 duplicate prefix');
  v_kiosk := save_outlet(null, 'VERIFY O KIOSK', 'kiosk', v_today, v_today, null);      -- a kiosk keeps no dates
  if (select opens_on is null and closes_on is null and kind = 'kiosk' from branches where id = v_kiosk) is not true then
    raise exception 'FAIL O1: a kiosk kept dates';
  end if;
  v_id := save_outlet(v_kiosk, 'VERIFY O KIOSK', 'kiosk', null, null, 'ZQ7');
  if v_id is distinct from v_kiosk or (select bill_prefix from branches where id = v_kiosk) is distinct from 'ZQ7' then
    raise exception 'FAIL O1: editing an outlet';
  end if;
  perform pg_temp.expect_error(format('select save_outlet(%L, %L, %L, null, null, null)', gen_random_uuid(), 'VERIFY O Y', 'branch'),
                               'Outlet not found', 'O1 unknown outlet');
  begin
    update branches set kind = 'popup' where id = v_b;                                -- HQ, but a pop-up needs dates
    raise exception 'FAIL O1: a pop-up without dates was accepted';
  exception when check_violation then null;
  end;

  -- ── O4. open for POS ──────────────────────────────────────────────────────
  if not pos_outlet_open(v_a) or not pos_outlet_open(v_pop) or not pos_outlet_open(v_kiosk) then
    raise exception 'FAIL O4: an open outlet reads closed';
  end if;
  update branches set opens_on = v_today - 10, closes_on = v_today - 1 where id = v_pop;
  if pos_outlet_open(v_pop) then raise exception 'FAIL O4: a pop-up after its last day is open'; end if;
  update branches set opens_on = v_today + 1, closes_on = v_today + 2 where id = v_pop;
  if pos_outlet_open(v_pop) then raise exception 'FAIL O4: a pop-up before its first day is open'; end if;
  update branches set opens_on = v_today, closes_on = v_today where id = v_pop;
  if not pos_outlet_open(v_pop) then raise exception 'FAIL O4: a one-day pop-up on its day is closed'; end if;
  update branches set is_active = false where id = v_kiosk;
  if pos_outlet_open(v_kiosk) then raise exception 'FAIL O4: an inactive outlet is open'; end if;
  update branches set is_active = true where id = v_kiosk;
  if pos_outlet_open(gen_random_uuid()) then raise exception 'FAIL O4: an unknown outlet is open'; end if;

  -- ── O4 / O2. scope and who may work where ─────────────────────────────────
  if not pos_staff_may_work(v_cash, v_a) or pos_staff_may_work(v_cash, v_b) or pos_staff_may_work(v_cash, v_pop) then
    raise exception 'FAIL O4: a cashier works at the home branch only';
  end if;
  if not pos_staff_may_work(v_owner, v_b) or not pos_staff_may_work(v_owner, v_pop) then
    raise exception 'FAIL O4: all_branches works everywhere';
  end if;
  if pos_staff_may_work(v_hr, v_a) then raise exception 'FAIL O4: no pos_login, still works'; end if;
  if pos_staff_may_work(v_cash, null) then raise exception 'FAIL O4: works at no outlet'; end if;
  perform pg_temp.act(v_cash);
  perform pg_temp.expect_error(format('select set_staff_outlet(%L, %L, true)', v_cash, v_b),
                               'Only a manager can change where staff may work', 'O2 a cashier');
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error(format('select set_staff_outlet(%L, %L, true)', v_cash, v_b),
                               'This outlet is not one of yours', 'O2 an outlet outside the manager''s scope');
  perform pg_temp.expect_error(format('select set_staff_outlet(%L, %L, true)', v_cash, v_a),
                               'This is their home branch already', 'O2 the home branch');
  perform pg_temp.expect_error(format('select set_staff_outlet(%L, %L, true)', gen_random_uuid(), v_a),
                               'Staff member not found', 'O2 unknown staff');
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_cash, v_b, true);
  perform set_staff_outlet(v_cash, v_b, true);                                          -- twice is fine
  if (select count(*) from staff_outlets where staff_id = v_cash and branch_id = v_b and added_by = v_owner) <> 1 then
    raise exception 'FAIL O2: the extra outlet was not recorded once, by its adder';
  end if;
  if not pos_staff_may_work(v_cash, v_b) then raise exception 'FAIL O2: an extra outlet does not count'; end if;
  perform set_staff_outlet(v_mgr, v_b, true);                                           -- the manager's own extra outlet
  perform pg_temp.act(v_mgr);
  select string_agg(name || ':' || is_home || ':' || open_now, ',' order by is_home desc, name) into v_text from my_outlets();
  if v_text is distinct from 'VERIFY O A:true:true,VERIFY O B:false:true' then
    raise exception 'FAIL O4 my_outlets of a manager: %', v_text;
  end if;
  set local role authenticated;
  select count(*) into n from staff_outlets where staff_id in (v_cash, v_mgr);
  reset role;
  if n <> 2 then raise exception 'FAIL O2: staff cannot read staff_outlets (% rows)', n; end if;
  perform set_staff_outlet(v_cash, v_b, false);                                         -- the manager now holds B
  if pos_staff_may_work(v_cash, v_b) then raise exception 'FAIL O2: removing an extra outlet'; end if;
  perform pg_temp.act(v_owner);
  select count(*) into n from my_outlets() where id in (v_a, v_b, v_pop, v_kiosk);
  if n <> 4 then raise exception 'FAIL O4: my_outlets of HQ lists % of the 4 test outlets', n; end if;
  update staff set status = 'resigned' where id = v_mgr;
  if pos_staff_may_work(v_mgr, v_a) or pos_staff_may_work(v_mgr, v_b) then raise exception 'FAIL O4: a resigned manager still works'; end if;
  update staff set status = 'active' where id = v_mgr;

  -- ── O5. approvers and PINs ────────────────────────────────────────────────
  perform pg_temp.act(v_sup);
  if not (set_my_pos_pin('2468', null)->>'ok')::boolean then raise exception 'FAIL O5 fixture: PIN not set'; end if;
  perform pg_temp.expect_error(format('select pos_check_approver(%L, %L, %L)', v_a, v_sup, '2468'),
                               'The approver cannot work at this outlet', 'O5 a supervisor of another outlet');
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_sup, v_a, true);
  if pos_check_approver(v_a, v_sup, '2468') is not null then raise exception 'FAIL O5: an approver from an extra outlet'; end if;
  perform pg_temp.expect_error(format('select pos_check_approver(%L, %L, %L)', v_a, v_cash, '0000'),
                               'This person cannot approve voids or refunds', 'O5 a cashier as approver');
  perform pg_temp.act(v_cash);
  if not exists (select 1 from pos_approvers() where staff_id = v_sup and has_pin) then
    raise exception 'FAIL O5: pos_approvers misses an approver from an extra outlet';
  end if;
  if exists (select 1 from pos_approvers() where staff_id = v_cash) then raise exception 'FAIL O5: a cashier listed as approver'; end if;
  perform pg_temp.expect_error(format('select count(*) from pos_outlet_approvers(%L)', v_a),
                               'This outlet is not one of yours', 'O5 approvers list for a cashier');
  perform pg_temp.act(v_mgr);
  if not exists (select 1 from pos_outlet_approvers(v_a) where staff_id = v_sup) then
    raise exception 'FAIL O5: pos_outlet_approvers misses the extra-outlet approver';
  end if;
  perform pg_temp.expect_error(format('select count(*) from pos_outlet_approvers(%L)', v_pop),
                               'This outlet is not one of yours', 'O5 approvers list outside the scope');
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_mgr, v_b, false);
  perform set_staff_outlet(v_sup, v_a, false);
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error(format('select clear_pos_pin(%L)', v_sup),
                               'This person does not work at your outlets', 'O5 clear a PIN outside the scope');
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_sup, v_a, true);
  perform pg_temp.act(v_mgr);
  perform clear_pos_pin(v_sup);
  if exists (select 1 from staff_pos_pins where staff_id = v_sup) then raise exception 'FAIL O5: the PIN was not cleared'; end if;

  -- ── O6. bill numbers ──────────────────────────────────────────────────────
  if pos_next_bill_no(v_pop) !~ '^ZQ8-\d{6}-001$' or pos_next_bill_no(v_pop) !~ '^ZQ8-\d{6}-002$' then
    raise exception 'FAIL O6: a prefixed bill number';
  end if;
  if pos_next_bill_no(v_b) !~ '^\d{6}-001$' then raise exception 'FAIL O6: a bill number without a prefix'; end if;
  if pos_next_bill_no(v_pop) <> 'ZQ8-' || to_char(v_today, 'YYMMDD') || '-003' then
    raise exception 'FAIL O6: the prefix, the Malaysia day and the running number';
  end if;

  -- ── O7. POS settings on a chosen outlet ───────────────────────────────────
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100'),
                                                                  (v_b, 'Bar', 'agent', '127.0.0.1:9101');
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L::jsonb)', v_b, '{"receiptTitle": "Nope"}'),
                               'This outlet is not one of yours', 'O7 receipt settings of another outlet');
  perform pg_temp.expect_error(format('select save_shift_settings(%L, 100)', v_b),
                               'This outlet is not one of yours', 'O7 shift settings of another outlet');
  perform pg_temp.expect_error(format('select save_branch_catalogs(%L, %L::jsonb)', v_b, '{}'),
                               'This outlet is not one of yours', 'O7 catalogs of another outlet');
  perform pg_temp.expect_error(format('select insert_test_print(%L, %L)', 'Bar', v_b),
                               'This outlet is not one of yours', 'O7 a test print at another outlet');
  perform save_shift_settings(v_a, 700);
  if (select cash_variance_limit_sen from branch_pos_settings where branch_id = v_a) is distinct from 700 then
    raise exception 'FAIL O7: shift settings of the home branch';
  end if;
  v_id := insert_test_print('Bar', v_a);
  if (select branch_id from print_jobs where id = v_id) is distinct from v_a then raise exception 'FAIL O7: a test print at the chosen outlet'; end if;
  perform pg_temp.act(v_cash);
  v_id := insert_test_print('Bar');                                                     -- the POS: the home branch
  if (select branch_id from print_jobs where id = v_id) is distinct from v_a then raise exception 'FAIL O7: the POS test print'; end if;
  perform pg_temp.expect_error(format('select insert_test_print(%L, %L)', 'Bar', v_a),
                               'This outlet is not one of yours', 'O7 a cashier''s test print for the back office');
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_mgr, v_b, true);                                           -- an extra outlet gives its back office
  perform pg_temp.act(v_mgr);
  perform save_shift_settings(v_b, 900);
  if (select cash_variance_limit_sen from branch_pos_settings where branch_id = v_b) is distinct from 900 then
    raise exception 'FAIL O7: shift settings of an extra outlet';
  end if;
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_mgr, v_b, false);
  -- the write policies, as a signed-in client
  perform pg_temp.act(v_mgr);
  set local role authenticated;
  begin
    insert into print_routes(branch_id, name, kind, address) values (v_b, 'Kitchen', 'agent', '127.0.0.1:9102');
    raise exception 'FAIL O7 rls: a printer added at another outlet';
  exception when insufficient_privilege then null;
  end;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Kitchen', 'agent', '127.0.0.1:9103');
  update print_routes set address = '127.0.0.1:9199' where branch_id = v_b and name = 'Bar';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL O7 rls: a printer changed at another outlet'; end if;
  begin
    insert into dining_tables(branch_id, label) values (v_b, 'OB1');
    raise exception 'FAIL O7 rls: a table added at another outlet';
  exception when insufficient_privilege then null;
  end;
  insert into dining_tables(branch_id, label) values (v_a, 'OA1');
  reset role;
  perform pg_temp.act(v_owner);
  insert into dining_tables(branch_id, label) values (v_b, 'OB1');
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error(format('update dining_tables set sort_order = 5 where branch_id = %L and label = %L', v_b, 'OB1'),
                               'Only a manager can change this table''s QR code, branch or status', 'O7 a table of another outlet');
  update dining_tables set sort_order = 5 where branch_id = v_a and label = 'OA1';
  perform pg_temp.expect_error(format('update dining_tables set branch_id = %L where branch_id = %L and label = %L', v_b, v_a, 'OA1'),
                               'Only a manager can change this table''s QR code, branch or status', 'O7 moving a table to another outlet');

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```


- [ ] **Step 5: Bring the three regression scripts up to date**

The new signatures, policies and approver message break three older verify scripts. Their fixtures also make managers branch-only (`all_branches: false`), because their "manager of another branch" checks assume that. Every old text below occurs exactly once (the last catalogs replacement occurs five times: replace all of them).

**`supabase/migration-2026-10-24-pos-checkout-verify.sql`:**

Replacement 1 in `supabase/migration-2026-10-24-pos-checkout-verify.sql` — replace:

```sql
  update system_role_permissions set permissions = permissions - 'pos_supervise';   -- code defaults for this run
```

with:

```sql
  update system_role_permissions set permissions = permissions - 'pos_supervise';   -- code defaults for this run
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';   -- managers: own branch only
```

Replacement 2 in `supabase/migration-2026-10-24-pos-checkout-verify.sql` — replace:

```sql
                    and qual like '%pos_caller_branch()%' and qual like '%has_menu_cap%'
                    and with_check like '%pos_caller_branch()%' and with_check like '%has_menu_cap%') then
```

with:

```sql
                    and qual like '%pos_manages_outlet(branch_id)%'
                    and with_check like '%pos_manages_outlet(branch_id)%') then
```

Replacement 3 in `supabase/migration-2026-10-24-pos-checkout-verify.sql` — replace:

```sql
'save_receipt_settings(jsonb)', 'pos_approvers()'
```

with:

```sql
'save_receipt_settings(uuid,jsonb)', 'pos_approvers()'
```

Replacement 4 in `supabase/migration-2026-10-24-pos-checkout-verify.sql` — replace:

```sql
  begin perform void_order_item(v_item, 'Wrong item keyed', v_far, '9999'); raise exception 'FAIL: other branch approved';
  exception when raise_exception then if sqlerrm <> 'The approver is not active staff of this branch' then raise; end if; end;
```

with:

```sql
  begin perform void_order_item(v_item, 'Wrong item keyed', v_far, '9999'); raise exception 'FAIL: other branch approved';
  exception when raise_exception then if sqlerrm <> 'The approver cannot work at this outlet' then raise; end if; end;
```

Replacement 5 in `supabase/migration-2026-10-24-pos-checkout-verify.sql` — replace:

```sql
  begin perform void_order_item(v_item, 'Wrong item keyed', v_sup, '1234'); raise exception 'FAIL: resigned approver approved';
  exception when raise_exception then if sqlerrm <> 'The approver is not active staff of this branch' then raise; end if; end;
```

with:

```sql
  begin perform void_order_item(v_item, 'Wrong item keyed', v_sup, '1234'); raise exception 'FAIL: resigned approver approved';
  exception when raise_exception then if sqlerrm <> 'The approver cannot work at this outlet' then raise; end if; end;
```

Replacement 6 in `supabase/migration-2026-10-24-pos-checkout-verify.sql` — replace:

```sql
  begin perform save_receipt_settings('{"receiptTitle": "Nope"}'::jsonb); raise exception 'FAIL: cashier saved settings';
```

with:

```sql
  begin perform save_receipt_settings(v_branch, '{"receiptTitle": "Nope"}'::jsonb); raise exception 'FAIL: cashier saved settings';
```

Replacement 7 in `supabase/migration-2026-10-24-pos-checkout-verify.sql` — replace:

```sql
  begin perform clear_pos_pin(v_far); raise exception 'FAIL: cleared a PIN of another branch';
  exception when raise_exception then if sqlerrm <> 'This person is not staff of your branch' then raise; end if; end;
```

with:

```sql
  -- clear_pos_pin's outlet scope (the owner holds all_branches) is checked in migration-2026-10-29-pos-outlets-verify.sql
```

Replacement 8 in `supabase/migration-2026-10-24-pos-checkout-verify.sql` — replace:

```sql
  begin perform save_receipt_settings('{"receiptTitle": "Verify Cafe", "receiptRoute": "Nowhere"}'::jsonb); raise exception 'FAIL: unknown route';
```

with:

```sql
  begin perform save_receipt_settings(v_branch, '{"receiptTitle": "Verify Cafe", "receiptRoute": "Nowhere"}'::jsonb); raise exception 'FAIL: unknown route';
```

Replacement 9 in `supabase/migration-2026-10-24-pos-checkout-verify.sql` — replace:

```sql
  perform save_receipt_settings('{"receiptTitle": " Verify Cafe 2 ",
```

with:

```sql
  perform save_receipt_settings(v_branch, '{"receiptTitle": " Verify Cafe 2 ",
```


**`supabase/migration-2026-10-24-pos-catalogs-verify.sql`** (in Replacement 4, replace **all five** occurrences of the old text):

Replacement 1 in `supabase/migration-2026-10-24-pos-catalogs-verify.sql` — replace:

```sql
  update system_role_permissions set permissions = permissions - 'manage_menu';   -- code defaults for this run
```

with:

```sql
  update system_role_permissions set permissions = permissions - 'manage_menu';   -- code defaults for this run
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';   -- managers: own branch only
```

Replacement 2 in `supabase/migration-2026-10-24-pos-catalogs-verify.sql` — replace:

```sql
                  and qual like '%pos_caller_branch()%' and qual like '%access_settings%'
                  and with_check like '%pos_caller_branch()%' and with_check like '%access_settings%') then
```

with:

```sql
                  and qual like '%pos_manages_outlet(branch_id)%'
                  and with_check like '%pos_manages_outlet(branch_id)%') then
```

Replacement 3 in `supabase/migration-2026-10-24-pos-catalogs-verify.sql` — replace:

```sql
'save_branch_catalogs(jsonb)',
```

with:

```sql
'save_branch_catalogs(uuid,jsonb)',
```

Replacement 4 in `supabase/migration-2026-10-24-pos-catalogs-verify.sql` — replace:

```sql
perform save_branch_catalogs(jsonb_build_object(
```

with:

```sql
perform save_branch_catalogs(v_branch, jsonb_build_object(
```


**`supabase/migration-2026-10-24-pos-shifts-verify.sql`:**

Replacement 1 in `supabase/migration-2026-10-24-pos-shifts-verify.sql` — replace:

```sql
'save_shift_settings(integer)'
```

with:

```sql
'save_shift_settings(uuid,integer)'
```

Replacement 2 in `supabase/migration-2026-10-24-pos-shifts-verify.sql` — replace:

```sql
  perform pg_temp.expect_error('select save_shift_settings(800)', 'Only a manager can change the shift settings', 'F settings by the cashier');
```

with:

```sql
  perform pg_temp.expect_error(format('select save_shift_settings(%L, 800)', v_branch), 'Only a manager can change the shift settings', 'F settings by the cashier');
```

Replacement 3 in `supabase/migration-2026-10-24-pos-shifts-verify.sql` — replace:

```sql
  perform pg_temp.expect_error('select save_shift_settings(-1)', 'Enter a cash variance limit between RM 0.00 and RM 10000.00', 'F bad limit');
  perform save_shift_settings(500);
```

with:

```sql
  perform pg_temp.expect_error(format('select save_shift_settings(%L, -1)', v_branch), 'Enter a cash variance limit between RM 0.00 and RM 10000.00', 'F bad limit');
  perform save_shift_settings(v_branch, 500);
```


- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts && npx vitest run && npx tsc -b`
Expected:
- the safe-update file passes;
- the full suite reports 128 files / 1046 tests passed;
- tsc prints nothing.

Then commit:

```bash
git add supabase/migration-2026-10-29-pos-outlets.sql supabase/migration-2026-10-29-pos-outlets-verify.sql \
  supabase/migration-2026-10-24-pos-checkout-verify.sql supabase/migration-2026-10-24-pos-catalogs-verify.sql \
  supabase/migration-2026-10-24-pos-shifts-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "feat(pos): outlets — kinds, pop-up days, bill prefix, extra outlets, pos_login, settings per outlet (SQL)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Apply on dev and verify (controller; the implementer does not touch the database)**

In the dev SQL editor, in this order:
1. `migration-2026-10-29-pos-outlets.sql` → `pos outlets applied`.
2. `migration-2026-10-29-pos-outlets-verify.sql` → `VERIFY OK`.
3. `migration-2026-10-24-pos-checkout-verify.sql`, `-catalogs-verify.sql`, `-shifts-verify.sql`, `migration-2026-10-26-pos-frontend-verify.sql` and `migration-2026-10-25-pos-hardening-verify.sql` → each `VERIFY OK`.

Each verify rolls back. If one fails, stop and report the message; do not edit dev data by hand.

---

### Task 2: The "Sign in to the POS" capability (implementer)

**Model tier:** cheap.

**Files:**
- Modify: `src/shared/types/index.ts`, `src/shared/types/capabilities.test.ts`

**Interfaces:**
- Produces: `Capability` gains `'pos_login'`. `CAPABILITIES` gains `{ key: 'pos_login', label: 'Sign in to the POS' }`, so the System Roles matrix shows it with no other change. `DEFAULT_SYSTEM_ROLE_CAPS[role].pos_login` is true for every role but hr.

- [ ] **Step 1: Write the failing tests**

Replacement 1 in `src/shared/types/capabilities.test.ts` — replace:

```ts
  it('manage_menu defaults match has_menu_cap / staff_has_cap in SQL: owner and admin only', () => {
```

with:

```ts
  it('pos_login is in the System Roles matrix as "Sign in to the POS"', () => {
    expect(CAPABILITIES.find((c) => c.key === 'pos_login')?.label).toBe('Sign in to the POS')
  })

  it('pos_login defaults match has_menu_cap / staff_has_cap in SQL: every role but hr', () => {
    expect(Object.fromEntries(SYSTEM_ROLES.map((r) => [r, DEFAULT_SYSTEM_ROLE_CAPS[r].pos_login]))).toEqual({
      owner: true, admin: true, hr: false, manager: true, supervisor: true, staff: true,
    })
  })

  it('all_branches defaults match has_menu_cap / staff_has_cap in SQL: owner, admin, hr and manager', () => {
    expect(Object.fromEntries(SYSTEM_ROLES.map((r) => [r, DEFAULT_SYSTEM_ROLE_CAPS[r].all_branches]))).toEqual({
      owner: true, admin: true, hr: true, manager: true, supervisor: false, staff: false,
    })
  })

  it('manage_menu defaults match has_menu_cap / staff_has_cap in SQL: owner and admin only', () => {
```


- [ ] **Step 2: Run them**

Run: `npx vitest run src/shared/types/capabilities.test.ts`
Expected: FAIL. The two `pos_login` tests fail (label undefined, defaults undefined); the `all_branches` test passes, since it pins defaults that already exist.

- [ ] **Step 3: Add the capability**

Replacement 1 in `src/shared/types/index.ts` — replace:

```ts
  | 'manage_menu'      // edit the company-wide menu and its catalogs (SQL: has_menu_cap / staff_has_cap)
```

with:

```ts
  | 'manage_menu'      // edit the company-wide menu and its catalogs (SQL: has_menu_cap / staff_has_cap)
  | 'pos_login'        // sign in to the POS with a PIN where one may work (SQL: has_menu_cap / staff_has_cap)
```

Replacement 2 in `src/shared/types/index.ts` — replace:

```ts
  { key: 'manage_menu',         label: 'Edit menu' },
```

with:

```ts
  { key: 'manage_menu',         label: 'Edit menu' },
  { key: 'pos_login',           label: 'Sign in to the POS' },
```

Replacement 3 in `src/shared/types/index.ts` — replace:

```ts
    manage_menu: true,
  },
  admin: {
```

with:

```ts
    manage_menu: true,
    pos_login: true,
  },
  admin: {
```

Replacement 4 in `src/shared/types/index.ts` — replace:

```ts
    manage_menu: true,
  },
  hr: {
```

with:

```ts
    manage_menu: true,
    pos_login: true,
  },
  hr: {
```

Replacement 5 in `src/shared/types/index.ts` — replace:

```ts
    manage_menu: false,
  },
  manager: {
```

with:

```ts
    manage_menu: false,
    pos_login: false,
  },
  manager: {
```

Replacement 6 in `src/shared/types/index.ts` — replace:

```ts
    manage_menu: false,
  },
  supervisor: {
```

with:

```ts
    manage_menu: false,
    pos_login: true,
  },
  supervisor: {
```

Replacement 7 in `src/shared/types/index.ts` — replace:

```ts
    manage_menu: false,
  },
  staff: {
```

with:

```ts
    manage_menu: false,
    pos_login: true,
  },
  staff: {
```

Replacement 8 in `src/shared/types/index.ts` — replace:

```ts
    manage_menu: false,
  },
}
```

with:

```ts
    manage_menu: false,
    pos_login: true,
  },
}
```


- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/shared/types/capabilities.test.ts && npx vitest run && npx tsc -b`
Expected: PASS. The suite reports 128 files / 1049 tests; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/index.ts src/shared/types/capabilities.test.ts
git commit -m "feat(roles): Sign in to the POS (pos_login), on for every role but HR

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Outlet rules and API (implementer)

**Model tier:** cheap.

**Files:**
- Create: `src/features/pos/outlets/outlet.ts`, `src/features/pos/outlets/outlet.test.ts`, `src/features/pos/outlets/outletsApi.ts`

**Interfaces:**
- Consumes: the Task 1 RPCs; `Approver` from `src/features/pos/checkout/checkoutApi.ts` (`{ staffId: string; name: string; hasPin: boolean }`).
- Produces:
  - Types: `OutletKind`, `OUTLET_KINDS`, `Outlet`, `OutletDraft`, `OutletInput`.
  - Functions: `draftFromOutlet(o)`, `parseOutletDraft(d)`, `mytDay(now)`, `billNoExample(prefix, now)`, `shortDay(iso)`, `outletNote(o, today)`, `outletDates(o)`, `pickOutlet(outlets, wanted)`.
  - API: `fetchMyOutlets()`, `saveOutlet(input)`, `fetchStaffOutlets(staffId)`, `setStaffOutlet(staffId, branchId, on)`, `fetchOutletApprovers(branchId)`.
  - Sub-plan B's lock screen uses `outletNote` and `shortDay` for "This outlet closed on 30 Nov."

- [ ] **Step 1: Write the failing test**

Create `src/features/pos/outlets/outlet.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  billNoExample, draftFromOutlet, mytDay, outletDates, outletNote, parseOutletDraft, pickOutlet, shortDay,
  type Outlet, type OutletDraft,
} from './outlet'

const draft = (over: Partial<OutletDraft> = {}): OutletDraft => ({ ...draftFromOutlet(null), name: 'Mid Valley', ...over })
const outlet = (over: Partial<Outlet> = {}): Outlet => ({
  id: 'o1', name: 'Cheras', kind: 'branch', opensOn: null, closesOn: null, billPrefix: null,
  isActive: true, isHome: false, openNow: true, ...over,
})

describe('parseOutletDraft', () => {
  it('trims the name and upper-cases the prefix', () => {
    expect(parseOutletDraft(draft({ name: '  Mid Valley ', billPrefix: ' mv ' }))).toEqual({
      ok: true, value: { id: null, name: 'Mid Valley', kind: 'branch', opensOn: null, closesOn: null, billPrefix: 'MV' },
    })
  })
  it('an empty prefix is none', () => {
    expect(parseOutletDraft(draft({ billPrefix: '  ' }))).toMatchObject({ ok: true, value: { billPrefix: null } })
  })
  it("refuses with save_outlet's words", () => {
    expect(parseOutletDraft(draft({ name: ' ' }))).toEqual({ ok: false, problem: 'Enter the outlet name' })
    expect(parseOutletDraft(draft({ name: 'x'.repeat(61) }))).toEqual({ ok: false, problem: 'The outlet name is longer than 60 characters' })
    expect(parseOutletDraft(draft({ billPrefix: 'ABCDE' }))).toEqual({ ok: false, problem: 'The bill prefix is 1 to 4 letters or digits' })
    expect(parseOutletDraft(draft({ billPrefix: 'P-1' }))).toEqual({ ok: false, problem: 'The bill prefix is 1 to 4 letters or digits' })
  })
  it('a pop-up needs both days, in order', () => {
    expect(parseOutletDraft(draft({ kind: 'popup', opensOn: '2026-12-01' }))).toEqual({ ok: false, problem: 'A pop-up needs its first and last day' })
    expect(parseOutletDraft(draft({ kind: 'popup', opensOn: '2026-12-02', closesOn: '2026-12-01' })))
      .toEqual({ ok: false, problem: 'The last day is before the first day' })
    expect(parseOutletDraft(draft({ kind: 'popup', opensOn: '2026-12-01', closesOn: '2026-12-01' })))
      .toMatchObject({ ok: true, value: { opensOn: '2026-12-01', closesOn: '2026-12-01' } })
  })
  it('a branch or kiosk keeps no dates', () => {
    expect(parseOutletDraft(draft({ kind: 'kiosk', opensOn: '2026-12-01', closesOn: '2026-11-01' })))
      .toMatchObject({ ok: true, value: { kind: 'kiosk', opensOn: null, closesOn: null } })
  })
})

describe('dates', () => {
  it('mytDay is the Malaysia day (UTC+8)', () => {
    expect(mytDay(new Date('2026-10-28T15:59:59Z'))).toBe('2026-10-28')
    expect(mytDay(new Date('2026-10-28T16:00:00Z'))).toBe('2026-10-29')
  })
  it('billNoExample matches pos_next_bill_no', () => {
    expect(billNoExample('PJ', new Date('2026-10-28T16:30:00Z'))).toBe('PJ-261029-001')
    expect(billNoExample(null, new Date('2026-10-28T16:30:00Z'))).toBe('261029-001')
  })
  it('shortDay and outletDates', () => {
    expect(shortDay('2026-11-30')).toBe('30 Nov')
    expect(outletDates(outlet({ kind: 'popup', opensOn: '2026-12-01', closesOn: '2026-12-31' }))).toBe('1 Dec – 31 Dec')
    expect(outletDates(outlet())).toBe('')
  })
})

describe('outletNote', () => {
  const pop = outlet({ kind: 'popup', opensOn: '2026-12-01', closesOn: '2026-12-31' })
  it('a pop-up before, during and after its days', () => {
    expect(outletNote(pop, '2026-11-30')).toBe('Opens on 1 Dec')
    expect(outletNote(pop, '2026-12-01')).toBeNull()
    expect(outletNote(pop, '2026-12-31')).toBeNull()
    expect(outletNote(pop, '2027-01-01')).toBe('Closed on 31 Dec')
  })
  it('an inactive outlet; a branch is always open', () => {
    expect(outletNote(outlet({ isActive: false }), '2026-12-01')).toBe('Inactive')
    expect(outletNote(outlet(), '2026-12-01')).toBeNull()
  })
})

describe('pickOutlet', () => {
  const list = [outlet({ id: 'a' }), outlet({ id: 'h', isHome: true }), outlet({ id: 'c' })]
  it('the one asked for, else home, else the first', () => {
    expect(pickOutlet(list, 'c')?.id).toBe('c')
    expect(pickOutlet(list, 'gone')?.id).toBe('h')
    expect(pickOutlet(list, null)?.id).toBe('h')
    expect(pickOutlet([outlet({ id: 'a' })], null)?.id).toBe('a')
    expect(pickOutlet([], 'a')).toBeNull()
  })
})
```


- [ ] **Step 2: Run it**

Run: `npx vitest run src/features/pos/outlets/outlet.test.ts`
Expected: FAIL with "Failed to resolve import "./outlet"".

- [ ] **Step 3: Write the rules**

Create `src/features/pos/outlets/outlet.ts`:

```ts
// Outlets (branches, kiosks, pop-ups): the form rules and the dates shown beside them.
// The server (save_outlet, pos_outlet_open) is the truth; these mirror its words.

export type OutletKind = 'branch' | 'kiosk' | 'popup'

export const OUTLET_KINDS: { kind: OutletKind; label: string }[] = [
  { kind: 'branch', label: 'Branch' },
  { kind: 'kiosk', label: 'Kiosk' },
  { kind: 'popup', label: 'Pop-up' },
]

/** One row of my_outlets(). Dates are 'YYYY-MM-DD' (Malaysia days). */
export interface Outlet {
  id: string
  name: string
  kind: OutletKind
  opensOn: string | null
  closesOn: string | null
  billPrefix: string | null
  isActive: boolean
  isHome: boolean
  openNow: boolean
}

/** The outlet form as typed: empty strings for empty fields. */
export interface OutletDraft {
  id: string | null
  name: string
  kind: OutletKind
  opensOn: string
  closesOn: string
  billPrefix: string
}

/** What save_outlet receives. */
export interface OutletInput {
  id: string | null
  name: string
  kind: OutletKind
  opensOn: string | null
  closesOn: string | null
  billPrefix: string | null
}

export function draftFromOutlet(o: Outlet | null): OutletDraft {
  if (!o) return { id: null, name: '', kind: 'branch', opensOn: '', closesOn: '', billPrefix: '' }
  return { id: o.id, name: o.name, kind: o.kind, opensOn: o.opensOn ?? '', closesOn: o.closesOn ?? '', billPrefix: o.billPrefix ?? '' }
}

/** The form checked with save_outlet's rules and messages. Dates are kept for a pop-up only. */
export function parseOutletDraft(d: OutletDraft): { ok: true; value: OutletInput } | { ok: false; problem: string } {
  const name = d.name.trim()
  if (!name) return { ok: false, problem: 'Enter the outlet name' }
  if (name.length > 60) return { ok: false, problem: 'The outlet name is longer than 60 characters' }
  const popup = d.kind === 'popup'
  const opensOn = popup && d.opensOn ? d.opensOn : null
  const closesOn = popup && d.closesOn ? d.closesOn : null
  if (popup && (!opensOn || !closesOn)) return { ok: false, problem: 'A pop-up needs its first and last day' }
  if (opensOn && closesOn && closesOn < opensOn) return { ok: false, problem: 'The last day is before the first day' }
  const billPrefix = d.billPrefix.trim().toUpperCase() || null
  if (billPrefix && !/^[A-Z0-9]{1,4}$/.test(billPrefix)) return { ok: false, problem: 'The bill prefix is 1 to 4 letters or digits' }
  return { ok: true, value: { id: d.id, name, kind: d.kind, opensOn, closesOn, billPrefix } }
}

const MYT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit' })

/** Today in Malaysia, 'YYYY-MM-DD'. */
export function mytDay(now: Date): string {
  return MYT_DAY.format(now)
}

/** The first bill number of a Malaysia day at an outlet with this prefix: 'PJ-261029-001'. */
export function billNoExample(prefix: string | null, now: Date): string {
  const [y, m, d] = mytDay(now).split('-')
  return `${prefix ? `${prefix}-` : ''}${y.slice(2)}${m}${d}-001`
}

const SHORT_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' })

/** '2026-11-30' → '30 Nov'. */
export function shortDay(iso: string): string {
  return SHORT_DAY.format(new Date(`${iso}T00:00:00Z`))
}

/** Why an outlet is not open for POS today, or null when it is. */
export function outletNote(o: Pick<Outlet, 'kind' | 'opensOn' | 'closesOn' | 'isActive'>, today: string): string | null {
  if (!o.isActive) return 'Inactive'
  if (o.kind !== 'popup' || !o.opensOn || !o.closesOn) return null
  if (today < o.opensOn) return `Opens on ${shortDay(o.opensOn)}`
  if (today > o.closesOn) return `Closed on ${shortDay(o.closesOn)}`
  return null
}

/** '1 Dec – 31 Dec' for a pop-up, '' otherwise. */
export function outletDates(o: Pick<Outlet, 'kind' | 'opensOn' | 'closesOn'>): string {
  return o.kind === 'popup' && o.opensOn && o.closesOn ? `${shortDay(o.opensOn)} – ${shortDay(o.closesOn)}` : ''
}

/** The outlet to show first: the one asked for, else the home branch, else the first. */
export function pickOutlet(outlets: Outlet[], wanted: string | null): Outlet | null {
  return outlets.find((o) => o.id === wanted) ?? outlets.find((o) => o.isHome) ?? outlets[0] ?? null
}
```


- [ ] **Step 4: Write the API calls**

Create `src/features/pos/outlets/outletsApi.ts`:

```ts
import { supabase } from '../../../shared/lib/supabase'
import type { Approver } from '../checkout/checkoutApi'
import type { Outlet, OutletInput, OutletKind } from './outlet'

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

interface OutletRow {
  id: string; name: string; kind: OutletKind; opens_on: string | null; closes_on: string | null
  bill_prefix: string | null; is_active: boolean; is_home: boolean; open_now: boolean
}

/** The caller's outlets (home branch first): my_outlets(). */
export async function fetchMyOutlets(): Promise<Outlet[]> {
  const { data, error } = await supabase.rpc('my_outlets')
  if (error) fail(error)
  return ((data ?? []) as OutletRow[]).map((r) => ({
    id: r.id, name: r.name, kind: r.kind, opensOn: r.opens_on, closesOn: r.closes_on, billPrefix: r.bill_prefix,
    isActive: r.is_active, isHome: r.is_home, openNow: r.open_now,
  }))
}

/** HQ adds (id null) or changes an outlet; returns its id. */
export async function saveOutlet(o: OutletInput): Promise<string> {
  const { data, error } = await supabase.rpc('save_outlet', {
    p_id: o.id, p_name: o.name, p_kind: o.kind, p_opens_on: o.opensOn, p_closes_on: o.closesOn, p_bill_prefix: o.billPrefix,
  })
  if (error) fail(error)
  return data as string
}

/** The extra outlets of a staff member (branch ids). */
export async function fetchStaffOutlets(staffId: string): Promise<string[]> {
  const { data, error } = await supabase.from('staff_outlets').select('branch_id').eq('staff_id', staffId)
  if (error) fail(error)
  return ((data ?? []) as { branch_id: string }[]).map((r) => r.branch_id)
}

export async function setStaffOutlet(staffId: string, branchId: string, on: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_staff_outlet', { p_staff_id: staffId, p_branch_id: branchId, p_on: on })
  if (error) fail(error)
}

/** Who may approve at an outlet the caller manages (POS settings → Approvers). */
export async function fetchOutletApprovers(branchId: string): Promise<Approver[]> {
  const { data, error } = await supabase.rpc('pos_outlet_approvers', { p_branch_id: branchId })
  if (error) fail(error)
  return ((data ?? []) as { staff_id: string; name: string; has_pin: boolean }[]).map((a) => ({ staffId: a.staff_id, name: a.name, hasPin: a.has_pin }))
}
```


- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/features/pos/outlets && npx vitest run && npx tsc -b`
Expected: 11 tests pass in `outlet.test.ts`. The suite reports 129 files / 1060 tests; tsc prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/outlets/outlet.ts src/features/pos/outlets/outlet.test.ts src/features/pos/outlets/outletsApi.ts
git commit -m "feat(pos): outlet form rules, Malaysia days, bill number preview, outlet API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: POS settings on a chosen outlet; the Outlets section (implementer)

**Model tier:** standard (six files change together).

**Files:**
- Create: `src/features/pos/outlets/OutletsSection.tsx`
- Modify: `src/features/pos/order/PosSettingsPage.tsx`, `src/features/pos/order/posApi.ts`, `src/features/pos/order/MenuCatalogsSection.tsx`, `src/features/pos/shift/shiftApi.ts`, `src/features/pos/shift/ShiftSettingsSection.tsx`, `src/features/pos/checkout/checkoutApi.ts`, `src/features/pos/checkout/CheckoutSettings.tsx`

**Interfaces:**
- Consumes: Task 3's `outlet.ts` and `outletsApi.ts`; `useCan()` from `src/shared/lib/permissions.ts` (`can('all_branches')`).
- Produces:
  - `saveBranchCatalogs(branchId, s)`, `saveCashVarianceLimit(branchId, limitSen)`, `saveReceiptDetails(branchId, d)`.
  - `insertTestPrint(route, branchId?)`: the POS's `PrintHostPanel` keeps calling it with the route only.
  - `/pos/settings?outlet=<id>`.

The page has no component test: the pure rules are tested in Task 3, and the controller checks the page in the browser in Task 6.

- [ ] **Step 1: The settings saves take the outlet**

Replacement 1 in `src/features/pos/order/posApi.ts` — replace:

```ts
/** POS settings → Menu catalogs, for the caller's own branch (save_branch_catalogs checks access_settings). */
export async function saveBranchCatalogs(s: BranchCatalogSettings): Promise<void> {
  const { error } = await supabase.rpc('save_branch_catalogs', { p: s })
```

with:

```ts
/** POS settings → Menu catalogs of an outlet in the caller's scope (save_branch_catalogs checks access_settings). */
export async function saveBranchCatalogs(branchId: string, s: BranchCatalogSettings): Promise<void> {
  const { error } = await supabase.rpc('save_branch_catalogs', { p_branch_id: branchId, p: s })
```

Replacement 2 in `src/features/pos/order/posApi.ts` — replace:

```ts
export async function insertTestPrint(route: string): Promise<void> {
  const { error } = await supabase.rpc('insert_test_print', { p_route: route })
```

with:

```ts
/** A test ticket on a route: the caller's home branch (the POS), or an outlet they manage (POS settings). */
export async function insertTestPrint(route: string, branchId?: string): Promise<void> {
  const { error } = await supabase.rpc('insert_test_print', { p_route: route, ...(branchId ? { p_branch_id: branchId } : {}) })
```

Replacement 1 in `src/features/pos/shift/shiftApi.ts` — replace:

```ts
export async function saveCashVarianceLimit(limitSen: number): Promise<void> {
  const { error } = await supabase.rpc('save_shift_settings', { p_cash_variance_limit_sen: limitSen })
```

with:

```ts
export async function saveCashVarianceLimit(branchId: string, limitSen: number): Promise<void> {
  const { error } = await supabase.rpc('save_shift_settings', { p_branch_id: branchId, p_cash_variance_limit_sen: limitSen })
```

Replacement 1 in `src/features/pos/checkout/checkoutApi.ts` — replace:

```ts
export async function saveReceiptDetails(d: ReceiptDetails): Promise<void> {
  const { error } = await supabase.rpc('save_receipt_settings', { p: d })
```

with:

```ts
export async function saveReceiptDetails(branchId: string, d: ReceiptDetails): Promise<void> {
  const { error } = await supabase.rpc('save_receipt_settings', { p_branch_id: branchId, p: d })
```


Replacement 1 in `src/features/pos/order/MenuCatalogsSection.tsx` — replace:

```tsx
 *  branch, and which catalogs a cashier may switch an order to. access_settings
 *  holders, own branch only (save_branch_catalogs). The outcome shows beside Save. */
```

with:

```tsx
 *  outlet, and which catalogs a cashier may switch an order to. access_settings
 *  holders, outlets in their scope (save_branch_catalogs). The outcome shows beside Save. */
```

Replacement 2 in `src/features/pos/order/MenuCatalogsSection.tsx` — replace:

```tsx
      await saveBranchCatalogs(settingsToSave(form, catalogs))
```

with:

```tsx
      await saveBranchCatalogs(branchId, settingsToSave(form, catalogs))
```

Replacement 1 in `src/features/pos/shift/ShiftSettingsSection.tsx` — replace:

```tsx
      await saveCashVarianceLimit(sen)
```

with:

```tsx
      await saveCashVarianceLimit(branchId, sen)
```

Replacement 1 in `src/features/pos/checkout/CheckoutSettings.tsx` — replace:

```tsx
  clearPin, deleteServiceChargeRule, fetchApprovers, fetchPaymentMethods, fetchProductNames, fetchReasonTemplates,
```

with:

```tsx
  clearPin, deleteServiceChargeRule, fetchPaymentMethods, fetchProductNames, fetchReasonTemplates,
```

Replacement 2 in `src/features/pos/checkout/CheckoutSettings.tsx` — replace:

```tsx
import { ACTION_TITLES, type ReasonAction } from './reasons'
```

with:

```tsx
import { fetchOutletApprovers } from '../outlets/outletsApi'
import { ACTION_TITLES, type ReasonAction } from './reasons'
```

Replacement 3 in `src/features/pos/checkout/CheckoutSettings.tsx` — replace:

```tsx
      <ApproversSection {...bind('approvers')} />
```

with:

```tsx
      <ApproversSection branchId={branchId} {...bind('approvers')} />
```

Replacement 4 in `src/features/pos/checkout/CheckoutSettings.tsx` — replace:

```tsx
    await saveReceiptDetails(d)
```

with:

```tsx
    await saveReceiptDetails(branchId, d)
```

Replacement 5 in `src/features/pos/checkout/CheckoutSettings.tsx` — replace:

```tsx
function ApproversSection({ run, onError, outcome }: SectionProps) {
  const [rows, setRows] = useState<Approver[]>([])
  const load = () => fetchApprovers().then(setRows, (e) => onError(msg(e)))
  useEffect(() => { void load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
```

with:

```tsx
function ApproversSection({ branchId, run, onError, outcome }: { branchId: string } & SectionProps) {
  const [rows, setRows] = useState<Approver[]>([])
  const load = () => fetchOutletApprovers(branchId).then(setRows, (e) => onError(msg(e)))
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
```

Replacement 6 in `src/features/pos/checkout/CheckoutSettings.tsx` — replace:

```tsx
      <p className="text-xs text-brown-muted">Staff of this branch who hold "Approve POS voids &amp; refunds" (Settings → System Roles). Each sets a PIN under My PIN on the POS.</p>
```

with:

```tsx
      <p className="text-xs text-brown-muted">Staff who may work at this outlet and hold "Approve POS voids &amp; refunds" (Settings → System Roles). Each sets a PIN under My PIN on the POS.</p>
```

Replacement 7 in `src/features/pos/checkout/CheckoutSettings.tsx` — replace:

```tsx
      {rows.length === 0 && <p className="text-sm text-brown-muted">Nobody at this branch can approve yet.</p>}
```

with:

```tsx
      {rows.length === 0 && <p className="text-sm text-brown-muted">Nobody at this outlet can approve yet.</p>}
```


- [ ] **Step 2: Create the Outlets section**

Create `src/features/pos/outlets/OutletsSection.tsx`:

```tsx
import { useRef, useState } from 'react'
import {
  OUTLET_KINDS, billNoExample, draftFromOutlet, mytDay, outletDates, outletNote, parseOutletDraft,
  type Outlet, type OutletDraft, type OutletKind,
} from './outlet'
import { saveOutlet } from './outletsApi'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const box = 'rounded-xl border border-border bg-card p-4'
const input = 'rounded border border-border p-1'
const kindLabel = (k: OutletKind) => OUTLET_KINDS.find((x) => x.kind === k)?.label ?? k

/** POS settings → Outlets: every outlet in the caller's scope. HQ (all_branches) adds outlets
 *  and sets their kind, a pop-up's days and the bill prefix (save_outlet). */
export default function OutletsSection({ outlets, isHq, onSaved }: {
  outlets: Outlet[]; isHq: boolean; onSaved: (id: string) => Promise<void>
}) {
  const [draft, setDraft] = useState<OutletDraft | null>(null)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const today = mytDay(new Date())

  const edit = (o: Outlet | null) => { setDraft(draftFromOutlet(o)); setOutcome(null) }
  const change = (d: OutletDraft) => { setDraft(d); setOutcome(null) }
  const save = async () => {
    if (!draft || running.current) return
    const parsed = parseOutletDraft(draft)
    if (!parsed.ok) { setOutcome({ ok: false, text: parsed.problem }); return }
    running.current = true; setBusy(true); setOutcome(null)
    try {
      const id = await saveOutlet(parsed.value)
      setDraft(null)
      setOutcome({ ok: true, text: `${parsed.value.name} saved` })
      await onSaved(id)
    } catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusy(false) }
  }

  return (
    <section className={box}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Outlets</h2>
        {isHq && !draft && <button onClick={() => edit(null)} className="rounded bg-brown-btn px-3 py-1 text-sm text-white">Add outlet</button>}
      </div>
      <p className="text-xs text-brown-muted">
        A branch, a kiosk (a small stall with its own staff and cash drawer) or a pop-up (open between its first and last day).
        Each outlet keeps its own tables, printers, catalogs, payment methods, shifts and reports.{isHq ? '' : ' Only HQ adds outlets or changes their kind, days and bill prefix.'}
      </p>
      <table className="mt-3 w-full text-sm">
        <thead><tr className="text-left text-xs text-brown-muted"><th>Outlet</th><th>Kind</th><th>Days</th><th>Bill numbers</th><th></th></tr></thead>
        <tbody>
          {outlets.map((o) => {
            const note = outletNote(o, today)
            return (
              <tr key={o.id} className="border-t border-border">
                <td className="py-2 font-medium">{o.name}{o.isHome && <span className="ml-2 text-xs text-brown-muted">home</span>}</td>
                <td>{kindLabel(o.kind)}</td>
                <td>{outletDates(o)}{note && <span className="ml-2 text-xs text-amber-700">{note}</span>}</td>
                <td className="font-mono text-xs">{billNoExample(o.billPrefix, new Date())}</td>
                <td className="text-right">{isHq && <button onClick={() => edit(o)} className="text-xs underline">Edit</button>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {draft && <OutletForm draft={draft} busy={busy} onChange={change} onSave={() => void save()} onCancel={() => { setDraft(null); setOutcome(null) }} />}
      {outcome && (outcome.ok
        ? <p role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-800">{outcome.text}</p>
        : <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{outcome.text}</p>)}
    </section>
  )
}

function OutletForm({ draft, busy, onChange, onSave, onCancel }: {
  draft: OutletDraft; busy: boolean; onChange: (d: OutletDraft) => void; onSave: () => void; onCancel: () => void
}) {
  const prefix = draft.billPrefix.trim().toUpperCase() || null
  return (
    <div className="mt-3 space-y-2 rounded border border-border p-3 text-sm">
      <div className="font-medium">{draft.id ? 'Edit outlet' : 'New outlet'}</div>
      <label className="block">Name
        <input className={`${input} ml-2 w-64`} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </label>
      <label className="block">Kind
        <select className={`${input} ml-2`} value={draft.kind} onChange={(e) => onChange({ ...draft, kind: e.target.value as OutletKind })}>
          {OUTLET_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
        </select>
      </label>
      {draft.kind === 'popup' && (
        <div className="flex gap-4">
          <label>First day<input type="date" className={`${input} ml-2`} value={draft.opensOn} onChange={(e) => onChange({ ...draft, opensOn: e.target.value })} /></label>
          <label>Last day<input type="date" className={`${input} ml-2`} value={draft.closesOn} onChange={(e) => onChange({ ...draft, closesOn: e.target.value })} /></label>
        </div>
      )}
      <label className="block">Bill prefix
        <input className={`${input} ml-2 w-20 uppercase`} maxLength={4} value={draft.billPrefix} onChange={(e) => onChange({ ...draft, billPrefix: e.target.value })} />
        <span className="ml-2 text-xs text-brown-muted">Optional, 1–4 letters or digits. Bills read {billNoExample(prefix, new Date())}.</span>
      </label>
      <div className="flex gap-2">
        <button disabled={busy} onClick={onSave} className="rounded bg-brown-btn px-3 py-1 text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save outlet'}</button>
        <button disabled={busy} onClick={onCancel} className="rounded border border-border px-3 py-1">Cancel</button>
      </div>
    </div>
  )
}
```


- [ ] **Step 3: The outlet picker on the page**

Replacement 1 in `src/features/pos/order/PosSettingsPage.tsx` — replace:

```tsx
import { Link } from 'react-router-dom'
```

with:

```tsx
import { Link, useSearchParams } from 'react-router-dom'
```

Replacement 2 in `src/features/pos/order/PosSettingsPage.tsx` — replace:

```tsx
import { useAuth } from '../../auth/AuthContext'
```

with:

```tsx
import { useCan } from '../../../shared/lib/permissions'
```

Replacement 3 in `src/features/pos/order/PosSettingsPage.tsx` — replace:

```tsx
import ShiftSettingsSection from '../shift/ShiftSettingsSection'
```

with:

```tsx
import ShiftSettingsSection from '../shift/ShiftSettingsSection'
import OutletsSection from '../outlets/OutletsSection'
import { fetchMyOutlets } from '../outlets/outletsApi'
import { OUTLET_KINDS, pickOutlet, type Outlet } from '../outlets/outlet'
```

Replacement 4 in `src/features/pos/order/PosSettingsPage.tsx` — replace:

```tsx
  const { staff } = useAuth()
  const branchId = staff?.branch_id ?? null
```

with:

```tsx
  const { can } = useCan()
  const [params, setParams] = useSearchParams()
  const [outlets, setOutlets] = useState<Outlet[] | null>(null)     // null while loading
  const [outletsError, setOutletsError] = useState<string | null>(null)
  const outlet = outlets ? pickOutlet(outlets, params.get('outlet')) : null
  const branchId = outlet?.id ?? null
  const loadOutlets = async () => {
    try { setOutlets(await fetchMyOutlets()); setOutletsError(null) }
    catch (e) { setOutletsError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void loadOutlets() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const chooseOutlet = (id: string) => setParams((p) => { p.set('outlet', id); return p }, { replace: true })
```

Replacement 5 in `src/features/pos/order/PosSettingsPage.tsx` — replace:

```tsx
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
```

with:

```tsx
  useEffect(() => { setTables([]); setRoutes([]); setDraft({}); dirty.current.clear(); void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
```

Replacement 6 in `src/features/pos/order/PosSettingsPage.tsx` — replace:

```tsx
  if (!branchId) return <div className="p-6">Your account has no branch — set it in Team first.</div>
```

with:

```tsx
  if (outletsError) return <div className="p-6 text-red-700">Could not load your outlets: {outletsError}</div>
  if (!outlets) return <div className="p-6">Loading…</div>
  if (!branchId) return <div className="p-6">You have no outlets — ask HQ to set your home branch in Team.</div>
```

Replacement 7 in `src/features/pos/order/PosSettingsPage.tsx` — replace:

```tsx
        <h1 className="text-2xl font-semibold">POS settings</h1>
        <Link to="/pos" className="text-sm underline">Open POS</Link>
      </div>
      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
```

with:

```tsx
        <h1 className="text-2xl font-semibold">POS settings</h1>
        <label className="text-sm">Outlet
          <select className="ml-2 rounded border border-border p-1" value={branchId} onChange={(e) => chooseOutlet(e.target.value)}>
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name} · {OUTLET_KINDS.find((k) => k.kind === o.kind)?.label}</option>)}
          </select>
        </label>
        <Link to="/pos" className="text-sm underline">Open POS</Link>
      </div>
      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <OutletsSection outlets={outlets} isHq={can('all_branches')} onSaved={async (id) => { await loadOutlets(); chooseOutlet(id) }} />
```

Replacement 8 in `src/features/pos/order/PosSettingsPage.tsx` — replace:

```tsx
insertTestPrint(name).catch((e) => setError(e.message))
```

with:

```tsx
insertTestPrint(name, branchId).catch((e) => setError(e.message))
```


- [ ] **Step 4: Run the checks**

Run: `npx tsc -b && npx vitest run`
Expected: tsc prints nothing; 129 files / 1060 tests pass (`PrintHostPanel.test.tsx` still passes: the POS calls `insertTestPrint(route)`).

Also run: `grep -n "fetchApprovers" src/features/pos/checkout/CheckoutSettings.tsx`
Expected: no output (the settings page uses `fetchOutletApprovers`; `ApprovalDialog` keeps `fetchApprovers`).

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/outlets/OutletsSection.tsx src/features/pos/order/PosSettingsPage.tsx src/features/pos/order/posApi.ts \
  src/features/pos/order/MenuCatalogsSection.tsx src/features/pos/shift/shiftApi.ts src/features/pos/shift/ShiftSettingsSection.tsx \
  src/features/pos/checkout/checkoutApi.ts src/features/pos/checkout/CheckoutSettings.tsx
git commit -m "feat(pos): POS settings per outlet — outlet picker, Outlets section (HQ adds outlets), approvers per outlet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Extra outlets on the staff profile (implementer)

**Model tier:** cheap.

**Files:**
- Create: `src/features/pos/outlets/ExtraOutletsCard.tsx`
- Modify: `src/features/staff/StaffProfile.tsx` (an import, `useCan`, one card mount)

**Interfaces:**
- Consumes: `fetchMyOutlets`, `fetchStaffOutlets`, `setStaffOutlet` (Task 3); `OUTLET_KINDS`, `Outlet`.
- Produces: `ExtraOutletsCard({ staffId, homeBranchId })`.

- [ ] **Step 1: Create the card**

Create `src/features/pos/outlets/ExtraOutletsCard.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { OUTLET_KINDS, type Outlet } from './outlet'
import { fetchMyOutlets, fetchStaffOutlets, setStaffOutlet } from './outletsApi'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Staff profile → POS outlets: the outlets this person may also work at, besides their home
 *  branch. A manager (access_settings) ticks the outlets of their own scope (set_staff_outlet). */
export function ExtraOutletsCard({ staffId, homeBranchId }: { staffId: string; homeBranchId: string | null }) {
  const [outlets, setOutlets] = useState<Outlet[] | null>(null)       // null while loading or after a failed load
  const [extra, setExtra] = useState<Set<string>>(new Set())
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const running = useRef(false)
  const seq = useRef(0)

  useEffect(() => {
    const id = ++seq.current
    setOutlets(null); setOutcome(null)
    Promise.all([fetchMyOutlets(), fetchStaffOutlets(staffId)]).then(([o, s]) => {
      if (id !== seq.current) return
      setOutlets(o); setExtra(new Set(s))
    }, (e) => { if (id === seq.current) setOutcome({ ok: false, text: `Could not load the outlets: ${msg(e)}` }) })
  }, [staffId])

  const toggle = async (o: Outlet, on: boolean) => {
    if (running.current) return
    running.current = true; setBusyId(o.id); setOutcome(null)
    try {
      await setStaffOutlet(staffId, o.id, on)
      setExtra((prev) => { const next = new Set(prev); if (on) next.add(o.id); else next.delete(o.id); return next })
      setOutcome({ ok: true, text: on ? `May now work at ${o.name}` : `No longer works at ${o.name}` })
    } catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusyId(null) }
  }

  const choices = (outlets ?? []).filter((o) => o.id !== homeBranchId)
  return (
    <div className="bg-white rounded-xl shadow-card p-5">
      <p className="text-xs font-semibold text-brown-muted uppercase tracking-widest mb-1">POS outlets</p>
      <p className="text-xs text-brown-faint mb-3">Besides their home branch, the outlets where this person may sign in to the POS (with the "Sign in to the POS" permission).</p>
      {outlets && choices.length === 0 && <p className="text-sm text-brown-muted">No other outlets in your scope.</p>}
      {choices.map((o) => (
        <label key={o.id} className="flex items-center gap-2 py-1 text-sm">
          <input type="checkbox" checked={extra.has(o.id)} disabled={outlets === null || busyId !== null}
            onChange={(e) => void toggle(o, e.target.checked)} />
          <span>{o.name}</span>
          <span className="text-xs text-brown-faint">{OUTLET_KINDS.find((k) => k.kind === o.kind)?.label}</span>
          {busyId === o.id && <span className="text-xs text-brown-faint">Saving…</span>}
        </label>
      ))}
      {outcome && <p role={outcome.ok ? 'status' : 'alert'} className={`mt-2 text-xs ${outcome.ok ? 'text-[#3D7A50]' : 'text-red-700'}`}>{outcome.text}</p>}
    </div>
  )
}
```


- [ ] **Step 2: Mount it on the profile**

Replacement 1 in `src/features/staff/StaffProfile.tsx` — replace:

```tsx
import { canReviewStaff } from '../../shared/lib/permissions'
```

with:

```tsx
import { canReviewStaff, useCan } from '../../shared/lib/permissions'
```

Replacement 2 in `src/features/staff/StaffProfile.tsx` — replace:

```tsx
import { CareerProgress } from './CareerProgress'
```

with:

```tsx
import { CareerProgress } from './CareerProgress'
import { ExtraOutletsCard } from '../pos/outlets/ExtraOutletsCard'
```

Replacement 3 in `src/features/staff/StaffProfile.tsx` — replace:

```tsx
  const isManager    = currentStaff?.rank === 'manager'
```

with:

```tsx
  const isManager    = currentStaff?.rank === 'manager'
  const { can }      = useCan()
```

Replacement 4 in `src/features/staff/StaffProfile.tsx` — replace:

```tsx
            <DangerZoneCard staff={staff} onReset={handleReset} />
          </div>
        )}
```

with:

```tsx
            <DangerZoneCard staff={staff} onReset={handleReset} />
          </div>
        )}
        {can('access_settings') && !isSelf && (
          <div className="mt-4">
            <ExtraOutletsCard staffId={staff.id} homeBranchId={staff.branch_id ?? null} />
          </div>
        )}
```


- [ ] **Step 3: Run the checks**

Run: `npx tsc -b && npx vitest run`
Expected: tsc prints nothing; 129 files / 1060 tests pass (`StaffProfile.supervisor.test.tsx` included).

- [ ] **Step 4: Commit**

```bash
git add src/features/pos/outlets/ExtraOutletsCard.tsx src/features/staff/StaffProfile.tsx
git commit -m "feat(team): POS outlets card — a manager adds the outlets a staff member may also work at

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Browser check on dev and push (controller)

**Model tier:** controller only.

- [ ] **Step 1: Start the dev server**

Use `preview_start` with the dev launch entry that points at craft-os-dev (`pos-menu-dev`, port 5174). Never use the entry that hits prod. The owner signs in; Claude never types a password.

- [ ] **Step 2: Walk through it**
  1. `/pos/settings` as the owner:
     - The Outlet picker lists every branch, home first.
     - The Outlets section shows each outlet's kind, days and a bill number preview.
  2. **Add outlet:** "VERIFY Pop-up", Pop-up, from today to today + 7, prefix `vp`.
     - The preview reads `VP-<today>-001`.
     - Save → "VERIFY Pop-up saved", and the picker switches to it.
  3. **Form errors:** saving with the last day before the first shows "The last day is before the first day" beside the form. A duplicate prefix shows the server's "The bill prefix VP is used by VERIFY Pop-up".
  4. **Settings on the pop-up:** with the pop-up chosen, add a table and a printer route and press Test print. The job goes to the pop-up: check `select branch_id from print_jobs order by created_at desc limit 1` (controller, read-only).
  5. **Staff profile → POS outlets:** tick the pop-up for a test staff member → "May now work at VERIFY Pop-up". Untick → "No longer works at VERIFY Pop-up".
  6. **Settings → System Roles** shows "Sign in to the POS", on for every role but HR.
  7. **Console:** no errors.
- [ ] **Step 3: Clean up the test outlet (controller):** set "VERIFY Pop-up" inactive in Settings → Branches. Outlets are never deleted, because bills reference them.
- [ ] **Step 4: Push**

```bash
git push origin feature/pos-demo
```

## Open points (not in this plan)

- **HQ for managers.** If the owner wants managers limited to their own branches (not HQ), they switch "All Branches" off for Manager in Settings → System Roles. That also limits what managers see elsewhere in Craft OS. Decide before Sub-plan B, whose device approval uses the same rule.
- **Prod order:** the POS SQL chain → `migration-2026-10-26-pos-frontend.sql` → this file, right before the deploy of Task 4. Re-run the Step 1 pre-check on prod first.
- **Sub-plans B, C and D** follow the build order above; each gets its own plan after the previous part is live on dev.
