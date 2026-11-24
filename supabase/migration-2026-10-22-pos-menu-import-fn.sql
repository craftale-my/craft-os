-- ============================================================================
-- Craft OS — POS Phase 1 · menu_import RPC (2026-10-22). Run after
-- migration-2026-10-22-pos-menu.sql. Idempotent.
-- One transaction: the whole Feedme import lands or none of it does.
-- ============================================================================
-- STOP guard (M1): after the menu catalogs are applied, menu_import lives in
-- migration-2026-10-24-pos-catalogs-fn.sql (manage_menu, not granted to staff);
-- re-running this file would bring back the access_settings version with a grant.
do $$ begin
  if to_regprocedure('pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)') is not null then
    raise exception 'STOP: menu catalogs (M1) are applied — re-run migration-2026-10-24-pos-catalogs-fn.sql instead of this file';
  end if;
end $$;

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
  drop table if exists pg_temp._imp_variants;
  create temp table pg_temp._imp_variants on commit drop as
  select mp.id as product_id, x.key, x.name, x."priceSen" as price_sen, x."sortOrder" as sort_order
    from jsonb_to_recordset(p_payload->'products') as p("feedmeId" text, variants jsonb)
    join menu_products mp on mp.feedme_product_id = p."feedmeId"
    cross join lateral jsonb_to_recordset(p.variants) as x(key text, name text, "priceSen" int, "sortOrder" int);

  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order, is_active)
  select product_id, key, name, price_sen, sort_order, true from pg_temp._imp_variants
  on conflict (product_id, feedme_variant_key) do update set
    name = excluded.name, price_sen = excluded.price_sen, sort_order = excluded.sort_order, is_active = true;
  get diagnostics n_var = row_count;

  update menu_variants mv set is_active = false
   where mv.product_id in (select distinct product_id from pg_temp._imp_variants)
     and not exists (select 1 from pg_temp._imp_variants iv
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
