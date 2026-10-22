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
