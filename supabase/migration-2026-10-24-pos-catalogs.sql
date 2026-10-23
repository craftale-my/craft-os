-- ============================================================================
-- Craft OS — POS menu catalogs · M1 schema, permissions and backfill (2026-10-24)
-- Run on craft-os-dev after every earlier POS migration, INCLUDING
-- migration-2026-10-24-pos-checkout-fixes.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m1.md
-- Design: docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md §2, §7
--
-- This file is now the canonical definition of has_menu_cap and staff_has_cap
-- (the checkout-fixes version plus manage_menu) and of the write policies on
-- menu_products, menu_variants and branch_menu_status. Re-running an older
-- migration that defines them (2026-10-22-pos-menu, 2026-10-23-pos-ordering,
-- 2026-10-24-pos-checkout, 2026-10-24-pos-checkout-fixes) puts the older versions
-- back — re-run this file and migration-2026-10-24-pos-catalogs-fn.sql afterwards.
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_caller_branch()') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-checkout-fixes.sql first (pos_caller_branch is missing)';
  end if;
end $$;

-- ── Capability manage_menu ("Edit menu"): owner and admin by default ────────
-- The checkout-fixes rule (live staff only: is_active and status = 'active'; the
-- Owner's setting in system_role_permissions wins over the default) plus one
-- branch. Mirrors buildRoleCaps (src/shared/lib/lookups.tsx) over
-- DEFAULT_SYSTEM_ROLE_CAPS (src/shared/types/index.ts) — change the three together.
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
        else false
      end)
    from staff s
    where s.id = auth.uid() and s.is_active and s.status = 'active'
  ), false)
$$;

-- The same rule for any staff member. Internal.
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
        else false
      end)
    from staff s
    where s.id = p_staff_id and s.is_active and s.status = 'active'
  ), false)
$$;
revoke all on function staff_has_cap(uuid, text) from public, anon, authenticated;

-- ── Tables ──────────────────────────────────────────────────────────────────
-- A catalog picks products from the master list, each with its own channel and
-- price. Nothing here is ever deleted: a catalog is deactivated, a product is
-- set to 'hidden' in it. (The cascades only serve menu_import, which re-creates
-- the add-on options of every group it imports.)
create table if not exists menu_catalogs (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique check (length(trim(name)) between 1 and 60),
  is_active            boolean not null default true,
  sort_order           integer not null default 0,
  feedme_catalog_name  text unique,                                    -- the Feedme sheet it is imported from
  created_at           timestamptz not null default now()
);

create table if not exists catalog_products (
  catalog_id    uuid not null references menu_catalogs(id) on delete cascade,
  product_id    uuid not null references menu_products(id) on delete cascade,
  availability  text not null default 'all' check (availability in ('all', 'counter_only', 'hidden')),
  sort_order    integer not null default 0,
  primary key (catalog_id, product_id)
);
create index if not exists catalog_products_product_idx on catalog_products(product_id);

create table if not exists catalog_variant_prices (
  catalog_id  uuid not null references menu_catalogs(id) on delete cascade,
  variant_id  uuid not null references menu_variants(id) on delete cascade,
  price_sen   integer not null check (price_sen >= 0),
  primary key (catalog_id, variant_id)
);
create index if not exists catalog_variant_prices_variant_idx on catalog_variant_prices(variant_id);

-- no row = the option's own price_delta_sen
create table if not exists catalog_option_prices (
  catalog_id       uuid not null references menu_catalogs(id) on delete cascade,
  option_id        uuid not null references modifier_options(id) on delete cascade,
  price_delta_sen  integer not null check (price_delta_sen >= 0),
  primary key (catalog_id, option_id)
);
create index if not exists catalog_option_prices_option_idx on catalog_option_prices(option_id);

-- which catalog a branch prices each order type from, plus the catalogs a cashier may switch to
create table if not exists branch_catalogs (
  branch_id   uuid not null references branches(id),
  role        text not null check (role in ('dine_in', 'takeaway', 'qr', 'additional')),
  catalog_id  uuid not null references menu_catalogs(id),
  primary key (branch_id, role, catalog_id)
);
create unique index if not exists branch_catalogs_one_per_role on branch_catalogs(branch_id, role) where role <> 'additional';

-- the catalog an order was priced from (null on orders placed before M1)
alter table orders add column if not exists catalog_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_catalog_id_fkey') then
    alter table orders add constraint orders_catalog_id_fkey foreign key (catalog_id) references menu_catalogs(id);
  end if;
end $$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every signed-in staff member reads the catalogs (the QR page reads only through
-- qr_menu). The company-wide catalog tables are written by Edit menu holders —
-- insert and update only; branch_catalogs by a manager of that branch.
do $$
declare t text;
begin
  foreach t in array array['menu_catalogs','catalog_products','catalog_variant_prices',
                           'catalog_option_prices','branch_catalogs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists menu_read on %I', t);
    execute format('create policy menu_read on %I for select to authenticated using (true)', t);
  end loop;
  foreach t in array array['menu_catalogs','catalog_products','catalog_variant_prices','catalog_option_prices']
  loop
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('create policy %I on %I for insert to authenticated with check (has_menu_cap(''manage_menu''))',
                   t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('create policy %I on %I for update to authenticated using (has_menu_cap(''manage_menu'')) with check (has_menu_cap(''manage_menu''))',
                   t || '_update', t);
  end loop;
end $$;

drop policy if exists branch_catalogs_manage on branch_catalogs;
create policy branch_catalogs_manage on branch_catalogs for all to authenticated
  using      (branch_id = pos_caller_branch() and has_menu_cap('access_settings'))
  with check (branch_id = pos_caller_branch() and has_menu_cap('access_settings'));

-- /menu edits of the master list need Edit menu now (was access_settings)
drop policy if exists menu_products_edit on menu_products;
create policy menu_products_edit on menu_products for update to authenticated
  using (has_menu_cap('manage_menu')) with check (has_menu_cap('manage_menu'));
drop policy if exists menu_variants_edit on menu_variants;
create policy menu_variants_edit on menu_variants for update to authenticated
  using (has_menu_cap('manage_menu')) with check (has_menu_cap('manage_menu'));

-- sold-out: any live staff member, for their own branch only (was: any branch)
drop policy if exists branch_menu_status_write on branch_menu_status;
create policy branch_menu_status_write on branch_menu_status for all to authenticated
  using (branch_id = pos_caller_branch()) with check (branch_id = pos_caller_branch());

-- ── Backfill: catalog "Craft Cafe" from today's menu, once ──────────────────
-- So ordering keeps working before any re-import: the products that are not
-- hidden today, at today's prices. Skipped when the catalog already exists.
do $$
declare v_id uuid;
begin
  if not exists (select 1 from menu_catalogs where feedme_catalog_name = 'Craft Cafe' or name = 'Craft Cafe') then
    insert into menu_catalogs(name, feedme_catalog_name, sort_order) values ('Craft Cafe', 'Craft Cafe', 0)
    returning id into v_id;
    insert into catalog_products(catalog_id, product_id, availability, sort_order)
    select v_id, p.id, p.availability, p.sort_order
      from menu_products p where p.is_active and p.availability <> 'hidden';
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
    select v_id, v.id, v.price_sen
      from menu_variants v join catalog_products cp on cp.catalog_id = v_id and cp.product_id = v.product_id
     where v.is_active;
  end if;
end $$;

-- every active branch without a catalog for dine-in, takeaway or QR gets Craft Cafe for it
insert into branch_catalogs(branch_id, role, catalog_id)
select b.id, r.role, c.id
  from branches b
  cross join (values ('dine_in'), ('takeaway'), ('qr')) as r(role)
  join menu_catalogs c on c.feedme_catalog_name = 'Craft Cafe' and c.is_active
 where coalesce(b.is_active, true)                      -- branches.is_active is nullable; null counts as active
   and not exists (select 1 from branch_catalogs bc where bc.branch_id = b.id and bc.role = r.role);

select 'catalogs schema applied' as result;
