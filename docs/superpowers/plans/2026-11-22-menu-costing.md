# Menu Costing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Managers record a recipe for each menu variant and add-on option, and see each variant's ingredient cost and food cost % against an optional category target.

**Architecture:** Merge `main` (items, prep recipes) into this POS-based branch. One SQL migration adds recipe-line tables, a targets table, a recursive standard-cost function, two cost views and manager-only RPCs. Two React screens (Menu Costing list, Recipe editor) read the views and call the RPCs; pure cost helpers live in `src/shared/lib/menuCosting.ts` with Vitest tests.

**Tech Stack:** React + Vite + TypeScript + Tailwind, Supabase (Postgres, RLS, plpgsql RPCs), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-menu-costing-design.md`

## Global Constraints

- Work only in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/menu-costing`, branch `feature/menu-costing`. Never run git in `/Users/USER/Desktop/Craft_OS` itself. Do not push (the controller pushes).
- SQL runs on **dev only** (`egznnbjmicebbhwasloy`) with `/private/tmp/claude-502/-Users-USER-Desktop-Craft-OS/2516e557-a088-40fb-85bf-3cbf7812eda7/scratchpad/devsql.sh <file.sql>` (one file = one transaction; a response containing `"message"` is an error). Never touch prod (`yfsoesxzurzjdwstszru`).
- All UI labels and copy in English.
- Every read and write of recipes, costs and targets requires the `manage_procurement` capability (SQL: `has_procurement_cap('manage_procurement')`).
- Ingredient cost = standard cost: `latest_price / conversion_rate`, or for an item with a current prep recipe (`recipe_for_date(item, business_date_of(now()))`) the recipe rolled up ÷ `yield_qty`, recursive, depth limit 5, null if any input is null.
- Food cost % = cost ÷ variant `price_sen` (SST-exclusive). Stored/compared in basis points: `food_cost_bp = cost_rm * 1000000 / price_sen`.
- Quantities in base units (`qty_base`). Variant lines `qty_base > 0`; add-on lines `qty_base <> 0` (negative removes, for swaps).
- Commit after every task; each message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The worktree has no `.env`: run tests as `VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run`.

## File Structure

| File | Responsibility |
|------|----------------|
| (merge) many files | Task 1 brings `main` in |
| `supabase/migration-2026-11-22-menu-costing.sql` (create) | Tables, RLS, cost functions, views, RPCs |
| `supabase/VERIFY-2026-11-22-menu-costing.sql` (create) | Dev-only checks; raises its report so it rolls back |
| `src/shared/types/menuCosting.ts` (create) | Row types for the views and lines |
| `src/shared/lib/menuCosting.ts` (+ `.test.ts`) (create) | Pure helpers: packs/loose, line and recipe cost, food cost %, status |
| `src/features/procurement/MenuCosting.tsx` (create) | List page |
| `src/features/procurement/MenuRecipeEditor.tsx` (create) | Recipe editor (variant + add-ons) |
| `src/features/procurement/RecipeLinesEditor.tsx` (create) | Reusable ingredient-lines editor used twice by the editor |
| `src/App.tsx`, `src/shared/lib/nav.ts`, `nav.test.ts` (modify) | Routes and nav entry |

---

### Task 1: Merge `main` into the branch

**Files:** the merge; conflicts expected in `src/features/hr/HrAttendance.tsx`, `src/features/staff/StaffProfile.tsx`, `src/index.css`, `src/shared/components/Sidebar.tsx`, `src/shared/lib/nav.ts`, `src/shared/lib/nav.test.ts`, `src/shared/types/index.ts`, `vite.config.ts`.

**Interfaces:**
- Produces: a branch that has both the POS code (menu tables, `/menu`, `/pos`) and main's inventory code (`src/features/procurement/*`, `src/shared/lib/procurement.ts`, `has_procurement_cap` capability names `use_procurement` / `manage_procurement` in `src/shared/types/index.ts`).

- [ ] **Step 1: Merge**

```bash
cd /Users/USER/Desktop/Craft_OS/.claude/worktrees/menu-costing
git fetch -q origin
git merge --no-ff origin/main -m "merge main into feature/menu-costing (inventory v2 + items for menu costing)"
```
Expected: `CONFLICT` in the 8 files above.

- [ ] **Step 2: Resolve every conflict by keeping both sides**

Rule: both branches added independent things; keep all of them.
- `nav.ts`: keep POS's `pos` group and main's `inventory` group (and any module-nav structure main introduced in PR #14 — if main restructured `NAV`, adopt main's structure and re-add the POS group and its children inside it). `nav.test.ts`: keep both sides' tests; fix expected lists so they match the merged `NAV`.
- `types/index.ts`: the `Capability` union must contain every capability from both sides (e.g. `manage_menu` from POS and `use_procurement`, `manage_procurement` from main); keep both sides' exports.
- `Sidebar.tsx`, `index.css`, `vite.config.ts`, `HrAttendance.tsx`, `StaffProfile.tsx`: keep both sides' additions; where the same line changed on both, combine them so neither feature is lost (e.g. both sides' vite plugins/inputs; both CSS rules).
Then `git add` the files.

- [ ] **Step 3: Install, type-check, test**

```bash
npm ci
npx tsc -b
VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run
```
Expected: tsc prints nothing; all test files pass. Fix any merge breakage (do not delete tests to pass).

- [ ] **Step 4: Commit the merge**

```bash
git commit --no-edit
```
(If the merge commit was not yet created because of conflicts, this creates it. Append the Co-Authored-By line with `git commit --amend` only if the message lacks it.)

---

### Task 2: Database — tables, cost functions, views, RPCs (dev)

**Files:**
- Create: `supabase/VERIFY-2026-11-22-menu-costing.sql`
- Create: `supabase/migration-2026-11-22-menu-costing.sql`

**Interfaces:**
- Consumes (already on dev): `items`, `recipes`, `recipe_lines`, `recipe_for_date(uuid, date) returns uuid`, `business_date_of(timestamptz) returns date`, `has_procurement_cap(text)`, `menu_products`, `menu_variants`, `menu_categories`, `modifier_options`, `modifier_groups`, `product_modifier_groups`.
- Produces: tables `menu_variant_recipe_lines(variant_id, item_id, qty_base, sort_order)`, `modifier_recipe_lines(option_id, item_id, qty_base, sort_order)`, `menu_recipe_meta(variant_id, updated_at, updated_by)`, `menu_category_targets(category_id, target_food_cost_bp)`; functions `item_standard_cost(uuid) returns numeric`, `item_standard_costs(uuid[]) returns table(item_id uuid, unit_cost numeric)`; views `menu_variant_costs`, `modifier_option_costs` (columns listed in Step 3); RPCs `save_variant_recipe(uuid, jsonb)`, `save_modifier_recipe(uuid, jsonb)`, `copy_variant_recipe(uuid, uuid)`, `set_category_target(uuid, integer)`.

- [ ] **Step 1: Write the VERIFY script (failing test)**

Create `supabase/VERIFY-2026-11-22-menu-costing.sql`:

```sql
-- ============================================================================
-- VERIFY — Menu costing (2026-11-22). DEV ONLY (craft-os-dev).
-- Builds [TEST] items, a prep recipe chain and a [TEST] menu product, acts as
-- the [TEST] manager and supervisor, and always ends by raising its report so
-- every change rolls back. Last line: VERIFY OK or VERIFY FAILED.
-- ============================================================================
do $verify$
declare
  c_manager    constant uuid := '193e1294-9c20-4425-b796-1cbff287e7a5';  -- test.manager.cheras
  c_supervisor constant uuid := 'bfd13ca2-6282-42f3-ad85-5fbe1325516d';  -- test.supervisor.cheras
  v_out text := ''; v_fail boolean := false; v_ok boolean;
  v_a uuid; v_b uuid; v_n uuid; v_p uuid; v_p2 uuid; v_r uuid;
  v_cat uuid; v_prod uuid; v_v1 uuid; v_v2 uuid; v_v3 uuid; v_grp uuid; v_opt uuid;
  v_cost numeric; v_row record;
begin
  -- Fixture (as postgres) ---------------------------------------------------
  -- A: RM 20 per 1000 g = 0.02/g. B: RM 5 per 500 ml = 0.01/ml. N: no price.
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] MC A', 'raw', 'pack', 'g', 1000, 20) returning id into v_a;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] MC B', 'raw', 'bottle', 'ml', 500, 5) returning id into v_b;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] MC N', 'raw', 'pack', 'g', 1000, null) returning id into v_n;
  -- P: prep, yield 1000 g from 500 g A (10.00) + 500 ml B (5.00) = 0.015/g.
  insert into items (name, category, purchase_unit, base_unit, conversion_rate)
  values ('[TEST] MC Prep P', 'semi_finished', 'batch', 'g', 1000) returning id into v_p;
  insert into recipes (item_id, version, yield_qty, effective_from, status, verified_at)
  values (v_p, 1, 1000, current_date - 1, 'active', now()) returning id into v_r;
  insert into recipe_lines (recipe_id, item_id, qty_base) values (v_r, v_a, 500), (v_r, v_b, 500);
  -- P2: prep, yield 10 from 100 g P (1.50) = 0.15 each.
  insert into items (name, category, purchase_unit, base_unit, conversion_rate)
  values ('[TEST] MC Prep P2', 'semi_finished', 'batch', 'pcs', 10) returning id into v_p2;
  insert into recipes (item_id, version, yield_qty, effective_from, status, verified_at)
  values (v_p2, 1, 10, current_date - 1, 'active', now()) returning id into v_r;
  insert into recipe_lines (recipe_id, item_id, qty_base) values (v_r, v_p, 100);

  insert into menu_categories (name) values ('[TEST] MC Drinks') returning id into v_cat;
  insert into menu_products (name, category_id) values ('[TEST] MC Latte', v_cat) returning id into v_prod;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'hot', 'Hot', 1000) returning id into v_v1;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'cold', 'Cold', 1200) returning id into v_v2;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'free', 'Free', 0) returning id into v_v3;
  insert into modifier_groups (name) values ('[TEST] MC Milk') returning id into v_grp;
  insert into modifier_options (group_id, name) values (v_grp, 'Oat milk') returning id into v_opt;

  -- 1. Standard costs (manager) ---------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_manager, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_ok := round(item_standard_cost(v_a), 6) = 0.02
      and round(item_standard_cost(v_p), 6) = 0.015
      and round(item_standard_cost(v_p2), 6) = 0.15
      and item_standard_cost(v_n) is null;
  v_out := v_out || format(E'%s  standard cost: raw, prep, nested prep, no price -> null\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 2. Variant recipe, cost and food cost % ----------------------------------
  -- Hot: 100 g P (1.50) + 50 g A (1.00) = 2.50 on RM 10.00 -> 2500 bp.
  perform save_variant_recipe(v_v1, jsonb_build_array(
    jsonb_build_object('item_id', v_p, 'qty_base', 100),
    jsonb_build_object('item_id', v_a, 'qty_base', 50)));
  select * into v_row from menu_variant_costs where variant_id = v_v1;
  v_ok := v_row.line_count = 2 and round(v_row.cost_rm, 4) = 2.5 and v_row.food_cost_bp = 2500
      and v_row.missing_cost_items = 0 and v_row.over_target = false;
  v_out := v_out || format(E'%s  variant cost 2.50 and 2500 bp (got %s / %s)\n', case when v_ok then 'PASS' else 'FAIL' end, v_row.cost_rm, v_row.food_cost_bp);
  v_fail := v_fail or not v_ok;

  -- 3. Target and over-target ------------------------------------------------
  perform set_category_target(v_cat, 2000);
  select * into v_row from menu_variant_costs where variant_id = v_v1;
  v_ok := v_row.target_food_cost_bp = 2000 and v_row.over_target = true;
  perform set_category_target(v_cat, null);
  select * into v_row from menu_variant_costs where variant_id = v_v1;
  v_ok := v_ok and v_row.target_food_cost_bp is null and v_row.over_target = false;
  v_out := v_out || format(E'%s  category target flags over-target; null clears\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 4. Missing cost propagates -------------------------------------------------
  perform save_variant_recipe(v_v2, jsonb_build_array(
    jsonb_build_object('item_id', v_a, 'qty_base', 50),
    jsonb_build_object('item_id', v_n, 'qty_base', 10)));
  select * into v_row from menu_variant_costs where variant_id = v_v2;
  v_ok := v_row.missing_cost_items = 1 and v_row.cost_rm is null and v_row.food_cost_bp is null;
  v_out := v_out || format(E'%s  an ingredient without a price makes cost and %% null\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 5. Copy recipe Hot -> Cold overwrites -------------------------------------
  perform copy_variant_recipe(v_v1, v_v2);
  select * into v_row from menu_variant_costs where variant_id = v_v2;
  v_ok := v_row.line_count = 2 and round(v_row.cost_rm, 4) = 2.5 and v_row.food_cost_bp = 2083;
  v_out := v_out || format(E'%s  copy Hot -> Cold (2.50 on RM 12.00 = 2083 bp, got %s)\n', case when v_ok then 'PASS' else 'FAIL' end, v_row.food_cost_bp);
  v_fail := v_fail or not v_ok;

  -- 6. Zero price -> no food cost % ---------------------------------------------
  perform copy_variant_recipe(v_v1, v_v3);
  select * into v_row from menu_variant_costs where variant_id = v_v3;
  v_ok := round(v_row.cost_rm, 4) = 2.5 and v_row.food_cost_bp is null;
  v_out := v_out || format(E'%s  price 0 -> food cost %% null\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 7. Swap add-on: +100 ml B (1.00) -100 g A (-2.00) = -1.00 -----------------
  perform save_modifier_recipe(v_opt, jsonb_build_array(
    jsonb_build_object('item_id', v_b, 'qty_base', 100),
    jsonb_build_object('item_id', v_a, 'qty_base', -100)));
  select * into v_row from modifier_option_costs where option_id = v_opt;
  v_ok := round(v_row.cost_delta_rm, 4) = -1 and v_row.line_count = 2;
  v_out := v_out || format(E'%s  swap add-on cost delta -1.00 (got %s)\n', case when v_ok then 'PASS' else 'FAIL' end, v_row.cost_delta_rm);
  v_fail := v_fail or not v_ok;

  -- 8. Validation ----------------------------------------------------------------
  begin
    perform save_variant_recipe(v_v1, jsonb_build_array(jsonb_build_object('item_id', v_a, 'qty_base', 0)));
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%greater than zero%';
  end;
  begin
    perform save_modifier_recipe(v_opt, jsonb_build_array(jsonb_build_object('item_id', v_a, 'qty_base', 0)));
    v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%cannot be zero%';
  end;
  begin
    perform save_variant_recipe(v_v1, jsonb_build_array(
      jsonb_build_object('item_id', v_a, 'qty_base', 1), jsonb_build_object('item_id', v_a, 'qty_base', 2)));
    v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%more than once%';
  end;
  v_out := v_out || format(E'%s  zero / duplicate lines refused\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 9. item_standard_costs batch ------------------------------------------------
  select count(*) = 2 and bool_and(case when item_id = v_a then round(unit_cost, 6) = 0.02 else unit_cost is null end)
    into v_ok from item_standard_costs(array[v_a, v_n]);
  v_out := v_out || format(E'%s  item_standard_costs batch\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 10. Supervisor (no manage_procurement) refused --------------------------------
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', c_supervisor, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_ok := true;
  begin perform item_standard_cost(v_a); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%Not authorised%'; end;
  begin perform save_variant_recipe(v_v1, '[]'::jsonb); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%Not authorised%'; end;
  begin perform set_category_target(v_cat, 1000); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%Not authorised%'; end;
  select v_ok and not exists (select 1 from menu_variant_recipe_lines) and not exists (select 1 from menu_category_targets)
    into v_ok;
  execute 'reset role';
  v_out := v_out || format(E'%s  supervisor refused on functions and sees no recipe rows\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 11. anon cannot execute ---------------------------------------------------------
  select not bool_or(has_function_privilege('anon', p.oid, 'execute')) into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('item_standard_cost', 'item_standard_costs', 'item_standard_cost_at',
     'save_variant_recipe', 'save_modifier_recipe', 'copy_variant_recipe', 'set_category_target');
  v_out := v_out || format(E'%s  anon cannot execute menu costing functions\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  v_out := v_out || case when v_fail then 'VERIFY FAILED' else 'VERIFY OK' end;
  raise exception E'\n%', v_out;
end
$verify$;
```

- [ ] **Step 2: Run it on dev and see it fail**

Run: `"$DEVSQL" supabase/VERIFY-2026-11-22-menu-costing.sql` (where `DEVSQL=/private/tmp/claude-502/-Users-USER-Desktop-Craft-OS/2516e557-a088-40fb-85bf-3cbf7812eda7/scratchpad/devsql.sh`)
Expected: error `function item_standard_cost(uuid) does not exist` (or a missing relation).

- [ ] **Step 3: Write the migration**

Create `supabase/migration-2026-11-22-menu-costing.sql`:

```sql
-- ============================================================================
-- Craft OS — Menu costing (2026-11-22)
-- Recipes per menu variant and per add-on option, a standard ingredient cost
-- (latest price, prep items rolled up from their recipe), food cost % per
-- variant and an optional target per menu category. Managers only.
-- Spec: docs/superpowers/specs/2026-11-22-menu-costing-design.md
-- Additive and idempotent. Dev first.
-- ============================================================================

-- 1. Tables -------------------------------------------------------------------
create table if not exists menu_variant_recipe_lines (
  variant_id uuid not null references menu_variants(id) on delete cascade,
  item_id    uuid not null references items(id),
  qty_base   numeric not null check (qty_base > 0),
  sort_order integer not null default 0,
  primary key (variant_id, item_id)
);

create table if not exists modifier_recipe_lines (
  option_id  uuid not null references modifier_options(id) on delete cascade,
  item_id    uuid not null references items(id),
  qty_base   numeric not null check (qty_base <> 0),
  sort_order integer not null default 0,
  primary key (option_id, item_id)
);

create table if not exists menu_recipe_meta (
  variant_id uuid primary key references menu_variants(id) on delete cascade,
  updated_at timestamptz not null default now(),
  updated_by uuid references staff(id)
);

create table if not exists menu_category_targets (
  category_id         uuid primary key references menu_categories(id) on delete cascade,
  target_food_cost_bp integer not null check (target_food_cost_bp between 0 and 10000)
);

-- 2. RLS: managers read; writes only through the functions below --------------
alter table menu_variant_recipe_lines enable row level security;
alter table modifier_recipe_lines     enable row level security;
alter table menu_recipe_meta          enable row level security;
alter table menu_category_targets     enable row level security;

drop policy if exists menu_variant_recipe_lines_select on menu_variant_recipe_lines;
create policy menu_variant_recipe_lines_select on menu_variant_recipe_lines for select to authenticated
  using (has_procurement_cap('manage_procurement'));
drop policy if exists modifier_recipe_lines_select on modifier_recipe_lines;
create policy modifier_recipe_lines_select on modifier_recipe_lines for select to authenticated
  using (has_procurement_cap('manage_procurement'));
drop policy if exists menu_recipe_meta_select on menu_recipe_meta;
create policy menu_recipe_meta_select on menu_recipe_meta for select to authenticated
  using (has_procurement_cap('manage_procurement'));
drop policy if exists menu_category_targets_select on menu_category_targets;
create policy menu_category_targets_select on menu_category_targets for select to authenticated
  using (has_procurement_cap('manage_procurement'));

revoke all on menu_variant_recipe_lines, modifier_recipe_lines, menu_recipe_meta, menu_category_targets
  from anon, authenticated;
grant select on menu_variant_recipe_lines, modifier_recipe_lines, menu_recipe_meta, menu_category_targets
  to authenticated;

-- 3. Standard cost ---------------------------------------------------------------
-- RM per base unit. An item with a current prep recipe is rolled up from its
-- lines; otherwise latest_price / conversion_rate. Null when any input is null.
create or replace function item_standard_cost_at(p_item_id uuid, p_depth integer)
returns numeric
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_recipe uuid;
  v_yield  numeric;
  v_total  numeric := 0;
  v_cost   numeric;
  r        record;
begin
  if p_depth > 5 then
    return null;
  end if;
  v_recipe := recipe_for_date(p_item_id, business_date_of(now()));
  if v_recipe is null then
    return (select i.latest_price / i.conversion_rate from items i
             where i.id = p_item_id and i.conversion_rate > 0);
  end if;
  select yield_qty into v_yield from recipes where id = v_recipe;
  for r in select item_id, qty_base from recipe_lines where recipe_id = v_recipe loop
    v_cost := item_standard_cost_at(r.item_id, p_depth + 1);
    if v_cost is null then
      return null;
    end if;
    v_total := v_total + r.qty_base * v_cost;
  end loop;
  return v_total / v_yield;
end;
$$;
revoke all on function item_standard_cost_at(uuid, integer) from public, anon, authenticated;

create or replace function item_standard_cost(p_item_id uuid)
returns numeric
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to see menu costs';
  end if;
  return item_standard_cost_at(p_item_id, 0);
end;
$$;

create or replace function item_standard_costs(p_item_ids uuid[])
returns table (item_id uuid, unit_cost numeric)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to see menu costs';
  end if;
  return query
    select x.id, item_standard_cost_at(x.id, 0)
      from unnest(coalesce(p_item_ids, '{}')) as x(id);
end;
$$;

-- 4. Cost views (invoker rights: recipe rows are manager-only under RLS) -------
create or replace view menu_variant_costs with (security_invoker = true) as
with lines as (
  select l.variant_id, l.qty_base * item_standard_cost(l.item_id) as line_cost
    from menu_variant_recipe_lines l
), agg as (
  select variant_id,
         count(*)::int                                   as line_count,
         count(*) filter (where line_cost is null)::int  as missing,
         sum(line_cost)                                  as total
    from lines group by variant_id
)
select v.id                         as variant_id,
       v.name                       as variant_name,
       v.product_id,
       p.name                       as product_name,
       p.category_id,
       c.name                       as category_name,
       v.price_sen,
       (v.is_active and p.is_active) as is_active,
       coalesce(a.line_count, 0)    as line_count,
       coalesce(a.missing, 0)       as missing_cost_items,
       case when a.missing = 0 then a.total end as cost_rm,
       case when a.missing = 0 and v.price_sen > 0
            then round(a.total * 1000000 / v.price_sen)::int end as food_cost_bp,
       t.target_food_cost_bp,
       coalesce(t.target_food_cost_bp is not null and a.missing = 0 and v.price_sen > 0
                and round(a.total * 1000000 / v.price_sen) > t.target_food_cost_bp, false) as over_target
  from menu_variants v
  join menu_products p on p.id = v.product_id
  left join menu_categories c on c.id = p.category_id
  left join menu_category_targets t on t.category_id = p.category_id
  left join agg a on a.variant_id = v.id;

create or replace view modifier_option_costs with (security_invoker = true) as
with lines as (
  select l.option_id, l.qty_base * item_standard_cost(l.item_id) as line_cost
    from modifier_recipe_lines l
)
select o.id                                              as option_id,
       o.group_id,
       o.name                                            as option_name,
       o.price_delta_sen,
       count(l.option_id)::int                           as line_count,
       count(l.option_id) filter (where l.line_cost is null)::int as missing_cost_items,
       case when count(l.option_id) filter (where l.line_cost is null) = 0
            then coalesce(sum(l.line_cost), 0) end       as cost_delta_rm
  from modifier_options o
  left join lines l on l.option_id = o.id
 group by o.id, o.group_id, o.name, o.price_delta_sen;

revoke all on menu_variant_costs, modifier_option_costs from anon;
grant select on menu_variant_costs, modifier_option_costs to authenticated;

-- 5. RPCs ------------------------------------------------------------------------
-- p_lines: [{"item_id": "...", "qty_base": 120}, ...] in display order.
create or replace function save_variant_recipe(p_variant_id uuid, p_lines jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to edit menu recipes';
  end if;
  if not exists (select 1 from menu_variants where id = p_variant_id) then
    raise exception 'Menu variant not found';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]')) e
              where (e->>'qty_base') is null or (e->>'qty_base')::numeric <= 0) then
    raise exception 'Every quantity must be greater than zero';
  end if;
  if exists (select e->>'item_id' from jsonb_array_elements(coalesce(p_lines, '[]')) e
              group by e->>'item_id' having count(*) > 1) then
    raise exception 'An ingredient is listed more than once';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]')) e
              where not exists (select 1 from items i where i.id = (e->>'item_id')::uuid)) then
    raise exception 'Ingredient not found';
  end if;
  delete from menu_variant_recipe_lines where variant_id = p_variant_id;
  insert into menu_variant_recipe_lines (variant_id, item_id, qty_base, sort_order)
  select p_variant_id, (x.e->>'item_id')::uuid, (x.e->>'qty_base')::numeric, x.ord::int
    from jsonb_array_elements(coalesce(p_lines, '[]')) with ordinality as x(e, ord);
  insert into menu_recipe_meta (variant_id, updated_at, updated_by)
  values (p_variant_id, now(), auth.uid())
  on conflict (variant_id) do update set updated_at = excluded.updated_at, updated_by = excluded.updated_by;
end;
$$;

create or replace function save_modifier_recipe(p_option_id uuid, p_lines jsonb)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to edit menu recipes';
  end if;
  if not exists (select 1 from modifier_options where id = p_option_id) then
    raise exception 'Add-on option not found';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]')) e
              where (e->>'qty_base') is null or (e->>'qty_base')::numeric = 0) then
    raise exception 'A quantity cannot be zero';
  end if;
  if exists (select e->>'item_id' from jsonb_array_elements(coalesce(p_lines, '[]')) e
              group by e->>'item_id' having count(*) > 1) then
    raise exception 'An ingredient is listed more than once';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]')) e
              where not exists (select 1 from items i where i.id = (e->>'item_id')::uuid)) then
    raise exception 'Ingredient not found';
  end if;
  delete from modifier_recipe_lines where option_id = p_option_id;
  insert into modifier_recipe_lines (option_id, item_id, qty_base, sort_order)
  select p_option_id, (x.e->>'item_id')::uuid, (x.e->>'qty_base')::numeric, x.ord::int
    from jsonb_array_elements(coalesce(p_lines, '[]')) with ordinality as x(e, ord);
end;
$$;

create or replace function copy_variant_recipe(p_from_variant uuid, p_to_variant uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to edit menu recipes';
  end if;
  if p_from_variant = p_to_variant then
    raise exception 'Choose a different variant to copy from';
  end if;
  if not exists (select 1 from menu_variants where id = p_to_variant)
     or not exists (select 1 from menu_variants where id = p_from_variant) then
    raise exception 'Menu variant not found';
  end if;
  delete from menu_variant_recipe_lines where variant_id = p_to_variant;
  insert into menu_variant_recipe_lines (variant_id, item_id, qty_base, sort_order)
  select p_to_variant, item_id, qty_base, sort_order
    from menu_variant_recipe_lines where variant_id = p_from_variant;
  insert into menu_recipe_meta (variant_id, updated_at, updated_by)
  values (p_to_variant, now(), auth.uid())
  on conflict (variant_id) do update set updated_at = excluded.updated_at, updated_by = excluded.updated_by;
end;
$$;

create or replace function set_category_target(p_category_id uuid, p_target_bp integer)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to set food cost targets';
  end if;
  if not exists (select 1 from menu_categories where id = p_category_id) then
    raise exception 'Menu category not found';
  end if;
  if p_target_bp is null then
    delete from menu_category_targets where category_id = p_category_id;
    return;
  end if;
  if p_target_bp < 0 or p_target_bp > 10000 then
    raise exception 'Target must be between 0%% and 100%%';
  end if;
  insert into menu_category_targets (category_id, target_food_cost_bp)
  values (p_category_id, p_target_bp)
  on conflict (category_id) do update set target_food_cost_bp = excluded.target_food_cost_bp;
end;
$$;

-- 6. Grants ----------------------------------------------------------------------
revoke all on function item_standard_cost(uuid) from public, anon;
revoke all on function item_standard_costs(uuid[]) from public, anon;
revoke all on function save_variant_recipe(uuid, jsonb) from public, anon;
revoke all on function save_modifier_recipe(uuid, jsonb) from public, anon;
revoke all on function copy_variant_recipe(uuid, uuid) from public, anon;
revoke all on function set_category_target(uuid, integer) from public, anon;
grant execute on function item_standard_cost(uuid) to authenticated;
grant execute on function item_standard_costs(uuid[]) to authenticated;
grant execute on function save_variant_recipe(uuid, jsonb) to authenticated;
grant execute on function save_modifier_recipe(uuid, jsonb) to authenticated;
grant execute on function copy_variant_recipe(uuid, uuid) to authenticated;
grant execute on function set_category_target(uuid, integer) to authenticated;
```

- [ ] **Step 4: Apply, verify, re-apply**

```bash
"$DEVSQL" supabase/migration-2026-11-22-menu-costing.sql     # expect []
"$DEVSQL" supabase/VERIFY-2026-11-22-menu-costing.sql        # expect 11 PASS lines and VERIFY OK
"$DEVSQL" supabase/migration-2026-11-22-menu-costing.sql     # expect [] (idempotent)
```
If a check fails, find the real cause; fix the migration, or a fixture detail that does not fit dev (e.g. a required column on `menu_products`/`modifier_groups`), never weakening what a check asserts. Record any fixture change in the report.

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-11-22-menu-costing.sql supabase/VERIFY-2026-11-22-menu-costing.sql
git commit -m "feat(menu-costing): recipe lines, standard cost, food cost views and RPCs (dev)"
```

---

### Task 3: Types and pure cost helpers

**Files:**
- Create: `src/shared/types/menuCosting.ts`
- Modify: `src/shared/types/index.ts` (add `export * from './menuCosting'`)
- Create: `src/shared/lib/menuCosting.ts`
- Test: `src/shared/lib/menuCosting.test.ts`

**Interfaces:**
- Consumes: view/table shapes from Task 2.
- Produces:
  - Types `MenuVariantCost`, `ModifierOptionCost`, `RecipeLine` (`{ item_id: string; qty_base: number }`), `CostStatus = 'no_recipe' | 'missing_cost' | 'no_price' | 'over_target' | 'ok'`, `COST_STATUS_LABELS`.
  - `packsLooseToBase(packs: number | null, loose: number | null, rate: number): number | null`
  - `baseToPacksLoose(base: number, rate: number): { packs: number; loose: number }`
  - `lineCost(qtyBase: number, unitCost: number | null | undefined): number | null`
  - `recipeCost(lines: { qtyBase: number; unitCost: number | null | undefined }[]): { cost: number | null; missing: number }`
  - `foodCostBp(costRm: number | null, priceSen: number): number | null`
  - `costStatus(v: { lineCount: number; missing: number; priceSen: number; foodCostBp: number | null; targetBp: number | null }): CostStatus`
  - `formatBp(bp: number | null): string`

- [ ] **Step 1: Write the failing tests**

Create `src/shared/lib/menuCosting.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  packsLooseToBase, baseToPacksLoose, lineCost, recipeCost, foodCostBp, costStatus, formatBp,
} from './menuCosting'

describe('packsLooseToBase', () => {
  it('adds packs times rate and loose, rounded to 3 dp', () => {
    expect(packsLooseToBase(3, 250, 1000)).toBe(3250)
    expect(packsLooseToBase(3, null, 1.1)).toBe(3.3)
  })
  it('returns null when both are blank', () => {
    expect(packsLooseToBase(null, null, 1000)).toBeNull()
  })
})

describe('baseToPacksLoose', () => {
  it('splits into whole packs and the rest', () => {
    expect(baseToPacksLoose(3250, 1000)).toEqual({ packs: 3, loose: 250 })
  })
  it('keeps negative quantities whole (add-on removals)', () => {
    expect(baseToPacksLoose(-200, 1000)).toEqual({ packs: 0, loose: -200 })
  })
  it('uses packs only when the rate is 1', () => {
    expect(baseToPacksLoose(7, 1)).toEqual({ packs: 7, loose: 0 })
  })
})

describe('lineCost / recipeCost', () => {
  it('multiplies quantity by unit cost', () => {
    expect(lineCost(100, 0.015)).toBeCloseTo(1.5)
  })
  it('is null without a unit cost', () => {
    expect(lineCost(100, null)).toBeNull()
    expect(lineCost(100, undefined)).toBeNull()
  })
  it('sums lines and counts missing costs; cost is null if any is missing', () => {
    expect(recipeCost([{ qtyBase: 100, unitCost: 0.015 }, { qtyBase: 50, unitCost: 0.02 }]))
      .toEqual({ cost: 2.5, missing: 0 })
    expect(recipeCost([{ qtyBase: 100, unitCost: 0.015 }, { qtyBase: 10, unitCost: null }]))
      .toEqual({ cost: null, missing: 1 })
  })
  it('handles negative add-on lines', () => {
    expect(recipeCost([{ qtyBase: 100, unitCost: 0.01 }, { qtyBase: -100, unitCost: 0.02 }]).cost).toBeCloseTo(-1)
  })
})

describe('foodCostBp', () => {
  it('is cost over price in basis points', () => {
    expect(foodCostBp(2.5, 1000)).toBe(2500)
    expect(foodCostBp(2.5, 1200)).toBe(2083)
  })
  it('is null with no cost or no price', () => {
    expect(foodCostBp(null, 1000)).toBeNull()
    expect(foodCostBp(2.5, 0)).toBeNull()
  })
})

describe('costStatus', () => {
  const base = { lineCount: 2, missing: 0, priceSen: 1000, foodCostBp: 2500, targetBp: null }
  it('orders the checks: no recipe, missing cost, no price, over target, ok', () => {
    expect(costStatus({ ...base, lineCount: 0 })).toBe('no_recipe')
    expect(costStatus({ ...base, missing: 1, foodCostBp: null })).toBe('missing_cost')
    expect(costStatus({ ...base, priceSen: 0, foodCostBp: null })).toBe('no_price')
    expect(costStatus({ ...base, targetBp: 2000 })).toBe('over_target')
    expect(costStatus({ ...base, targetBp: 3000 })).toBe('ok')
    expect(costStatus(base)).toBe('ok')
  })
})

describe('formatBp', () => {
  it('shows one decimal percent or a dash', () => {
    expect(formatBp(2083)).toBe('20.8%')
    expect(formatBp(2500)).toBe('25.0%')
    expect(formatBp(null)).toBe('—')
  })
})
```

- [ ] **Step 2: Run and see it fail**

Run: `VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run src/shared/lib/menuCosting.test.ts`
Expected: FAIL — cannot resolve `./menuCosting`.

- [ ] **Step 3: Write the types**

Create `src/shared/types/menuCosting.ts`:

```ts
/** One row of the menu_variant_costs view. Costs in RM, prices in sen. */
export interface MenuVariantCost {
  variant_id: string
  variant_name: string
  product_id: string
  product_name: string
  category_id: string | null
  category_name: string | null
  price_sen: number
  is_active: boolean
  line_count: number
  missing_cost_items: number
  /** Null when there is no recipe or an ingredient has no cost. */
  cost_rm: number | null
  /** cost ÷ price in basis points (2500 = 25%); null when not computable. */
  food_cost_bp: number | null
  target_food_cost_bp: number | null
  over_target: boolean
}

/** One row of the modifier_option_costs view. */
export interface ModifierOptionCost {
  option_id: string
  group_id: string
  option_name: string
  price_delta_sen: number
  line_count: number
  missing_cost_items: number
  /** May be negative (a swap that saves cost); null when an ingredient has no cost. */
  cost_delta_rm: number | null
}

/** A recipe line as saved: base units of the item. */
export interface RecipeLine {
  item_id: string
  qty_base: number
}

export type CostStatus = 'no_recipe' | 'missing_cost' | 'no_price' | 'over_target' | 'ok'

export const COST_STATUS_LABELS: Record<CostStatus, string> = {
  no_recipe:    'No recipe',
  missing_cost: 'Missing price',
  no_price:     'No selling price',
  over_target:  'Over target',
  ok:           'OK',
}
```

Append to `src/shared/types/index.ts`: `export * from './menuCosting'`.

- [ ] **Step 4: Write the helpers**

Create `src/shared/lib/menuCosting.ts`:

```ts
import type { CostStatus } from '../types'

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Packs + loose base units → base units (3 dp). Both blank = null. */
export function packsLooseToBase(packs: number | null, loose: number | null, rate: number): number | null {
  if (packs == null && loose == null) return null
  return round3((packs ?? 0) * rate + (loose ?? 0))
}

/** Base units → whole packs and the rest. Negative quantities stay loose. */
export function baseToPacksLoose(base: number, rate: number): { packs: number; loose: number } {
  if (rate === 1) return { packs: base, loose: 0 }
  if (base < 0) return { packs: 0, loose: round3(base) }
  const packs = Math.floor(base / rate + 1e-9)
  const loose = round3(base - packs * rate)
  return { packs, loose: loose < 0 ? 0 : loose }
}

/** Cost of one line in RM; null when the ingredient has no cost. */
export function lineCost(qtyBase: number, unitCost: number | null | undefined): number | null {
  return unitCost == null ? null : qtyBase * unitCost
}

/** Total recipe cost; null when any line has no cost. */
export function recipeCost(lines: { qtyBase: number; unitCost: number | null | undefined }[]): { cost: number | null; missing: number } {
  let total = 0
  let missing = 0
  for (const l of lines) {
    const c = lineCost(l.qtyBase, l.unitCost)
    if (c == null) missing += 1
    else total += c
  }
  return { cost: missing > 0 ? null : Math.round(total * 10000) / 10000, missing }
}

/** Food cost in basis points: cost (RM) ÷ price (sen). */
export function foodCostBp(costRm: number | null, priceSen: number): number | null {
  if (costRm == null || priceSen <= 0) return null
  return Math.round((costRm * 1000000) / priceSen)
}

export function costStatus(v: {
  lineCount: number; missing: number; priceSen: number; foodCostBp: number | null; targetBp: number | null
}): CostStatus {
  if (v.lineCount === 0) return 'no_recipe'
  if (v.missing > 0) return 'missing_cost'
  if (v.priceSen <= 0) return 'no_price'
  if (v.targetBp != null && v.foodCostBp != null && v.foodCostBp > v.targetBp) return 'over_target'
  return 'ok'
}

export function formatBp(bp: number | null): string {
  return bp == null ? '—' : `${(bp / 100).toFixed(1)}%`
}
```

- [ ] **Step 5: Tests pass, type-check, full suite, commit**

```bash
VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run src/shared/lib/menuCosting.test.ts
npx tsc -b
VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run
git add src/shared/types/menuCosting.ts src/shared/types/index.ts src/shared/lib/menuCosting.ts src/shared/lib/menuCosting.test.ts
git commit -m "feat(menu-costing): cost types and helpers"
```
Expected: all pass, tsc silent.

---

### Task 4: Menu Costing list page, route and nav

**Files:**
- Create: `src/features/procurement/MenuCosting.tsx`
- Create (placeholder, replaced in Task 5): `src/features/procurement/MenuRecipeEditor.tsx` with `export default function MenuRecipeEditorPage() { return null }`
- Modify: `src/App.tsx` (routes next to the other `/procurement/*` routes), `src/shared/lib/nav.ts` (inventory group), `src/shared/lib/nav.test.ts`

**Interfaces:**
- Consumes: view `menu_variant_costs`; RPC `set_category_target`; helpers `costStatus`, `formatBp`; `money` from `src/shared/lib/procurement.ts`; `COST_STATUS_LABELS`.
- Produces: routes `/procurement/menu-costing` and `/procurement/menu-costing/:variantId` (both `manage_procurement`); nav entry id `proc-menu-costing`.

- [ ] **Step 1: Nav test first**

In `src/shared/lib/nav.test.ts`, add `'proc-menu-costing'` to the managers' expected inventory list right after `'proc-recipes'` (it must not appear in the supervisors' list), and add:

```ts
expect(activeEntry(full, '/procurement/menu-costing/v-1')).toEqual({ leafId: 'proc-menu-costing', groupId: 'inventory' })
```
Run `VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run src/shared/lib/nav.test.ts` → FAIL.

- [ ] **Step 2: Nav entry**

In `src/shared/lib/nav.ts`, inventory group, after the `proc-recipes` entry:

```ts
      { id: 'proc-menu-costing', label: 'Menu Costing', to: '/procurement/menu-costing', cap: 'manage_procurement' },
```
Nav test → PASS.

- [ ] **Step 3: List page**

Create `src/features/procurement/MenuCosting.tsx`:

```tsx
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money } from '../../shared/lib/procurement'
import { costStatus, formatBp } from '../../shared/lib/menuCosting'
import type { MenuVariantCost, CostStatus } from '../../shared/types'
import { COST_STATUS_LABELS } from '../../shared/types'

const STATUS_CLS: Record<CostStatus, string> = {
  no_recipe:    'bg-[#F3EEE6] text-brown-muted',
  missing_cost: 'bg-[#FDF0DC] text-[#B46309]',
  no_price:     'bg-[#F3EEE6] text-brown-muted',
  over_target:  'bg-[#FBE4E1] text-red-700',
  ok:           'bg-[#E6F2E3] text-green-700',
}
type Filter = 'all' | CostStatus

function statusOf(r: MenuVariantCost): CostStatus {
  return costStatus({
    lineCount: r.line_count, missing: r.missing_cost_items, priceSen: r.price_sen,
    foodCostBp: r.food_cost_bp, targetBp: r.target_food_cost_bp,
  })
}

export default function MenuCostingPage() {
  const [rows, setRows] = useState<MenuVariantCost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sortWorst, setSortWorst] = useState(false)
  const [search, setSearch] = useState('')
  const busy = useRef(false)

  const load = useCallback(async () => {
    const { data, error: err } = await supabase
      .from('menu_variant_costs').select('*').eq('is_active', true)
    if (err) setError(err.message)
    setRows((data as MenuVariantCost[]) ?? [])
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  async function editTarget(categoryId: string, name: string, current: number | null) {
    if (busy.current) return
    const input = window.prompt(`Target food cost % for ${name} (blank = none)`, current == null ? '' : String(current / 100))
    if (input === null) return
    const trimmed = input.trim()
    const pct = trimmed === '' ? null : Number(trimmed)
    if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) { setError('Enter a percentage between 0 and 100.'); return }
    busy.current = true
    const { error: err } = await supabase.rpc('set_category_target', {
      p_category_id: categoryId, p_target_bp: pct === null ? null : Math.round(pct * 100),
    })
    busy.current = false
    if (err) { setError(err.message); return }
    setError('')
    load()
  }

  const counts = useMemo(() => {
    const c: Record<CostStatus, number> = { no_recipe: 0, missing_cost: 0, no_price: 0, over_target: 0, ok: 0 }
    rows.forEach(r => { c[statusOf(r)] += 1 })
    return c
  }, [rows])

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const shown = rows.filter(r =>
      (filter === 'all' || statusOf(r) === filter)
      && (!q || r.product_name.toLowerCase().includes(q) || r.variant_name.toLowerCase().includes(q)))
    const byCat = new Map<string, { id: string | null; name: string; target: number | null; rows: MenuVariantCost[] }>()
    for (const r of shown) {
      const key = r.category_id ?? 'none'
      if (!byCat.has(key)) byCat.set(key, { id: r.category_id, name: r.category_name ?? 'No category', target: r.target_food_cost_bp, rows: [] })
      byCat.get(key)!.rows.push(r)
    }
    const list = [...byCat.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const g of list) {
      g.rows.sort(sortWorst
        ? (a, b) => (b.food_cost_bp ?? -1) - (a.food_cost_bp ?? -1)
        : (a, b) => a.product_name.localeCompare(b.product_name) || a.variant_name.localeCompare(b.variant_name))
    }
    return list
  }, [rows, filter, search, sortWorst])

  const pill = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap border ${active ? 'bg-[#C4813A] border-[#C4813A] text-white' : 'bg-white border-[#D4C5B0] text-brown-medium'}`

  return (
    <div className="min-h-screen bg-cream-light px-4 py-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <div>
          <h1 className="text-xl font-bold text-brown-dark">Menu Costing</h1>
          <p className="text-xs text-brown-faint mt-0.5">Ingredient cost and food cost % per menu size, from the latest purchase prices. Prices exclude SST.</p>
        </div>
        <input
          className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark"
          placeholder="Search menu" value={search} onChange={e => setSearch(e.target.value)}
        />
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4">
          <button type="button" className={pill(filter === 'all')} onClick={() => setFilter('all')}>All · {rows.length}</button>
          {(['over_target', 'missing_cost', 'no_recipe', 'no_price', 'ok'] as const).map(s => (
            <button key={s} type="button" className={pill(filter === s)} onClick={() => setFilter(s)}>
              {COST_STATUS_LABELS[s]} · {counts[s]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-brown-muted">
          <input type="checkbox" checked={sortWorst} onChange={e => setSortWorst(e.target.checked)} />
          Highest food cost first
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        {loading ? <p className="text-sm text-brown-faint">Loading…</p> : groups.length === 0 ? (
          <p className="text-sm text-brown-faint">Nothing matches.</p>
        ) : groups.map(g => (
          <section key={g.id ?? 'none'} className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-brown-dark">{g.name}</h2>
              {g.id && (
                <button type="button" className="text-xs font-semibold text-[#C4813A]" onClick={() => editTarget(g.id!, g.name, g.target)}>
                  {g.target == null ? 'Set target' : `Target ${formatBp(g.target)}`}
                </button>
              )}
            </div>
            <ul className="space-y-2">
              {g.rows.map(r => {
                const s = statusOf(r)
                return (
                  <li key={r.variant_id}>
                    <Link to={`/procurement/menu-costing/${r.variant_id}`}
                      className="flex items-center justify-between gap-3 bg-white rounded-xl border border-[#E8DDD0] px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-brown-dark truncate">{r.product_name}</p>
                        <p className="text-xs text-brown-faint">
                          {r.variant_name} · {money(r.price_sen / 100)} · cost {r.cost_rm == null ? '—' : money(Number(r.cost_rm))}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-base font-bold ${s === 'over_target' ? 'text-red-700' : 'text-brown-dark'}`}>{formatBp(r.food_cost_bp)}</p>
                        <span className={`inline-block mt-0.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${STATUS_CLS[s]}`}>{COST_STATUS_LABELS[s]}</span>
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
```

Check `money` exists in `src/shared/lib/procurement.ts` after the merge (it formats `RM n.nn` from a number of ringgit). If the merged file lacks it, add nothing new — use `` `RM ${(x).toFixed(2)}` `` inline instead.

- [ ] **Step 4: Routes**

In `src/App.tsx`, import `MenuCostingPage from './features/procurement/MenuCosting'` and `MenuRecipeEditorPage from './features/procurement/MenuRecipeEditor'`, and add, next to the other procurement routes, two routes using the same `ProtectedRoute requireCap="manage_procurement"` + `AppLayout` wrapper those routes use: `/procurement/menu-costing` → `MenuCostingPage`, `/procurement/menu-costing/:variantId` → `MenuRecipeEditorPage`.

- [ ] **Step 5: Type-check, tests, commit**

```bash
npx tsc -b
VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run
git add src/features/procurement/MenuCosting.tsx src/features/procurement/MenuRecipeEditor.tsx src/App.tsx src/shared/lib/nav.ts src/shared/lib/nav.test.ts
git commit -m "feat(menu-costing): Menu Costing list page, routes and nav"
```

---

### Task 5: Recipe editor (variant recipe, copy, add-on recipes)

**Files:**
- Create: `src/features/procurement/RecipeLinesEditor.tsx`
- Replace: `src/features/procurement/MenuRecipeEditor.tsx`

**Interfaces:**
- Consumes: tables `menu_variants`, `menu_products`, `product_modifier_groups`, `modifier_groups`, `modifier_options`, `menu_variant_recipe_lines`, `modifier_recipe_lines`, `items`; views `menu_variant_costs`, `modifier_option_costs`; RPCs `item_standard_costs`, `save_variant_recipe`, `save_modifier_recipe`, `copy_variant_recipe`; helpers `packsLooseToBase`, `baseToPacksLoose`, `lineCost`, `recipeCost`, `foodCostBp`, `formatBp`; `money`, `qty` from `src/shared/lib/procurement.ts`; type `Item`.
- Produces: `RecipeLinesEditor` component:
  `({ lines, onChange, items, costs, allowNegative }: { lines: RecipeLine[]; onChange: (next: RecipeLine[]) => void; items: Item[]; costs: Map<string, number | null>; allowNegative: boolean })`.

- [ ] **Step 1: Lines editor**

Create `src/features/procurement/RecipeLinesEditor.tsx`:

```tsx
import { useState, useMemo } from 'react'
import { money, qty } from '../../shared/lib/procurement'
import { packsLooseToBase, baseToPacksLoose, lineCost } from '../../shared/lib/menuCosting'
import type { Item, RecipeLine } from '../../shared/types'

const numCls = 'w-20 h-10 px-2 rounded-lg border border-[#E8DDD0] bg-[#FDFAF6] text-center text-sm font-bold text-brown-dark'

function parse(v: string): number | null {
  if (v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

function QtyInputs({ item, value, negative, onCommit }: {
  item: Item; value: number; negative: boolean; onCommit: (base: number | null) => void
}) {
  const rate = Number(item.conversion_rate)
  const single = rate === 1
  const start = baseToPacksLoose(Math.abs(value), rate)
  const [p, setP] = useState(start.packs ? String(start.packs) : '')
  const [l, setL] = useState(start.loose ? String(start.loose) : '')
  function commit(np = p, nl = l) {
    const pp = parse(np); const ll = single ? null : parse(nl)
    if (Number.isNaN(pp) || Number.isNaN(ll)) return
    const base = packsLooseToBase(pp, ll, rate)
    onCommit(base == null || base === 0 ? null : (negative ? -base : base))
  }
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <input className={numCls} inputMode="decimal" value={p} aria-label={`${item.name} ${single ? item.base_unit : item.purchase_unit}`}
        onChange={e => setP(e.target.value)} onBlur={() => commit()} />
      <span className="text-xs text-brown-muted">{single ? item.base_unit : item.purchase_unit}</span>
      {!single && (<>
        <span className="text-brown-faint">+</span>
        <input className={numCls} inputMode="decimal" value={l} aria-label={`${item.name} ${item.base_unit}`}
          onChange={e => setL(e.target.value)} onBlur={() => commit()} />
        <span className="text-xs text-brown-muted">{item.base_unit}</span>
      </>)}
    </div>
  )
}

export default function RecipeLinesEditor({ lines, onChange, items, costs, allowNegative }: {
  lines: RecipeLine[]
  onChange: (next: RecipeLine[]) => void
  items: Item[]
  costs: Map<string, number | null>
  allowNegative: boolean
}) {
  const [search, setSearch] = useState('')
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items])
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    const used = new Set(lines.map(l => l.item_id))
    return items.filter(i => i.status === 'active' && !used.has(i.id) && i.name.toLowerCase().includes(q)).slice(0, 8)
  }, [search, items, lines])

  function setQty(itemId: string, base: number | null) {
    if (base == null) return
    onChange(lines.map(l => (l.item_id === itemId ? { ...l, qty_base: base } : l)))
  }
  function flip(itemId: string) {
    onChange(lines.map(l => (l.item_id === itemId ? { ...l, qty_base: -l.qty_base } : l)))
  }

  return (
    <div className="space-y-2">
      {lines.length === 0 && <p className="text-sm text-brown-faint">No ingredients yet.</p>}
      {lines.map(l => {
        const it = byId.get(l.item_id)
        if (!it) return null
        const c = lineCost(l.qty_base, costs.get(l.item_id))
        const neg = l.qty_base < 0
        return (
          <div key={`${l.item_id}:${neg ? 'n' : 'p'}`} className="bg-white rounded-xl border border-[#E8DDD0] px-3 py-2.5 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-brown-dark">{it.name}{it.status !== 'active' && <span className="ml-2 text-xs text-[#B46309]">Inactive</span>}</p>
                <p className="text-xs text-brown-faint">{qty(Math.abs(l.qty_base))} {it.base_unit} · {c == null ? <span className="text-[#B46309]">No price</span> : money(c)}</p>
              </div>
              <button type="button" className="text-xs text-red-700" onClick={() => onChange(lines.filter(x => x.item_id !== l.item_id))}>Remove</button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {allowNegative && (
                <button type="button" onClick={() => flip(l.item_id)}
                  className={`px-2 py-1 rounded-full text-xs font-semibold border ${neg ? 'border-red-300 text-red-700' : 'border-green-300 text-green-700'}`}>
                  {neg ? 'Removes' : 'Adds'}
                </button>
              )}
              <QtyInputs item={it} value={l.qty_base} negative={neg} onCommit={b => setQty(l.item_id, b)} />
            </div>
          </div>
        )
      })}
      <div className="relative">
        <input className="w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm" placeholder="Add ingredient — search items"
          value={search} onChange={e => setSearch(e.target.value)} />
        {matches.length > 0 && (
          <ul className="mt-1 bg-white rounded-lg border border-[#E8DDD0] divide-y divide-[#F0E8DC]">
            {matches.map(i => (
              <li key={i.id}>
                <button type="button" className="w-full text-left px-3 py-2 text-sm text-brown-dark"
                  onClick={() => { onChange([...lines, { item_id: i.id, qty_base: Number(i.conversion_rate) === 1 ? 1 : Number(i.conversion_rate) }]); setSearch('') }}>
                  {i.name} <span className="text-xs text-brown-faint">({i.purchase_unit}, {qty(Number(i.conversion_rate))} {i.base_unit})</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
```

(A newly added ingredient starts at one purchase unit; the user adjusts it.)

- [ ] **Step 2: Editor page**

Replace `src/features/procurement/MenuRecipeEditor.tsx`:

```tsx
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { money } from '../../shared/lib/procurement'
import { recipeCost, foodCostBp, formatBp } from '../../shared/lib/menuCosting'
import type { Item, RecipeLine } from '../../shared/types'
import RecipeLinesEditor from './RecipeLinesEditor'

interface Variant { id: string; name: string; price_sen: number; product_id: string }
interface Option { id: string; name: string; price_delta_sen: number; group_name: string }

const sameLines = (a: RecipeLine[], b: RecipeLine[]) =>
  a.length === b.length && a.every((l, i) => l.item_id === b[i].item_id && l.qty_base === b[i].qty_base)

export default function MenuRecipeEditorPage() {
  const { variantId } = useParams<{ variantId: string }>()
  const [variant, setVariant] = useState<Variant | null>(null)
  const [productName, setProductName] = useState('')
  const [siblings, setSiblings] = useState<Variant[]>([])
  const [options, setOptions] = useState<Option[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [costs, setCosts] = useState<Map<string, number | null>>(new Map())
  const [lines, setLines] = useState<RecipeLine[]>([])
  const [savedLines, setSavedLines] = useState<RecipeLine[]>([])
  const [optLines, setOptLines] = useState<Record<string, RecipeLine[]>>({})
  const [optSaved, setOptSaved] = useState<Record<string, RecipeLine[]>>({})
  const [openOpt, setOpenOpt] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const busy = useRef(false)
  const [busyState, setBusyState] = useState(false)

  const loadCosts = useCallback(async (ids: string[]) => {
    const missing = ids.filter(id => !costs.has(id))
    if (missing.length === 0) return
    const { data, error: err } = await supabase.rpc('item_standard_costs', { p_item_ids: missing })
    if (err) { setError(err.message); return }
    setCosts(prev => {
      const next = new Map(prev)
      for (const r of (data as { item_id: string; unit_cost: number | null }[]) ?? []) next.set(r.item_id, r.unit_cost == null ? null : Number(r.unit_cost))
      return next
    })
  }, [costs])

  const load = useCallback(async () => {
    if (!variantId) return
    const { data: v, error: vErr } = await supabase.from('menu_variants').select('id, name, price_sen, product_id').eq('id', variantId).maybeSingle()
    if (vErr || !v) { setError(vErr?.message ?? 'Menu variant not found'); setLoading(false); return }
    const vv = v as Variant
    const [pRes, sRes, iRes, lRes, gRes] = await Promise.all([
      supabase.from('menu_products').select('name').eq('id', vv.product_id).maybeSingle(),
      supabase.from('menu_variants').select('id, name, price_sen, product_id').eq('product_id', vv.product_id).eq('is_active', true).order('sort_order'),
      supabase.from('items').select('*').order('name'),
      supabase.from('menu_variant_recipe_lines').select('item_id, qty_base').eq('variant_id', vv.id).order('sort_order'),
      supabase.from('product_modifier_groups').select('group_id, sort_order, group:modifier_groups(name, options:modifier_options(id, name, price_delta_sen, sort_order))').eq('product_id', vv.product_id).order('sort_order'),
    ])
    const opts: Option[] = []
    for (const g of (gRes.data as unknown as { group: { name: string; options: { id: string; name: string; price_delta_sen: number; sort_order: number }[] } | null }[]) ?? []) {
      for (const o of [...(g.group?.options ?? [])].sort((a, b) => a.sort_order - b.sort_order)) {
        opts.push({ id: o.id, name: o.name, price_delta_sen: o.price_delta_sen, group_name: g.group?.name ?? '' })
      }
    }
    const olRes = opts.length
      ? await supabase.from('modifier_recipe_lines').select('option_id, item_id, qty_base').in('option_id', opts.map(o => o.id)).order('sort_order')
      : { data: [], error: null }
    const recipe = ((lRes.data as RecipeLine[]) ?? []).map(l => ({ item_id: l.item_id, qty_base: Number(l.qty_base) }))
    const byOpt: Record<string, RecipeLine[]> = {}
    for (const r of (olRes.data as { option_id: string; item_id: string; qty_base: number }[]) ?? []) {
      (byOpt[r.option_id] ??= []).push({ item_id: r.item_id, qty_base: Number(r.qty_base) })
    }
    setVariant(vv)
    setProductName((pRes.data as { name: string } | null)?.name ?? '')
    setSiblings(((sRes.data as Variant[]) ?? []).filter(s => s.id !== vv.id))
    setItems((iRes.data as Item[]) ?? [])
    setLines(recipe); setSavedLines(recipe)
    setOptions(opts); setOptLines(byOpt); setOptSaved(byOpt)
    const firstErr = [pRes, sRes, iRes, lRes, gRes, olRes].find(r => r.error)?.error
    if (firstErr) setError(firstErr.message)
    setLoading(false)
  }, [variantId])

  useEffect(() => { load() }, [load])

  // Fetch costs for every ingredient on screen.
  useEffect(() => {
    const ids = new Set(lines.map(l => l.item_id))
    Object.values(optLines).forEach(ls => ls.forEach(l => ids.add(l.item_id)))
    if (ids.size) loadCosts([...ids])
  }, [lines, optLines, loadCosts])

  const dirty = !sameLines(lines, savedLines) || options.some(o => !sameLines(optLines[o.id] ?? [], optSaved[o.id] ?? []))
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const total = useMemo(() => recipeCost(lines.map(l => ({ qtyBase: l.qty_base, unitCost: costs.get(l.item_id) }))), [lines, costs])

  async function run(fn: () => Promise<boolean>) {
    if (busy.current) return
    busy.current = true; setBusyState(true); setError(''); setNotice('')
    try { await fn() } finally { busy.current = false; setBusyState(false) }
  }

  const saveVariant = () => run(async () => {
    const { error: err } = await supabase.rpc('save_variant_recipe', { p_variant_id: variantId, p_lines: lines })
    if (err) { setError(err.message); return false }
    setSavedLines(lines); setNotice('Recipe saved.'); return true
  })

  const saveOption = (optionId: string) => run(async () => {
    const ls = optLines[optionId] ?? []
    const { error: err } = await supabase.rpc('save_modifier_recipe', { p_option_id: optionId, p_lines: ls })
    if (err) { setError(err.message); return false }
    setOptSaved(prev => ({ ...prev, [optionId]: ls })); setNotice('Add-on saved.'); return true
  })

  const copyFrom = (fromId: string) => run(async () => {
    if (lines.length > 0 && !window.confirm('Replace this recipe with the one from the other size?')) return false
    const { error: err } = await supabase.rpc('copy_variant_recipe', { p_from_variant: fromId, p_to_variant: variantId })
    if (err) { setError(err.message); return false }
    await load(); setNotice('Recipe copied. Adjust the quantities for this size.'); return true
  })

  if (loading) return <div className="min-h-screen bg-cream-light px-4 py-8 text-center text-sm text-brown-faint">Loading…</div>
  if (!variant) {
    return (
      <div className="min-h-screen bg-cream-light px-4 py-8 text-center">
        <p className="text-sm text-brown-muted">{error || 'Menu variant not found.'}</p>
        <Link to="/procurement/menu-costing" className="text-sm text-[#C4813A] font-semibold">← Menu Costing</Link>
      </div>
    )
  }

  const bp = foodCostBp(total.cost, variant.price_sen)

  return (
    <div className="min-h-screen bg-cream-light px-4 py-6 pb-28">
      <div className="max-w-2xl mx-auto space-y-4">
        <Link to="/procurement/menu-costing" className="text-sm text-brown-muted">← Menu Costing</Link>
        <div>
          <h1 className="text-xl font-bold text-brown-dark">{productName} · {variant.name}</h1>
          <p className="text-xs text-brown-faint">Price {money(variant.price_sen / 100)} (excl. SST)</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-white rounded-xl border border-[#E8DDD0] p-3 text-center">
            <p className="text-xs text-brown-faint">Cost</p>
            <p className="text-base font-bold text-brown-dark">{total.cost == null ? (lines.length ? 'Missing price' : '—') : money(total.cost)}</p>
          </div>
          <div className="bg-white rounded-xl border border-[#E8DDD0] p-3 text-center">
            <p className="text-xs text-brown-faint">Food cost</p>
            <p className="text-base font-bold text-brown-dark">{formatBp(bp)}</p>
          </div>
        </div>

        {siblings.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap text-xs text-brown-muted">
            Copy from:
            {siblings.map(s => (
              <button key={s.id} type="button" disabled={busyState} onClick={() => copyFrom(s.id)}
                className="px-2.5 py-1 rounded-full border border-[#D4C5B0] bg-white font-semibold text-brown-medium disabled:opacity-50">{s.name}</button>
            ))}
          </div>
        )}

        <section className="space-y-2">
          <h2 className="text-sm font-bold text-brown-dark">Ingredients</h2>
          <RecipeLinesEditor lines={lines} onChange={setLines} items={items} costs={costs} allowNegative={false} />
        </section>

        {options.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-bold text-brown-dark">Add-ons</h2>
            <p className="text-xs text-brown-faint">What each add-on adds to, or removes from, the recipe above.</p>
            {options.map(o => {
              const ls = optLines[o.id] ?? []
              const delta = recipeCost(ls.map(l => ({ qtyBase: l.qty_base, unitCost: costs.get(l.item_id) })))
              const open = openOpt === o.id
              const optDirty = !sameLines(ls, optSaved[o.id] ?? [])
              return (
                <div key={o.id} className="bg-white rounded-xl border border-[#E8DDD0]">
                  <button type="button" onClick={() => setOpenOpt(open ? null : o.id)} className="w-full flex items-center justify-between px-4 py-3 text-left">
                    <span className="text-sm text-brown-dark"><span className="text-xs text-brown-faint">{o.group_name} · </span>{o.name}</span>
                    <span className="text-xs text-brown-muted">
                      {ls.length === 0 ? 'No change' : delta.cost == null ? 'Missing price' : `${delta.cost < 0 ? '−' : '+'}${money(Math.abs(delta.cost))}`}
                      {optDirty && ' · unsaved'}
                    </span>
                  </button>
                  {open && (
                    <div className="px-3 pb-3 space-y-2">
                      <RecipeLinesEditor lines={ls} onChange={next => setOptLines(prev => ({ ...prev, [o.id]: next }))} items={items} costs={costs} allowNegative />
                      <button type="button" disabled={busyState || !optDirty} onClick={() => saveOption(o.id)}
                        className="w-full h-10 rounded-lg bg-brown-btn text-white text-sm font-bold disabled:opacity-40">Save add-on</button>
                    </div>
                  )}
                </div>
              )
            })}
          </section>
        )}

        {notice && <p className="text-sm text-green-700">{notice}</p>}
        {error && <p className="text-sm text-red-700">{error}</p>}
      </div>

      <div className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-[#E8DDD0] px-4 py-3">
        <div className="max-w-2xl mx-auto">
          <button type="button" disabled={busyState || sameLines(lines, savedLines)} onClick={saveVariant}
            className="w-full h-12 rounded-xl bg-brown-btn text-white text-sm font-bold disabled:opacity-40">
            {sameLines(lines, savedLines) ? 'Recipe saved' : 'Save recipe'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Type-check, tests, commit**

```bash
npx tsc -b
VITE_SUPABASE_URL=http://localhost:1 VITE_SUPABASE_ANON_KEY=x npx vitest run
git add src/features/procurement/RecipeLinesEditor.tsx src/features/procurement/MenuRecipeEditor.tsx
git commit -m "feat(menu-costing): recipe editor with copy-from and add-on recipes"
```
If the embedded select on `product_modifier_groups → modifier_groups → modifier_options` fails at runtime because PostgREST cannot infer the relation, the controller's browser check (Task 6) will catch it; keep the code as written here.

---

### Task 6: Browser check on dev (controller)

- [ ] Start a dev-proxy launch entry for this worktree (copy `.env.local` and `vite.proxy.local.mjs` from `../inventory-v2`, port 5186, `VITE_SUPABASE_URL=http://localhost:5186/sb`), sign in the [TEST] Cheras manager.
- [ ] Menu Costing list loads the dev menu, filters and counts work, setting a category target flags over-target rows.
- [ ] Open a variant, add two [TEST] ingredients, save; cost and food cost % match a hand calculation; list row updates.
- [ ] Copy that recipe to another size; add a swap add-on (Adds / Removes); save; cost delta shows.
- [ ] A supervisor cannot open `/procurement/menu-costing`.
- [ ] Push the branch.
