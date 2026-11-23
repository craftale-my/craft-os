-- ============================================================================
-- Craft OS — Menu costing (2026-11-22)
-- Recipes per menu variant and per add-on option, a standard ingredient cost
-- (latest price, prep items rolled up from their recipe), food cost % per
-- variant and an optional target per menu category. Managers only.
-- Spec: docs/superpowers/specs/2026-11-22-menu-costing-design.md
-- Additive and idempotent. Dev first.
-- ============================================================================

-- 0. Needs the POS menu tables (feature/pos-demo migrations) ---------------
do $$ begin
  if to_regclass('public.menu_variants') is null
     or to_regclass('public.modifier_options') is null
     or to_regclass('public.menu_products') is null
     or to_regclass('public.menu_categories') is null then
    raise exception 'Apply the POS menu migrations first';
  end if;
end $$;

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

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'menu_variant_recipe_lines_qty_not_nan') then
    alter table menu_variant_recipe_lines add constraint menu_variant_recipe_lines_qty_not_nan check (qty_base <> 'NaN');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'modifier_recipe_lines_qty_not_nan') then
    alter table modifier_recipe_lines add constraint modifier_recipe_lines_qty_not_nan check (qty_base <> 'NaN');
  end if;
end $$;

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
       case when a.missing = 0 and has_procurement_cap('manage_procurement') then a.total end as cost_rm,
       case when a.missing = 0 and v.price_sen > 0
            then round(a.total * 1000000 / v.price_sen)::bigint end as food_cost_bp,
       t.target_food_cost_bp,
       coalesce(t.target_food_cost_bp is not null and a.missing = 0 and v.price_sen > 0
                and round(a.total * 1000000 / v.price_sen)::bigint > t.target_food_cost_bp, false) as over_target
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
       case when has_procurement_cap('manage_procurement')
             and count(l.option_id) filter (where l.line_cost is null) = 0
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
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Lines must be a list';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
              where jsonb_typeof(e) <> 'object'
                 or coalesce(e->>'item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 or jsonb_typeof(e->'qty_base') is distinct from 'number') then
    raise exception 'Each line needs an ingredient and a quantity';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]')) e
              where (e->>'qty_base')::numeric <= 0) then
    raise exception 'Every quantity must be greater than zero';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]')) e
              group by (e->>'item_id')::uuid having count(*) > 1) then
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
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Lines must be a list';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
              where jsonb_typeof(e) <> 'object'
                 or coalesce(e->>'item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 or jsonb_typeof(e->'qty_base') is distinct from 'number') then
    raise exception 'Each line needs an ingredient and a quantity';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]')) e
              where (e->>'qty_base')::numeric = 0) then
    raise exception 'A quantity cannot be zero';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]')) e
              group by (e->>'item_id')::uuid having count(*) > 1) then
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
  if (select product_id from menu_variants where id = p_from_variant)
     is distinct from (select product_id from menu_variants where id = p_to_variant) then
    raise exception 'You can only copy between sizes of the same menu item';
  end if;
  if not exists (select 1 from menu_variant_recipe_lines where variant_id = p_from_variant) then
    raise exception 'That size has no recipe yet';
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
