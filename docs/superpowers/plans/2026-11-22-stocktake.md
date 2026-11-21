# Stocktake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a branch count its stock on a phone (weekly key items or a full count, blind, grouped by storage location) and have the submitted count set stock on hand, with a variance report in RM.

**Architecture:** One SQL migration adds storage locations, the key-item flag, count tables and SECURITY DEFINER RPCs; submit writes one `stocktake` ledger row per item that differs, costed at the branch's moving average. Three React screens (list, counting/result, setup) call those RPCs through `supabase.rpc` and read the tables directly under RLS. Pure helpers (packs + loose conversion, grouping, progress, sorting) live in their own module with Vitest tests.

**Tech Stack:** React + Vite + Tailwind, Supabase (Postgres, RLS, plpgsql RPCs), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-stocktake-design.md`

## Global Constraints

- Work in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/stocktake`, branch `feature/stocktake`. Never run git commands in the main checkout.
- SQL runs on **dev only** (`egznnbjmicebbhwasloy`). Never touch prod (`yfsoesxzurzjdwstszru`) in this plan.
- All UI labels and copy in English.
- Supervisors see only their own branch, managers all branches: reuse `useBranchPicker` / `seesAllBranches`; SQL uses `can_access_branch`.
- Capabilities: counting = `use_procurement`; setup = `manage_procurement`.
- Blind count: the counting screen never shows the system quantity.
- Submitting a count adjusts stock immediately; there is no approval step.
- Ledger quantities are in base units; cost per base unit comes from `inventory_avg_unit_cost(item, branch, null)`.
- Stock-out advisory lock key is exactly `'stock_out:' || item_id::text || ':' || branch_id::text`.
- Commit after every task; end commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Dev SQL runner

Every SQL step uses this script (create it once, in the session scratchpad, not the repo):

```bash
cat > "$SCRATCH/devsql.sh" <<'EOF'
#!/bin/bash
# usage: devsql.sh <file.sql> — runs on DEV (egznnbjmicebbhwasloy). One request = one transaction.
jq -Rs '{query: .}' "$1" | curl -s -X POST "https://api.supabase.com/v1/projects/egznnbjmicebbhwasloy/database/query" \
  -H "Authorization: Bearer $(cat ~/.supabase-access-token)" -H "Content-Type: application/json" --data-binary @-
echo
EOF
chmod +x "$SCRATCH/devsql.sh"
```

`$SCRATCH` = `/private/tmp/claude-502/-Users-USER-Desktop-Craft-OS/2516e557-a088-40fb-85bf-3cbf7812eda7/scratchpad`. A response containing `"message"` is an error.

## File Structure

| File | Responsibility |
|------|----------------|
| `supabase/migration-2026-11-22-stocktake.sql` (create) | Schema, RLS, RPCs for locations, key items, counts |
| `supabase/VERIFY-2026-11-22-stocktake.sql` (create) | Dev-only behaviour checks, rolls back by raising its report |
| `src/shared/types/procurement.ts` (modify) | `stocktake` ledger type, `Item.count_weekly`, count types |
| `src/shared/lib/stocktake.ts` (create) | Pure helpers: packs/loose ↔ base, count item list, grouping, progress, result sort |
| `src/shared/lib/stocktake.test.ts` (create) | Vitest for the helpers |
| `src/features/procurement/StockCounts.tsx` (create) | List page: branch picker, resume card, start buttons, history |
| `src/features/procurement/StockCountSession.tsx` (create) | Counting screen for an in-progress count; shows the result once submitted |
| `src/features/procurement/StockCountResult.tsx` (create) | Result view: totals and lines sorted by RM variance |
| `src/features/procurement/StockCountSetup.tsx` (create) | Locations, items per location, key items |
| `src/App.tsx` (modify) | Three routes |
| `src/shared/lib/nav.ts`, `nav.test.ts` (modify) | "Stock Count" nav entry |

---

### Task 1: Database — schema, RLS and RPCs (dev)

**Files:**
- Create: `supabase/VERIFY-2026-11-22-stocktake.sql`
- Create: `supabase/migration-2026-11-22-stocktake.sql`

**Interfaces:**
- Produces (used by every later task):
  - Tables `storage_locations(id, branch_id, name, sort_order, is_active, created_at)`, `item_locations(item_id, location_id, sort_order)`, `stock_counts(id, branch_id, kind, status, started_by, started_at, submitted_by, submitted_at, business_date, notes, item_count, gain_value, loss_value, net_value)`, `stock_count_entries(id, count_id, item_id, location_id, counted_base, counted_by, counted_at)`, `stock_count_items(count_id, item_id, counted_base, expected_base, variance_base, unit_cost, variance_value, transaction_id)`; column `items.count_weekly`.
  - RPCs: `save_storage_location(p_id uuid, p_branch_id uuid, p_name text, p_sort_order int, p_is_active boolean) returns storage_locations`; `set_location_items(p_location_id uuid, p_item_ids uuid[]) returns void`; `set_item_count_weekly(p_item_id uuid, p_value boolean) returns void`; `start_stock_count(p_branch_id uuid, p_kind text) returns stock_counts`; `save_count_entry(p_count_id uuid, p_item_id uuid, p_location_id uuid, p_counted_base numeric) returns void`; `cancel_stock_count(p_count_id uuid) returns void`; `submit_stock_count(p_count_id uuid) returns stock_counts`.

- [ ] **Step 1: Write the VERIFY script (the failing test)**

Create `supabase/VERIFY-2026-11-22-stocktake.sql`:

```sql
-- ============================================================================
-- VERIFY — Stocktake (2026-11-22). DEV ONLY (craft-os-dev).
--
-- Creates two [TEST] key items, acts as the [TEST] logins, and always ends by
-- raising its report as an error so every change is rolled back.
-- Last line: VERIFY OK or VERIFY FAILED.
-- ============================================================================
do $verify$
declare
  c_sup_cheras constant uuid := 'bfd13ca2-6282-42f3-ad85-5fbe1325516d';
  c_cheras     constant uuid := '75bb97bb-dedb-4aee-b326-373fd883780e';
  c_puchong    constant uuid := '13d1292f-e9ca-40ec-90d9-ed3086aa2396';
  v_out  text := '';
  v_fail boolean := false;
  v_ok   boolean;
  v_a    uuid;   -- item A: 10 on hand at RM 0.50, counted 7  -> loss 3
  v_b    uuid;   -- item B: 4 on hand at RM 2.00, counted 6   -> gain 2
  v_c    uuid;   -- item C: 5 on hand, counted 5              -> no ledger row
  v_loc1 uuid;
  v_loc2 uuid;
  v_count stock_counts%rowtype;
  v_n    int;
  v_avg_before numeric;
  v_avg_after  numeric;
  v_bal  numeric;
begin
  -- Fixture (as postgres): three key items with costed stock at Cheras.
  update items set count_weekly = false where count_weekly;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price, count_weekly)
  values ('[TEST] VERIFY Stocktake A', 'raw', 'pack', 'g', 1000, 500, true) returning id into v_a;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price, count_weekly)
  values ('[TEST] VERIFY Stocktake B', 'raw', 'box', 'pcs', 10, 20, true) returning id into v_b;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price, count_weekly)
  values ('[TEST] VERIFY Stocktake C', 'raw', 'pcs', 'pcs', 1, 1, true) returning id into v_c;
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type)
  values (v_a, c_cheras, 'stock_in', 10, 0.5, 'manual'),
         (v_b, c_cheras, 'stock_in', 4, 2, 'manual'),
         (v_c, c_cheras, 'stock_in', 5, 1, 'manual');
  delete from stock_counts where branch_id = c_cheras and status = 'in_progress';
  v_avg_before := inventory_avg_unit_cost(v_b, c_cheras, null);

  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_cheras, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- 1. Supervisor cannot set up locations (manager only) ----------------------
  begin
    perform save_storage_location(null, c_cheras, '[TEST] Chiller', 0, true);
    v_ok := false;
  exception when others then v_ok := true;
  end;
  v_out := v_out || format(E'%s  supervisor cannot create locations\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 2. Supervisor cannot start a count at another branch ----------------------
  begin
    perform start_stock_count(c_puchong, 'weekly');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  v_out := v_out || format(E'%s  supervisor cannot count another branch\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 3. Start, then a second start is refused ----------------------------------
  v_count := start_stock_count(c_cheras, 'weekly');
  begin
    perform start_stock_count(c_cheras, 'full');
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%already in progress%';
  end;
  v_out := v_out || format(E'%s  one in-progress count per branch\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 4. Submit refused while an item is not counted ---------------------------
  execute 'reset role';
  insert into storage_locations (branch_id, name, sort_order) values (c_cheras, '[TEST] VERIFY Front', 0) returning id into v_loc1;
  insert into storage_locations (branch_id, name, sort_order) values (c_cheras, '[TEST] VERIFY Back', 1) returning id into v_loc2;
  execute 'set local role authenticated';
  perform save_count_entry(v_count.id, v_a, v_loc1, 4);
  perform save_count_entry(v_count.id, v_a, v_loc2, 3);   -- A total 7
  perform save_count_entry(v_count.id, v_b, null, 6);
  begin
    perform submit_stock_count(v_count.id);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%not counted yet%';
  end;
  v_out := v_out || format(E'%s  submit refused while an item is uncounted\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 5. Negative count refused; null clears an entry --------------------------
  begin
    perform save_count_entry(v_count.id, v_c, null, -1);
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform save_count_entry(v_count.id, v_c, null, 99);
  perform save_count_entry(v_count.id, v_c, null, null);
  select count(*) into v_n from stock_count_entries where count_id = v_count.id and item_id = v_c;
  v_ok := v_ok and v_n = 0;
  v_out := v_out || format(E'%s  negative refused, null clears the entry\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 6. Submit: balances equal counts, ledger rows only where different -------
  perform save_count_entry(v_count.id, v_c, null, 5);
  v_count := submit_stock_count(v_count.id);
  execute 'reset role';
  select coalesce(sum(quantity), 0) into v_bal from inventory_transactions where item_id = v_a and branch_id = c_cheras;
  v_ok := v_bal = 7;
  select coalesce(sum(quantity), 0) into v_bal from inventory_transactions where item_id = v_b and branch_id = c_cheras;
  v_ok := v_ok and v_bal = 6;
  select count(*) into v_n from inventory_transactions where reference_id = v_count.id and transaction_type = 'stocktake';
  v_ok := v_ok and v_n = 2 and v_count.status = 'submitted' and v_count.item_count = 3;
  v_out := v_out || format(E'%s  submit sets balances, 2 ledger rows, zero variance writes none\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 7. RM totals: loss 3 x 0.50 = 1.50, gain 2 x 2.00 = 4.00 -----------------
  v_ok := v_count.loss_value = 1.50 and v_count.gain_value = 4.00 and v_count.net_value = 2.50;
  v_out := v_out || format(E'%s  loss/gain/net values (%s / %s / %s)\n', case when v_ok then 'PASS' else 'FAIL' end,
                           v_count.loss_value, v_count.gain_value, v_count.net_value);
  v_fail := v_fail or not v_ok;

  -- 8. A gain does not move the moving average --------------------------------
  v_avg_after := inventory_avg_unit_cost(v_b, c_cheras, null);
  v_ok := round(v_avg_after, 6) = round(v_avg_before, 6);
  v_out := v_out || format(E'%s  moving average unchanged by a gain\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 9. Entries locked after submit -------------------------------------------
  execute 'set local role authenticated';
  begin
    perform save_count_entry(v_count.id, v_a, v_loc1, 1);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%no longer open%';
  end;
  execute 'reset role';
  v_out := v_out || format(E'%s  entries refused after submit\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 10. anon cannot run any stocktake function -------------------------------
  select not bool_or(has_function_privilege('anon', p.oid, 'execute')) into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('save_storage_location', 'set_location_items', 'set_item_count_weekly',
                       'start_stock_count', 'save_count_entry', 'cancel_stock_count', 'submit_stock_count');
  v_out := v_out || format(E'%s  anon cannot execute stocktake functions\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  v_out := v_out || case when v_fail then 'VERIFY FAILED' else 'VERIFY OK' end;
  raise exception E'\n%', v_out;
end
$verify$;
```

- [ ] **Step 2: Run it on dev and see it fail**

Run: `"$SCRATCH/devsql.sh" supabase/VERIFY-2026-11-22-stocktake.sql`
Expected: an error mentioning `column "count_weekly" of relation "items" does not exist` (the schema is not there yet).

- [ ] **Step 3: Write the migration**

Create `supabase/migration-2026-11-22-stocktake.sql`:

```sql
-- ============================================================================
-- Craft OS — Stocktake (2026-11-22)
--
-- Storage locations per branch, a weekly "key item" flag, and stock counts:
-- staff enter counts (blind) per item and location; submit_stock_count sets
-- each item's balance to the counted total with one 'stocktake' ledger row
-- per item that differs, costed at the branch's moving average.
-- Spec: docs/superpowers/specs/2026-11-22-stocktake-design.md
-- Additive and idempotent. Run on dev first.
-- ============================================================================

-- 1. Key items ---------------------------------------------------------------
alter table items add column if not exists count_weekly boolean not null default false;

-- 2. Ledger type ---------------------------------------------------------------
alter table inventory_transactions
  drop constraint if exists inventory_transactions_transaction_type_check;
alter table inventory_transactions
  add constraint inventory_transactions_transaction_type_check
  check (transaction_type in ('stock_in', 'adjustment', 'wastage',
                              'transfer_out', 'transfer_in',
                              'production_out', 'production_in',
                              'stocktake'));

-- 3. Tables --------------------------------------------------------------------
create table if not exists storage_locations (
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branches(id),
  name       text not null check (btrim(name) <> ''),
  sort_order int  not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists storage_locations_branch_name_uidx
  on storage_locations (branch_id, lower(btrim(name)));

create table if not exists item_locations (
  item_id     uuid not null references items(id) on delete cascade,
  location_id uuid not null references storage_locations(id) on delete cascade,
  sort_order  int  not null default 0,
  primary key (item_id, location_id)
);
create index if not exists item_locations_location_idx on item_locations (location_id);

create table if not exists stock_counts (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  kind         text not null check (kind in ('weekly', 'full')),
  status       text not null default 'in_progress'
                 check (status in ('in_progress', 'submitted', 'cancelled')),
  started_by   uuid references staff(id),
  started_at   timestamptz not null default now(),
  submitted_by uuid references staff(id),
  submitted_at timestamptz,
  business_date date,
  notes        text,
  item_count   int,
  gain_value   numeric,
  loss_value   numeric,
  net_value    numeric
);
create unique index if not exists stock_counts_one_open_uidx
  on stock_counts (branch_id) where status = 'in_progress';
create index if not exists stock_counts_branch_started_idx
  on stock_counts (branch_id, started_at desc);

create table if not exists stock_count_entries (
  id           uuid primary key default gen_random_uuid(),
  count_id     uuid not null references stock_counts(id) on delete cascade,
  item_id      uuid not null references items(id),
  location_id  uuid references storage_locations(id),
  counted_base numeric not null check (counted_base >= 0),
  counted_by   uuid references staff(id),
  counted_at   timestamptz not null default now()
);
create unique index if not exists stock_count_entries_uidx
  on stock_count_entries (count_id, item_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists stock_count_items (
  count_id       uuid not null references stock_counts(id) on delete cascade,
  item_id        uuid not null references items(id),
  counted_base   numeric not null,
  expected_base  numeric not null,
  variance_base  numeric not null,
  unit_cost      numeric,
  variance_value numeric not null default 0,
  transaction_id uuid references inventory_transactions(id),
  primary key (count_id, item_id)
);

-- 4. RLS: reads by branch; writes only through the functions below -----------
alter table storage_locations   enable row level security;
alter table item_locations      enable row level security;
alter table stock_counts        enable row level security;
alter table stock_count_entries enable row level security;
alter table stock_count_items   enable row level security;

drop policy if exists storage_locations_select on storage_locations;
create policy storage_locations_select on storage_locations for select to authenticated
  using (has_procurement_cap('use_procurement') and can_access_branch(branch_id));

drop policy if exists item_locations_select on item_locations;
create policy item_locations_select on item_locations for select to authenticated
  using (has_procurement_cap('use_procurement') and exists (
    select 1 from storage_locations l where l.id = location_id and can_access_branch(l.branch_id)));

drop policy if exists stock_counts_select on stock_counts;
create policy stock_counts_select on stock_counts for select to authenticated
  using (has_procurement_cap('use_procurement') and can_access_branch(branch_id));

drop policy if exists stock_count_entries_select on stock_count_entries;
create policy stock_count_entries_select on stock_count_entries for select to authenticated
  using (has_procurement_cap('use_procurement') and exists (
    select 1 from stock_counts c where c.id = count_id and can_access_branch(c.branch_id)));

drop policy if exists stock_count_items_select on stock_count_items;
create policy stock_count_items_select on stock_count_items for select to authenticated
  using (has_procurement_cap('use_procurement') and exists (
    select 1 from stock_counts c where c.id = count_id and can_access_branch(c.branch_id)));

revoke all on storage_locations, item_locations, stock_counts, stock_count_entries, stock_count_items
  from anon, authenticated;
grant select on storage_locations, item_locations, stock_counts, stock_count_entries, stock_count_items
  to authenticated;

-- 5. Setup functions (managers) -----------------------------------------------
create or replace function save_storage_location(
  p_id uuid, p_branch_id uuid, p_name text, p_sort_order int, p_is_active boolean
) returns storage_locations
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_row storage_locations%rowtype;
  v_name text := nullif(btrim(p_name), '');
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to manage storage locations';
  end if;
  if p_branch_id is null or not can_access_branch(p_branch_id) then
    raise exception 'Not authorised for this branch';
  end if;
  if v_name is null then
    raise exception 'Location name is required';
  end if;
  begin
    if p_id is null then
      insert into storage_locations (branch_id, name, sort_order, is_active)
      values (p_branch_id, v_name, coalesce(p_sort_order, 0), coalesce(p_is_active, true))
      returning * into v_row;
    else
      update storage_locations
         set name = v_name, sort_order = coalesce(p_sort_order, sort_order),
             is_active = coalesce(p_is_active, is_active)
       where id = p_id and branch_id = p_branch_id
      returning * into v_row;
      if not found then
        raise exception 'Location not found';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'A location called "%" already exists at this branch', v_name;
  end;
  return v_row;
end;
$$;

create or replace function set_location_items(p_location_id uuid, p_item_ids uuid[])
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_branch uuid;
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to manage storage locations';
  end if;
  select branch_id into v_branch from storage_locations where id = p_location_id;
  if not found then
    raise exception 'Location not found';
  end if;
  if not can_access_branch(v_branch) then
    raise exception 'Not authorised for this branch';
  end if;
  delete from item_locations where location_id = p_location_id;
  insert into item_locations (item_id, location_id, sort_order)
  select x.item_id, p_location_id, x.ord::int
    from unnest(coalesce(p_item_ids, '{}')) with ordinality as x(item_id, ord)
   where exists (select 1 from items i where i.id = x.item_id)
  on conflict (item_id, location_id) do nothing;
end;
$$;

create or replace function set_item_count_weekly(p_item_id uuid, p_value boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to change key items';
  end if;
  update items set count_weekly = coalesce(p_value, false) where id = p_item_id;
  if not found then
    raise exception 'Item not found';
  end if;
end;
$$;

-- 6. Counting functions (anyone with use_procurement at the branch) -----------
create or replace function start_stock_count(p_branch_id uuid, p_kind text)
returns stock_counts
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_row  stock_counts%rowtype;
  v_open uuid;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to count stock';
  end if;
  if p_branch_id is null or not can_access_branch(p_branch_id) then
    raise exception 'Not authorised to count stock at this branch';
  end if;
  if p_kind is null or p_kind not in ('weekly', 'full') then
    raise exception 'Unknown count type: %', coalesce(p_kind, '(none)');
  end if;
  if not exists (select 1 from branches where id = p_branch_id and is_active) then
    raise exception 'Branch not found';
  end if;
  select id into v_open from stock_counts where branch_id = p_branch_id and status = 'in_progress';
  if found then
    raise exception 'A count is already in progress at this branch (%)', v_open;
  end if;
  begin
    insert into stock_counts (branch_id, kind, started_by)
    values (p_branch_id, p_kind, auth.uid())
    returning * into v_row;
  exception when unique_violation then
    select id into v_open from stock_counts where branch_id = p_branch_id and status = 'in_progress';
    raise exception 'A count is already in progress at this branch (%)', v_open;
  end;
  return v_row;
end;
$$;

create or replace function save_count_entry(
  p_count_id uuid, p_item_id uuid, p_location_id uuid, p_counted_base numeric
) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_count stock_counts%rowtype;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to count stock';
  end if;
  -- Share lock: waits for a submit in flight, then sees its status.
  select * into v_count from stock_counts where id = p_count_id for share;
  if not found then
    raise exception 'Count not found';
  end if;
  if not can_access_branch(v_count.branch_id) then
    raise exception 'Not authorised to count stock at this branch';
  end if;
  if v_count.status <> 'in_progress' then
    raise exception 'This count is no longer open';
  end if;
  if not exists (select 1 from items where id = p_item_id) then
    raise exception 'Item not found';
  end if;
  if p_location_id is not null and not exists (
       select 1 from storage_locations where id = p_location_id and branch_id = v_count.branch_id) then
    raise exception 'Location not found at this branch';
  end if;

  if p_counted_base is null then
    delete from stock_count_entries
     where count_id = p_count_id and item_id = p_item_id
       and location_id is not distinct from p_location_id;
    return;
  end if;
  if p_counted_base < 0 then
    raise exception 'Counted quantity cannot be negative';
  end if;

  insert into stock_count_entries (count_id, item_id, location_id, counted_base, counted_by, counted_at)
  values (p_count_id, p_item_id, p_location_id, p_counted_base, auth.uid(), now())
  on conflict (count_id, item_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set counted_base = excluded.counted_base,
                counted_by   = excluded.counted_by,
                counted_at   = excluded.counted_at;
end;
$$;

create or replace function cancel_stock_count(p_count_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_count stock_counts%rowtype;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to count stock';
  end if;
  select * into v_count from stock_counts where id = p_count_id for update;
  if not found then
    raise exception 'Count not found';
  end if;
  if not can_access_branch(v_count.branch_id) then
    raise exception 'Not authorised to count stock at this branch';
  end if;
  if v_count.status <> 'in_progress' then
    raise exception 'This count is no longer open';
  end if;
  if v_count.started_by is distinct from auth.uid() and not has_procurement_cap('manage_procurement') then
    raise exception 'Only the person who started this count or a manager can cancel it';
  end if;
  update stock_counts set status = 'cancelled' where id = p_count_id;
end;
$$;

create or replace function submit_stock_count(p_count_id uuid)
returns stock_counts
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_count    stock_counts%rowtype;
  v_missing  int;
  r          record;
  v_expected numeric;
  v_variance numeric;
  v_cost     numeric;
  v_value    numeric;
  v_tx       uuid;
  v_gain     numeric := 0;
  v_loss     numeric := 0;
  v_n        int := 0;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to count stock';
  end if;
  select * into v_count from stock_counts where id = p_count_id for update;
  if not found then
    raise exception 'Count not found';
  end if;
  if not can_access_branch(v_count.branch_id) then
    raise exception 'Not authorised to count stock at this branch';
  end if;
  if v_count.status <> 'in_progress' then
    raise exception 'This count is no longer open';
  end if;

  select count(*) into v_missing
    from items i
   where i.status = 'active'
     and (v_count.kind = 'full' or i.count_weekly)
     and not exists (select 1 from stock_count_entries e
                      where e.count_id = p_count_id and e.item_id = i.id);
  if v_missing > 0 then
    raise exception '% item(s) not counted yet', v_missing;
  end if;

  for r in
    select i.id as item_id, sum(e.counted_base) as counted
      from items i
      join stock_count_entries e on e.item_id = i.id and e.count_id = p_count_id
     where i.status = 'active' and (v_count.kind = 'full' or i.count_weekly)
     group by i.id
     order by i.id
  loop
    perform pg_advisory_xact_lock(hashtext('stock_out:' || r.item_id::text || ':' || v_count.branch_id::text));
    select coalesce(sum(quantity), 0) into v_expected
      from inventory_transactions
     where item_id = r.item_id and branch_id = v_count.branch_id;
    v_variance := r.counted - v_expected;
    v_cost := coalesce(inventory_avg_unit_cost(r.item_id, v_count.branch_id, null), 0);
    v_value := round(v_variance * v_cost, 2);
    v_tx := null;
    if v_variance <> 0 then
      insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost,
                                          reference_type, reference_id, created_by, notes)
      values (r.item_id, v_count.branch_id, 'stocktake', v_variance, v_cost,
              'stock_count', p_count_id, auth.uid(), initcap(v_count.kind) || ' stock count')
      returning id into v_tx;
    end if;
    insert into stock_count_items (count_id, item_id, counted_base, expected_base, variance_base,
                                   unit_cost, variance_value, transaction_id)
    values (p_count_id, r.item_id, r.counted, v_expected, v_variance, v_cost, v_value, v_tx);
    if v_value > 0 then
      v_gain := v_gain + v_value;
    elsif v_value < 0 then
      v_loss := v_loss - v_value;
    end if;
    v_n := v_n + 1;
  end loop;

  update stock_counts
     set status = 'submitted', submitted_by = auth.uid(), submitted_at = now(),
         business_date = business_date_of(now()), item_count = v_n,
         gain_value = v_gain, loss_value = v_loss, net_value = v_gain - v_loss
   where id = p_count_id
  returning * into v_count;
  return v_count;
end;
$$;

-- 7. Grants ----------------------------------------------------------------------
revoke all on function save_storage_location(uuid, uuid, text, int, boolean) from public, anon;
revoke all on function set_location_items(uuid, uuid[]) from public, anon;
revoke all on function set_item_count_weekly(uuid, boolean) from public, anon;
revoke all on function start_stock_count(uuid, text) from public, anon;
revoke all on function save_count_entry(uuid, uuid, uuid, numeric) from public, anon;
revoke all on function cancel_stock_count(uuid) from public, anon;
revoke all on function submit_stock_count(uuid) from public, anon;
grant execute on function save_storage_location(uuid, uuid, text, int, boolean) to authenticated;
grant execute on function set_location_items(uuid, uuid[]) to authenticated;
grant execute on function set_item_count_weekly(uuid, boolean) to authenticated;
grant execute on function start_stock_count(uuid, text) to authenticated;
grant execute on function save_count_entry(uuid, uuid, uuid, numeric) to authenticated;
grant execute on function cancel_stock_count(uuid) to authenticated;
grant execute on function submit_stock_count(uuid) to authenticated;
```

- [ ] **Step 4: Apply the migration on dev**

Run: `"$SCRATCH/devsql.sh" supabase/migration-2026-11-22-stocktake.sql`
Expected: `[]`

- [ ] **Step 5: Run VERIFY and see it pass**

Run: `"$SCRATCH/devsql.sh" supabase/VERIFY-2026-11-22-stocktake.sql`
Expected: an error message whose text lists ten `PASS` lines and ends with `VERIFY OK`. Any `FAIL` → fix the migration, re-apply (it is idempotent), re-run.

- [ ] **Step 6: Re-apply once more to prove idempotency**

Run: `"$SCRATCH/devsql.sh" supabase/migration-2026-11-22-stocktake.sql`
Expected: `[]`

- [ ] **Step 7: Commit**

```bash
git add supabase/migration-2026-11-22-stocktake.sql supabase/VERIFY-2026-11-22-stocktake.sql
git commit -m "feat(stocktake): locations, key items, stock counts and submit RPC (dev)"
```

---

### Task 2: Types and pure helpers

**Files:**
- Modify: `src/shared/types/procurement.ts` (`Item` at ~line 62, `InventoryTransactionType` at ~line 276, `TRANSACTION_TYPE_LABELS` at ~line 281)
- Create: `src/shared/lib/stocktake.ts`
- Test: `src/shared/lib/stocktake.test.ts`

**Interfaces:**
- Consumes: table shapes from Task 1.
- Produces:
  - Types `StorageLocation`, `ItemLocation`, `StockCountKind`, `StockCountStatus`, `StockCount`, `StockCountEntry`, `StockCountItem`, `STOCK_COUNT_KIND_LABELS`; `Item.count_weekly: boolean`; `'stocktake'` in `InventoryTransactionType`.
  - `packsLooseToBase(packs: number | null, loose: number | null, rate: number): number | null`
  - `baseToPacksLoose(base: number, rate: number): { packs: number; loose: number }`
  - `itemsForCount(items: Item[], kind: StockCountKind): Item[]`
  - `UNASSIGNED = 'unassigned'`; `entryKey(itemId: string, locationId: string | null): string`
  - `groupForCounting(items: Item[], locations: StorageLocation[], itemLocations: ItemLocation[]): CountGroup[]` where `CountGroup = { key: string; label: string; locationId: string | null; items: Item[] }`
  - `groupProgress(group: CountGroup, entries: Map<string, number>): { done: number; total: number }`
  - `uncountedItems(items: Item[], entries: StockCountEntry[]): Item[]`
  - `sortResultLines<T extends { variance_value: number; name: string }>(lines: T[]): T[]`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/lib/stocktake.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  packsLooseToBase, baseToPacksLoose, itemsForCount, groupForCounting, groupProgress,
  uncountedItems, sortResultLines, entryKey, UNASSIGNED,
} from './stocktake'
import type { Item, StorageLocation, ItemLocation, StockCountEntry } from '../types'

function item(id: string, over: Partial<Item> = {}): Item {
  return {
    id, name: id, name_zh: null, category: 'raw', departments: [], department: null,
    supplier_id: null, purchase_unit: 'pack', base_unit: 'g', conversion_rate: 1000,
    latest_price: null, min_stock_alert: 0, status: 'active', created_at: '', count_weekly: false,
    ...over,
  }
}
const loc = (id: string, sort: number, active = true): StorageLocation =>
  ({ id, branch_id: 'b1', name: id.toUpperCase(), sort_order: sort, is_active: active, created_at: '' })

describe('packsLooseToBase', () => {
  it('adds packs times the rate to the loose amount', () => {
    expect(packsLooseToBase(3, 250, 1000)).toBe(3250)
  })
  it('treats a blank half as zero', () => {
    expect(packsLooseToBase(2, null, 1000)).toBe(2000)
    expect(packsLooseToBase(null, 40, 1000)).toBe(40)
  })
  it('returns null when both halves are blank', () => {
    expect(packsLooseToBase(null, null, 1000)).toBeNull()
  })
})

describe('baseToPacksLoose', () => {
  it('splits base units into whole packs and the rest', () => {
    expect(baseToPacksLoose(3250, 1000)).toEqual({ packs: 3, loose: 250 })
  })
  it('keeps everything in packs when the rate is 1', () => {
    expect(baseToPacksLoose(7, 1)).toEqual({ packs: 7, loose: 0 })
  })
  it('does not lose a pack to floating point', () => {
    expect(baseToPacksLoose(0.3 * 10, 0.1 * 10)).toEqual({ packs: 3, loose: 0 })
  })
})

describe('itemsForCount', () => {
  const items = [item('a', { count_weekly: true }), item('b'), item('c', { count_weekly: true, status: 'inactive' })]
  it('weekly = active key items', () => {
    expect(itemsForCount(items, 'weekly').map(i => i.id)).toEqual(['a'])
  })
  it('full = every active item', () => {
    expect(itemsForCount(items, 'full').map(i => i.id)).toEqual(['a', 'b'])
  })
})

describe('groupForCounting', () => {
  const items = [item('milk'), item('beans'), item('cups')]
  const locations = [loc('back', 2), loc('bar', 1), loc('old', 0, false)]
  const links: ItemLocation[] = [
    { item_id: 'milk', location_id: 'bar', sort_order: 2 },
    { item_id: 'beans', location_id: 'bar', sort_order: 1 },
    { item_id: 'milk', location_id: 'back', sort_order: 1 },
    { item_id: 'cups', location_id: 'old', sort_order: 1 },
  ]
  const groups = groupForCounting(items, locations, links)
  it('orders active locations by sort_order and puts Unassigned last', () => {
    expect(groups.map(g => g.key)).toEqual(['bar', 'back', UNASSIGNED])
  })
  it('orders items inside a location by their sort_order', () => {
    expect(groups[0].items.map(i => i.id)).toEqual(['beans', 'milk'])
  })
  it('lists an item in every location it sits in', () => {
    expect(groups[1].items.map(i => i.id)).toEqual(['milk'])
  })
  it('sends items only in inactive locations to Unassigned', () => {
    expect(groups[2]).toMatchObject({ label: 'Unassigned', locationId: null })
    expect(groups[2].items.map(i => i.id)).toEqual(['cups'])
  })
  it('drops Unassigned when it is empty', () => {
    expect(groupForCounting([item('milk')], locations, links).map(g => g.key)).toEqual(['bar', 'back'])
  })
})

describe('groupProgress', () => {
  it('counts items with an entry at that location', () => {
    const g = { key: 'bar', label: 'BAR', locationId: 'bar', items: [item('a'), item('b')] }
    const entries = new Map([[entryKey('a', 'bar'), 5], [entryKey('b', null), 2]])
    expect(groupProgress(g, entries)).toEqual({ done: 1, total: 2 })
  })
})

describe('uncountedItems', () => {
  it('returns items with no entry anywhere', () => {
    const entries = [{ item_id: 'a', location_id: 'bar', counted_base: 0 }] as StockCountEntry[]
    expect(uncountedItems([item('a'), item('b')], entries).map(i => i.id)).toEqual(['b'])
  })
})

describe('sortResultLines', () => {
  it('puts the biggest RM difference first, either sign, then by name', () => {
    const lines = [
      { name: 'b', variance_value: -2 }, { name: 'a', variance_value: 5 },
      { name: 'c', variance_value: -9 }, { name: 'd', variance_value: 2 },
    ]
    expect(sortResultLines(lines).map(l => l.name)).toEqual(['c', 'a', 'b', 'd'])
  })
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run src/shared/lib/stocktake.test.ts`
Expected: FAIL — `Failed to resolve import "./stocktake"`.

- [ ] **Step 3: Add the types**

In `src/shared/types/procurement.ts`, inside `export interface Item`, after `min_stock_alert: number`:

```ts
  /** Key item: counted in the weekly stock count. */
  count_weekly: boolean
```

Replace the `InventoryTransactionType` block and add the label:

```ts
export type InventoryTransactionType =
  | 'stock_in' | 'adjustment' | 'wastage' | 'transfer_out' | 'transfer_in'
  | 'production_out' | 'production_in' | 'stocktake'
```

In `TRANSACTION_TYPE_LABELS`, add the line `stocktake:      'Stock Count',` after `production_in`. Change the comment above the type from `/** Phase 2 will add sales / stocktake. */` to `/** Sales depletion comes with the POS. */`.

Append to the end of the file:

```ts
// ── Stocktake ────────────────────────────────────────────────────────────────

export interface StorageLocation {
  id: string
  branch_id: string
  name: string
  sort_order: number
  is_active: boolean
  created_at: string
}

export interface ItemLocation {
  item_id: string
  location_id: string
  sort_order: number
}

export type StockCountKind = 'weekly' | 'full'
export type StockCountStatus = 'in_progress' | 'submitted' | 'cancelled'

export const STOCK_COUNT_KIND_LABELS: Record<StockCountKind, string> = {
  weekly: 'Weekly',
  full:   'Full',
}

export interface StockCount {
  id: string
  branch_id: string
  kind: StockCountKind
  status: StockCountStatus
  started_by: string | null
  started_at: string
  submitted_by: string | null
  submitted_at: string | null
  business_date: string | null
  notes: string | null
  item_count: number | null
  gain_value: number | null
  loss_value: number | null
  net_value: number | null
}

export interface StockCountEntry {
  id: string
  count_id: string
  item_id: string
  /** null = Unassigned. */
  location_id: string | null
  /** Base units. */
  counted_base: number
  counted_by: string | null
  counted_at: string
}

export interface StockCountItem {
  count_id: string
  item_id: string
  counted_base: number
  expected_base: number
  variance_base: number
  unit_cost: number | null
  variance_value: number
  transaction_id: string | null
}
```

- [ ] **Step 4: Write the helpers**

Create `src/shared/lib/stocktake.ts`:

```ts
import type { Item, StorageLocation, ItemLocation, StockCountEntry, StockCountKind } from '../types'

export const UNASSIGNED = 'unassigned'

export interface CountGroup {
  key: string
  label: string
  /** null = Unassigned. */
  locationId: string | null
  items: Item[]
}

/** Packs + loose base units → base units. Both blank = not counted (null). */
export function packsLooseToBase(packs: number | null, loose: number | null, rate: number): number | null {
  if (packs == null && loose == null) return null
  return (packs ?? 0) * rate + (loose ?? 0)
}

/** Base units → whole packs and the rest, for showing a saved count. */
export function baseToPacksLoose(base: number, rate: number): { packs: number; loose: number } {
  if (rate === 1) return { packs: base, loose: 0 }
  const packs = Math.floor(base / rate + 1e-9)
  const loose = Math.round((base - packs * rate) * 1000) / 1000
  return { packs, loose: loose < 0 ? 0 : loose }
}

/** Items a count of this kind must cover: weekly = active key items, full = every active item. */
export function itemsForCount(items: Item[], kind: StockCountKind): Item[] {
  return items.filter(i => i.status === 'active' && (kind === 'full' || i.count_weekly))
}

/** Key for an item at a location (null location = Unassigned). */
export function entryKey(itemId: string, locationId: string | null): string {
  return `${itemId}:${locationId ?? UNASSIGNED}`
}

/**
 * Count list in walking order: active locations by sort_order, each with its
 * items by sort_order; items in no active location go to a final Unassigned group.
 */
export function groupForCounting(
  items: Item[], locations: StorageLocation[], itemLocations: ItemLocation[],
): CountGroup[] {
  const byId = new Map(items.map(i => [i.id, i]))
  const active = locations.filter(l => l.is_active).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  const placed = new Set<string>()
  const groups: CountGroup[] = active.map(l => {
    const links = itemLocations
      .filter(link => link.location_id === l.id && byId.has(link.item_id))
      .sort((a, b) => a.sort_order - b.sort_order)
    links.forEach(link => placed.add(link.item_id))
    return { key: l.id, label: l.name, locationId: l.id, items: links.map(link => byId.get(link.item_id)!) }
  }).filter(g => g.items.length > 0)
  const rest = items.filter(i => !placed.has(i.id)).sort((a, b) => a.name.localeCompare(b.name))
  if (rest.length > 0) groups.push({ key: UNASSIGNED, label: 'Unassigned', locationId: null, items: rest })
  return groups
}

/** How many items in the group have a number at that location. */
export function groupProgress(group: CountGroup, entries: Map<string, number>): { done: number; total: number } {
  const done = group.items.filter(i => entries.has(entryKey(i.id, group.locationId))).length
  return { done, total: group.items.length }
}

/** Items with no entry at any location — submit is blocked while any remain. */
export function uncountedItems(items: Item[], entries: StockCountEntry[]): Item[] {
  const counted = new Set(entries.map(e => e.item_id))
  return items.filter(i => !counted.has(i.id))
}

/** Biggest RM difference first (loss or gain), then by name. */
export function sortResultLines<T extends { variance_value: number; name: string }>(lines: T[]): T[] {
  return [...lines].sort((a, b) =>
    Math.abs(b.variance_value) - Math.abs(a.variance_value) || a.name.localeCompare(b.name))
}
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `npx vitest run src/shared/lib/stocktake.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Run the type check and full test suite**

Run: `npx tsc -b && npx vitest run`
Expected: no type errors (any test fixture that builds an `Item` literal without `count_weekly` must get `count_weekly: false` added); all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/procurement.ts src/shared/lib/stocktake.ts src/shared/lib/stocktake.test.ts
git commit -m "feat(stocktake): count types and helpers for packs/loose, grouping, progress"
```

---

### Task 3: Stock Count list page, routes and nav

**Files:**
- Create: `src/features/procurement/StockCounts.tsx`
- Modify: `src/App.tsx` (imports near line 41; routes after the `/procurement/wastage` route near line 392)
- Modify: `src/shared/lib/nav.ts:85`, `src/shared/lib/nav.test.ts:144-153,162`

**Interfaces:**
- Consumes: `useBranchPicker()` → `{ branches, branchId, setBranchId, allBranches, loaded, error, branchName, staffHasNoBranch }`; `StockCount`, `STOCK_COUNT_KIND_LABELS`; RPC `start_stock_count`.
- Produces: routes `/procurement/stock-counts`, `/procurement/stock-counts/setup`, `/procurement/stock-counts/:id`; default exports `StockCountsPage`, `StockCountSessionPage`, `StockCountSetupPage` (the last two are created in Tasks 4 and 5 — add their routes in this task with placeholder files that export a component rendering `null`, replaced later).

- [ ] **Step 1: Update the nav test first**

In `src/shared/lib/nav.test.ts`, in both expected lists insert `'proc-stockcount'` right after `'proc-wastage'`, and add to the "detail routes highlight their list page" test:

```ts
    expect(activeEntry(full, '/procurement/stock-counts/count-1')).toEqual({ leafId: 'proc-stockcount', groupId: 'inventory' })
```

Change the supervisor test title to `'shows supervisors (use_procurement only) orders, receiving, transfers, wastage, stock count, recipes and inventory, not master data'`.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/shared/lib/nav.test.ts`
Expected: FAIL — the lists lack `proc-stockcount`.

- [ ] **Step 3: Add the nav entry**

In `src/shared/lib/nav.ts`, after the `proc-wastage` line:

```ts
      { id: 'proc-stockcount', label: 'Stock Count', to: '/procurement/stock-counts', cap: 'use_procurement' },
```

Run: `npx vitest run src/shared/lib/nav.test.ts` → PASS.

- [ ] **Step 4: Create placeholder pages so routes compile**

```bash
for f in StockCountSession StockCountSetup; do
  printf 'export default function %sPage() {\n  return null\n}\n' "$f" > "src/features/procurement/$f.tsx"
done
```

- [ ] **Step 5: Write the list page**

Create `src/features/procurement/StockCounts.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useCan } from '../../shared/lib/permissions'
import { money } from '../../shared/lib/procurement'
import { useBranchPicker } from './useBranchPicker'
import type { StockCount, StockCountKind } from '../../shared/types'
import { STOCK_COUNT_KIND_LABELS } from '../../shared/types'

const selectCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

type CountRow = StockCount & { starter: { name: string } | null; entries: { count: number }[] }

export default function StockCountsPage() {
  const navigate = useNavigate()
  const { can } = useCan()
  const { branches, branchId, setBranchId, allBranches, loaded, error: branchError, staffHasNoBranch } = useBranchPicker()
  const [counts, setCounts] = useState<CountRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState<StockCountKind | null>(null)

  const load = useCallback(async () => {
    if (!branchId) return
    setLoading(true)
    const { data, error: err } = await supabase
      .from('stock_counts')
      .select('*, starter:staff!stock_counts_started_by_fkey(name), entries:stock_count_entries(count)')
      .eq('branch_id', branchId)
      .neq('status', 'cancelled')
      .order('started_at', { ascending: false })
      .limit(30)
    if (err) setError(err.message)
    setCounts((data as CountRow[]) ?? [])
    setLoading(false)
  }, [branchId])

  useEffect(() => { load() }, [load])

  async function start(kind: StockCountKind) {
    setStarting(kind)
    setError('')
    const { data, error: err } = await supabase.rpc('start_stock_count', { p_branch_id: branchId, p_kind: kind })
    setStarting(null)
    if (err) {
      const open = /\(([0-9a-f-]{36})\)/.exec(err.message)?.[1]
      if (open) { navigate(`/procurement/stock-counts/${open}`); return }
      setError(err.message)
      return
    }
    navigate(`/procurement/stock-counts/${(data as StockCount).id}`)
  }

  const open = counts.find(c => c.status === 'in_progress')
  const history = counts.filter(c => c.status === 'submitted')

  return (
    <div className="min-h-screen bg-cream-light px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-brown-dark">Stock Count</h1>
            <p className="text-xs text-brown-faint mt-0.5">Count what is on the shelf. Submitting sets stock on hand to your numbers.</p>
          </div>
          {can('manage_procurement') && (
            <Link to="/procurement/stock-counts/setup" className="text-xs font-semibold text-[#C4813A] whitespace-nowrap">
              Locations & key items
            </Link>
          )}
        </div>

        {allBranches && branches.length > 1 && (
          <select className={selectCls} value={branchId} onChange={e => setBranchId(e.target.value)} aria-label="Branch">
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}

        {(branchError || error) && <p className="text-sm text-red-700">{branchError || error}</p>}
        {loaded && staffHasNoBranch && (
          <p className="text-sm text-brown-muted">Your staff record has no branch. Ask a manager to set it.</p>
        )}

        {open ? (
          <Link
            to={`/procurement/stock-counts/${open.id}`}
            className="block bg-white rounded-xl border-2 border-[#C4813A] p-4"
          >
            <p className="text-xs font-semibold text-[#C4813A] uppercase tracking-wide">In progress</p>
            <p className="text-base font-bold text-brown-dark mt-1">{STOCK_COUNT_KIND_LABELS[open.kind]} count</p>
            <p className="text-xs text-brown-faint mt-0.5">
              Started {when(open.started_at)}{open.starter ? ` by ${open.starter.name}` : ''} · {open.entries[0]?.count ?? 0} entries saved
            </p>
            <p className="text-sm font-semibold text-brown-btn mt-3">Resume counting →</p>
          </Link>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {(['weekly', 'full'] as const).map(kind => (
              <button
                key={kind}
                type="button"
                disabled={!branchId || starting !== null}
                onClick={() => start(kind)}
                className="bg-white rounded-xl border border-[#E8DDD0] p-4 text-left active:bg-[#F5EDE0] disabled:opacity-50"
              >
                <p className="text-base font-bold text-brown-dark">
                  {starting === kind ? 'Starting…' : `Start ${kind} count`}
                </p>
                <p className="text-xs text-brown-faint mt-1">
                  {kind === 'weekly' ? 'Key items only' : 'Every item at this branch'}
                </p>
              </button>
            ))}
          </div>
        )}

        <section>
          <h2 className="text-sm font-bold text-brown-dark mb-2">History</h2>
          {loading ? (
            <p className="text-sm text-brown-faint">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-brown-faint">No counts submitted yet.</p>
          ) : (
            <ul className="space-y-2">
              {history.map(c => {
                const net = Number(c.net_value ?? 0)
                return (
                  <li key={c.id}>
                    <Link
                      to={`/procurement/stock-counts/${c.id}`}
                      className="flex items-center justify-between gap-3 bg-white rounded-xl border border-[#E8DDD0] px-4 py-3"
                    >
                      <div>
                        <p className="text-sm font-semibold text-brown-dark">
                          {STOCK_COUNT_KIND_LABELS[c.kind]} · {c.item_count ?? 0} items
                        </p>
                        <p className="text-xs text-brown-faint">
                          {c.submitted_at ? when(c.submitted_at) : ''}{c.starter ? ` · ${c.starter.name}` : ''}
                        </p>
                      </div>
                      <span className={`text-sm font-bold ${net < 0 ? 'text-red-700' : net > 0 ? 'text-green-700' : 'text-brown-muted'}`}>
                        {net < 0 ? '−' : net > 0 ? '+' : ''}{money(Math.abs(net))}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
```

The embed `staff!stock_counts_started_by_fkey` names the foreign key explicitly because `stock_counts` has two foreign keys to `staff` (`started_by`, `submitted_by`); Postgres names it `stock_counts_started_by_fkey` by default.

- [ ] **Step 6: Add the routes**

In `src/App.tsx`, next to `import WastagePage …`:

```tsx
import StockCountsPage from './features/procurement/StockCounts'
import StockCountSessionPage from './features/procurement/StockCountSession'
import StockCountSetupPage from './features/procurement/StockCountSetup'
```

After the `/procurement/wastage` `<Route … />` block:

```tsx
      <Route
        path="/procurement/stock-counts"
        element={
          <ProtectedRoute requireCap="use_procurement">
            <AppLayout><StockCountsPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/procurement/stock-counts/setup"
        element={
          <ProtectedRoute requireCap="manage_procurement">
            <AppLayout><StockCountSetupPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/procurement/stock-counts/:id"
        element={
          <ProtectedRoute requireCap="use_procurement">
            <AppLayout><StockCountSessionPage /></AppLayout>
          </ProtectedRoute>
        }
      />
```

- [ ] **Step 7: Type check, tests, commit**

Run: `npx tsc -b && npx vitest run`
Expected: no errors, all pass.

```bash
git add src/features/procurement/StockCounts.tsx src/features/procurement/StockCountSession.tsx src/features/procurement/StockCountSetup.tsx src/App.tsx src/shared/lib/nav.ts src/shared/lib/nav.test.ts
git commit -m "feat(stocktake): Stock Count list page, routes and nav entry"
```

---

### Task 4: Counting screen and result view

**Files:**
- Replace: `src/features/procurement/StockCountSession.tsx`
- Create: `src/features/procurement/StockCountResult.tsx`

**Interfaces:**
- Consumes: Task 2 helpers (`itemsForCount`, `groupForCounting`, `groupProgress`, `entryKey`, `packsLooseToBase`, `baseToPacksLoose`, `uncountedItems`, `sortResultLines`); RPCs `save_count_entry`, `submit_stock_count`, `cancel_stock_count`; `money`, `qty`, `packs` from `procurement.ts`.
- Produces: default export `StockCountSessionPage`; default export `StockCountResult({ count, branchName }: { count: StockCount; branchName: string })`.

- [ ] **Step 1: Write the result view**

Create `src/features/procurement/StockCountResult.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { money, qty, packs } from '../../shared/lib/procurement'
import { sortResultLines } from '../../shared/lib/stocktake'
import type { StockCount, StockCountItem, Item } from '../../shared/types'
import { STOCK_COUNT_KIND_LABELS } from '../../shared/types'

type Line = StockCountItem & { item: Pick<Item, 'name' | 'base_unit' | 'purchase_unit' | 'conversion_rate'> }

function signed(n: number, fmt: (v: number) => string): string {
  return `${n < 0 ? '−' : n > 0 ? '+' : ''}${fmt(Math.abs(n))}`
}

export default function StockCountResult({ count, branchName }: { count: StockCount; branchName: string }) {
  const [lines, setLines] = useState<Line[]>([])
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    supabase
      .from('stock_count_items')
      .select('*, item:items(name, base_unit, purchase_unit, conversion_rate)')
      .eq('count_id', count.id)
      .then(({ data, error: err }) => {
        if (err) setError(err.message)
        setLines((data as Line[]) ?? [])
      })
  }, [count.id])

  const sorted = sortResultLines(lines.map(l => ({ ...l, name: l.item.name, variance_value: Number(l.variance_value) })))
  const changed = sorted.filter(l => Number(l.variance_base) !== 0)
  const shown = showAll ? sorted : changed

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-brown-dark">{STOCK_COUNT_KIND_LABELS[count.kind]} count · {branchName}</h1>
        <p className="text-xs text-brown-faint mt-0.5">
          Submitted {count.submitted_at ? new Date(count.submitted_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }) : ''} · {count.item_count ?? 0} items. Stock on hand now matches these counts.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Loss', value: -Number(count.loss_value ?? 0) },
          { label: 'Gain', value: Number(count.gain_value ?? 0) },
          { label: 'Net', value: Number(count.net_value ?? 0) },
        ].map(t => (
          <div key={t.label} className="bg-white rounded-xl border border-[#E8DDD0] p-3 text-center">
            <p className="text-xs text-brown-faint">{t.label}</p>
            <p className={`text-base font-bold ${t.value < 0 ? 'text-red-700' : t.value > 0 ? 'text-green-700' : 'text-brown-dark'}`}>
              {signed(t.value, money)}
            </p>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-brown-dark">
          {showAll ? 'All items' : `${changed.length} item${changed.length === 1 ? '' : 's'} with a difference`}
        </h2>
        <button type="button" onClick={() => setShowAll(v => !v)} className="text-xs font-semibold text-[#C4813A]">
          {showAll ? 'Only differences' : 'Show all'}
        </button>
      </div>

      <ul className="space-y-2">
        {shown.map(l => {
          const v = Number(l.variance_base)
          return (
            <li key={l.item_id} className="bg-white rounded-xl border border-[#E8DDD0] px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-brown-dark">{l.item.name}</p>
                <span className={`text-sm font-bold whitespace-nowrap ${l.variance_value < 0 ? 'text-red-700' : l.variance_value > 0 ? 'text-green-700' : 'text-brown-muted'}`}>
                  {signed(l.variance_value, money)}
                </span>
              </div>
              <p className="text-xs text-brown-faint mt-1">
                Counted {qty(Number(l.counted_base))} {l.item.base_unit} · Expected {qty(Number(l.expected_base))} {l.item.base_unit} ·{' '}
                <span className={v < 0 ? 'text-red-700' : v > 0 ? 'text-green-700' : ''}>
                  {signed(v, n => `${qty(n)} ${l.item.base_unit}`)}
                  {l.item.conversion_rate !== 1 && ` (${signed(v, n => `${packs(n, l.item.conversion_rate)} ${l.item.purchase_unit}`)})`}
                </span>
              </p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
```

- [ ] **Step 2: Write the counting screen**

Replace `src/features/procurement/StockCountSession.tsx`:

```tsx
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import {
  itemsForCount, groupForCounting, groupProgress, entryKey, packsLooseToBase, baseToPacksLoose, uncountedItems,
} from '../../shared/lib/stocktake'
import { qty } from '../../shared/lib/procurement'
import type { Item, StorageLocation, ItemLocation, StockCount, StockCountEntry, Branch } from '../../shared/types'
import { STOCK_COUNT_KIND_LABELS } from '../../shared/types'
import StockCountResult from './StockCountResult'

const numCls =
  'w-20 h-11 px-2 rounded-xl border border-[#E8DDD0] bg-[#FDFAF6] text-center text-base font-bold text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

function parse(v: string): number | null {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

/** One item at one location: packs + loose, saved on blur. Never shows system stock. */
function CountRow({ item, locationId, saved, onSave }: {
  item: Item
  locationId: string | null
  saved: number | undefined
  onSave: (itemId: string, locationId: string | null, base: number | null) => Promise<void>
}) {
  const rate = Number(item.conversion_rate)
  const single = rate === 1
  const start = saved == null ? null : baseToPacksLoose(saved, rate)
  const [packsText, setPacksText] = useState(start ? String(start.packs) : '')
  const [looseText, setLooseText] = useState(start && start.loose ? String(start.loose) : '')
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')

  async function commit() {
    const p = parse(packsText)
    const l = single ? null : parse(looseText)
    if (Number.isNaN(p) || Number.isNaN(l)) { setState('error'); return }
    const base = packsLooseToBase(p, l, rate)
    if (base === (saved ?? null)) return
    setState('saving')
    try {
      await onSave(item.id, locationId, base)
      setState('idle')
    } catch {
      setState('error')
    }
  }

  return (
    <div className={`bg-white rounded-xl border px-4 py-3 ${saved != null ? 'border-[#B9D7B0]' : 'border-[#E8DDD0]'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-brown-dark">{item.name}</p>
          <p className="text-xs text-brown-faint">
            {single ? item.base_unit : `1 ${item.purchase_unit} = ${qty(rate)} ${item.base_unit}`}
          </p>
        </div>
        <span className="text-xs font-semibold whitespace-nowrap">
          {state === 'saving' ? <span className="text-brown-faint">Saving…</span>
            : state === 'error' ? <span className="text-red-700">Not saved</span>
            : saved != null ? <span className="text-green-700">✓ {qty(saved)} {item.base_unit}</span>
            : null}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-2">
        <input
          type="text" inputMode="decimal" className={numCls} value={packsText}
          aria-label={`${item.name} ${single ? item.base_unit : item.purchase_unit}`}
          onChange={e => setPacksText(e.target.value)} onBlur={commit} onFocus={e => e.target.select()}
        />
        <span className="text-xs text-brown-muted">{single ? item.base_unit : item.purchase_unit}</span>
        {!single && (
          <>
            <span className="text-brown-faint">+</span>
            <input
              type="text" inputMode="decimal" className={numCls} value={looseText}
              aria-label={`${item.name} loose ${item.base_unit}`}
              onChange={e => setLooseText(e.target.value)} onBlur={commit} onFocus={e => e.target.select()}
            />
            <span className="text-xs text-brown-muted">{item.base_unit}</span>
          </>
        )}
      </div>
    </div>
  )
}

export default function StockCountSessionPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { staff } = useAuth()
  const [count, setCount] = useState<StockCount | null>(null)
  const [branch, setBranch] = useState<Branch | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [links, setLinks] = useState<ItemLocation[]>([])
  const [entries, setEntries] = useState<StockCountEntry[]>([])
  const [tab, setTab] = useState<string>('')
  const [onlyGaps, setOnlyGaps] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!id) return
    const { data: c, error: cErr } = await supabase.from('stock_counts').select('*').eq('id', id).maybeSingle()
    if (cErr || !c) { setError(cErr?.message ?? 'Count not found'); setLoading(false); return }
    const sc = c as StockCount
    const [bRes, iRes, lRes, eRes] = await Promise.all([
      supabase.from('branches').select('*').eq('id', sc.branch_id).maybeSingle(),
      supabase.from('items').select('*').eq('status', 'active').order('name'),
      supabase.from('storage_locations').select('*').eq('branch_id', sc.branch_id),
      supabase.from('stock_count_entries').select('*').eq('count_id', sc.id),
    ])
    const locs = (lRes.data as StorageLocation[]) ?? []
    const linkRes = locs.length
      ? await supabase.from('item_locations').select('*').in('location_id', locs.map(l => l.id))
      : { data: [], error: null }
    setCount(sc)
    setBranch((bRes.data as Branch) ?? null)
    setItems((iRes.data as Item[]) ?? [])
    setLocations(locs)
    setLinks((linkRes.data as ItemLocation[]) ?? [])
    setEntries((eRes.data as StockCountEntry[]) ?? [])
    setError(iRes.error?.message ?? eRes.error?.message ?? '')
    setLoading(false)
  }, [id])

  useEffect(() => { load() }, [load])

  const countItems = useMemo(() => (count ? itemsForCount(items, count.kind) : []), [items, count])
  const groups = useMemo(() => groupForCounting(countItems, locations, links), [countItems, locations, links])
  const entryMap = useMemo(
    () => new Map(entries.map(e => [entryKey(e.item_id, e.location_id), Number(e.counted_base)])), [entries])
  const missing = useMemo(() => uncountedItems(countItems, entries), [countItems, entries])
  const activeTab = groups.some(g => g.key === tab) ? tab : groups[0]?.key ?? ''
  const group = groups.find(g => g.key === activeTab)

  async function saveEntry(itemId: string, locationId: string | null, base: number | null) {
    const { error: err } = await supabase.rpc('save_count_entry', {
      p_count_id: id, p_item_id: itemId, p_location_id: locationId, p_counted_base: base,
    })
    if (err) { setError(err.message); throw err }
    setEntries(prev => {
      const rest = prev.filter(e => !(e.item_id === itemId && e.location_id === locationId))
      if (base == null) return rest
      return [...rest, {
        id: '', count_id: id!, item_id: itemId, location_id: locationId, counted_base: base,
        counted_by: staff?.id ?? null, counted_at: new Date().toISOString(),
      }]
    })
  }

  async function submit() {
    setBusy(true)
    setError('')
    const { data, error: err } = await supabase.rpc('submit_stock_count', { p_count_id: id })
    setBusy(false)
    setConfirming(false)
    if (err) { setError(err.message); load(); return }
    setCount(data as StockCount)
  }

  async function cancel() {
    if (!window.confirm('Cancel this count? Numbers entered so far are discarded and stock is not changed.')) return
    const { error: err } = await supabase.rpc('cancel_stock_count', { p_count_id: id })
    if (err) { setError(err.message); return }
    navigate('/procurement/stock-counts')
  }

  if (loading) return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  if (!count) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8 text-center">
        <p className="text-sm text-brown-muted">{error || 'Count not found.'}</p>
        <Link to="/procurement/stock-counts" className="text-sm text-[#C4813A] font-semibold">← Stock Count</Link>
      </div>
    )
  }

  if (count.status !== 'in_progress') {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-6">
        <div className="max-w-2xl mx-auto space-y-3">
          <Link to="/procurement/stock-counts" className="text-sm text-brown-muted">← Stock Count</Link>
          {count.status === 'cancelled'
            ? <p className="text-sm text-brown-muted">This count was cancelled. Stock was not changed.</p>
            : <StockCountResult count={count} branchName={branch?.name ?? ''} />}
        </div>
      </div>
    )
  }

  const done = countItems.length - missing.length
  const shownItems = group
    ? (onlyGaps ? group.items.filter(i => !entryMap.has(entryKey(i.id, group.locationId))) : group.items)
    : []

  return (
    <div className="min-h-screen bg-cream-light pb-36">
      <div className="max-w-2xl mx-auto px-4 pt-6 space-y-3">
        <Link to="/procurement/stock-counts" className="text-sm text-brown-muted">← Stock Count</Link>
        <div>
          <h1 className="text-xl font-bold text-brown-dark">{STOCK_COUNT_KIND_LABELS[count.kind]} count</h1>
          <p className="text-xs text-brown-faint">{branch?.name} · Count what is there; system stock is hidden until you submit.</p>
        </div>

        {countItems.length === 0 ? (
          <p className="text-sm text-brown-muted bg-white rounded-xl border border-[#E8DDD0] p-4">
            {count.kind === 'weekly'
              ? 'No key items yet. A manager marks key items under Locations & key items.'
              : 'There are no active items to count.'}
          </p>
        ) : (
          <>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4">
              {groups.map(g => {
                const p = groupProgress(g, entryMap)
                const on = g.key === activeTab
                return (
                  <button
                    key={g.key} type="button" onClick={() => setTab(g.key)}
                    className={`px-3 py-2 rounded-full text-xs font-semibold whitespace-nowrap border ${
                      on ? 'bg-[#C4813A] border-[#C4813A] text-white' : 'bg-white border-[#D4C5B0] text-brown-medium'}`}
                  >
                    {g.label} · {p.done}/{p.total}
                  </button>
                )
              })}
            </div>
            <label className="flex items-center gap-2 text-xs text-brown-muted">
              <input type="checkbox" checked={onlyGaps} onChange={e => setOnlyGaps(e.target.checked)} />
              Not counted only
            </label>
            <div className="space-y-2">
              {group && shownItems.map(i => (
                <CountRow
                  key={entryKey(i.id, group.locationId)}
                  item={i}
                  locationId={group.locationId}
                  saved={entryMap.get(entryKey(i.id, group.locationId))}
                  onSave={saveEntry}
                />
              ))}
              {group && shownItems.length === 0 && (
                <p className="text-sm text-brown-faint text-center py-4">Everything here is counted.</p>
              )}
            </div>
            <button type="button" onClick={cancel} className="text-xs text-brown-faint underline pt-2">Cancel this count</button>
          </>
        )}
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>

      {countItems.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 bg-white border-t border-[#E8DDD0] px-4 py-3">
          <div className="max-w-2xl mx-auto">
            {confirming ? (
              <div className="space-y-2">
                <p className="text-sm text-brown-dark">
                  Stock on hand at {branch?.name} will be set to these counts for {countItems.length} items. This cannot be undone.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setConfirming(false)} className="h-12 rounded-xl border border-[#D4C5B0] text-sm font-semibold text-brown-medium">
                    Keep counting
                  </button>
                  <button type="button" onClick={submit} disabled={busy} className="h-12 rounded-xl bg-brown-btn text-white text-sm font-bold disabled:opacity-50">
                    {busy ? 'Submitting…' : 'Submit count'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex justify-between text-xs text-brown-muted mb-2">
                  <span>{done} of {countItems.length} items counted</span>
                  {missing.length > 0 && <span>{missing.length} to go</span>}
                </div>
                <button
                  type="button" disabled={missing.length > 0} onClick={() => setConfirming(true)}
                  className="w-full h-12 rounded-xl bg-brown-btn text-white text-sm font-bold disabled:opacity-40"
                >
                  Submit count
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Type check, tests, commit**

Run: `npx tsc -b && npx vitest run`
Expected: no errors, all pass.

```bash
git add src/features/procurement/StockCountSession.tsx src/features/procurement/StockCountResult.tsx
git commit -m "feat(stocktake): blind counting screen by location and the result view"
```

---

### Task 5: Setup screen — locations, items per location, key items

**Files:**
- Replace: `src/features/procurement/StockCountSetup.tsx`

**Interfaces:**
- Consumes: `useBranchPicker`; RPCs `save_storage_location`, `set_location_items`, `set_item_count_weekly`; `StorageLocation`, `ItemLocation`, `Item`.
- Produces: default export `StockCountSetupPage`.

- [ ] **Step 1: Write the setup screen**

Replace `src/features/procurement/StockCountSetup.tsx`:

```tsx
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useBranchPicker } from './useBranchPicker'
import type { Item, StorageLocation, ItemLocation } from '../../shared/types'

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'

type Panel = { kind: 'location'; location: StorageLocation } | { kind: 'key' } | null

export default function StockCountSetupPage() {
  const { branches, branchId, setBranchId, allBranches } = useBranchPicker()
  const [locations, setLocations] = useState<StorageLocation[]>([])
  const [links, setLinks] = useState<ItemLocation[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [newName, setNewName] = useState('')
  const [panel, setPanel] = useState<Panel>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!branchId) return
    const [lRes, iRes] = await Promise.all([
      supabase.from('storage_locations').select('*').eq('branch_id', branchId).order('sort_order').order('name'),
      supabase.from('items').select('*').eq('status', 'active').order('name'),
    ])
    const locs = (lRes.data as StorageLocation[]) ?? []
    const linkRes = locs.length
      ? await supabase.from('item_locations').select('*').in('location_id', locs.map(l => l.id))
      : { data: [], error: null }
    setLocations(locs)
    setItems((iRes.data as Item[]) ?? [])
    setLinks((linkRes.data as ItemLocation[]) ?? [])
    setError(lRes.error?.message ?? iRes.error?.message ?? '')
  }, [branchId])

  useEffect(() => { load() }, [load])

  async function rpc(fn: string, args: Record<string, unknown>) {
    setBusy(true)
    setError('')
    const { error: err } = await supabase.rpc(fn, args)
    setBusy(false)
    if (err) { setError(err.message); return false }
    return true
  }

  async function addLocation() {
    const name = newName.trim()
    if (!name) return
    const next = locations.reduce((m, l) => Math.max(m, l.sort_order), -1) + 1
    if (await rpc('save_storage_location', { p_id: null, p_branch_id: branchId, p_name: name, p_sort_order: next, p_is_active: true })) {
      setNewName('')
      load()
    }
  }

  async function saveLocation(l: StorageLocation, patch: Partial<StorageLocation>) {
    const merged = { ...l, ...patch }
    if (await rpc('save_storage_location', {
      p_id: l.id, p_branch_id: branchId, p_name: merged.name, p_sort_order: merged.sort_order, p_is_active: merged.is_active,
    })) load()
  }

  async function move(index: number, dir: -1 | 1) {
    const active = locations.filter(l => l.is_active)
    const a = active[index]
    const b = active[index + dir]
    if (!a || !b) return
    // Renumber the whole list so equal sort_orders cannot stall a move.
    const order = active.map(l => l.id)
    order[index] = b.id
    order[index + dir] = a.id
    for (const [i, lid] of order.entries()) {
      const loc = active.find(l => l.id === lid)!
      if (loc.sort_order !== i) {
        const ok = await rpc('save_storage_location', {
          p_id: loc.id, p_branch_id: branchId, p_name: loc.name, p_sort_order: i, p_is_active: true,
        })
        if (!ok) break
      }
    }
    load()
  }

  function openLocation(l: StorageLocation) {
    setPicked(links.filter(x => x.location_id === l.id).sort((x, y) => x.sort_order - y.sort_order).map(x => x.item_id))
    setSearch('')
    setPanel({ kind: 'location', location: l })
  }

  async function saveLocationItems() {
    if (panel?.kind !== 'location') return
    if (await rpc('set_location_items', { p_location_id: panel.location.id, p_item_ids: picked })) {
      setPanel(null)
      load()
    }
  }

  async function toggleKey(item: Item) {
    if (await rpc('set_item_count_weekly', { p_item_id: item.id, p_value: !item.count_weekly })) {
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, count_weekly: !i.count_weekly } : i)))
    }
  }

  const filtered = useMemo(
    () => items.filter(i => i.name.toLowerCase().includes(search.trim().toLowerCase())), [items, search])
  const active = locations.filter(l => l.is_active)
  const inactive = locations.filter(l => !l.is_active)
  const keyCount = items.filter(i => i.count_weekly).length

  if (panel) {
    const isKey = panel.kind === 'key'
    return (
      <div className="min-h-screen bg-cream-light pb-28">
        <div className="max-w-2xl mx-auto px-4 pt-6 space-y-3">
          <button type="button" onClick={() => setPanel(null)} className="text-sm text-brown-muted">← Back</button>
          <h1 className="text-xl font-bold text-brown-dark">{isKey ? 'Key items' : panel.location.name}</h1>
          <p className="text-xs text-brown-faint">
            {isKey
              ? 'Key items are counted every week. Tap to switch. Applies to every branch.'
              : 'Tick the items kept here. They are counted in the order you tick them.'}
          </p>
          <input className={inputCls} placeholder="Search items" value={search} onChange={e => setSearch(e.target.value)} />
          <ul className="space-y-1">
            {filtered.map(i => {
              const on = isKey ? i.count_weekly : picked.includes(i.id)
              return (
                <li key={i.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => (isKey
                      ? toggleKey(i)
                      : setPicked(p => (p.includes(i.id) ? p.filter(x => x !== i.id) : [...p, i.id])))}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-left ${
                      on ? 'bg-[#FBF1E4] border-[#C4813A]' : 'bg-white border-[#E8DDD0]'}`}
                  >
                    <span className="text-sm text-brown-dark">{i.name}</span>
                    <span className="text-sm font-bold text-[#C4813A]">
                      {on ? (isKey ? '★' : `✓ ${picked.indexOf(i.id) + 1}`) : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>
        {!isKey && (
          <div className="fixed bottom-0 inset-x-0 bg-white border-t border-[#E8DDD0] px-4 py-3">
            <div className="max-w-2xl mx-auto">
              <button type="button" disabled={busy} onClick={saveLocationItems}
                className="w-full h-12 rounded-xl bg-brown-btn text-white text-sm font-bold disabled:opacity-50">
                Save {picked.length} item{picked.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-cream-light px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <Link to="/procurement/stock-counts" className="text-sm text-brown-muted">← Stock Count</Link>
        <h1 className="text-xl font-bold text-brown-dark">Locations & key items</h1>

        {allBranches && branches.length > 1 && (
          <select className={inputCls} value={branchId} onChange={e => setBranchId(e.target.value)} aria-label="Branch">
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}

        <button type="button" onClick={() => { setSearch(''); setPanel({ kind: 'key' }) }}
          className="w-full flex items-center justify-between bg-white rounded-xl border border-[#E8DDD0] px-4 py-3">
          <span className="text-sm font-semibold text-brown-dark">Key items (counted weekly)</span>
          <span className="text-sm text-brown-muted">{keyCount} →</span>
        </button>

        <section className="space-y-2">
          <h2 className="text-sm font-bold text-brown-dark">Storage locations — walking order</h2>
          {active.length === 0 && <p className="text-sm text-brown-faint">No locations yet. Add them in the order you walk the store.</p>}
          {active.map((l, idx) => {
            const n = links.filter(x => x.location_id === l.id).length
            return (
              <div key={l.id} className="flex items-center gap-2 bg-white rounded-xl border border-[#E8DDD0] px-3 py-2">
                <div className="flex flex-col">
                  <button type="button" aria-label={`Move ${l.name} up`} disabled={busy || idx === 0} onClick={() => move(idx, -1)}
                    className="w-8 h-6 text-brown-btn disabled:opacity-30">▲</button>
                  <button type="button" aria-label={`Move ${l.name} down`} disabled={busy || idx === active.length - 1} onClick={() => move(idx, 1)}
                    className="w-8 h-6 text-brown-btn disabled:opacity-30">▼</button>
                </div>
                <button type="button" onClick={() => openLocation(l)} className="flex-1 text-left">
                  <p className="text-sm font-semibold text-brown-dark">{l.name}</p>
                  <p className="text-xs text-brown-faint">{n} item{n === 1 ? '' : 's'} · tap to choose</p>
                </button>
                <button type="button" className="text-xs text-brown-faint px-2" disabled={busy}
                  onClick={() => {
                    const name = window.prompt('Rename location', l.name)
                    if (name && name.trim() && name.trim() !== l.name) saveLocation(l, { name: name.trim() })
                  }}>
                  Rename
                </button>
                <button type="button" className="text-xs text-red-700 px-2" disabled={busy}
                  onClick={() => saveLocation(l, { is_active: false })}>
                  Remove
                </button>
              </div>
            )
          })}
          <div className="flex gap-2">
            <input className={inputCls} placeholder="New location, e.g. Chiller 1" value={newName}
              onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addLocation() }} />
            <button type="button" disabled={busy || !newName.trim()} onClick={addLocation}
              className="px-4 rounded-lg bg-brown-btn text-white text-sm font-semibold disabled:opacity-50">
              Add
            </button>
          </div>
          {inactive.length > 0 && (
            <p className="text-xs text-brown-faint">
              Removed: {inactive.map((l, i) => (
                <span key={l.id}>
                  {i > 0 && ', '}
                  <button type="button" className="underline" onClick={() => saveLocation(l, { is_active: true })}>{l.name}</button>
                </span>
              ))} (tap to restore)
            </p>
          )}
        </section>
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Type check, tests, commit**

Run: `npx tsc -b && npx vitest run`
Expected: no errors, all pass.

```bash
git add src/features/procurement/StockCountSetup.tsx
git commit -m "feat(stocktake): setup screen for locations, items per location and key items"
```

---

### Task 6: Browser check on dev at phone size

**Files:** none (verification only; fixes go back into the files above, each with its own commit).

- [ ] **Step 1: Start the dev preview**

Use the `inventory-v2-dev-proxy` pattern: add a launch entry `stocktake-dev-proxy` to the main checkout's `.claude/launch.json` that runs this worktree with the git-excluded proxy config:

```json
{
  "name": "stocktake-dev-proxy",
  "runtimeExecutable": "bash",
  "runtimeArgs": ["-c", "cd /Users/USER/Desktop/Craft_OS/.claude/worktrees/stocktake && cp -n ../inventory-v2/vite.proxy.local.mjs . && cp -n ../inventory-v2/.env.local . ; VITE_SUPABASE_URL=http://localhost:5185/sb npx vite --config vite.proxy.local.mjs --host 127.0.0.1 --port 5185 --strictPort"],
  "port": 5185
}
```

Before starting: `grep -c egznnbjmicebbhwasloy .env.local` must be ≥ 1 and `grep -c yfsoesxzurzjdwstszru .env.local` must be 0 (dev only). Confirm `vite.proxy.local.mjs` is git-excluded (`git check-ignore -v vite.proxy.local.mjs` or add it to `.git/info/exclude`), and add `.env.local` to the exclude too if `git status` lists it. If `node_modules` is missing, `npm ci`.

- [ ] **Step 2: Sign in as a [TEST] manager, then set up**

Sign in with the scratchpad `devlogin.sh <email>` → `setSession` snippet. As a [TEST] manager (Cheras), open `/procurement/stock-counts/setup` at the mobile viewport: add "[TEST] Bar Chiller" and "[TEST] Dry Store", reorder them, tick 3 items into each (one item in both), and mark 4 items as key items.

Expected: counts per location update; a duplicate name shows "A location called … already exists".

- [ ] **Step 3: Count as the [TEST] Cheras supervisor**

Switch to `test.supervisor.cheras@craftale.test`. Open Stock Count → **Start weekly count**. Check: no system quantity shown anywhere; tabs show `n/total`; entering 2 packs + 150 shows "✓ <base>"; reload keeps the numbers; **Submit count** stays disabled until every key item has a number; "Not counted only" hides counted rows.

- [ ] **Step 4: Submit and read the result**

Submit → confirm sheet → Submit. Expected: result view with Loss / Gain / Net and lines sorted by RM; Stock on Hand (`/procurement/inventory`) for those items now equals the counted totals; the Stock Count list shows the count in History.

- [ ] **Step 5: Guard rails**

Start a full count, then from the list page tap Start again — expected: it opens the in-progress count instead. Cancel it — expected: back on the list, stock unchanged. As the supervisor, `/procurement/stock-counts/setup` must be refused by `ProtectedRoute`.

- [ ] **Step 6: Clean up dev test rows and push**

The [TEST] locations created in Step 2 can stay on dev. Then:

```bash
git push origin feature/stocktake
```

Report the screenshots of the counting screen and result view to the owner.
