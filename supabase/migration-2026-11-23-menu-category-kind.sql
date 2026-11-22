-- Category kind: drink / food (spec docs/superpowers/specs/2026-11-22-qr-ai-pick-mascot-design.md §4).
-- The QR page's AI Pick suggests food to a table that has only drinks, and a drink to one that has only food.
-- Idempotent; dev first, then prod. Additive: an older client ignores the new field.
-- Run before the back-office build that sets kinds (an older server has no menu_set_category_kind).
-- Then run migration-2026-11-23-menu-category-kind-verify.sql (prints VERIFY OK).
-- Lines marked K1 are the only changes to the re-created functions.

do $$
begin
  if to_regprocedure('qr_menu(text)') is null or to_regprocedure('pos_menu_rows(uuid)') is null
     or to_regprocedure('menu_editor_lookups()') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'branch_pos_settings' and column_name = 'last_order_at') then
    raise exception 'STOP: run migration-2026-10-24-pos-menu-editor-fn.sql and migration-2026-11-22-pos-feedme-habits.sql first';
  end if;
end $$;

-- ── menu_categories.kind: 'drink' | 'food' | null (null = neither, e.g. flowers, merchandise) ──
alter table menu_categories add column if not exists kind text;
alter table menu_categories drop constraint if exists menu_categories_kind_check;
alter table menu_categories add constraint menu_categories_kind_check check (kind is null or kind in ('drink', 'food'));

-- ── menu_set_category_kind: the category editor's Type choice ──────────────
-- A setter of its own, like menu_set_category_active (menu_save_category keeps its signature,
-- so no overload and no drop). p_kind: 'drink', 'food' or null (Other).
create or replace function menu_set_category_kind(p_id uuid, p_kind text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_kind is not null and p_kind not in ('drink', 'food') then raise exception 'Invalid category type'; end if;
  update menu_categories set kind = p_kind where id = p_id;
  if not found then raise exception 'Category not found — refresh and try again'; end if;
end $$;
revoke all on function menu_set_category_kind(uuid, text) from public, anon;
grant execute on function menu_set_category_kind(uuid, text) to authenticated;

-- ── menu_editor_lookups: each category carries its kind ────────────────────
-- Re-created from its current text (migration-2026-10-24-pos-menu-editor-fn.sql).
create or replace function menu_editor_lookups() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return jsonb_build_object(
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'name', c.name, 'isActive', c.is_active, 'sortOrder', c.sort_order,
               'kind', c.kind,                                                    -- K1
               'productCount', (select count(*) from menu_products p
                                 where p.category_id = c.id and p.is_active and not p.is_addon))
             order by c.sort_order, c.name)
        from menu_categories c), '[]'::jsonb),
    'catalogs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'isActive', m.is_active, 'sortOrder', m.sort_order,
               'feedmeName', m.feedme_catalog_name,
               'productCount', (select count(*) from catalog_products cp
                                  join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
                                 where cp.catalog_id = m.id and cp.availability <> 'hidden'),
               -- products the catalog sells with an active variant it has no price for: the pad and
               -- QR leave them out (a re-import can cause it in catalogs made here, Open point 7)
               'unpricedCount', (select count(*) from catalog_products cp
                                   join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
                                  where cp.catalog_id = m.id and cp.availability <> 'hidden'
                                    and exists (select 1 from menu_variants v
                                                 where v.product_id = p.id and v.is_active
                                                   and not exists (select 1 from catalog_variant_prices cvp
                                                                    where cvp.catalog_id = m.id and cvp.variant_id = v.id))),
               'uses', coalesce((select jsonb_agg(jsonb_build_object('branch', b.name, 'role', bc.role) order by b.name, bc.role)
                                   from branch_catalogs bc join branches b on b.id = bc.branch_id and coalesce(b.is_active, true)
                                  where bc.catalog_id = m.id), '[]'::jsonb))
             order by m.sort_order, m.name)
        from menu_catalogs m), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name, 'isActive', g.is_active, 'min', g.min_select, 'max', g.max_select,
               'optionCount', (select count(*) from modifier_options o where o.group_id = g.id and o.availability <> 'hidden'),
               'productCount', (select count(*) from product_modifier_groups pmg
                                  join menu_products p on p.id = pmg.product_id and p.is_active
                                 where pmg.group_id = g.id))
             order by g.sort_order, g.name)
        from modifier_groups g), '[]'::jsonb),
    'addOns', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'isActive', p.is_active) order by p.name)
        from menu_products p where p.is_addon), '[]'::jsonb));
end $$;
revoke all on function menu_editor_lookups() from public, anon;
grant execute on function menu_editor_lookups() to authenticated;

-- ── pos_menu_rows: each product's category carries its kind ────────────────
-- Re-created from its current text (migration-2026-10-24-pos-menu-editor-fn.sql).
create or replace function pos_menu_rows(p_catalog_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  return jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'description', p.description, 'is_addon', p.is_addon,
               'is_active', p.is_active, 'sort_order', p.sort_order,
               'category', case when c.id is null then null
                                else jsonb_build_object('name', c.name, 'sort_order', c.sort_order, 'kind', c.kind) end,   -- K1
               'menu_variants', coalesce((select jsonb_agg(jsonb_build_object(
                                                  'id', v.id, 'name', v.name, 'is_active', v.is_active,
                                                  'sort_order', v.sort_order, 'feedme_variant_key', v.feedme_variant_key))
                                           from menu_variants v where v.product_id = p.id), '[]'::jsonb)))
        from catalog_products cp
        join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
        left join menu_categories c on c.id = p.category_id
       where cp.catalog_id = p_catalog_id and cp.availability <> 'hidden'
         and (c.id is null or c.is_active)), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name, 'min_select', g.min_select, 'max_select', g.max_select,
               'is_active', g.is_active, 'sort_order', g.sort_order,
               'modifier_options', coalesce((select jsonb_agg(jsonb_build_object(
                                                     'id', o.id, 'name', o.name, 'price_delta_sen', o.price_delta_sen,
                                                     'is_default', o.is_default, 'availability', o.availability,
                                                     'sort_order', o.sort_order, 'product_id', o.product_id))
                                              from modifier_options o where o.group_id = g.id), '[]'::jsonb)))
        from modifier_groups g where g.is_active), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', pmg.product_id, 'group_id', pmg.group_id, 'sort_order', pmg.sort_order))
        from product_modifier_groups pmg
       where exists (select 1 from catalog_products cp
                      where cp.catalog_id = p_catalog_id and cp.product_id = pmg.product_id and cp.availability <> 'hidden')), '[]'::jsonb),
    'soldOut', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', s.product_id, 'is_sold_out', s.is_sold_out))
        from branch_menu_status s where s.branch_id = v_branch and s.is_sold_out), '[]'::jsonb),
    'catalog', jsonb_build_object(
      'products', coalesce((
        select jsonb_agg(jsonb_build_object('product_id', cp.product_id, 'availability', cp.availability, 'sort_order', cp.sort_order))
          from catalog_products cp where cp.catalog_id = p_catalog_id and cp.availability <> 'hidden'), '[]'::jsonb),
      'prices', coalesce((
        select jsonb_agg(jsonb_build_object('variant_id', cvp.variant_id, 'price_sen', cvp.price_sen))
          from catalog_variant_prices cvp where cvp.catalog_id = p_catalog_id), '[]'::jsonb),
      'optionPrices', coalesce((
        select jsonb_agg(jsonb_build_object('option_id', cop.option_id, 'price_delta_sen', cop.price_delta_sen))
          from catalog_option_prices cop where cop.catalog_id = p_catalog_id), '[]'::jsonb)));
end $$;
revoke all on function pos_menu_rows(uuid) from public, anon;
grant execute on function pos_menu_rows(uuid) to authenticated;

-- ── qr_menu: each category carries its kind ────────────────────────────────
-- Re-created from its current text (migration-2026-11-22-pos-feedme-habits.sql, lines H1 kept).
create or replace function qr_menu(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'tableLabel', t.label,
    'paused', t.qr_paused,
    'needsPax', not exists (select 1 from bills b where b.table_id = t.id and b.status = 'open' and b.pax is not null),
    'ordersOpenAt', (select to_char(s.orders_open_at, 'HH24:MI') from branch_pos_settings s where s.branch_id = t.branch_id),   -- H1
    'lastOrderAt', (select to_char(s.last_order_at, 'HH24:MI') from branch_pos_settings s where s.branch_id = t.branch_id),     -- H1
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'kind', c.kind, 'products', c.products) order by c.sort_order, c.name)   -- K1
      from (
        select mc.name, mc.sort_order, mc.kind,                                       -- K1
          jsonb_agg(jsonb_build_object(
            'id', p.id, 'name', p.name, 'description', p.description,
            'soldOut', coalesce(bms.is_sold_out, false),
            'imagePath', p.image_path,                                                 -- M3: the product photo (a path in menu-images)
            -- M1: the qr catalog's prices; a variant it has no price for is not offered
            'variants', (select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'priceSen', cvp.price_sen,
                                                             'isBase', v.feedme_variant_key = '')
                                          order by v.sort_order, v.name)
                           from menu_variants v
                           join catalog_variant_prices cvp on cvp.catalog_id = qc.catalog_id and cvp.variant_id = v.id
                          where v.product_id = p.id and v.is_active),
            'groups', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', g.id, 'name', g.name, 'min', g.min_select, 'max', g.max_select,
                       'options', coalesce((
                         select jsonb_agg(jsonb_build_object(
                                  'id', o.id, 'name', o.name,
                                  'priceDeltaSen', coalesce(cop.price_delta_sen, o.price_delta_sen),   -- M1
                                  'isDefault', o.is_default,
                                  'available', o.availability = 'all' and not coalesce(obs.is_sold_out, false))
                                order by o.sort_order, o.name)
                           from modifier_options o
                           left join catalog_option_prices cop on cop.catalog_id = qc.catalog_id and cop.option_id = o.id   -- M1
                           left join branch_menu_status obs on obs.branch_id = t.branch_id and obs.product_id = o.product_id
                          where o.group_id = g.id and o.availability <> 'hidden'), '[]'::jsonb))
                     order by pmg.sort_order, g.name)
                from product_modifier_groups pmg
                join modifier_groups g on g.id = pmg.group_id and g.is_active
               where pmg.product_id = p.id), '[]'::jsonb)
          ) order by cp.sort_order, p.name) as products                             -- M1: the catalog's order
          -- M1: the products of the branch's qr catalog that QR may sell (was menu_products.availability = 'all')
          from catalog_products cp
          join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
          join menu_categories mc on mc.id = p.category_id and mc.is_active
          left join branch_menu_status bms on bms.branch_id = t.branch_id and bms.product_id = p.id
         where cp.catalog_id = qc.catalog_id and cp.availability = 'all'
           and menu_product_open(p.id, now())                                        -- M3: inside a time slot now, or none
           and exists (select 1 from menu_variants v
                         join catalog_variant_prices cvp on cvp.catalog_id = qc.catalog_id and cvp.variant_id = v.id
                        where v.product_id = p.id and v.is_active)
         group by mc.name, mc.sort_order, mc.kind                                     -- K1
      ) c), '[]'::jsonb))
  from dining_tables t
  -- M1: the branch's qr catalog, if it is set and active (none = an empty menu; ordering says why)
  left join lateral (
    select bc.catalog_id from branch_catalogs bc
      join menu_catalogs m on m.id = bc.catalog_id and m.is_active
     where bc.branch_id = t.branch_id and bc.role = 'qr'
  ) qc on true
  where t.qr_token = p_token and t.is_active
$$;
revoke all on function qr_menu(text) from public;
grant execute on function qr_menu(text) to anon, authenticated;

notify pgrst, 'reload schema';
select 'menu category kind applied' as result;
