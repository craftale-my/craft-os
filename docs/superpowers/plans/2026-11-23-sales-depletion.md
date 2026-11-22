# POS Sales Depletion and Usage Variance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every paid POS bill deducts its ingredients from stock (by menu and add-on recipes), and each submitted stock count shows "Since last count": sold vs wasted vs unexplained loss per ingredient in RM.

**Architecture:** An AFTER UPDATE trigger on `bills` calls an internal `deplete_bill` when a bill becomes `paid`; it writes one `sale` ledger row per ingredient and a `bill_depletions` marker, and never blocks checkout. Report functions read the ledger between the previous and current submitted stock count. The stock count result view gains a "Since last count" section.

**Tech Stack:** React + Vite + TypeScript + Tailwind, Supabase (Postgres, RLS, plpgsql), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-sales-depletion-design.md`

## Global Constraints

- Work only in `/Users/USER/Desktop/Craft_OS/.claude/worktrees/sales-depletion` (branch `feature/sales-depletion`). Never run git in `/Users/USER/Desktop/Craft_OS`. Do not push.
- SQL runs on **dev only** (`egznnbjmicebbhwasloy`) with `/private/tmp/claude-502/-Users-USER-Desktop-Craft-OS/2516e557-a088-40fb-85bf-3cbf7812eda7/scratchpad/devsql.sh <file.sql>` (one file = one transaction; a response containing `"message"` is an error). Never touch prod (`yfsoesxzurzjdwstszru`).
- Deduct when a bill becomes `paid`, only `order_items` with `voided_at is null`. Refunds never return stock. No back-fill of bills already paid.
- Depletion must never block checkout (errors are caught and recorded in `bill_depletions`).
- Ledger type `sale`; the transaction-type constraint must keep all existing types: `stock_in`, `adjustment`, `wastage`, `transfer_out`, `transfer_in`, `production_out`, `production_in`, `stocktake`.
- Report access = stock count access: `has_procurement_cap('use_procurement')` and `can_access_branch(branch)`.
- Internal functions (`deplete_bill`, `stock_count_usage_period`, trigger function) are revoked from `public, anon, authenticated`; client RPCs are revoked from `public, anon` and granted to `authenticated`. Every SECURITY DEFINER function sets `search_path = public, pg_temp`.
- All UI copy in English. Tests: `VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run`.
- Commit after every task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|------|----------------|
| (merge) | Task 1 brings `main` (stocktake) in |
| `supabase/migration-2026-11-23-sales-depletion.sql` | `sale` type, `bill_depletions`, `deplete_bill`, trigger |
| `supabase/migration-2026-11-23-stock-count-usage.sql` | Report functions |
| `supabase/VERIFY-2026-11-23-sales-depletion.sql` | Dev checks for both migrations (rolls back) |
| `src/shared/lib/stockUsage.ts` (+ `.test.ts`) | Pure helpers for the usage section |
| `src/shared/types/procurement.ts` | `'sale'` type label, usage row types |
| `src/features/procurement/StockCountUsage.tsx` | "Since last count" section |
| `src/features/procurement/StockCountResult.tsx` | Renders `StockCountUsage` |

---

### Task 1: Merge `main` (stocktake) into the branch

**Files:** the merge; one expected conflict in `src/shared/lib/nav.test.ts`.

**Interfaces:**
- Produces: a branch with menu costing (POS + `menu_variant_recipe_lines`, `modifier_recipe_lines`) and stocktake (`stock_counts`, `stock_count_items`, `StockCountResult.tsx`, nav `proc-stockcount`).

- [ ] **Step 1: Merge**

```bash
cd /Users/USER/Desktop/Craft_OS/.claude/worktrees/sales-depletion
git fetch -q origin
git merge --no-ff origin/main -m "merge main (stocktake) into feature/sales-depletion"
```
Expected: `CONFLICT (content): Merge conflict in src/shared/lib/nav.test.ts`.

- [ ] **Step 2: Resolve by keeping both nav entries**

Both sides added an inventory entry: main `proc-stockcount` (after `proc-wastage`, cap `use_procurement`), this branch `proc-menu-costing` (after `proc-recipes`, cap `manage_procurement`). In `nav.test.ts` keep every test from both sides; expected lists must match the merged `src/shared/lib/nav.ts` (read it — it auto-merged): supervisors see `proc-stockcount` but not `proc-menu-costing`; managers see both. Keep both `activeEntry` assertions (`/procurement/stock-counts/…` → `proc-stockcount`, `/procurement/menu-costing/…` → `proc-menu-costing`). `git add src/shared/lib/nav.test.ts`.

- [ ] **Step 3: Install, type-check, test, commit**

```bash
npm ci
npx tsc -b
VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run
git commit --no-edit
```
Expected: tsc silent; all tests pass. If the merge commit message lacks the Co-Authored-By line, amend it in.

---

### Task 2: Depletion on payment (dev)

**Files:**
- Create: `supabase/VERIFY-2026-11-23-sales-depletion.sql` (part A)
- Create: `supabase/migration-2026-11-23-sales-depletion.sql`

**Interfaces:**
- Consumes (on dev): `bills(id, branch_id, bill_no, status, …)`, `orders`, `order_items(bill_id, variant_id, qty, modifiers_snapshot jsonb [{optionId,…}], voided_at)`, `menu_variant_recipe_lines(variant_id, item_id, qty_base)`, `modifier_recipe_lines(option_id, item_id, qty_base)`, `inventory_transactions` (+ its `stamp_inventory_unit_cost` trigger), `has_procurement_cap`, `can_access_branch`.
- Produces: table `bill_depletions(bill_id pk, branch_id, depleted_at, status 'done'|'error', error, lines_without_recipe)`; internal `deplete_bill(uuid) returns void`; trigger `bills_deplete_on_paid`; ledger type `sale`.

- [ ] **Step 1: Write VERIFY part A (failing test)**

Create `supabase/VERIFY-2026-11-23-sales-depletion.sql`:

```sql
-- ============================================================================
-- VERIFY — POS sales depletion + stock count usage (2026-11-23). DEV ONLY.
-- Builds a [TEST] item, menu variant, add-ons and bills at Cheras, then always
-- raises its report so every change rolls back. Last line: VERIFY OK/FAILED.
-- ============================================================================
do $verify$
declare
  c_cheras  constant uuid := '75bb97bb-dedb-4aee-b326-373fd883780e';
  c_manager constant uuid := '193e1294-9c20-4425-b796-1cbff287e7a5';  -- test.manager.cheras
  v_out text := ''; v_fail boolean := false; v_ok boolean;
  v_a uuid; v_cat uuid; v_prod uuid; v_var uuid; v_var_norecipe uuid; v_grp uuid; v_opt_add uuid; v_opt_swap uuid;
  v_bill uuid; v_bill2 uuid; v_bill3 uuid; v_order uuid; v_n int; v_q numeric; v_row record;
  v_c1 uuid; v_c2 uuid; v_sum jsonb;
begin
  -- Fixture (as postgres) -------------------------------------------------------
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] SD Beans', 'raw', 'pack', 'g', 1000, 50) returning id into v_a;           -- RM 0.05/g
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type)
  values (v_a, c_cheras, 'stock_in', 5000, 0.05, 'manual');
  insert into menu_categories (name) values ('[TEST] SD Cat') returning id into v_cat;
  insert into menu_products (name, category_id) values ('[TEST] SD Latte', v_cat) returning id into v_prod;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'hot', 'Hot', 1000) returning id into v_var;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'none', 'No recipe', 1000) returning id into v_var_norecipe;
  insert into menu_variant_recipe_lines (variant_id, item_id, qty_base) values (v_var, v_a, 100);
  insert into modifier_groups (name) values ('[TEST] SD Extras') returning id into v_grp;
  insert into modifier_options (group_id, name) values (v_grp, 'Extra shot') returning id into v_opt_add;
  insert into modifier_options (group_id, name) values (v_grp, 'Decaf swap') returning id into v_opt_swap;
  insert into modifier_recipe_lines (option_id, item_id, qty_base) values (v_opt_add, v_a, 50), (v_opt_swap, v_a, -20);

  -- Bill 1: 2 x Hot + Extra shot (2*(100+50)=300), 1 x Hot + Decaf swap (100-20=80), 1 voided Hot (0),
  --         1 x No recipe (0, counted as without recipe)  => sale -380
  insert into bills (branch_id, bill_no, order_type) values (c_cheras, '[TEST]SD-1', 'dine_in') returning id into v_bill;
  insert into orders (bill_id, branch_id, order_no, source, client_order_id)
  values (v_bill, c_cheras, 1, 'counter', gen_random_uuid()) returning id into v_order;
  insert into order_items (order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, qty, order_type, modifiers_snapshot, voided_at)
  values
    (v_order, v_bill, v_prod, v_var, 'SD Latte', 1000, 600, 2, 'dine_in', jsonb_build_array(jsonb_build_object('optionId', v_opt_add, 'name', 'Extra shot')), null),
    (v_order, v_bill, v_prod, v_var, 'SD Latte', 1000, 600, 1, 'dine_in', jsonb_build_array(jsonb_build_object('optionId', v_opt_swap, 'name', 'Decaf swap')), null),
    (v_order, v_bill, v_prod, v_var, 'SD Latte', 1000, 600, 1, 'dine_in', '[]'::jsonb, now()),
    (v_order, v_bill, v_prod, v_var_norecipe, 'SD Other', 1000, 600, 1, 'dine_in', '[]'::jsonb, null);

  -- A1. Paying deducts once, variant + add-on + swap, voided excluded -----------
  update bills set status = 'paid', closed_at = now() where id = v_bill;
  select coalesce(sum(quantity), 0), count(*) into v_q, v_n
    from inventory_transactions where reference_id = v_bill and transaction_type = 'sale' and item_id = v_a;
  select * into v_row from bill_depletions where bill_id = v_bill;
  v_ok := v_q = -380 and v_n = 1 and v_row.status = 'done' and v_row.lines_without_recipe = 1;
  v_out := v_out || format(E'%s  paid bill deducts -380 g in one sale row, 1 line without recipe (got %s, %s rows)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_q, v_n);
  v_fail := v_fail or v_ok is not true;

  -- A2. Unit cost stamped at the moving average ----------------------------------
  select round(unit_cost, 6) = 0.05 into v_ok from inventory_transactions where reference_id = v_bill and transaction_type = 'sale';
  v_out := v_out || format(E'%s  sale row costed at the moving average\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- A3. Paid -> open -> paid does not deduct again --------------------------------
  update bills set status = 'open' where id = v_bill;
  update bills set status = 'paid' where id = v_bill;
  select count(*) into v_n from inventory_transactions where reference_id = v_bill and transaction_type = 'sale';
  v_ok := v_n = 1;
  v_out := v_out || format(E'%s  a second paid transition does not deduct again\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- A4. Merged and voided bills deduct nothing ------------------------------------
  insert into bills (branch_id, bill_no, order_type) values (c_cheras, '[TEST]SD-2', 'dine_in') returning id into v_bill2;
  insert into orders (bill_id, branch_id, order_no, source, client_order_id)
  values (v_bill2, c_cheras, 1, 'counter', gen_random_uuid()) returning id into v_order;
  insert into order_items (order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, qty, order_type)
  values (v_order, v_bill2, v_prod, v_var, 'SD Latte', 1000, 600, 1, 'dine_in');
  update bills set status = 'merged' where id = v_bill2;
  update bills set status = 'voided' where id = v_bill2;
  select count(*) into v_n from inventory_transactions where reference_id = v_bill2;
  v_ok := v_n = 0 and not exists (select 1 from bill_depletions where bill_id = v_bill2);
  v_out := v_out || format(E'%s  merged / voided bills deduct nothing\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- A5. A depletion error never blocks payment, and is recorded --------------------
  execute $t$create or replace function pg_temp.sd_block_sale() returns trigger language plpgsql as $f$
    begin if new.transaction_type = 'sale' then raise exception 'boom'; end if; return new; end $f$$t$;
  execute 'create trigger sd_block_sale before insert on inventory_transactions for each row execute function pg_temp.sd_block_sale()';
  insert into bills (branch_id, bill_no, order_type) values (c_cheras, '[TEST]SD-3', 'dine_in') returning id into v_bill3;
  insert into orders (bill_id, branch_id, order_no, source, client_order_id)
  values (v_bill3, c_cheras, 1, 'counter', gen_random_uuid()) returning id into v_order;
  insert into order_items (order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, qty, order_type)
  values (v_order, v_bill3, v_prod, v_var, 'SD Latte', 1000, 600, 1, 'dine_in');
  begin
    update bills set status = 'paid', closed_at = now() where id = v_bill3;
    v_ok := true;
  exception when others then v_ok := false;
  end;
  execute 'drop trigger sd_block_sale on inventory_transactions';
  select v_ok and b.status = 'paid' and d.status = 'error' and d.error like '%boom%'
    into v_ok from bills b join bill_depletions d on d.bill_id = b.id where b.id = v_bill3;
  v_out := v_out || format(E'%s  a depletion error does not block payment and is recorded\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- A6. Ledger constraint keeps every type --------------------------------------------
  select pg_get_constraintdef(oid) like all (array['%stock_in%','%adjustment%','%wastage%','%transfer_out%','%transfer_in%',
           '%production_out%','%production_in%','%stocktake%','%''sale''%'])
    into v_ok from pg_constraint where conname = 'inventory_transactions_transaction_type_check';
  v_out := v_out || format(E'%s  ledger types keep all eight plus sale\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- A7. Internal functions closed; bill_depletions not writable by clients -------------
  select not bool_or(has_function_privilege(r.rolname, p.oid, 'execute'))
    into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated')) as r(rolname)
   where n.nspname = 'public' and p.proname in ('deplete_bill', 'bills_deplete_on_paid');
  v_ok := v_ok and not has_table_privilege('authenticated', 'public.bill_depletions', 'insert')
                and not has_table_privilege('anon', 'public.bill_depletions', 'select');
  v_out := v_out || format(E'%s  internal depletion functions and table writes closed to clients\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- PART B (usage report) is appended in Task 3 here. --------------------------------

  v_out := v_out || case when v_fail then 'VERIFY FAILED' else 'VERIFY OK' end;
  raise exception E'\n%', v_out;
end
$verify$;
```

- [ ] **Step 2: Run on dev and see it fail**

Run: `"$DEVSQL" supabase/VERIFY-2026-11-23-sales-depletion.sql` (`DEVSQL=/private/tmp/claude-502/-Users-USER-Desktop-Craft-OS/2516e557-a088-40fb-85bf-3cbf7812eda7/scratchpad/devsql.sh`)
Expected: an error that `bill_depletions` does not exist (or a check violation for `'sale'`). If it fails earlier on a fixture column (e.g. `orders.order_no` / `client_order_id` types, a required column on `bills`/`orders`/`order_items`, a `bills_*` trigger needing data), fix the fixture to fit dev — never weaken an assertion — and note it in the report.

- [ ] **Step 3: Write the migration**

Create `supabase/migration-2026-11-23-sales-depletion.sql`:

```sql
-- ============================================================================
-- Craft OS — POS sales depletion (2026-11-23)
-- When a bill becomes paid, deduct its ingredients by menu variant and add-on
-- recipes: one 'sale' ledger row per ingredient, costed at the moving average.
-- Never blocks checkout (errors are recorded in bill_depletions).
-- Spec: docs/superpowers/specs/2026-11-23-sales-depletion-design.md
-- Additive and idempotent. Requires the POS, menu costing and stocktake migrations.
-- ============================================================================

do $$
begin
  if to_regclass('public.bills') is null or to_regclass('public.menu_variant_recipe_lines') is null
     or to_regclass('public.stock_counts') is null then
    raise exception 'Apply the POS, menu costing and stocktake migrations first';
  end if;
end $$;

-- 1. Ledger type ---------------------------------------------------------------
alter table inventory_transactions
  drop constraint if exists inventory_transactions_transaction_type_check;
alter table inventory_transactions
  add constraint inventory_transactions_transaction_type_check
  check (transaction_type in ('stock_in', 'adjustment', 'wastage',
                              'transfer_out', 'transfer_in',
                              'production_out', 'production_in',
                              'stocktake', 'sale'));

-- 2. One marker per depleted bill --------------------------------------------------
create table if not exists bill_depletions (
  bill_id              uuid primary key references bills(id) on delete cascade,
  branch_id            uuid not null references branches(id),
  depleted_at          timestamptz not null default now(),
  status               text not null check (status in ('done', 'error')),
  error                text,
  lines_without_recipe integer not null default 0
);
create index if not exists bill_depletions_branch_time_idx on bill_depletions (branch_id, depleted_at);

alter table bill_depletions enable row level security;
drop policy if exists bill_depletions_select on bill_depletions;
create policy bill_depletions_select on bill_depletions for select to authenticated
  using (has_procurement_cap('use_procurement') and can_access_branch(branch_id));
revoke all on bill_depletions from anon, authenticated;
grant select on bill_depletions to authenticated;

-- 3. deplete_bill (internal) -------------------------------------------------------
create or replace function deplete_bill(p_bill_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_bill    bills%rowtype;
  v_missing integer;
  r         record;
begin
  select * into v_bill from bills where id = p_bill_id;
  if not found or v_bill.status <> 'paid' then
    return;
  end if;
  if exists (select 1 from bill_depletions where bill_id = p_bill_id) then
    return;
  end if;

  for r in
    with lines as (
      select oi.qty, oi.variant_id,
             case when jsonb_typeof(oi.modifiers_snapshot) = 'array' then oi.modifiers_snapshot else '[]'::jsonb end as mods
        from order_items oi
       where oi.bill_id = p_bill_id and oi.voided_at is null
    ), usage as (
      select vl.item_id, l.qty * vl.qty_base as q
        from lines l
        join menu_variant_recipe_lines vl on vl.variant_id = l.variant_id
      union all
      select ml.item_id, l.qty * ml.qty_base
        from lines l
        cross join lateral jsonb_array_elements(l.mods) as e(mod)
        join modifier_recipe_lines ml on ml.option_id::text = e.mod->>'optionId'
    )
    select item_id, sum(q) as total
      from usage
     group by item_id
    having sum(q) <> 0
  loop
    insert into inventory_transactions (item_id, branch_id, transaction_type, quantity,
                                        reference_type, reference_id, notes)
    values (r.item_id, v_bill.branch_id, 'sale', -r.total, 'bill', p_bill_id, 'Sale ' || v_bill.bill_no);
  end loop;

  select count(*) into v_missing
    from order_items oi
   where oi.bill_id = p_bill_id and oi.voided_at is null
     and not exists (select 1 from menu_variant_recipe_lines vl where vl.variant_id = oi.variant_id);

  insert into bill_depletions (bill_id, branch_id, status, lines_without_recipe)
  values (p_bill_id, v_bill.branch_id, 'done', v_missing);
end;
$$;
revoke all on function deplete_bill(uuid) from public, anon, authenticated;

-- 4. Trigger: deplete on the transition to paid, never blocking -------------------
create or replace function bills_deplete_on_paid()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform deplete_bill(new.id);
  exception when others then
    insert into bill_depletions (bill_id, branch_id, status, error)
    values (new.id, new.branch_id, 'error', left(sqlerrm, 500))
    on conflict (bill_id) do nothing;
  end;
  return null;
end;
$$;
revoke all on function bills_deplete_on_paid() from public, anon, authenticated;

drop trigger if exists bills_deplete_on_paid on bills;
create trigger bills_deplete_on_paid
  after update of status on bills
  for each row
  when (old.status is distinct from 'paid' and new.status = 'paid')
  execute function bills_deplete_on_paid();
```

- [ ] **Step 4: Apply, verify, re-apply**

```bash
"$DEVSQL" supabase/migration-2026-11-23-sales-depletion.sql   # []
"$DEVSQL" supabase/VERIFY-2026-11-23-sales-depletion.sql      # 7 PASS, VERIFY OK
"$DEVSQL" supabase/migration-2026-11-23-sales-depletion.sql   # [] (idempotent)
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-11-23-sales-depletion.sql supabase/VERIFY-2026-11-23-sales-depletion.sql
git commit -m "feat(sales-depletion): deduct ingredients when a POS bill is paid (dev)"
```

---

### Task 3: Usage report functions (dev)

**Files:**
- Create: `supabase/migration-2026-11-23-stock-count-usage.sql`
- Modify: `supabase/VERIFY-2026-11-23-sales-depletion.sql` (insert PART B before the final verdict)

**Interfaces:**
- Consumes: Task 2 objects; `stock_counts(id, branch_id, status, submitted_at)`, `stock_count_items(count_id, item_id, variance_base, variance_value)`, `wastage` / `sale` ledger rows.
- Produces (RPCs for `authenticated`):
  - `stock_count_usage(p_count_id uuid) returns table(item_id uuid, item_name text, base_unit text, sold_base numeric, sold_value numeric, wasted_base numeric, wasted_value numeric, unexplained_base numeric, unexplained_value numeric, unexplained_pct numeric)` — `unexplained_*` keep the count's sign (negative = loss); `unexplained_pct = −unexplained_base ÷ sold_base × 100` when `sold_base > 0`, else null.
  - `stock_count_usage_summary(p_count_id uuid) returns jsonb` with keys `period_start`, `period_end`, `from_previous` (bool), `bills_paid`, `lines_without_recipe`, `depletion_errors`, `sold_value`, `wasted_value`, `unexplained_value`.
  - `stock_count_unrecipe_sales(p_count_id uuid) returns table(product_name text, variant_name text, qty_sold bigint)` (top 50 by qty).
  - Internal `stock_count_usage_period(p_count_id uuid, out branch_id uuid, out period_start timestamptz, out period_end timestamptz, out from_previous boolean)`.

- [ ] **Step 1: Add VERIFY part B (failing)**

Replace the line `-- PART B (usage report) is appended in Task 3 here. ---…` in the VERIFY file with:

```sql
  -- PART B: usage report ---------------------------------------------------------------
  -- Previous count a day ago, current count a minute from now; between them:
  -- the -380 g sale (bill 1) and a 30 g wastage; the current count found 40 g less than book.
  insert into stock_counts (branch_id, kind, status, started_at, submitted_at, item_count, gain_value, loss_value, net_value)
  values (c_cheras, 'full', 'submitted', now() - interval '1 day', now() - interval '1 day', 0, 0, 0, 0) returning id into v_c1;
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type)
  values (v_a, c_cheras, 'wastage', -30, 0.05, 'manual');
  insert into stock_counts (branch_id, kind, status, started_at, submitted_at, item_count, gain_value, loss_value, net_value)
  values (c_cheras, 'full', 'submitted', now(), now() + interval '1 minute', 1, 0, 2, -2) returning id into v_c2;
  insert into stock_count_items (count_id, item_id, counted_base, expected_base, variance_base, unit_cost, variance_value)
  values (v_c2, v_a, 4550, 4590, -40, 0.05, -2);

  perform set_config('request.jwt.claims', json_build_object('sub', c_manager, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- B1. Per-item usage ------------------------------------------------------------------
  select * into v_row from stock_count_usage(v_c2) where item_id = v_a;
  v_ok := v_row.sold_base = 380 and round(v_row.sold_value, 2) = 19.00
      and v_row.wasted_base = 30 and round(v_row.wasted_value, 2) = 1.50
      and v_row.unexplained_base = -40 and round(v_row.unexplained_value, 2) = -2.00
      and round(v_row.unexplained_pct, 2) = 10.53;
  v_out := v_out || format(E'%s  usage: sold 380 g RM 19.00, wasted 30 g RM 1.50, unexplained -40 g RM -2.00 = 10.53%% (got %s / %s / %s / %s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_row.sold_base, v_row.wasted_base, v_row.unexplained_base, v_row.unexplained_pct);
  v_fail := v_fail or v_ok is not true;

  -- B2. Summary -----------------------------------------------------------------------
  v_sum := stock_count_usage_summary(v_c2);
  v_ok := (v_sum->>'from_previous')::boolean = true
      and (v_sum->>'lines_without_recipe')::int >= 1
      and (v_sum->>'depletion_errors')::int >= 1
      and (v_sum->>'bills_paid')::int >= 2
      and round((v_sum->>'sold_value')::numeric, 2) >= 19.00;
  v_out := v_out || format(E'%s  summary: previous count found, paid bills, lines without recipe, errors (%s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_sum);
  v_fail := v_fail or v_ok is not true;

  -- B3. Sold without recipe -------------------------------------------------------------
  select exists (select 1 from stock_count_unrecipe_sales(v_c2) where variant_name = 'No recipe' and qty_sold = 1)
    into v_ok;
  v_out := v_out || format(E'%s  sold-without-recipe lists the no-recipe variant\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;
  execute 'reset role';

  -- B4. anon refused; internal period function closed ------------------------------------
  select not bool_or(has_function_privilege('anon', p.oid, 'execute'))
     and not exists (select 1 from pg_proc p2 join pg_namespace n2 on n2.oid = p2.pronamespace
                      where n2.nspname = 'public' and p2.proname = 'stock_count_usage_period'
                        and has_function_privilege('authenticated', p2.oid, 'execute'))
    into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('stock_count_usage', 'stock_count_usage_summary', 'stock_count_unrecipe_sales');
  v_out := v_out || format(E'%s  usage functions closed to anon; period helper internal\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;
```

Run VERIFY → expected failure: `function stock_count_usage(uuid) does not exist`.

- [ ] **Step 2: Write the migration**

Create `supabase/migration-2026-11-23-stock-count-usage.sql`:

```sql
-- ============================================================================
-- Craft OS — Stock count usage ("Since last count") (2026-11-23)
-- For a submitted count: what sales should have used (sale rows), what was
-- logged as waste, and what the count found missing on top, per ingredient,
-- between the previous submitted count at the branch and this one.
-- Additive and idempotent. Requires migration-2026-11-23-sales-depletion.sql.
-- ============================================================================

create or replace function stock_count_usage_period(
  p_count_id uuid,
  out branch_id uuid, out period_start timestamptz, out period_end timestamptz, out from_previous boolean
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_c stock_counts%rowtype;
begin
  select * into v_c from stock_counts s where s.id = p_count_id;
  if not found or v_c.status <> 'submitted' then
    raise exception 'Count not found or not submitted';
  end if;
  branch_id := v_c.branch_id;
  period_end := v_c.submitted_at;
  select max(s.submitted_at) into period_start
    from stock_counts s
   where s.branch_id = v_c.branch_id and s.status = 'submitted' and s.submitted_at < v_c.submitted_at;
  from_previous := period_start is not null;
  if period_start is null then
    period_start := v_c.submitted_at - interval '30 days';
  end if;
end;
$$;
revoke all on function stock_count_usage_period(uuid) from public, anon, authenticated;

create or replace function stock_count_usage(p_count_id uuid)
returns table (item_id uuid, item_name text, base_unit text,
               sold_base numeric, sold_value numeric, wasted_base numeric, wasted_value numeric,
               unexplained_base numeric, unexplained_value numeric, unexplained_pct numeric)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  p record;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to see stock usage';
  end if;
  select * into p from stock_count_usage_period(p_count_id);
  if not can_access_branch(p.branch_id) then
    raise exception 'Not authorised for this branch';
  end if;
  return query
    with tx as (
      select t.item_id,
             -sum(t.quantity) filter (where t.transaction_type = 'sale')                               as sold_b,
             -sum(t.quantity * coalesce(t.unit_cost, 0)) filter (where t.transaction_type = 'sale')    as sold_v,
             -sum(t.quantity) filter (where t.transaction_type = 'wastage')                            as waste_b,
             -sum(t.quantity * coalesce(t.unit_cost, 0)) filter (where t.transaction_type = 'wastage') as waste_v
        from inventory_transactions t
       where t.branch_id = p.branch_id
         and t.transaction_type in ('sale', 'wastage')
         and t.created_at > p.period_start and t.created_at <= p.period_end
       group by t.item_id
    ), ci as (
      select sci.item_id, sci.variance_base, sci.variance_value
        from stock_count_items sci where sci.count_id = p_count_id
    ), ids as (
      select tx.item_id from tx union select ci.item_id from ci
    )
    select ids.item_id, i.name, i.base_unit,
           coalesce(tx.sold_b, 0), coalesce(tx.sold_v, 0),
           coalesce(tx.waste_b, 0), coalesce(tx.waste_v, 0),
           coalesce(ci.variance_base, 0), coalesce(ci.variance_value, 0),
           case when coalesce(tx.sold_b, 0) > 0
                then -coalesce(ci.variance_base, 0) / tx.sold_b * 100 end
      from ids
      join items i on i.id = ids.item_id
      left join tx on tx.item_id = ids.item_id
      left join ci on ci.item_id = ids.item_id;
end;
$$;

create or replace function stock_count_usage_summary(p_count_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  p record;
  v_sold numeric; v_waste numeric; v_unexp numeric;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to see stock usage';
  end if;
  select * into p from stock_count_usage_period(p_count_id);
  if not can_access_branch(p.branch_id) then
    raise exception 'Not authorised for this branch';
  end if;
  select coalesce(sum(u.sold_value), 0), coalesce(sum(u.wasted_value), 0), coalesce(sum(u.unexplained_value), 0)
    into v_sold, v_waste, v_unexp
    from stock_count_usage(p_count_id) u;
  return jsonb_build_object(
    'period_start', p.period_start,
    'period_end', p.period_end,
    'from_previous', p.from_previous,
    'bills_paid', (select count(*) from bills b where b.branch_id = p.branch_id and b.status = 'paid'
                     and b.closed_at > p.period_start and b.closed_at <= p.period_end),
    'lines_without_recipe', (select coalesce(sum(d.lines_without_recipe), 0) from bill_depletions d
                              where d.branch_id = p.branch_id and d.depleted_at > p.period_start and d.depleted_at <= p.period_end),
    'depletion_errors', (select count(*) from bill_depletions d
                          where d.branch_id = p.branch_id and d.status = 'error'
                            and d.depleted_at > p.period_start and d.depleted_at <= p.period_end),
    'sold_value', v_sold,
    'wasted_value', v_waste,
    'unexplained_value', v_unexp);
end;
$$;

create or replace function stock_count_unrecipe_sales(p_count_id uuid)
returns table (product_name text, variant_name text, qty_sold bigint)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  p record;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to see stock usage';
  end if;
  select * into p from stock_count_usage_period(p_count_id);
  if not can_access_branch(p.branch_id) then
    raise exception 'Not authorised for this branch';
  end if;
  return query
    select mp.name::text, mv.name::text, sum(oi.qty)::bigint
      from bills b
      join order_items oi on oi.bill_id = b.id and oi.voided_at is null
      join menu_variants mv on mv.id = oi.variant_id
      join menu_products mp on mp.id = mv.product_id
     where b.branch_id = p.branch_id and b.status = 'paid'
       and b.closed_at > p.period_start and b.closed_at <= p.period_end
       and not exists (select 1 from menu_variant_recipe_lines vl where vl.variant_id = oi.variant_id)
     group by mp.name, mv.name
     order by 3 desc, 1, 2
     limit 50;
end;
$$;

revoke all on function stock_count_usage(uuid) from public, anon;
revoke all on function stock_count_usage_summary(uuid) from public, anon;
revoke all on function stock_count_unrecipe_sales(uuid) from public, anon;
grant execute on function stock_count_usage(uuid) to authenticated;
grant execute on function stock_count_usage_summary(uuid) to authenticated;
grant execute on function stock_count_unrecipe_sales(uuid) to authenticated;
```

- [ ] **Step 3: Apply, verify, re-apply**

```bash
"$DEVSQL" supabase/migration-2026-11-23-stock-count-usage.sql   # []
"$DEVSQL" supabase/VERIFY-2026-11-23-sales-depletion.sql        # 11 PASS, VERIFY OK
"$DEVSQL" supabase/migration-2026-11-23-stock-count-usage.sql   # []
```
If B1's numbers differ only because dev already has other `sale`/`wastage` rows for the fixture item — impossible, the item is new — investigate the period bounds instead (rows are created at `now()`, C1 at `now() − 1 day`, C2 at `now() + 1 minute`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migration-2026-11-23-stock-count-usage.sql supabase/VERIFY-2026-11-23-sales-depletion.sql
git commit -m "feat(sales-depletion): usage since last count — sold, wasted, unexplained per ingredient (dev)"
```

---

### Task 4: "Since last count" on the stock count result

**Files:**
- Modify: `src/shared/types/procurement.ts` (add `'sale'` to `InventoryTransactionType` and `TRANSACTION_TYPE_LABELS` (`sale: 'Sale'`); append usage types)
- Create: `src/shared/lib/stockUsage.ts`, `src/shared/lib/stockUsage.test.ts`
- Create: `src/features/procurement/StockCountUsage.tsx`
- Modify: `src/features/procurement/StockCountResult.tsx` (render `<StockCountUsage countId={count.id} />` after the variance list)
- Modify (only if needed): `src/features/procurement/InventoryDetail.tsx` — a `reference_type 'bill'` ledger row reads "Sale" (no link needed).

**Interfaces:**
- Consumes: RPCs `stock_count_usage`, `stock_count_usage_summary`, `stock_count_unrecipe_sales`; `money`, `qty` from `src/shared/lib/procurement.ts`.
- Produces: types `StockUsageRow` (fields of `stock_count_usage`, numbers), `StockUsageSummary` (keys of the summary, numbers/strings/booleans), `UnrecipeSale`; helpers `normaliseUsageRow(raw): StockUsageRow` (Number() on numeric fields; `unexplained_pct` null stays null), `sortUsageRows(rows): StockUsageRow[]` (biggest unexplained loss first = ascending `unexplained_value`, then descending `sold_value`, then name), `formatPeriod(startIso, endIso): string` (e.g. `22 Nov 02:32 → 30 Nov 23:10`, Asia/Kuala_Lumpur), `formatPct(n: number | null): string` (`'—'` for null, one decimal + `%`).

- [ ] **Step 1: Tests first** — `src/shared/lib/stockUsage.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normaliseUsageRow, sortUsageRows, formatPct, formatPeriod } from './stockUsage'

const row = (name: string, unexplained: number, sold: number) => ({
  item_id: name, item_name: name, base_unit: 'g', sold_base: 0, sold_value: sold,
  wasted_base: 0, wasted_value: 0, unexplained_base: 0, unexplained_value: unexplained, unexplained_pct: null,
})

describe('normaliseUsageRow', () => {
  it('turns numeric strings into numbers and keeps null pct', () => {
    const r = normaliseUsageRow({ ...row('a', 0, 0), sold_value: '19.00', unexplained_value: '-2.5', unexplained_pct: null } as never)
    expect(r.sold_value).toBe(19)
    expect(r.unexplained_value).toBe(-2.5)
    expect(r.unexplained_pct).toBeNull()
  })
})

describe('sortUsageRows', () => {
  it('puts the biggest unexplained loss first, then most sold, then name', () => {
    const out = sortUsageRows([row('b', -1, 5), row('a', -9, 1), row('c', 0, 50), row('d', -1, 9)])
    expect(out.map(r => r.item_name)).toEqual(['a', 'd', 'b', 'c'])
  })
})

describe('formatPct', () => {
  it('shows one decimal or a dash', () => {
    expect(formatPct(10.526)).toBe('10.5%')
    expect(formatPct(null)).toBe('—')
  })
})

describe('formatPeriod', () => {
  it('formats both ends in Malaysia time', () => {
    expect(formatPeriod('2026-11-21T18:32:00Z', '2026-11-30T15:10:00Z')).toBe('22 Nov 02:32 → 30 Nov 23:10')
  })
})
```

Run → FAIL (module missing).

- [ ] **Step 2: Types and helpers**

Append to `src/shared/types/procurement.ts`:

```ts
// ── Stock usage since last count ─────────────────────────────────────────────

export interface StockUsageRow {
  item_id: string
  item_name: string
  base_unit: string
  sold_base: number
  sold_value: number
  wasted_base: number
  wasted_value: number
  /** Count variance: negative = loss beyond sales and waste. */
  unexplained_base: number
  unexplained_value: number
  /** Unexplained loss as % of what sales used; null when nothing was sold. */
  unexplained_pct: number | null
}

export interface StockUsageSummary {
  period_start: string
  period_end: string
  from_previous: boolean
  bills_paid: number
  lines_without_recipe: number
  depletion_errors: number
  sold_value: number
  wasted_value: number
  unexplained_value: number
}

export interface UnrecipeSale {
  product_name: string
  variant_name: string
  qty_sold: number
}
```

Also add `'sale'` to `InventoryTransactionType` and `sale: 'Sale'` to `TRANSACTION_TYPE_LABELS`.

Create `src/shared/lib/stockUsage.ts`:

```ts
import type { StockUsageRow } from '../types'

const num = (v: unknown): number => Number(v ?? 0)

export function normaliseUsageRow(raw: StockUsageRow): StockUsageRow {
  return {
    ...raw,
    sold_base: num(raw.sold_base),
    sold_value: num(raw.sold_value),
    wasted_base: num(raw.wasted_base),
    wasted_value: num(raw.wasted_value),
    unexplained_base: num(raw.unexplained_base),
    unexplained_value: num(raw.unexplained_value),
    unexplained_pct: raw.unexplained_pct == null ? null : Number(raw.unexplained_pct),
  }
}

/** Biggest unexplained loss first, then most sold by value, then by name. */
export function sortUsageRows(rows: StockUsageRow[]): StockUsageRow[] {
  return [...rows].sort((a, b) =>
    a.unexplained_value - b.unexplained_value
    || b.sold_value - a.sold_value
    || a.item_name.localeCompare(b.item_name))
}

export function formatPct(n: number | null): string {
  return n == null ? '—' : `${n.toFixed(1)}%`
}

function myt(iso: string): string {
  const d = new Date(iso)
  const day = d.toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short' })
  const time = d.toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}

export function formatPeriod(startIso: string, endIso: string): string {
  return `${myt(startIso)} → ${myt(endIso)}`
}
```

Run the tests → PASS.

- [ ] **Step 3: The section component**

Create `src/features/procurement/StockCountUsage.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money, qty } from '../../shared/lib/procurement'
import { useCan } from '../../shared/lib/permissions'
import { normaliseUsageRow, sortUsageRows, formatPct, formatPeriod } from '../../shared/lib/stockUsage'
import type { StockUsageRow, StockUsageSummary, UnrecipeSale } from '../../shared/types'

export default function StockCountUsage({ countId }: { countId: string }) {
  const { can } = useCan()
  const [rows, setRows] = useState<StockUsageRow[] | null>(null)
  const [summary, setSummary] = useState<StockUsageSummary | null>(null)
  const [unrecipe, setUnrecipe] = useState<UnrecipeSale[]>([])
  const [error, setError] = useState('')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      supabase.rpc('stock_count_usage', { p_count_id: countId }),
      supabase.rpc('stock_count_usage_summary', { p_count_id: countId }),
      supabase.rpc('stock_count_unrecipe_sales', { p_count_id: countId }),
    ]).then(([u, s, n]) => {
      if (cancelled) return
      const err = u.error ?? s.error ?? n.error
      if (err) { setError(err.message); return }
      setRows(((u.data as StockUsageRow[]) ?? []).map(normaliseUsageRow))
      const sm = s.data as StockUsageSummary
      setSummary({ ...sm, bills_paid: Number(sm.bills_paid), lines_without_recipe: Number(sm.lines_without_recipe),
        depletion_errors: Number(sm.depletion_errors), sold_value: Number(sm.sold_value),
        wasted_value: Number(sm.wasted_value), unexplained_value: Number(sm.unexplained_value) })
      setUnrecipe(((n.data as UnrecipeSale[]) ?? []).map(r => ({ ...r, qty_sold: Number(r.qty_sold) })))
    }).catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [countId])

  if (error) return <p className="text-sm text-red-700">Couldn't load usage since last count: {error}</p>
  if (!rows || !summary) return <p className="text-sm text-brown-faint">Loading usage since last count…</p>

  const sorted = sortUsageRows(rows)
  const withMovement = sorted.filter(r => r.sold_base !== 0 || r.wasted_base !== 0 || r.unexplained_base !== 0)
  const shown = showAll ? withMovement : withMovement.slice(0, 15)

  return (
    <section className="space-y-3 pt-2">
      <div>
        <h2 className="text-base font-bold text-brown-dark">Since last count</h2>
        <p className="text-xs text-brown-faint">
          {formatPeriod(summary.period_start, summary.period_end)} · {summary.bills_paid} bills paid
          {!summary.from_previous && ' · first count, so the last 30 days are shown'}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Sold (recipes)', value: summary.sold_value, tone: 'text-brown-dark' },
          { label: 'Wasted', value: summary.wasted_value, tone: 'text-brown-dark' },
          { label: 'Unexplained', value: summary.unexplained_value, tone: summary.unexplained_value < 0 ? 'text-red-700' : 'text-green-700' },
        ].map(t => (
          <div key={t.label} className="bg-white rounded-xl border border-[#E8DDD0] p-3 text-center">
            <p className="text-xs text-brown-faint">{t.label}</p>
            <p className={`text-base font-bold ${t.tone}`}>{money(Math.abs(t.value))}</p>
          </div>
        ))}
      </div>

      {summary.lines_without_recipe > 0 && (
        <div className="rounded-xl border border-[#F0D9B5] bg-[#FDF6EC] p-3 text-xs text-[#8A5A1C] space-y-1">
          <p className="font-semibold">
            {summary.lines_without_recipe} item{summary.lines_without_recipe === 1 ? '' : 's'} sold had no recipe, so usage is understated.
          </p>
          {unrecipe.length > 0 && (
            <p>{unrecipe.slice(0, 5).map(u => `${u.product_name} · ${u.variant_name} (${u.qty_sold})`).join(', ')}</p>
          )}
          {can('manage_procurement') && <Link to="/procurement/menu-costing" className="font-semibold underline">Add recipes in Menu Costing</Link>}
        </div>
      )}
      {summary.depletion_errors > 0 && (
        <p className="text-xs text-red-700">{summary.depletion_errors} paid bill{summary.depletion_errors === 1 ? '' : 's'} could not deduct stock. Ask a manager to check the recipes.</p>
      )}

      {withMovement.length === 0 ? (
        <p className="text-sm text-brown-faint">No sales, waste or count differences in this period.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map(r => (
            <li key={r.item_id} className="bg-white rounded-xl border border-[#E8DDD0] px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-brown-dark">{r.item_name}</p>
                <span className={`text-sm font-bold whitespace-nowrap ${r.unexplained_value < 0 ? 'text-red-700' : r.unexplained_value > 0 ? 'text-green-700' : 'text-brown-muted'}`}>
                  {r.unexplained_value < 0 ? '−' : r.unexplained_value > 0 ? '+' : ''}{money(Math.abs(r.unexplained_value))}
                </span>
              </div>
              <p className="text-xs text-brown-faint mt-1">
                Sold {qty(r.sold_base)} {r.base_unit} ({money(r.sold_value)}) · Wasted {qty(r.wasted_base)} {r.base_unit}
                {' · '}Unexplained {qty(Math.abs(r.unexplained_base))} {r.base_unit} {r.unexplained_base < 0 ? 'short' : r.unexplained_base > 0 ? 'over' : ''}
                {r.unexplained_pct != null && r.unexplained_base < 0 && ` (${formatPct(r.unexplained_pct)} of sold)`}
              </p>
            </li>
          ))}
        </ul>
      )}
      {withMovement.length > 15 && (
        <button type="button" className="text-xs font-semibold text-[#C4813A]" onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Show fewer' : `Show all ${withMovement.length}`}
        </button>
      )}
    </section>
  )
}
```

In `StockCountResult.tsx` import it and render `<StockCountUsage countId={count.id} />` as the last child of the result's outer container.

- [ ] **Step 4: Type-check, full suite, commit**

```bash
npx tsc -b
VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run
git add src/shared/types/procurement.ts src/shared/lib/stockUsage.ts src/shared/lib/stockUsage.test.ts src/features/procurement/StockCountUsage.tsx src/features/procurement/StockCountResult.tsx
git commit -m "feat(sales-depletion): 'Since last count' usage section on the stock count result"
```
(`InventoryDetail.tsx` only if `tsc` or the `'sale'` label needs a reference case.)

---

### Task 5: Browser check on dev (controller)

- [ ] Launch entry `sales-depletion-dev-proxy` (port 5187; copy `.env.local` and the local `vite.proxy.local.mjs` from `../menu-costing`, which merges the real vite config), sign in the [TEST] Cheras manager.
- [ ] Give a menu variant a recipe (Menu Costing), take and pay a POS bill for it at Cheras on dev; Stock on Hand drops by the recipe quantity; the ledger shows a "Sale" row.
- [ ] Submit a stock count at Cheras; the result shows "Since last count" with the sale, any waste and the unexplained difference; the "no recipe" warning lists dishes sold without recipes.
- [ ] Push the branch.
