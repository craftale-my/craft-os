# POS Phase 1 · Sub-plan 1 — Menu (schema, Feedme import, `/menu`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the real Craft Cafe menu into Craft OS: menu tables, a re-runnable import from Feedme's menu export (zip of `.xlsx` files), and a `/menu` page where managers see the menu and set what Feedme's export doesn't carry (SST rate, print route, availability).

**Architecture:** Menu tables in the same Supabase project as Craft OS, readable by all signed-in staff, writable only by holders of `access_settings` (owner/admin/manager). The import runs in the browser: unzip + parse the `.xlsx` files (`fflate` + `DOMParser`), turn them into one JSON payload with a pure, unit-tested builder, then send it to a single `security definer` RPC `menu_import` that upserts by Feedme ID inside one transaction. Re-importing updates names/prices/categories/variants/add-ons but never touches `sst_rate_bp` or `print_route`, and never deletes products.

**Tech Stack:** React 19 + Vite 6 + TypeScript, Supabase (Postgres, RLS, plpgsql RPC), Vitest (+ jsdom for `DOMParser`), `fflate` (zip).

**Spec:** `docs/superpowers/specs/2026-10-22-pos-demo-design.md` (数据模型 · 菜单, 菜单导入). Phase 0 results: `docs/superpowers/spikes/2026-10-22-pos-phase0-results.md`.

## Spec deltas (decided while reading the real export, 2026-10-22)

- **No `set_slots` / `set_slot_choices`.** Feedme models sets (e.g. "Sip & Sweet Set") as products with add-on groups ("Choice of slice Cake", "Main 1"…), and its export has no separate set structure. Craft OS follows: sets are products + modifier groups. Each modifier option points at the add-on product it stands for (`modifier_options.product_id`), so Sub-plan 2 can route a set's cake to the kitchen and its drink to the bar.
- **SST rate, print route and images are not in the export.** `sst_rate_bp` (default 600 = 6%) and `print_route` are set on `/menu` and are never overwritten by a re-import. Images are out of scope.
- **Availability comes from the "Craft Cafe" catalog sheet** (user's choice): `ALL → all`, `POS_ONLY → counter_only`, `NONE → hidden`. Add-on links come from the `Default Catalog` column of `itemLinkedAddon` (the only catalog column that file has).
- **Per-branch sold-out (`branch_menu_status`) and print-route → printer mapping move to Sub-plan 2**, where ordering needs them.

## Global Constraints

- **Dev database first.** Every SQL file in this plan is run on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) and verified there; running it on prod (`yfsoesxzurzjdwstszru`) is a separate, later step the user decides. The worktree's `.env.local` points at dev.
- All UI copy, field names and error messages in English (`english-product-copy` rule); comments may be Chinese or English, matching surrounding files.
- Money is integer sen; SST is basis points (600 = 6%).
- Join on Feedme IDs, never on names (`feedme-pos` memory: names have trailing spaces, mixed CJK).
- `has_menu_cap('access_settings')` must mirror `DEFAULT_SYSTEM_ROLE_CAPS[*].access_settings` (owner, admin, manager → true) plus the rank fallback `manager` — change both in the same commit if either changes (`procurement-phase1-defects` memory, item 3).
- Every write whose success is shown to a user goes through `writeOutcome` (`src/shared/lib/db-write.ts`) with `.select()`.
- The repo has no ESLint config (pre-existing) — lint steps are skipped; `npx tsc -b` and `npx vitest run` are the gates.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-22-pos-menu.sql` | `has_menu_cap`, menu tables, RLS |
| `supabase/migration-2026-10-22-pos-menu-import-fn.sql` | `menu_import(jsonb)` RPC |
| `supabase/migration-2026-10-22-pos-menu-verify.sql` | Self-check for both files (rolled back) |
| `src/features/pos/menu/xlsx.ts` | `readXlsx(bytes)` → `{ sheetName: string[][] }` |
| `src/features/pos/menu/testing/makeXlsx.ts` | Test helper: build `.xlsx` bytes from arrays |
| `src/features/pos/menu/feedmeExport.ts` | `readFeedmeExport(zip)`, `buildMenuImport(files, catalog)` — pure payload builder |
| `src/features/pos/menu/menuApi.ts` | Supabase calls: `fetchMenu`, `updateProducts`, `importMenu` |
| `src/features/pos/menu/menuView.ts` | Pure: `groupMenu`, `formatPrice`, constants |
| `src/features/pos/menu/MenuPage.tsx` | `/menu` |
| `src/features/pos/menu/MenuImportPage.tsx` | `/menu/import` |
| `src/App.tsx`, `src/shared/lib/nav.ts`, `src/shared/components/Sidebar.tsx`, `src/shared/lib/nav.test.ts` | Route + nav entry |

---

### Task 1: Bring the dev database up to the Craft OS schema (controller + user)

Done by the controller in the Supabase dashboard of **craft-os-dev**, not by a subagent (needs the browser). The dev project today has only the Phase 0 `spike_*` tables; menu permissions need `staff` and `system_role_permissions`.

- [ ] **Step 1: Confirm the target.** Dashboard top bar must read **craft-os-dev** (ref `egznnbjmicebbhwasloy`). Never run these in Craft-Os-Prod.

- [ ] **Step 2: Run the base schema.** Run `supabase/FRESH_BUILD_full.sql` in the SQL editor (load it with `window.monaco.editor.getModels()[0].setValue(...)` after checking its SHA-256 against the file, as done on 2026-10-22). Expected: "Success. No rows returned".

- [ ] **Step 3: Run every later migration in the order below** (not plain filename order: `checklist-assignee` alters a table that `tasks-projects` creates), one at a time, checking each result before the next:

```
migration-2026-07-06-rbac.sql
migration-2026-07-07-skill-matrix.sql
migration-2026-07-08-leave-accrual.sql
migration-2026-07-08-rls-system-role.sql
migration-2026-07-09-auto-absent.sql
migration-2026-07-10-supervisor-review-scope.sql
migration-2026-08-02-dedupe-chan-jie-ling.sql
migration-2026-08-02-department-normalise.sql
migration-2026-08-02-service-crew-backfill.sql
migration-2026-08-03-avatar-storage-policies.sql
migration-2026-08-14-tasks-projects.sql
migration-2026-08-14-tasks-upsert-fn.sql
migration-2026-08-14-checklist-assignee.sql
migration-2026-09-02-late-reason-notifications.sql
migration-2026-09-02-notify-late-fn.sql
migration-2026-09-02-rejudge-boundary-late.sql
```

If one fails, stop and report the file and the error to the user — do not edit migrations to force them through. (Data-fix migrations such as `dedupe-chan-jie-ling` touch no rows on an empty database; a `pg_cron` schedule may fail if the extension is off — report it, it is not needed for the menu.)

- [ ] **Step 4: Make the test login an owner.** In the SQL editor:

```sql
insert into staff (id, name, rank, onboarding_completed, joined_at, system_role)
values ('76cbcf9f-905e-450d-9f5e-1c9e72a9373d', 'POS Test Owner', 'manager', true, current_date, 'owner')
on conflict (id) do update set system_role = 'owner', rank = 'manager';
select id, name, rank, system_role from staff;
```

Expected: one row, `system_role = owner`. (`76cbcf9f…` is the dev test login `juinxian@gmail.com` created on 2026-10-22.)

- [ ] **Step 5: Record it.** Append to `.superpowers/sdd/progress.md`: date, files run, any failures. Note: from now on the Phase 0 `spike-*.sql` files refuse to run on dev (their guard sees `public.staff`) — expected, Phase 0 is finished.

---

### Task 2: Menu schema and permissions

**Files:**
- Create: `supabase/migration-2026-10-22-pos-menu.sql`
- Create: `supabase/migration-2026-10-22-pos-menu-verify.sql` (Part A in this task; Part B is added in Task 3)

**Interfaces:**
- Produces: tables `menu_categories(id, name unique, sort_order, is_active)`, `menu_products(id, category_id, name, internal_name, description, availability ∈ {all,counter_only,hidden}, is_addon, sst_rate_bp, print_route, takeaway_fee_sen, feedme_product_id unique, sort_order, is_active, created_at, updated_at)`, `menu_variants(id, product_id, feedme_variant_key ('' = base), name, price_sen, sort_order, is_active, unique(product_id, feedme_variant_key))`, `modifier_groups(id, feedme_group_id unique, name, min_select, max_select, stackable, sort_order, is_active)`, `modifier_options(id, group_id, product_id, feedme_variant_key, name, price_delta_sen, is_default, availability, sort_order)`, `product_modifier_groups(product_id, group_id, sort_order)`; function `has_menu_cap(p_cap text) returns boolean`.

- [ ] **Step 1: Write the migration**

`supabase/migration-2026-10-22-pos-menu.sql`:

```sql
-- ============================================================================
-- Craft OS — POS Phase 1 · Menu (2026-10-22)
-- Run on craft-os-dev first. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-22-pos-phase1-menu.md
-- ============================================================================

-- ── Permission helper ────────────────────────────────────────────────────────
-- Mirrors DEFAULT_SYSTEM_ROLE_CAPS[*].access_settings in src/shared/types/index.ts
-- (owner/admin/manager) plus the legacy rank fallback. Change both together.
create or replace function has_menu_cap(p_cap text) returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce((
    select
      coalesce((
        select (srp.permissions ->> p_cap)::boolean
        from system_role_permissions srp
        where srp.system_role = s.system_role
      ), false)
      or
      case p_cap
        when 'access_settings' then
          s.system_role in ('owner','admin','manager') or s.rank = 'manager'
        else false
      end
    from staff s
    where s.id = auth.uid()
  ), false)
$$;

-- ── Tables ──────────────────────────────────────────────────────────────────
create table if not exists menu_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists menu_products (
  id                 uuid primary key default gen_random_uuid(),
  category_id        uuid references menu_categories(id) on delete set null,
  name               text not null,
  internal_name      text,
  description        text,
  availability       text not null default 'all' check (availability in ('all','counter_only','hidden')),
  is_addon           boolean not null default false,
  sst_rate_bp        integer not null default 600 check (sst_rate_bp between 0 and 10000),
  print_route        text,
  takeaway_fee_sen   integer not null default 0 check (takeaway_fee_sen >= 0),
  feedme_product_id  text unique,
  sort_order         integer not null default 0,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists menu_variants (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references menu_products(id) on delete cascade,
  feedme_variant_key  text not null default '',          -- '' = the base (only) variant
  name                text not null,
  price_sen           integer not null check (price_sen >= 0),
  sort_order          integer not null default 0,
  is_active           boolean not null default true,
  unique (product_id, feedme_variant_key)
);

create table if not exists modifier_groups (
  id               uuid primary key default gen_random_uuid(),
  feedme_group_id  text unique,
  name             text not null,
  min_select       integer not null default 0 check (min_select >= 0),
  max_select       integer not null default 1 check (max_select >= 1),
  stackable        boolean not null default false,
  sort_order       integer not null default 0,
  is_active        boolean not null default true,
  check (max_select >= min_select)
);

create table if not exists modifier_options (
  id                  uuid primary key default gen_random_uuid(),
  group_id            uuid not null references modifier_groups(id) on delete cascade,
  product_id          uuid references menu_products(id) on delete set null,  -- the add-on item it stands for
  feedme_variant_key  text not null default '',
  name                text not null,
  price_delta_sen     integer not null default 0 check (price_delta_sen >= 0),
  is_default          boolean not null default false,
  availability        text not null default 'all' check (availability in ('all','counter_only','hidden')),
  sort_order          integer not null default 0,
  unique (group_id, product_id, feedme_variant_key)
);

create table if not exists product_modifier_groups (
  product_id  uuid not null references menu_products(id) on delete cascade,
  group_id    uuid not null references modifier_groups(id) on delete cascade,
  sort_order  integer not null default 0,
  primary key (product_id, group_id)
);

create index if not exists menu_products_category_idx on menu_products(category_id);
create index if not exists menu_variants_product_idx on menu_variants(product_id);
create index if not exists modifier_options_group_idx on modifier_options(group_id);

-- ── RLS: every signed-in staff member reads the menu; settings holders edit
-- products/variants in place; inserts and deletes only happen through menu_import.
do $$
declare t text;
begin
  foreach t in array array['menu_categories','menu_products','menu_variants',
                           'modifier_groups','modifier_options','product_modifier_groups']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists menu_read on %I', t);
    execute format('create policy menu_read on %I for select to authenticated using (true)', t);
  end loop;
end $$;

drop policy if exists menu_products_edit on menu_products;
create policy menu_products_edit on menu_products for update to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));

drop policy if exists menu_variants_edit on menu_variants;
create policy menu_variants_edit on menu_variants for update to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));
```

- [ ] **Step 2: Write Part A of the self-check**

`supabase/migration-2026-10-22-pos-menu-verify.sql` (Task 3 appends Part B before the final `select`):

```sql
-- Self-check for the POS menu migrations. Run on craft-os-dev after both
-- migration files. Everything is rolled back. Success = result row "VERIFY OK".
begin;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';
  r record;
begin
  -- A1. tables exist with RLS on and a read policy
  for r in select t from unnest(array['menu_categories','menu_products','menu_variants',
                                      'modifier_groups','modifier_options','product_modifier_groups']) as t loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = r.t and c.relrowsecurity) then
      raise exception 'FAIL schema: % missing or RLS off', r.t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.t
                      and policyname = 'menu_read' and cmd = 'SELECT') then
      raise exception 'FAIL rls: % has no menu_read policy', r.t;
    end if;
  end loop;

  -- A2. nobody but RPCs inserts or deletes
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename like any (array['menu_%','modifier_%','product_modifier_groups'])
              and cmd in ('INSERT','DELETE','ALL')) then
    raise exception 'FAIL rls: an insert/delete policy exists on a menu table';
  end if;

  -- A3. has_menu_cap: owner yes, anonymous no
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  if not has_menu_cap('access_settings') then raise exception 'FAIL cap: owner lacks access_settings'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  if has_menu_cap('access_settings') then raise exception 'FAIL cap: unknown user has access_settings'; end if;

  -- A4. defaults
  insert into menu_products(name, feedme_product_id) values ('verify product', 'verify-1') returning sst_rate_bp, availability into r;
  if r.sst_rate_bp <> 600 or r.availability <> 'all' then raise exception 'FAIL defaults: %', r; end if;

  raise notice 'VERIFY OK';
end $$;

do $$
declare
  r record;
  v_id uuid;
begin
  -- C1. permission matrix on real staff rows (inserted here, rolled back with everything else)
  for r in select * from (values
      ('owner', 'trainee', true), ('admin', 'trainee', true), ('manager', 'trainee', true),
      ('hr', 'trainee', false), ('supervisor', 'trainee', false), ('staff', 'trainee', false),
      ('staff', 'manager', true)) as m(role, rank, expected) loop
    v_id := gen_random_uuid();
    insert into auth.users (id) values (v_id);  -- staff.id references auth.users
    insert into staff (id, name, rank, onboarding_completed, joined_at, system_role)
    values (v_id, 'verify ' || r.role || '/' || r.rank, r.rank, true, current_date, r.role);
    perform set_config('request.jwt.claims', json_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    if has_menu_cap('access_settings') is distinct from r.expected then
      raise exception 'FAIL cap matrix: role % rank % expected %', r.role, r.rank, r.expected;
    end if;
  end loop;

  -- C2. the two edit policies exist, are UPDATE-only and gated on has_menu_cap
  for r in select t from unnest(array['menu_products','menu_variants']) as t loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.t
                      and policyname = r.t || '_edit' and cmd = 'UPDATE'
                      and qual like '%has_menu_cap%' and with_check like '%has_menu_cap%') then
      raise exception 'FAIL rls: %_edit policy missing or not gated on has_menu_cap', r.t;
    end if;
  end loop;

  raise notice 'VERIFY OK (permissions)';
end $$;

select 'VERIFY OK' as result;

rollback;
```

- [ ] **Step 3: Run on dev** (controller, dashboard): run the migration, then the verify file. Expected: `VERIFY OK`. (If the editor asks to confirm a "destructive operation", confirm — the verify file rolls back.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migration-2026-10-22-pos-menu.sql supabase/migration-2026-10-22-pos-menu-verify.sql
git commit -m "feat(pos-menu): menu tables, read-for-staff RLS and has_menu_cap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `menu_import` RPC

**Files:**
- Create: `supabase/migration-2026-10-22-pos-menu-import-fn.sql`
- Modify: `supabase/migration-2026-10-22-pos-menu-verify.sql` (add Part B)

**Interfaces:**
- Consumes: Task 2 tables and `has_menu_cap`.
- Produces: `menu_import(p_payload jsonb) returns jsonb` → `{categories, products, variants, groups, options, links}` row counts. Payload is exactly the `MenuImport` type of Task 5 (camelCase keys): `{ categories:[{name,sortOrder}], products:[{feedmeId,name,internalName,description,category,availability,isAddon,takeawayFeeSen,sortOrder,variants:[{key,name,priceSen,sortOrder}]}], groups:[{feedmeId,name,min,max,stackable,sortOrder,options:[{productFeedmeId,variantKey,name,priceSen,isDefault,availability,sortOrder}]}], links:[{productFeedmeId,groupFeedmeId,sortOrder}] }`.
- Rules: upsert by Feedme ID; **never overwrite `sst_rate_bp` or `print_route`**; never delete products; variants of an imported product that are not in the file become `is_active = false`; options of an imported group and links of an imported product are replaced.

- [ ] **Step 1: Write the function**

`supabase/migration-2026-10-22-pos-menu-import-fn.sql`:

```sql
-- ============================================================================
-- Craft OS — POS Phase 1 · menu_import RPC (2026-10-22). Run after
-- migration-2026-10-22-pos-menu.sql. Idempotent.
-- One transaction: the whole Feedme import lands or none of it does.
-- ============================================================================
create or replace function menu_import(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n_cat int; n_prod int; n_var int; n_grp int; n_opt int; n_link int;
begin
  if not has_menu_cap('access_settings') then
    raise exception 'Not allowed to import the menu';
  end if;
  if p_payload is null
     or jsonb_typeof(p_payload->'categories') is distinct from 'array'
     or jsonb_typeof(p_payload->'products')   is distinct from 'array'
     or jsonb_typeof(p_payload->'groups')     is distinct from 'array'
     or jsonb_typeof(p_payload->'links')      is distinct from 'array' then
    raise exception 'Invalid import file';
  end if;
  -- a NULL/blank Feedme id never conflicts, so it would create a fresh row on every import
  if exists (select 1 from jsonb_array_elements(p_payload->'products') p where coalesce(p->>'feedmeId', '') = '')
     or exists (select 1 from jsonb_array_elements(p_payload->'groups') g where coalesce(g->>'feedmeId', '') = '')
     or exists (select 1 from jsonb_array_elements(p_payload->'categories') c where coalesce(c->>'name', '') = '') then
    raise exception 'Invalid import file: an item has no Feedme id';
  end if;

  -- categories
  insert into menu_categories(name, sort_order, is_active)
  select c.name, c."sortOrder", true
    from jsonb_to_recordset(p_payload->'categories') as c(name text, "sortOrder" int)
  on conflict (name) do update set sort_order = excluded.sort_order, is_active = true;
  get diagnostics n_cat = row_count;

  -- products — sst_rate_bp and print_route are Craft OS settings: not in the
  -- insert list, not in the update list, so a re-import never changes them
  insert into menu_products(feedme_product_id, name, internal_name, description, category_id,
                            availability, is_addon, takeaway_fee_sen, sort_order, is_active, updated_at)
  select p."feedmeId", p.name, p."internalName", p.description, mc.id,
         p.availability, p."isAddon", p."takeawayFeeSen", p."sortOrder", true, now()
    from jsonb_to_recordset(p_payload->'products') as p(
           "feedmeId" text, name text, "internalName" text, description text, category text,
           availability text, "isAddon" boolean, "takeawayFeeSen" int, "sortOrder" int)
    left join menu_categories mc on mc.name = p.category
  on conflict (feedme_product_id) do update set
    name = excluded.name, internal_name = excluded.internal_name, description = excluded.description,
    category_id = excluded.category_id, availability = excluded.availability, is_addon = excluded.is_addon,
    takeaway_fee_sen = excluded.takeaway_fee_sen, sort_order = excluded.sort_order,
    is_active = true, updated_at = now();
  get diagnostics n_prod = row_count;

  -- variants: upsert the file's, then switch off the imported products' others
  -- (dropped first: a second call in the same transaction — as in the verify
  -- script — would otherwise hit "relation already exists")
  drop table if exists _imp_variants;
  create temp table _imp_variants on commit drop as
  select mp.id as product_id, x.key, x.name, x."priceSen" as price_sen, x."sortOrder" as sort_order
    from jsonb_to_recordset(p_payload->'products') as p("feedmeId" text, variants jsonb)
    join menu_products mp on mp.feedme_product_id = p."feedmeId"
    cross join lateral jsonb_to_recordset(p.variants) as x(key text, name text, "priceSen" int, "sortOrder" int);

  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order, is_active)
  select product_id, key, name, price_sen, sort_order, true from _imp_variants
  on conflict (product_id, feedme_variant_key) do update set
    name = excluded.name, price_sen = excluded.price_sen, sort_order = excluded.sort_order, is_active = true;
  get diagnostics n_var = row_count;

  update menu_variants mv set is_active = false
   where mv.product_id in (select distinct product_id from _imp_variants)
     and not exists (select 1 from _imp_variants iv
                      where iv.product_id = mv.product_id and iv.key = mv.feedme_variant_key);

  -- modifier groups
  insert into modifier_groups(feedme_group_id, name, min_select, max_select, stackable, sort_order, is_active)
  select g."feedmeId", g.name, g.min, g.max, g.stackable, g."sortOrder", true
    from jsonb_to_recordset(p_payload->'groups') as g(
           "feedmeId" text, name text, min int, max int, stackable boolean, "sortOrder" int)
  on conflict (feedme_group_id) do update set
    name = excluded.name, min_select = excluded.min_select, max_select = excluded.max_select,
    stackable = excluded.stackable, sort_order = excluded.sort_order, is_active = true;
  get diagnostics n_grp = row_count;

  -- options of the imported groups are replaced (orders keep their own snapshots)
  delete from modifier_options
   where group_id in (select mg.id from modifier_groups mg
                       where mg.feedme_group_id in (select g->>'feedmeId' from jsonb_array_elements(p_payload->'groups') g));

  insert into modifier_options(group_id, product_id, feedme_variant_key, name, price_delta_sen,
                               is_default, availability, sort_order)
  select mg.id, mp.id, coalesce(o."variantKey", ''), o.name, o."priceSen", o."isDefault", o.availability, o."sortOrder"
    from jsonb_to_recordset(p_payload->'groups') as g("feedmeId" text, options jsonb)
    join modifier_groups mg on mg.feedme_group_id = g."feedmeId"
    cross join lateral jsonb_to_recordset(g.options) as o(
           "productFeedmeId" text, "variantKey" text, name text, "priceSen" int,
           "isDefault" boolean, availability text, "sortOrder" int)
    left join menu_products mp on mp.feedme_product_id = o."productFeedmeId"
  on conflict (group_id, product_id, feedme_variant_key) do nothing;
  get diagnostics n_opt = row_count;

  -- links of the imported products are replaced
  delete from product_modifier_groups
   where product_id in (select mp.id from menu_products mp
                         where mp.feedme_product_id in (select p->>'feedmeId' from jsonb_array_elements(p_payload->'products') p));

  insert into product_modifier_groups(product_id, group_id, sort_order)
  select mp.id, mg.id, l."sortOrder"
    from jsonb_to_recordset(p_payload->'links') as l("productFeedmeId" text, "groupFeedmeId" text, "sortOrder" int)
    join menu_products mp on mp.feedme_product_id = l."productFeedmeId"
    join modifier_groups mg on mg.feedme_group_id = l."groupFeedmeId"
  on conflict do nothing;
  get diagnostics n_link = row_count;

  return jsonb_build_object('categories', n_cat, 'products', n_prod, 'variants', n_var,
                            'groups', n_grp, 'options', n_opt, 'links', n_link);
end $$;

revoke all on function menu_import(jsonb) from public, anon;
grant execute on function menu_import(jsonb) to authenticated;
```

- [ ] **Step 2: Add Part B to the self-check**

In `supabase/migration-2026-10-22-pos-menu-verify.sql`, insert this block **after** Part A's `end $$;` and **before** Part C (the permission-matrix block that precedes `select 'VERIFY OK' as result;`):

```sql
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';
  v_payload jsonb := $j${
    "categories": [{"name": "VERIFY COFFEE", "sortOrder": 0}, {"name": "ADDON", "sortOrder": 1}],
    "products": [
      {"feedmeId": "verify-latte", "name": "Verify Latte", "internalName": null, "description": null,
       "category": "VERIFY COFFEE", "availability": "all", "isAddon": false, "takeawayFeeSen": 100, "sortOrder": 0,
       "variants": [{"key": "v/hot", "name": "HOT", "priceSen": 1200, "sortOrder": 0},
                    {"key": "v/cold", "name": "COLD", "priceSen": 1300, "sortOrder": 1}]},
      {"feedmeId": "verify-oat", "name": "Oat milk", "internalName": null, "description": null,
       "category": "ADDON", "availability": "all", "isAddon": true, "takeawayFeeSen": 0, "sortOrder": 1,
       "variants": [{"key": "", "name": "Regular", "priceSen": 200, "sortOrder": 0}]}
    ],
    "groups": [{"feedmeId": "verify-milk", "name": "Milk", "min": 0, "max": 1, "stackable": false, "sortOrder": 0,
                "options": [{"productFeedmeId": "verify-oat", "variantKey": "", "name": "Oat milk", "priceSen": 200,
                             "isDefault": false, "availability": "all", "sortOrder": 0}]}],
    "links": [{"productFeedmeId": "verify-latte", "groupFeedmeId": "verify-milk", "sortOrder": 0}]
  }$j$;
  v_counts jsonb;
  v_latte uuid;
  n int;
begin
  -- B1. refused without access_settings
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  begin
    perform menu_import(v_payload);
    raise exception 'FAIL import: allowed without access_settings';
  exception when raise_exception then
    if sqlerrm not like 'Not allowed%' then raise; end if;
  end;

  -- B2. first import as owner
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_counts := menu_import(v_payload);
  if (v_counts->>'products')::int <> 2 or (v_counts->>'variants')::int <> 3
     or (v_counts->>'options')::int <> 1 or (v_counts->>'links')::int <> 1 then
    raise exception 'FAIL import counts: %', v_counts;
  end if;
  select id into v_latte from menu_products where feedme_product_id = 'verify-latte';

  -- B3. manager settings survive a re-import; price changes land; dropped variant is switched off
  update menu_products set sst_rate_bp = 0, print_route = 'Bar' where id = v_latte;
  v_payload := jsonb_set(v_payload, '{products,0,variants}',
                 '[{"key": "v/hot", "name": "HOT", "priceSen": 1250, "sortOrder": 0}]'::jsonb);
  perform menu_import(v_payload);
  if (select sst_rate_bp from menu_products where id = v_latte) <> 0
     or (select print_route from menu_products where id = v_latte) is distinct from 'Bar' then
    raise exception 'FAIL re-import: overwrote sst_rate_bp or print_route';
  end if;
  if (select price_sen from menu_variants where product_id = v_latte and feedme_variant_key = 'v/hot') is distinct from 1250 then
    raise exception 'FAIL re-import: price not updated';
  end if;
  if (select is_active from menu_variants where product_id = v_latte and feedme_variant_key = 'v/cold') is distinct from false then
    raise exception 'FAIL re-import: removed variant should be kept but inactive';
  end if;

  -- B4. idempotent: same payload again → same row counts in the tables
  perform menu_import(v_payload);
  select count(*) into n from menu_products where feedme_product_id in ('verify-latte', 'verify-oat');
  if n <> 2 then raise exception 'FAIL idempotent: % verify products', n; end if;
  select count(*) into n from modifier_options mo join modifier_groups mg on mg.id = mo.group_id where mg.feedme_group_id = 'verify-milk';
  if n <> 1 then raise exception 'FAIL idempotent: % options', n; end if;

  -- B5. option points at the add-on product
  if not exists (select 1 from modifier_options mo join menu_products mp on mp.id = mo.product_id
                  where mp.feedme_product_id = 'verify-oat') then
    raise exception 'FAIL options: option not linked to its add-on product';
  end if;

  -- B6. malformed payload
  begin
    perform menu_import('{"products": "nope"}'::jsonb);
    raise exception 'FAIL import: malformed payload accepted';
  exception when raise_exception then
    if sqlerrm not like 'Invalid import file%' then raise; end if;
  end;

  -- B7. grants: anon cannot call it, authenticated can (the cap check is the second gate)
  if has_function_privilege('anon', 'menu_import(jsonb)', 'execute') then
    raise exception 'FAIL grants: anon can execute menu_import';
  end if;
  if not has_function_privilege('authenticated', 'menu_import(jsonb)', 'execute') then
    raise exception 'FAIL grants: authenticated cannot execute menu_import';
  end if;

  -- B8. atomic: a bad group (max 0) aborts the whole call, leaving no new category behind
  begin
    perform menu_import(jsonb_build_object(
      'categories', jsonb_build_array(jsonb_build_object('name', 'VERIFY ATOMIC', 'sortOrder', 9)),
      'products', '[]'::jsonb, 'links', '[]'::jsonb,
      'groups', jsonb_build_array(jsonb_build_object('feedmeId', 'verify-bad', 'name', 'Bad', 'min', 0, 'max', 0,
                                                      'stackable', false, 'sortOrder', 0, 'options', '[]'::jsonb))));
    raise exception 'FAIL atomic: max 0 group was accepted';
  exception when check_violation then
    null;
  end;
  if exists (select 1 from menu_categories where name = 'VERIFY ATOMIC') then
    raise exception 'FAIL atomic: category survived a failed import';
  end if;

  -- B9. blank Feedme id is refused before any write
  begin
    perform menu_import(jsonb_build_object('categories', '[]'::jsonb, 'groups', '[]'::jsonb, 'links', '[]'::jsonb,
      'products', jsonb_build_array(jsonb_build_object('feedmeId', '', 'name', 'No id', 'category', 'ADDON',
        'availability', 'all', 'isAddon', false, 'takeawayFeeSen', 0, 'sortOrder', 0, 'variants', '[]'::jsonb))));
    raise exception 'FAIL blank id: accepted';
  exception when raise_exception then
    if sqlerrm not like 'Invalid import file: an item has no Feedme id%' then raise; end if;
  end;

  raise notice 'VERIFY OK (import)';
end $$;
```

- [ ] **Step 3: Run on dev** (controller): run the function file, then the whole verify file. Expected: `VERIFY OK`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migration-2026-10-22-pos-menu-import-fn.sql supabase/migration-2026-10-22-pos-menu-verify.sql
git commit -m "feat(pos-menu): menu_import RPC — upsert by Feedme ID, keep SST and print route

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `.xlsx` reader

**Files:**
- Modify: `package.json` (dependency `fflate`)
- Create: `src/features/pos/menu/xlsx.ts`
- Create: `src/features/pos/menu/testing/makeXlsx.ts`
- Test: `src/features/pos/menu/xlsx.test.ts`

**Interfaces:**
- Produces: `type Sheet = string[][]`, `type Workbook = Record<string, Sheet>`, `readXlsx(bytes: Uint8Array): Workbook` (cells as strings; gaps are `''`), `makeXlsx(wb: Workbook): Uint8Array` (test helper, inline strings).

- [ ] **Step 1: Install fflate**

```bash
npm install fflate@^0.8.2
```

- [ ] **Step 2: Write the test helper**

`src/features/pos/menu/testing/makeXlsx.ts`:

```ts
import { strToU8, zipSync } from 'fflate'
import type { Workbook } from '../xlsx'

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function colName(i: number): string {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Builds a minimal .xlsx (inline strings) — enough for readXlsx tests. */
export function makeXlsx(wb: Workbook): Uint8Array {
  const names = Object.keys(wb)
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
        names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        `</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        names
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `</Relationships>`,
    ),
  }
  names.forEach((n, i) => {
    const rows = wb[n]
      .map(
        (row, ri) =>
          `<row r="${ri + 1}">` +
          row
            .map((v, ci) =>
              v === '' ? '' : `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`,
            )
            .join('') +
          `</row>`,
      )
      .join('')
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData></worksheet>`,
    )
  })
  return zipSync(files)
}
```

- [ ] **Step 3: Write the failing test**

`src/features/pos/menu/xlsx.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { readXlsx } from './xlsx'
import { makeXlsx } from './testing/makeXlsx'

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

describe('readXlsx', () => {
  it('reads every sheet by name with inline strings and keeps CJK text', () => {
    const bytes = makeXlsx({
      'Craft Cafe': [['Product ID', 'Name'], ['item_1', 'Salted Egg 咸蛋酱 ']],
      'Grab Food': [['Product ID'], ['item_1']],
    })
    expect(readXlsx(bytes)).toEqual({
      'Craft Cafe': [['Product ID', 'Name'], ['item_1', 'Salted Egg 咸蛋酱 ']],
      'Grab Food': [['Product ID'], ['item_1']],
    })
  })

  it('fills skipped cells with empty strings', () => {
    const bytes = makeXlsx({ S: [['a', '', 'c']] })
    expect(readXlsx(bytes).S).toEqual([['a', '', 'c']])
  })

  it('resolves shared strings and plain numbers', () => {
    const bytes = zipSync({
      'xl/workbook.xml': strToU8(
        `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Menu" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
      ),
      'xl/sharedStrings.xml': strToU8(`<sst xmlns="${MAIN}"><si><t>Coffee Latte</t></si><si><r><t>Mo</t></r><r><t>cha</t></r></si></sst>`),
      'xl/worksheets/sheet1.xml': strToU8(
        `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>13.5</v></c><c r="C1" t="s"><v>1</v></c></row></sheetData></worksheet>`,
      ),
    })
    expect(readXlsx(bytes).Menu).toEqual([['Coffee Latte', '13.5', 'Mocha']])
  })

  it('rejects a file that is not an Excel workbook', () => {
    expect(() => readXlsx(zipSync({ 'hello.txt': strToU8('hi') }))).toThrow('Not an Excel (.xlsx) file')
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/features/pos/menu/xlsx.test.ts`
Expected: FAIL — `Failed to resolve import "./xlsx"`

- [ ] **Step 5: Write the reader**

`src/features/pos/menu/xlsx.ts`:

```ts
import { strFromU8, unzipSync } from 'fflate'

/** A sheet as rows of cell text. Skipped cells are ''. */
export type Sheet = string[][]
export type Workbook = Record<string, Sheet>

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

const textOf = (el: Element): string =>
  Array.from(el.getElementsByTagNameNS(MAIN, 't'))
    .map((t) => t.textContent ?? '')
    .join('')

/** Reads every sheet of an .xlsx into strings. Only what Feedme's export
 *  uses: shared strings, inline strings and plain values (numbers stay text). */
export function readXlsx(bytes: Uint8Array): Workbook {
  const files = unzipSync(bytes)
  const parse = (path: string): Document | null => {
    const f = files[path]
    return f ? new DOMParser().parseFromString(strFromU8(f), 'application/xml') : null
  }
  const book = parse('xl/workbook.xml')
  const rels = parse('xl/_rels/workbook.xml.rels')
  if (!book || !rels) throw new Error('Not an Excel (.xlsx) file')

  const shared = Array.from(parse('xl/sharedStrings.xml')?.getElementsByTagNameNS(MAIN, 'si') ?? []).map(textOf)
  const target = new Map<string, string>()
  for (const r of Array.from(rels.getElementsByTagName('Relationship'))) {
    target.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '')
  }

  const out: Workbook = {}
  for (const sheet of Array.from(book.getElementsByTagNameNS(MAIN, 'sheet'))) {
    const t = target.get(sheet.getAttributeNS(REL, 'id') ?? '') ?? ''
    const path = t.startsWith('/') ? t.slice(1) : t.startsWith('xl/') ? t : `xl/${t}`
    const rows: Sheet = []
    for (const row of Array.from(parse(path)?.getElementsByTagNameNS(MAIN, 'row') ?? [])) {
      const cells: string[] = []
      for (const c of Array.from(row.getElementsByTagNameNS(MAIN, 'c'))) {
        const type = c.getAttribute('t')
        const v = c.getElementsByTagNameNS(MAIN, 'v')[0]?.textContent ?? ''
        cells[colIndex(c.getAttribute('r') ?? 'A1')] =
          type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? textOf(c) : v
      }
      rows.push(Array.from(cells, (x) => x ?? ''))
    }
    out[sheet.getAttribute('name') ?? path] = rows
  }
  return out
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/features/pos/menu/xlsx.test.ts`
Expected: PASS (4 tests). Then `npx tsc -b` — clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/features/pos/menu/xlsx.ts src/features/pos/menu/xlsx.test.ts src/features/pos/menu/testing/makeXlsx.ts
git commit -m "feat(pos-menu): minimal .xlsx reader for Feedme's menu export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Feedme export → import payload

**Files:**
- Create: `src/features/pos/menu/feedmeExport.ts`
- Test: `src/features/pos/menu/feedmeExport.test.ts`

**Interfaces:**
- Consumes: `readXlsx`, `Workbook`, `Sheet` (Task 4); `makeXlsx` (tests only).
- Produces:
  - `type Availability = 'all' | 'counter_only' | 'hidden'`
  - `interface ImportVariant { key: string; name: string; priceSen: number; sortOrder: number }`
  - `interface ImportProduct { feedmeId: string; name: string; internalName: string | null; description: string | null; category: string; availability: Availability; isAddon: boolean; takeawayFeeSen: number; sortOrder: number; variants: ImportVariant[] }`
  - `interface ImportOption { productFeedmeId: string; variantKey: string; name: string; priceSen: number; isDefault: boolean; availability: Availability; sortOrder: number }`
  - `interface ImportGroup { feedmeId: string; name: string; min: number; max: number; stackable: boolean; sortOrder: number; options: ImportOption[] }`
  - `interface ImportLink { productFeedmeId: string; groupFeedmeId: string; sortOrder: number }`
  - `interface MenuImport { categories: { name: string; sortOrder: number }[]; products: ImportProduct[]; groups: ImportGroup[]; links: ImportLink[] }`
  - `interface FeedmeFiles { menu: Workbook; addonGroup: Workbook; itemLinkedAddon: Workbook }`
  - `FEEDME_CATALOG = 'Craft Cafe'`
  - `clean(s)`, `toSen(raw): number | null`
  - `readFeedmeExport(zip: Uint8Array): FeedmeFiles`
  - `buildMenuImport(files: FeedmeFiles, catalog: string): { payload: MenuImport; warnings: string[] }`

Export facts this encodes (seen in the 2026-10-22 export): each product has exactly one base row (blank `Variant key`) followed by its variant rows (same Product ID); a variant row's `Selling price` is the full price; add-on items are products in category `ADDON`; `itemLinkedAddon` has one sheet per group and only a `Default Catalog` flag column.

- [ ] **Step 1: Write the failing test**

`src/features/pos/menu/feedmeExport.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { buildMenuImport, clean, readFeedmeExport, toSen, type FeedmeFiles } from './feedmeExport'
import { makeXlsx } from './testing/makeXlsx'

const MENU_HEADER = [
  'Product ID (For update do not modify, left blank will create new item)', 'Order code (blank if no code)', 'Name',
  'Internal name (blank if no internal name, catalog & variant will be ignored)',
  'Description (blank if no description, catalog & variant will be ignored)',
  'Variant key (Do not modify existed key, blank for base item and added variant)',
  'Variant Name (blank for base item and added variant)', 'Category (create new category if not existed)',
  'SubCategories (comma-separated subcategory names, variant will be ignored)', 'Order from (ALL, POS_ONLY, NONE)',
  'perXUnit', 'unit', 'Open price (T, F, variant will be ignored)', 'Selling price', 'Tracking cost', 'Min price',
  'Group under parent (T, F, variant will be ignored)',
  'Takeaway name (blank if not applicable, create new takeaway if not existed)',
  'Takeaway price (blank if not applicable, create new takeaway if not existed)',
]
const GROUP_HEADER = [
  'Group ID (For update do not modify, left blank)', 'Group Name', 'Min', 'Max', 'Stackable (T for TRUE / F for FALSE)',
  'Item ID (Can get in menu file)', 'Item Code (Can get in menu file)', 'Item Name',
  'Item Name Overrider (left it blank if no)', 'Variant Key (left it blank for base item)',
  'Variant Name (left it blank for base item)', 'Item price', 'Order from (ALL, POS_ONLY, NONE) (Default ALL)',
  'isDefault (T for TRUE / F for FALSE)',
]
// row builder: only the columns the importer reads
function menuRow(id: string, name: string, key: string, variantName: string, category: string, orderFrom: string, price: string, takeaway = '') {
  const r = Array(19).fill('')
  r[0] = id; r[2] = name; r[5] = key; r[6] = variantName; r[7] = category; r[9] = orderFrom; r[13] = price; r[18] = takeaway
  return r
}
function groupRow(gid: string, gname: string, min: string, max: string, itemId: string, itemName: string, price: string) {
  const r = Array(14).fill('')
  r[0] = gid; r[1] = gname; r[2] = min; r[3] = max; r[5] = itemId; r[7] = itemName; r[11] = price; r[12] = 'ALL'
  return r
}

function files(): FeedmeFiles {
  const menu = [
    MENU_HEADER,
    menuRow('product_tea', 'Apple Tea', '', '', 'TEA', 'ALL', '10'),
    menuRow('product_tea', 'Apple Tea', 'variant_x/0', 'HOT', 'TEA', 'ALL', '10'),
    menuRow('product_tea', 'Apple Tea', 'variant_x/1', 'COLD', 'TEA', 'ALL', '11.5'),
    menuRow('product_don', 'Smoked Duck  DON ', '', '', 'DONBURI', 'POS_ONLY', '24', '1.06'),
    menuRow('item_egg', 'Salted Egg 咸蛋酱 ', '', '', 'ADDON', 'NONE', '0'),
    menuRow('item_bad', 'Broken price', '', '', 'TEA', 'ALL', 'abc'),
  ]
  return {
    menu: { 'Craft Cafe': menu, 'Grab Food': menu.map((r) => [...r]) },
    addonGroup: {
      'Craft Cafe': [
        GROUP_HEADER,
        groupRow('group_sauce', 'Sauce | Choose One', '1', '1', 'item_egg', 'Salted Egg 咸蛋酱 ', '0'),
        groupRow('group_sauce', 'Sauce | Choose One', '1', '1', 'item_ghost', 'Ghost', '0'),
      ],
    },
    itemLinkedAddon: {
      '1. Sauce | Choose One': [
        ['Group ID', 'Item ID', 'Item Name', 'Default Catalog'],
        ['group_sauce', 'product_don', 'Smoked Duck DON', 'T'],
        ['group_sauce', 'product_tea', 'Apple Tea', ''],
      ],
    },
  }
}

describe('clean / toSen', () => {
  it('collapses and trims whitespace', () => {
    expect(clean('  Smoked Duck  DON ')).toBe('Smoked Duck DON')
  })
  it('converts ringgit text to sen and rejects junk', () => {
    expect(toSen('11.5')).toBe(1150)
    expect(toSen('1.06')).toBe(106)
    expect(toSen('0')).toBe(0)
    expect(toSen('')).toBeNull()
    expect(toSen('abc')).toBeNull()
    expect(toSen('-1')).toBeNull()
  })
})

describe('buildMenuImport', () => {
  const { payload, warnings } = buildMenuImport(files(), 'Craft Cafe')
  const byId = new Map(payload.products.map((p) => [p.feedmeId, p]))

  it('keeps categories in first-seen order', () => {
    expect(payload.categories).toEqual([
      { name: 'TEA', sortOrder: 0 },
      { name: 'DONBURI', sortOrder: 1 },
      { name: 'ADDON', sortOrder: 2 },
    ])
  })

  it('turns variant rows into variants and drops the base price for variant products', () => {
    expect(byId.get('product_tea')!.variants).toEqual([
      { key: 'variant_x/0', name: 'HOT', priceSen: 1000, sortOrder: 0 },
      { key: 'variant_x/1', name: 'COLD', priceSen: 1150, sortOrder: 1 },
    ])
  })

  it('gives a product without variants one base variant', () => {
    expect(byId.get('product_don')).toMatchObject({
      name: 'Smoked Duck DON',
      availability: 'counter_only',
      isAddon: false,
      takeawayFeeSen: 106,
      variants: [{ key: '', name: 'Regular', priceSen: 2400, sortOrder: 0 }],
    })
  })

  it('marks ADDON items and maps NONE to hidden', () => {
    expect(byId.get('item_egg')).toMatchObject({ name: 'Salted Egg 咸蛋酱', isAddon: true, availability: 'hidden' })
  })

  it('skips a repeated variant key and a repeated base row, keeping the first', () => {
    const f = files()
    f.menu['Craft Cafe'].push(
      menuRow('product_tea', 'Apple Tea', 'variant_x/1', 'COLD AGAIN', 'TEA', 'ALL', '99'),
      menuRow('product_don', 'Smoked Duck DON v2', '', '', 'DONBURI', 'ALL', '1'),
    )
    const r = buildMenuImport(f, 'Craft Cafe')
    const tea = r.payload.products.find((p) => p.feedmeId === 'product_tea')!
    expect(tea.variants.map((v) => v.priceSen)).toEqual([1000, 1150])
    expect(r.payload.products.find((p) => p.feedmeId === 'product_don')!.variants[0].priceSen).toBe(2400)
    expect(r.warnings).toContain('Apple Tea / COLD AGAIN: duplicate variant key — skipped')
    expect(r.warnings).toContain('Smoked Duck DON v2: second base row for the same Product ID — skipped')
  })

  it('skips a product with no valid price and says why', () => {
    expect(byId.has('item_bad')).toBe(false)
    expect(warnings).toContain('Broken price: price "abc" is not a number — skipped')
  })

  it('builds groups from the catalog sheet and skips options for unknown products', () => {
    expect(payload.groups).toEqual([
      {
        feedmeId: 'group_sauce', name: 'Sauce | Choose One', min: 1, max: 1, stackable: false, sortOrder: 0,
        options: [{ productFeedmeId: 'item_egg', variantKey: '', name: 'Salted Egg 咸蛋酱', priceSen: 0, isDefault: false, availability: 'all', sortOrder: 0 }],
      },
    ])
    expect(warnings).toContain('Sauce | Choose One: option "Ghost" is not in the menu — skipped')
  })

  it('links products flagged T and falls back to the Default Catalog column with one warning', () => {
    expect(payload.links).toEqual([{ productFeedmeId: 'product_don', groupFeedmeId: 'group_sauce', sortOrder: 0 }])
    expect(warnings.filter((w) => w.includes('Default Catalog'))).toHaveLength(1)
  })

  it('fails clearly when the catalog sheet is missing', () => {
    expect(() => buildMenuImport(files(), 'Craftale')).toThrow('Sheet "Craftale" not found in the menu file')
  })

  it('fails clearly when a column is missing', () => {
    const f = files()
    f.menu['Craft Cafe'][0] = f.menu['Craft Cafe'][0].map((h) => (h === 'Selling price' ? 'Price' : h))
    expect(() => buildMenuImport(f, 'Craft Cafe')).toThrow('Column "Selling price" not found')
  })
})

describe('readFeedmeExport', () => {
  it('finds the three workbooks in the zip by their file-name prefix', () => {
    const f = files()
    const zip = zipSync({
      'menu_22-10-2026_19-36.xlsx': makeXlsx(f.menu),
      'addonGroup_22-10-2026_19-36.xlsx': makeXlsx(f.addonGroup),
      'itemLinkedAddon_22-10-2026_19-36.xlsx': makeXlsx(f.itemLinkedAddon),
      'translationLocalization_22-10-2026_19-36.xlsx': makeXlsx({ Product: [['Product ID']] }),
    })
    const read = readFeedmeExport(zip)
    expect(Object.keys(read.menu)).toEqual(['Craft Cafe', 'Grab Food'])
    expect(read.itemLinkedAddon['1. Sauce | Choose One'][1][1]).toBe('product_don')
  })

  it('says which file is missing', () => {
    const zip = zipSync({ 'menu_x.xlsx': makeXlsx({ S: [['a']] }) })
    expect(() => readFeedmeExport(zip)).toThrow('The zip has no addonGroup_….xlsx — is this a Feedme menu export?')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/pos/menu/feedmeExport.test.ts`
Expected: FAIL — `Failed to resolve import "./feedmeExport"`

- [ ] **Step 3: Write the builder**

`src/features/pos/menu/feedmeExport.ts`:

```ts
import { unzipSync } from 'fflate'
import { readXlsx, type Sheet, type Workbook } from './xlsx'

export type Availability = 'all' | 'counter_only' | 'hidden'

export interface ImportVariant { key: string; name: string; priceSen: number; sortOrder: number }
export interface ImportProduct {
  feedmeId: string
  name: string
  internalName: string | null
  description: string | null
  category: string
  availability: Availability
  isAddon: boolean
  takeawayFeeSen: number
  sortOrder: number
  variants: ImportVariant[]
}
export interface ImportOption {
  productFeedmeId: string
  variantKey: string
  name: string
  priceSen: number
  isDefault: boolean
  availability: Availability
  sortOrder: number
}
export interface ImportGroup {
  feedmeId: string
  name: string
  min: number
  max: number
  stackable: boolean
  sortOrder: number
  options: ImportOption[]
}
export interface ImportLink { productFeedmeId: string; groupFeedmeId: string; sortOrder: number }
export interface MenuImport {
  categories: { name: string; sortOrder: number }[]
  products: ImportProduct[]
  groups: ImportGroup[]
  links: ImportLink[]
}
export interface FeedmeFiles { menu: Workbook; addonGroup: Workbook; itemLinkedAddon: Workbook }

/** The Feedme catalog whose "Order from" decides the shop's menu (user's choice, 2026-10-22). */
export const FEEDME_CATALOG = 'Craft Cafe'

const AVAILABILITY: Record<string, Availability> = { ALL: 'all', POS_ONLY: 'counter_only', NONE: 'hidden' }

export const clean = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/** "11.5" → 1150. Blank, non-numeric or negative → null. */
export function toSen(raw: string | undefined): number | null {
  const s = clean(raw)
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

/** Column index by header name. Feedme headers carry a hint in brackets,
 *  e.g. "Product ID (For update do not modify, …)", so "Product ID" matches
 *  the header itself or the header followed by " (". */
function columns(header: string[], names: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of names) {
    const i = header.findIndex((h) => {
      const c = clean(h)
      return c === name || c.startsWith(`${name} (`)
    })
    if (i < 0) throw new Error(`Column "${name}" not found — is this a Feedme menu export?`)
    out[name] = i
  }
  return out
}

function sheetOf(wb: Workbook, name: string, file: string): Sheet {
  const s = wb[name]
  if (!s || s.length === 0) throw new Error(`Sheet "${name}" not found in ${file}`)
  return s
}

/** Unzips Feedme's "Export" download (books_<date>.zip). */
export function readFeedmeExport(zip: Uint8Array): FeedmeFiles {
  const entries = unzipSync(zip)
  const find = (prefix: string): Workbook => {
    const name = Object.keys(entries).find((n) => {
      const base = n.split('/').pop() ?? n
      return base.startsWith(`${prefix}_`) && base.endsWith('.xlsx')
    })
    if (!name) throw new Error(`The zip has no ${prefix}_….xlsx — is this a Feedme menu export?`)
    return readXlsx(entries[name])
  }
  return { menu: find('menu'), addonGroup: find('addonGroup'), itemLinkedAddon: find('itemLinkedAddon') }
}

export function buildMenuImport(files: FeedmeFiles, catalog: string): { payload: MenuImport; warnings: string[] } {
  const warnings: string[] = []

  // ── products and variants ────────────────────────────────────────────────
  const menu = sheetOf(files.menu, catalog, 'the menu file')
  const mc = columns(menu[0], [
    'Product ID', 'Name', 'Internal name', 'Description', 'Variant key', 'Variant Name',
    'Category', 'Order from', 'Selling price', 'Takeaway price',
  ])
  const products = new Map<string, ImportProduct>()
  const basePrice = new Map<string, number>()
  const skipped = new Set<string>()
  const categories: string[] = []

  menu.slice(1).forEach((r, i) => {
    const id = clean(r[mc['Product ID']])
    if (!id || skipped.has(id)) return
    const key = clean(r[mc['Variant key']])
    const rawPrice = clean(r[mc['Selling price']])
    const price = toSen(rawPrice)

    if (!key) {
      const name = clean(r[mc['Name']])
      if (products.has(id)) {
        warnings.push(`${name || id}: second base row for the same Product ID — skipped`)
        return
      }
      if (!name) {
        warnings.push(`Product ${id} has no name — skipped`)
        skipped.add(id)
        return
      }
      if (price === null) {
        warnings.push(`${name}: price "${rawPrice}" is not a number — skipped`)
        skipped.add(id)
        return
      }
      const category = clean(r[mc['Category']]) || 'Uncategorised'
      if (!categories.includes(category)) categories.push(category)
      const orderFrom = clean(r[mc['Order from']]).toUpperCase()
      const availability = AVAILABILITY[orderFrom]
      if (!availability) warnings.push(`${name}: unknown "Order from" value "${orderFrom}" — hidden`)
      basePrice.set(id, price)
      products.set(id, {
        feedmeId: id,
        name,
        internalName: clean(r[mc['Internal name']]) || null,
        description: clean(r[mc['Description']]) || null,
        category,
        availability: availability ?? 'hidden',
        isAddon: category.toUpperCase() === 'ADDON',
        takeawayFeeSen: toSen(r[mc['Takeaway price']]) ?? 0,
        sortOrder: i,
        variants: [],
      })
      return
    }

    const p = products.get(id)
    if (!p) {
      warnings.push(`Variant row for unknown product ${id} — skipped`)
      return
    }
    const variantName = clean(r[mc['Variant Name']]) || key
    if (p.variants.some((v) => v.key === key)) {
      warnings.push(`${p.name} / ${variantName}: duplicate variant key — skipped`)
      return
    }
    if (price === null) {
      warnings.push(`${p.name} / ${variantName}: price "${rawPrice}" is not a number — variant skipped`)
      return
    }
    p.variants.push({ key, name: variantName, priceSen: price, sortOrder: p.variants.length })
  })

  for (const p of products.values()) {
    if (p.variants.length === 0) p.variants.push({ key: '', name: 'Regular', priceSen: basePrice.get(p.feedmeId) ?? 0, sortOrder: 0 })
  }

  // ── modifier groups ──────────────────────────────────────────────────────
  const addon = sheetOf(files.addonGroup, catalog, 'the add-on group file')
  const gc = columns(addon[0], [
    'Group ID', 'Group Name', 'Min', 'Max', 'Stackable', 'Item ID', 'Item Name',
    'Item Name Overrider', 'Variant Key', 'Item price', 'Order from', 'isDefault',
  ])
  const groups = new Map<string, ImportGroup>()
  for (const r of addon.slice(1)) {
    const gid = clean(r[gc['Group ID']])
    if (!gid) continue
    let group = groups.get(gid)
    if (!group) {
      const name = clean(r[gc['Group Name']]) || gid
      const min = Number(clean(r[gc['Min']]) || '0')
      const max = Number(clean(r[gc['Max']]) || '1')
      group = {
        feedmeId: gid,
        name,
        min: Number.isInteger(min) && min >= 0 ? min : 0,
        max: Number.isInteger(max) && max >= 1 ? max : 1,
        stackable: clean(r[gc['Stackable']]).toUpperCase() === 'T',
        sortOrder: groups.size,
        options: [],
      }
      if (group.max < group.min) {
        warnings.push(`${name}: max ${group.max} is below min ${group.min} — max set to ${group.min}`)
        group.max = group.min
      }
      groups.set(gid, group)
    }
    const itemId = clean(r[gc['Item ID']])
    const itemName = clean(r[gc['Item Name']])
    const product = products.get(itemId)
    if (!product) {
      warnings.push(`${group.name}: option "${itemName || itemId}" is not in the menu — skipped`)
      continue
    }
    group.options.push({
      productFeedmeId: itemId,
      variantKey: clean(r[gc['Variant Key']]),
      name: clean(r[gc['Item Name Overrider']]) || itemName || product.name,
      priceSen: toSen(r[gc['Item price']]) ?? 0,
      isDefault: clean(r[gc['isDefault']]).toUpperCase() === 'T',
      availability: AVAILABILITY[clean(r[gc['Order from']]).toUpperCase()] ?? 'all',
      sortOrder: group.options.length,
    })
  }

  // ── links (product → group) ──────────────────────────────────────────────
  const links: ImportLink[] = []
  const seen = new Set<string>()
  let warnedFallback = false
  for (const sheet of Object.values(files.itemLinkedAddon)) {
    if (sheet.length === 0) continue
    const lc = columns(sheet[0], ['Group ID', 'Item ID'])
    let flag = sheet[0].findIndex((h) => clean(h) === catalog)
    if (flag < 0) {
      flag = sheet[0].findIndex((h) => clean(h) === 'Default Catalog')
      if (flag < 0) continue
      if (!warnedFallback) {
        warnings.push(`Add-on links have no "${catalog}" column — used "Default Catalog" instead`)
        warnedFallback = true
      }
    }
    for (const r of sheet.slice(1)) {
      if (clean(r[flag]).toUpperCase() !== 'T') continue
      const gid = clean(r[lc['Group ID']])
      const pid = clean(r[lc['Item ID']])
      const group = groups.get(gid)
      if (!group || !products.has(pid) || seen.has(`${pid}|${gid}`)) continue
      seen.add(`${pid}|${gid}`)
      links.push({ productFeedmeId: pid, groupFeedmeId: gid, sortOrder: group.sortOrder })
    }
  }

  return {
    payload: {
      categories: categories.map((name, sortOrder) => ({ name, sortOrder })),
      products: [...products.values()],
      groups: [...groups.values()],
      links,
    },
    warnings,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/pos/menu/feedmeExport.test.ts`
Expected: PASS (14 tests). Then `npx tsc -b` — clean.

- [ ] **Step 5: Check it against the real export (controller only, no commit of data)**

The real export lives outside the repo at `/private/tmp/claude-502/-Users-USER-Desktop-Craft-OS/e3c853f6-da0a-496f-8b0e-03e8237963bc/scratchpad/feedme-menu-export/` (unzipped) and `/Users/USER/Downloads/books_22-10-2026_19-36.zip`. Run a throwaway vitest in the scratchpad (jsdom) that calls `readFeedmeExport` on the zip and `buildMenuImport(…, 'Craft Cafe')`, and print counts + the first 20 warnings. Expected roughly: 409 products, ~74 categories, 36 groups, links > 0, a small number of warnings. Report the numbers; do not commit the file or the script.

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/menu/feedmeExport.ts src/features/pos/menu/feedmeExport.test.ts
git commit -m "feat(pos-menu): turn Feedme's menu export into one import payload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `/menu` page

**Files:**
- Create: `src/features/pos/menu/menuApi.ts`
- Create: `src/features/pos/menu/menuView.ts`
- Test: `src/features/pos/menu/menuView.test.ts`
- Create: `src/features/pos/menu/MenuPage.tsx`
- Modify: `src/App.tsx` (route), `src/shared/lib/nav.ts` (leaf), `src/shared/lib/nav.test.ts` (expected ids), `src/shared/components/Sidebar.tsx` (icon)

**Interfaces:**
- Consumes: `Availability`, `MenuImport` (Task 5); `writeOutcome` (`src/shared/lib/db-write.ts`); `supabase` (`src/shared/lib/supabase.ts`); `ProtectedRoute` with `requireCap="access_settings"`, `AppLayout` (both in `src/App.tsx`).
- Produces:
  - `interface MenuVariantRow { id: string; name: string; price_sen: number; is_active: boolean; sort_order: number }`
  - `interface MenuProductRow { id: string; name: string; availability: Availability; is_addon: boolean; sst_rate_bp: number; print_route: string | null; takeaway_fee_sen: number; sort_order: number; category: { name: string; sort_order: number } | null; menu_variants: MenuVariantRow[] }`
  - `type ProductPatch = Partial<Pick<MenuProductRow, 'availability' | 'sst_rate_bp' | 'print_route'>>`
  - `fetchMenu(): Promise<MenuProductRow[]>`, `updateProducts(ids: string[], patch: ProductPatch): Promise<void>`, `importMenu(payload: MenuImport): Promise<Record<string, number>>`
  - `PRINT_ROUTES = ['Bar', 'Kitchen', 'Bakery', 'Front House']`, `SST_CHOICES = [{ bp: 600, label: '6%' }, { bp: 0, label: '0%' }]`, `AVAILABILITY_LABELS: Record<Availability, string>`
  - `formatPrice(variants): string`, `groupMenu(rows, { showAddons, search }): MenuSection[]`, `interface MenuSection { title: string; products: MenuProductRow[] }`

- [ ] **Step 1: Write the failing view test**

`src/features/pos/menu/menuView.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatPrice, groupMenu } from './menuView'
import type { MenuProductRow } from './menuApi'

function row(over: Partial<MenuProductRow>): MenuProductRow {
  return {
    id: over.name ?? 'x', name: 'x', availability: 'all', is_addon: false, sst_rate_bp: 600, print_route: null,
    takeaway_fee_sen: 0, sort_order: 0, category: { name: 'TEA', sort_order: 0 }, menu_variants: [], ...over,
  }
}
const v = (price_sen: number, is_active = true) => ({ id: String(price_sen), name: 'v', price_sen, is_active, sort_order: 0 })

describe('formatPrice', () => {
  it('shows one price, a range, or a dash, ignoring switched-off variants', () => {
    expect(formatPrice([v(1000)])).toBe('RM 10.00')
    expect(formatPrice([v(1000), v(1150), v(900, false)])).toBe('RM 10.00 – 11.50')
    expect(formatPrice([v(900, false)])).toBe('—')
  })
})

describe('groupMenu', () => {
  const rows = [
    row({ name: 'Oat milk', is_addon: true, category: { name: 'ADDON', sort_order: 2 } }),
    row({ name: 'Smoked Duck DON', sort_order: 1, category: { name: 'DONBURI', sort_order: 1 } }),
    row({ name: 'Lychee Rose', sort_order: 2 }),
    row({ name: 'Apple Tea', sort_order: 1 }),
    row({ name: 'Mystery', category: null }),
  ]

  it('orders sections by category and products by sort order, hiding add-ons by default', () => {
    const s = groupMenu(rows, { showAddons: false, search: '' })
    expect(s.map((x) => x.title)).toEqual(['TEA', 'DONBURI', 'Uncategorised'])
    expect(s[0].products.map((p) => p.name)).toEqual(['Apple Tea', 'Lychee Rose'])
  })

  it('shows add-ons when asked', () => {
    expect(groupMenu(rows, { showAddons: true, search: '' }).map((x) => x.title)).toContain('ADDON')
  })

  it('filters by name, case-insensitively', () => {
    const s = groupMenu(rows, { showAddons: false, search: 'duck' })
    expect(s).toHaveLength(1)
    expect(s[0].products[0].name).toBe('Smoked Duck DON')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/pos/menu/menuView.test.ts`
Expected: FAIL — `Failed to resolve import "./menuView"`

- [ ] **Step 3: Write `menuApi.ts`**

```ts
import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { Availability, MenuImport } from './feedmeExport'

export interface MenuVariantRow { id: string; name: string; price_sen: number; is_active: boolean; sort_order: number }
export interface MenuProductRow {
  id: string
  name: string
  availability: Availability
  is_addon: boolean
  sst_rate_bp: number
  print_route: string | null
  takeaway_fee_sen: number
  sort_order: number
  category: { name: string; sort_order: number } | null
  menu_variants: MenuVariantRow[]
}
export type ProductPatch = Partial<Pick<MenuProductRow, 'availability' | 'sst_rate_bp' | 'print_route'>>

export async function fetchMenu(): Promise<MenuProductRow[]> {
  const { data, error } = await supabase
    .from('menu_products')
    .select(
      'id, name, availability, is_addon, sst_rate_bp, print_route, takeaway_fee_sen, sort_order, ' +
        'category:menu_categories(name, sort_order), menu_variants(id, name, price_sen, is_active, sort_order)',
    )
    .eq('is_active', true)
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown as MenuProductRow[]
}

/** One patch for many products (e.g. a whole category's print route). */
export async function updateProducts(ids: string[], patch: ProductPatch): Promise<void> {
  if (ids.length === 0) return
  const res = await supabase
    .from('menu_products')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .in('id', ids)
    .select('id')
  const outcome = writeOutcome(res)
  if (!outcome.ok) throw new Error(`Menu change failed: ${outcome.reason}`)
  if ((res.data ?? []).length !== ids.length) throw new Error('Some products were not updated — refresh and try again.')
}

export async function importMenu(payload: MenuImport): Promise<Record<string, number>> {
  const { data, error } = await supabase.rpc('menu_import', { p_payload: payload })
  if (error) throw new Error(error.message)
  return data as Record<string, number>
}
```

- [ ] **Step 4: Write `menuView.ts`**

```ts
import type { Availability } from './feedmeExport'
import type { MenuProductRow, MenuVariantRow } from './menuApi'

/** Feedme's print routes at Craft Cafe (portal → Menu → Print route, 2026-10-22). */
export const PRINT_ROUTES = ['Bar', 'Kitchen', 'Bakery', 'Front House'] as const
export const SST_CHOICES = [
  { bp: 600, label: '6%' },
  { bp: 0, label: '0%' },
] as const
export const AVAILABILITY_LABELS: Record<Availability, string> = {
  all: 'Counter + QR',
  counter_only: 'Counter only',
  hidden: 'Hidden',
}

export interface MenuSection { title: string; products: MenuProductRow[] }

const rm = (sen: number) => (sen / 100).toFixed(2)

export function formatPrice(variants: Pick<MenuVariantRow, 'price_sen' | 'is_active'>[]): string {
  const prices = variants.filter((v) => v.is_active).map((v) => v.price_sen)
  if (prices.length === 0) return '—'
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  return lo === hi ? `RM ${rm(lo)}` : `RM ${rm(lo)} – ${rm(hi)}`
}

export function groupMenu(rows: MenuProductRow[], opts: { showAddons: boolean; search: string }): MenuSection[] {
  const q = opts.search.trim().toLowerCase()
  const sections = new Map<string, { order: number; products: MenuProductRow[] }>()
  for (const r of rows) {
    if (!opts.showAddons && r.is_addon) continue
    if (q && !r.name.toLowerCase().includes(q)) continue
    const title = r.category?.name ?? 'Uncategorised'
    if (!sections.has(title)) sections.set(title, { order: r.category?.sort_order ?? Number.MAX_SAFE_INTEGER, products: [] })
    sections.get(title)!.products.push(r)
  }
  return [...sections.entries()]
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([title, s]) => ({
      title,
      products: s.products.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    }))
}
```

- [ ] **Step 5: Run the view test**

Run: `npx vitest run src/features/pos/menu/menuView.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Write `MenuPage.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchMenu, updateProducts, type MenuProductRow, type ProductPatch } from './menuApi'
import { AVAILABILITY_LABELS, PRINT_ROUTES, SST_CHOICES, formatPrice, groupMenu } from './menuView'
import type { Availability } from './feedmeExport'

const select = 'rounded border border-border bg-card px-2 py-1 text-sm'

export default function MenuPage() {
  const [rows, setRows] = useState<MenuProductRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showAddons, setShowAddons] = useState(false)

  const load = useCallback(() => {
    fetchMenu()
      .then((r) => {
        setRows(r)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
  }, [])
  useEffect(load, [load])

  const sections = useMemo(() => groupMenu(rows ?? [], { showAddons, search }), [rows, showAddons, search])

  const save = async (ids: string[], patch: ProductPatch) => {
    const before = rows
    setRows((rs) => rs?.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r)) ?? rs)
    try {
      await updateProducts(ids, patch)
      setError(null)
    } catch (e) {
      setRows(before)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (rows === null && !error) return <p className="p-6 text-sm">Loading menu…</p>

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Menu</h1>
          <p className="text-sm text-gray-500">
            {rows?.length ?? 0} products. Names, prices and add-ons come from Feedme; SST, print route and availability are set here.
          </p>
        </div>
        <Link to="/menu/import" className="rounded bg-brown-btn px-4 py-2 text-sm text-white hover:bg-brown-btn-hover">
          Import from Feedme
        </Link>
      </div>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center gap-4">
        <input
          className="w-64 rounded border border-border px-3 py-2 text-sm"
          placeholder="Search products"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showAddons} onChange={(e) => setShowAddons(e.target.checked)} />
          Show add-on items
        </label>
      </div>

      {rows?.length === 0 && (
        <p className="rounded border border-border p-6 text-sm">No menu yet — use “Import from Feedme”.</p>
      )}

      {sections.map((section) => (
        <section key={section.title} className="rounded border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
            <h2 className="font-medium">
              {section.title} <span className="text-sm text-gray-500">({section.products.length})</span>
            </h2>
            <label className="flex items-center gap-2 text-sm">
              Print whole category to
              <select
                className={select}
                value=""
                onChange={(e) =>
                  void save(
                    // the whole category, not just the rows the search/add-on filter is showing
                    (rows ?? []).filter((r) => (r.category?.name ?? 'Uncategorised') === section.title).map((p) => p.id),
                    { print_route: e.target.value || null },
                  )
                }
              >
                <option value="" disabled>Choose…</option>
                {PRINT_ROUTES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-gray-500">
              <tr>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Price</th>
                <th className="px-4 py-2">Availability</th>
                <th className="px-4 py-2">SST</th>
                <th className="px-4 py-2">Print route</th>
              </tr>
            </thead>
            <tbody>
              {section.products.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-4 py-2">
                    {p.name}
                    {p.menu_variants.filter((v) => v.is_active).length > 1 && (
                      <span className="ml-2 text-xs text-gray-500">
                        {p.menu_variants.filter((v) => v.is_active).map((v) => v.name).join(' / ')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{formatPrice(p.menu_variants)}</td>
                  <td className="px-4 py-2">
                    <select
                      className={select}
                      value={p.availability}
                      onChange={(e) => void save([p.id], { availability: e.target.value as Availability })}
                    >
                      {(Object.keys(AVAILABILITY_LABELS) as Availability[]).map((a) => (
                        <option key={a} value={a}>{AVAILABILITY_LABELS[a]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <select
                      className={select}
                      value={p.sst_rate_bp}
                      onChange={(e) => void save([p.id], { sst_rate_bp: Number(e.target.value) })}
                    >
                      {SST_CHOICES.map((c) => (
                        <option key={c.bp} value={c.bp}>{c.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <select
                      className={select}
                      value={p.print_route ?? ''}
                      onChange={(e) => void save([p.id], { print_route: e.target.value || null })}
                    >
                      <option value="">Not printed</option>
                      {PRINT_ROUTES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
```

(Colours follow the project palette in `tailwind.config.js`: primary buttons `bg-brown-btn hover:bg-brown-btn-hover`, borders `border-border`, panels `bg-card`.)

- [ ] **Step 7: Wire the route and nav**

In `src/shared/lib/nav.ts`, insert before the `settings` leaf:

```ts
  { id: 'menu', label: 'Menu', to: '/menu', activePaths: ['/menu'], cap: 'access_settings' },
```

In `src/shared/lib/nav.test.ts`, the `access_settings` expectation becomes:

```ts
    expect(ids(visibleNav(canWith('access_settings')))).toEqual(['profile', 'time-pay', 'menu', 'settings'])
```

In `src/shared/components/Sidebar.tsx`, import `UtensilsCrossed` from `lucide-react` alongside the existing icons and add `menu: UtensilsCrossed,` to the id → icon map.

In `src/App.tsx`, import `MenuPage from './features/pos/menu/MenuPage'` and add next to the `/settings` route:

```tsx
      <Route
        path="/menu"
        element={
          <ProtectedRoute requireCap="access_settings">
            <AppLayout><MenuPage /></AppLayout>
          </ProtectedRoute>
        }
      />
```

- [ ] **Step 8: Verify**

Run: `npx vitest run src/features/pos src/shared` — all pass; `npx tsc -b` — clean.

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/menu/menuApi.ts src/features/pos/menu/menuView.ts src/features/pos/menu/menuView.test.ts src/features/pos/menu/MenuPage.tsx src/App.tsx src/shared/lib/nav.ts src/shared/lib/nav.test.ts src/shared/components/Sidebar.tsx
git commit -m "feat(pos-menu): /menu page — set SST, print route and availability per product

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `/menu/import` page

**Files:**
- Create: `src/features/pos/menu/MenuImportPage.tsx`
- Modify: `src/App.tsx` (route)

**Interfaces:**
- Consumes: `readFeedmeExport`, `buildMenuImport`, `FEEDME_CATALOG`, `MenuImport` (Task 5); `importMenu` (Task 6).

- [ ] **Step 1: Write the page**

`src/features/pos/menu/MenuImportPage.tsx`:

```tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { buildMenuImport, FEEDME_CATALOG, readFeedmeExport, type MenuImport } from './feedmeExport'
import { importMenu } from './menuApi'

type Stage =
  | { kind: 'pick' }
  | { kind: 'preview'; fileName: string; payload: MenuImport; warnings: string[] }
  | { kind: 'importing' }
  | { kind: 'done'; counts: Record<string, number> }

export default function MenuImportPage() {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' })
  const [error, setError] = useState<string | null>(null)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const files = readFeedmeExport(new Uint8Array(await file.arrayBuffer()))
      const { payload, warnings } = buildMenuImport(files, FEEDME_CATALOG)
      setStage({ kind: 'preview', fileName: file.name, payload, warnings })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: 'pick' })
    }
  }

  const confirm = async (payload: MenuImport) => {
    setStage({ kind: 'importing' })
    try {
      setStage({ kind: 'done', counts: await importMenu(payload) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: 'pick' })
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <Link to="/menu" className="text-sm underline">← Menu</Link>
      <h1 className="text-2xl font-semibold">Import menu from Feedme</h1>
      <p className="text-sm text-gray-500">
        In the Feedme portal go to Menu → Products → Export and choose the downloaded <code>books_….zip</code>.
        Availability is taken from the “{FEEDME_CATALOG}” catalog. Importing again updates names, prices and add-ons;
        SST and print routes set in Craft OS are kept, and no product is deleted.
      </p>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {stage.kind === 'pick' && (
        <input type="file" accept=".zip" onChange={(e) => void onFile(e.target.files?.[0])} />
      )}

      {stage.kind === 'preview' && (
        <div className="space-y-3 rounded border border-border p-4">
          <p className="text-sm">
            <b>{stage.fileName}</b>: {stage.payload.products.length} products ({' '}
            {stage.payload.products.filter((p) => p.isAddon).length} add-on items),{' '}
            {stage.payload.products.reduce((n, p) => n + p.variants.length, 0)} variants,{' '}
            {stage.payload.categories.length} categories, {stage.payload.groups.length} add-on groups,{' '}
            {stage.payload.links.length} product ↔ add-on links.
          </p>
          {stage.warnings.length > 0 && (
            <details className="text-sm">
              <summary>{stage.warnings.length} warnings</summary>
              <ul className="mt-2 list-disc pl-5">
                {stage.warnings.slice(0, 100).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex gap-2">
            <button className="rounded bg-brown-btn px-4 py-2 text-sm text-white hover:bg-brown-btn-hover" onClick={() => void confirm(stage.payload)}>
              Import {stage.payload.products.length} products
            </button>
            <button className="rounded border border-border px-4 py-2 text-sm" onClick={() => setStage({ kind: 'pick' })}>
              Choose another file
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'importing' && <p className="text-sm">Importing…</p>}

      {stage.kind === 'done' && (
        <div className="space-y-2 rounded border border-border p-4 text-sm">
          <p>
            Imported: {stage.counts.products} products, {stage.counts.variants} variants, {stage.counts.groups} add-on groups,{' '}
            {stage.counts.options} add-on options, {stage.counts.links} links.
          </p>
          <Link to="/menu" className="underline">Open the menu</Link>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add the route** in `src/App.tsx` (import `MenuImportPage from './features/pos/menu/MenuImportPage'`), next to `/menu`:

```tsx
      <Route
        path="/menu/import"
        element={
          <ProtectedRoute requireCap="access_settings">
            <AppLayout><MenuImportPage /></AppLayout>
          </ProtectedRoute>
        }
      />
```

- [ ] **Step 3: Verify** — `npx tsc -b` clean; `npx vitest run src/features/pos src/shared` passes.

- [ ] **Step 4: Commit**

```bash
git add src/features/pos/menu/MenuImportPage.tsx src/App.tsx
git commit -m "feat(pos-menu): /menu/import — preview Feedme export, then import in one go

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Real import on dev and a manager walk-through (controller + user)

- [ ] **Step 1:** Add a dev-server entry pointing at the worktree in the main checkout's `.claude/launch.json` (as `pos-spike-https` did, without `HTTPS=1`, port 5174) and start it with `preview_start`.
- [ ] **Step 2:** The user signs in at `/login` with the dev test login (the user types the password), opens **Menu → Import from Feedme**, chooses `/Users/USER/Downloads/books_22-10-2026_19-36.zip`, reads the preview counts and warnings, and presses **Import**.
- [ ] **Step 3:** Controller checks the database (SQL editor, read-only): `select count(*) from menu_products; select count(*) from menu_variants where is_active; select count(*) from modifier_groups; select count(*) from product_modifier_groups;` — counts match the preview.
- [ ] **Step 4:** User sets a print route for one whole category and SST 0% on one product (e.g. Keychain), reloads, sees both kept; imports the same zip again; sees both still kept.
- [ ] **Step 5:** Record the numbers and anything odd in `.superpowers/sdd/progress.md`; commit nothing from the export.
