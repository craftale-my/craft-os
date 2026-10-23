-- ============================================================================
-- Craft OS — POS menu catalogs · M2 menu editor functions (2026-10-24). Run on
-- craft-os-dev after migration-2026-10-24-pos-catalogs.sql and
-- migration-2026-10-24-pos-catalogs-fn.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m2.md
-- Design: docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md §2, §4, §7
--
-- Only NEW functions: no function, table, column or policy of an earlier file is
-- re-created or changed, so re-running this file never puts anything older back.
-- Every editor function needs Edit menu (has_menu_cap('manage_menu'), live staff
-- only) and answers 'Not allowed to edit the menu' otherwise. Nothing is deleted
-- except configuration that no order refers to: a product's link to an add-on
-- group, and a catalog's add-on price override (orders snapshot names and prices).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('menu_set_catalog_product(uuid,uuid,text)') is null
     or to_regprocedure('pos_order_catalog(uuid,text,text,uuid)') is null
     or to_regprocedure('pos_my_branch()') is null
     or to_regclass('public.catalog_option_prices') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-catalogs.sql and migration-2026-10-24-pos-catalogs-fn.sql first (the M1 catalog functions are missing)';
  end if;
  if pg_get_functiondef('has_menu_cap(text)'::regprocedure) not like '%manage_menu%' then
    raise exception 'STOP: has_menu_cap does not know manage_menu — re-run migration-2026-10-24-pos-catalogs.sql first';
  end if;
end $$;

-- ── Internal helpers ───────────────────────────────────────────────────────
create or replace function menu_require_editor() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('manage_menu') then
    raise exception 'Not allowed to edit the menu';
  end if;
end $$;
revoke all on function menu_require_editor() from public, anon, authenticated;

-- A name as the editor shows it: every run of whitespace (tab, newline, no-break space and the
-- other Unicode spaces, the same set as JavaScript's \s) becomes one space, then the ends are
-- trimmed. Same words and same cleaning as cleanName()/nameProblem() in
-- src/features/pos/menu/menuForms.ts, so the duplicate-name check cannot be slipped past.
create or replace function menu_clean_name(p_name text, p_what text, p_max integer) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v text := trim(regexp_replace(coalesce(p_name, ''),
              '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'));
begin
  if v = '' then raise exception '% name is required', p_what; end if;
  if length(v) > p_max then raise exception '% name is too long (at most % characters)', p_what, p_max; end if;
  return v;
end $$;
revoke all on function menu_clean_name(text, text, integer) from public, anon, authenticated;

-- A whole number of sen from 0 to 99 999 999 (RM 999 999.99), else null.
create or replace function menu_sen(p_value jsonb) returns integer
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return null; end if;
  v := (p_value #>> '{}')::numeric;
  if v < 0 or v > 99999999 or v <> trunc(v) then return null; end if;
  return v::integer;
end $$;
revoke all on function menu_sen(jsonb) from public, anon, authenticated;

-- A uuid given as a JSON string, else null (plpgsql: the cast runs only after the check).
create or replace function menu_uuid(p_value jsonb) returns uuid
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if jsonb_typeof(p_value) is distinct from 'string'
     or (p_value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return (p_value #>> '{}')::uuid;
end $$;
revoke all on function menu_uuid(jsonb) from public, anon, authenticated;

-- The key of a variant made in Craft OS. menu_variants.feedme_variant_key is unique
-- per product and '' marks the base (only) variant, whose name tickets leave out.
create or replace function menu_new_variant_key() returns text
language sql volatile set search_path = public, pg_temp as $$
  select 'cos-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
$$;
revoke all on function menu_new_variant_key() from public, anon, authenticated;

-- Spec §2: a product a catalog sells has a price there for each of its active
-- variants. Checked after every write that could break it; raises the first gap.
create or replace function menu_check_catalog_prices(p_product_id uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_missing text;
begin
  select format('%s: enter a price for %s', m.name, v.name) into v_missing
    from catalog_products cp
    join menu_catalogs m on m.id = cp.catalog_id
    join menu_variants v on v.product_id = cp.product_id and v.is_active
   where cp.product_id = p_product_id and cp.availability <> 'hidden'
     and not exists (select 1 from catalog_variant_prices cvp where cvp.catalog_id = cp.catalog_id and cvp.variant_id = v.id)
   order by m.sort_order, m.name, v.sort_order, v.name
   limit 1;
  if v_missing is not null then
    raise exception '%', v_missing;
  end if;
end $$;
revoke all on function menu_check_catalog_prices(uuid) from public, anon, authenticated;

-- ── Reads for the editor pages (one JSON value each: PostgREST's 1000-row cap
--    never cuts them short) ──────────────────────────────────────────────────
-- Categories, catalogs (with where they are used), add-on groups and add-on items.
create or replace function menu_editor_lookups() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return jsonb_build_object(
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'name', c.name, 'isActive', c.is_active, 'sortOrder', c.sort_order,
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

-- The Products page: every product (switched-off ones too) in the shape of
-- MenuProductRow (src/features/pos/menu/menuApi.ts), plus the catalogs that sell it.
create or replace function menu_product_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'is_active', p.is_active, 'is_addon', p.is_addon,
             'sst_rate_bp', p.sst_rate_bp, 'print_route', p.print_route, 'takeaway_fee_sen', p.takeaway_fee_sen,
             'sort_order', p.sort_order, 'category_id', p.category_id,
             'category', case when c.id is null then null
                              else jsonb_build_object('name', c.name, 'sort_order', c.sort_order) end,
             'menu_variants', coalesce((select jsonb_agg(jsonb_build_object(
                                                'id', v.id, 'name', v.name, 'price_sen', v.price_sen,
                                                'is_active', v.is_active, 'sort_order', v.sort_order)
                                              order by v.sort_order, v.name)
                                         from menu_variants v where v.product_id = p.id), '[]'::jsonb),
             'catalog_ids', coalesce((select jsonb_agg(cp.catalog_id)
                                       from catalog_products cp
                                      where cp.product_id = p.id and cp.availability <> 'hidden'), '[]'::jsonb))
           order by p.sort_order, p.name)
      from menu_products p
      left join menu_categories c on c.id = p.category_id), '[]'::jsonb);
end $$;
revoke all on function menu_product_list() from public, anon;
grant execute on function menu_product_list() to authenticated;

-- The product editor: the product, its variants (in order), its add-on groups (in
-- order) and one entry per catalog (every catalog; 'hidden' when it does not sell it).
create or replace function menu_product_detail(p_product_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  perform menu_require_editor();
  select jsonb_build_object(
           'id', p.id, 'name', p.name, 'internalName', p.internal_name, 'description', p.description,
           'categoryId', p.category_id, 'sstRateBp', p.sst_rate_bp, 'printRoute', p.print_route,
           'takeawayFeeSen', p.takeaway_fee_sen, 'isActive', p.is_active, 'isAddon', p.is_addon,
           'feedmeProductId', p.feedme_product_id,
           'variants', coalesce((select jsonb_agg(jsonb_build_object('id', mv.id, 'name', mv.name, 'priceSen', mv.price_sen,
                                                                     'isActive', mv.is_active)
                                                  order by mv.sort_order, mv.name)
                                   from menu_variants mv where mv.product_id = p.id), '[]'::jsonb),
           'groupIds', coalesce((select jsonb_agg(pmg.group_id order by pmg.sort_order, g.name)
                                   from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id
                                  where pmg.product_id = p.id), '[]'::jsonb),
           'catalogs', coalesce((select jsonb_agg(jsonb_build_object(
                                          'catalogId', m.id,
                                          'availability', coalesce(cp.availability, 'hidden'),
                                          'prices', coalesce((select jsonb_object_agg(cvp.variant_id::text, cvp.price_sen)
                                                                from catalog_variant_prices cvp
                                                                join menu_variants mv on mv.id = cvp.variant_id and mv.product_id = p.id
                                                               where cvp.catalog_id = m.id), '{}'::jsonb))
                                        order by m.sort_order, m.name)
                                   from menu_catalogs m
                                   left join catalog_products cp on cp.catalog_id = m.id and cp.product_id = p.id), '[]'::jsonb))
    into v
    from menu_products p
   where p.id = p_product_id;
  if v is null then
    raise exception 'Product not found';
  end if;
  return v;
end $$;
revoke all on function menu_product_detail(uuid) from public, anon;
grant execute on function menu_product_detail(uuid) to authenticated;

-- ── Save a product in one transaction (spec §4) ────────────────────────────
-- p = { id: uuid|null (null = new), name, internalName, description, categoryId,
--       sstRateBp, printRoute, takeawayFeeSen, isActive, isAddon,
--       variants: [{ ref, id: uuid|null, name, priceSen, isActive }]          (array order = order on screen)
--       groupIds: [uuid]                                                     (array order = order on screen)
--       catalogs: [{ catalogId, availability: 'all'|'counter_only'|'hidden',
--                    prices: [{ ref, priceSen }] }] }                        (ref = a variant's ref)
-- An existing variant's ref is its id; a new one's is any other string. Every
-- existing variant must be listed (switched off, never dropped). Catalogs left out
-- are not touched. For an existing product a detail key that is left out keeps its
-- stored value (the editor sends only what changed, so a save never undoes an edit
-- made meanwhile on the Products or catalog page); a new product needs them all.
-- Returns the product id.
create or replace function menu_save_product(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id       uuid;
  v_new      boolean;
  v_name     text;
  v_internal text;
  v_desc     text;
  v_cat      uuid;
  v_sst      integer;
  v_route    text;
  v_fee      integer;
  v_groups   uuid[];
  v_el       record;
  v_pr       record;
  v_vid      uuid;
  v_vname    text;
  v_price    integer;
  v_catalog  uuid;
  v_avail    text;
  v_cname    text;
  v_text     text;
  v_cur      menu_products;
  v_on       boolean;
  v_addon    boolean;
begin
  perform menu_require_editor();
  if jsonb_typeof(p) is distinct from 'object'
     or jsonb_typeof(p->'variants') is distinct from 'array'
     or jsonb_typeof(p->'groupIds') is distinct from 'array'
     or jsonb_typeof(p->'catalogs') is distinct from 'array' then
    raise exception 'Invalid product';
  end if;

  -- ── the product ──
  v_new := coalesce(jsonb_typeof(p->'id'), 'null') = 'null';
  if not v_new then
    v_id := menu_uuid(p->'id');
    select * into v_cur from menu_products where id = v_id;
    if v_id is null or not found then
      raise exception 'Product not found — refresh and try again';
    end if;
  end if;
  -- each detail: the payload's value when the key is there (always for a new product), else the stored one
  if v_new or p ? 'name' then v_name := menu_clean_name(p->>'name', 'Product', 120); else v_name := v_cur.name; end if;
  if v_new or p ? 'internalName' then
    v_internal := nullif(trim(coalesce(p->>'internalName', '')), '');
    if length(v_internal) > 120 then raise exception 'Internal name is too long (at most 120 characters)'; end if;
  else v_internal := v_cur.internal_name; end if;
  if v_new or p ? 'description' then
    v_desc := nullif(trim(coalesce(p->>'description', '')), '');
    if length(v_desc) > 1000 then raise exception 'Description is too long (at most 1000 characters)'; end if;
  else v_desc := v_cur.description; end if;
  v_cat := case when v_new or p ? 'categoryId' then menu_uuid(p->'categoryId') else v_cur.category_id end;
  if v_cat is null or not exists (select 1 from menu_categories where id = v_cat) then
    raise exception 'Choose a category';
  end if;
  if v_new or p ? 'sstRateBp' then
    v_sst := menu_sen(p->'sstRateBp');
    if v_sst is null or v_sst > 10000 then raise exception 'Invalid SST rate'; end if;
  else v_sst := v_cur.sst_rate_bp; end if;
  if v_new or p ? 'printRoute' then
    if coalesce(jsonb_typeof(p->'printRoute'), 'null') not in ('null', 'string') then raise exception 'Invalid product'; end if;
    v_route := nullif(trim(coalesce(p->>'printRoute', '')), '');
    if length(v_route) > 40 then raise exception 'Print route name is too long (at most 40 characters)'; end if;
  else v_route := v_cur.print_route; end if;
  if v_new or p ? 'takeawayFeeSen' then
    v_fee := menu_sen(p->'takeawayFeeSen');
    if v_fee is null then raise exception 'Invalid takeaway fee'; end if;
  else v_fee := v_cur.takeaway_fee_sen; end if;
  if v_new or p ? 'isActive' then
    if jsonb_typeof(p->'isActive') is distinct from 'boolean' then raise exception 'Invalid product'; end if;
    v_on := (p->>'isActive')::boolean;
  else v_on := v_cur.is_active; end if;
  if v_new or p ? 'isAddon' then
    if jsonb_typeof(p->'isAddon') is distinct from 'boolean' then raise exception 'Invalid product'; end if;
    v_addon := (p->>'isAddon')::boolean;
  else v_addon := v_cur.is_addon; end if;

  -- ── variants, in the order given ──
  if jsonb_array_length(p->'variants') > 30 then raise exception 'Too many variants (at most 30)'; end if;
  drop table if exists pg_temp._ms_var;
  create temp table pg_temp._ms_var (
    ref text primary key, id uuid unique, name text not null, price_sen integer not null,
    is_active boolean not null, sort_order integer not null
  ) on commit drop;
  for v_el in select e.v, e.ord from jsonb_array_elements(p->'variants') with ordinality as e(v, ord) loop
    if jsonb_typeof(v_el.v) <> 'object' or jsonb_typeof(v_el.v->'ref') is distinct from 'string'
       or coalesce(v_el.v->>'ref', '') = '' or jsonb_typeof(v_el.v->'isActive') is distinct from 'boolean' then
      raise exception 'Invalid product';
    end if;
    v_vid := null;
    if coalesce(jsonb_typeof(v_el.v->'id'), 'null') <> 'null' then
      v_vid := menu_uuid(v_el.v->'id');
      if v_vid is null or v_new or not exists (select 1 from menu_variants where id = v_vid and product_id = v_id) then
        raise exception 'Variant not found — refresh and try again';
      end if;
    end if;
    v_vname := menu_clean_name(v_el.v->>'name', 'Variant', 60);
    v_price := menu_sen(v_el.v->'priceSen');
    if v_price is null then raise exception 'Invalid default price for %', v_vname; end if;
    begin
      insert into pg_temp._ms_var(ref, id, name, price_sen, is_active, sort_order)
      values (v_el.v->>'ref', v_vid, v_vname, v_price, (v_el.v->>'isActive')::boolean, v_el.ord - 1);
    exception when unique_violation then
      raise exception 'Invalid product';                       -- a ref or a variant id twice
    end;
  end loop;
  if not v_new and exists (select 1 from menu_variants mv where mv.product_id = v_id
                             and not exists (select 1 from pg_temp._ms_var t where t.id = mv.id)) then
    raise exception 'The product changed since you opened it — refresh and try again';
  end if;
  if not exists (select 1 from pg_temp._ms_var where is_active) then
    raise exception 'A product needs at least one active variant';
  end if;
  select t.name into v_text from pg_temp._ms_var t
   where t.is_active and lower(t.name) in (select lower(x.name) from pg_temp._ms_var x where x.is_active
                                            group by lower(x.name) having count(*) > 1)
   order by t.sort_order limit 1;                              -- the first of the twins, as the editor names it
  if v_text is not null then raise exception 'Two variants are called %', v_text; end if;

  -- ── add-on groups, in the order given ──
  if jsonb_array_length(p->'groupIds') > 30 then raise exception 'Too many add-on groups (at most 30)'; end if;
  if exists (select 1 from jsonb_array_elements(p->'groupIds') g where menu_uuid(g) is null) then
    raise exception 'Invalid product';
  end if;
  select coalesce(array_agg(menu_uuid(g.v) order by g.ord), '{}') into v_groups
    from jsonb_array_elements(p->'groupIds') with ordinality as g(v, ord);
  if cardinality(v_groups) <> (select count(distinct u) from unnest(v_groups) u) then
    raise exception 'An add-on group is linked twice';
  end if;
  if exists (select 1 from unnest(v_groups) u where not exists (select 1 from modifier_groups g where g.id = u)) then
    raise exception 'Add-on group not found — refresh and try again';
  end if;

  -- ── catalogs: availability and prices ──
  drop table if exists pg_temp._ms_cat;
  create temp table pg_temp._ms_cat (catalog_id uuid primary key, availability text not null) on commit drop;
  drop table if exists pg_temp._ms_price;
  create temp table pg_temp._ms_price (
    catalog_id uuid not null, ref text not null, price_sen integer not null, primary key (catalog_id, ref)
  ) on commit drop;
  for v_el in select e.v from jsonb_array_elements(p->'catalogs') as e(v) loop
    if jsonb_typeof(v_el.v) <> 'object' or jsonb_typeof(v_el.v->'prices') is distinct from 'array' then
      raise exception 'Invalid product';
    end if;
    v_catalog := menu_uuid(v_el.v->'catalogId');
    select name into v_cname from menu_catalogs where id = v_catalog;
    if v_cname is null then raise exception 'Catalog not found — refresh and try again'; end if;
    v_avail := v_el.v->>'availability';
    if v_avail is null or v_avail not in ('all', 'counter_only', 'hidden') then
      raise exception 'Invalid availability';
    end if;
    begin
      insert into pg_temp._ms_cat(catalog_id, availability) values (v_catalog, v_avail);
    exception when unique_violation then
      raise exception 'Invalid product';                       -- a catalog twice
    end;
    for v_pr in select x.v from jsonb_array_elements(v_el.v->'prices') as x(v) loop
      if jsonb_typeof(v_pr.v) <> 'object'
         or not exists (select 1 from pg_temp._ms_var t where t.ref = v_pr.v->>'ref') then
        raise exception 'Invalid product';
      end if;
      v_price := menu_sen(v_pr.v->'priceSen');
      if v_price is null then
        raise exception '%: invalid price for %', v_cname, (select t.name from pg_temp._ms_var t where t.ref = v_pr.v->>'ref');
      end if;
      begin
        insert into pg_temp._ms_price(catalog_id, ref, price_sen) values (v_catalog, v_pr.v->>'ref', v_price);
      exception when unique_violation then
        raise exception 'Invalid product';                     -- a variant priced twice in one catalog
      end;
    end loop;
  end loop;

  -- ── write: the product ──
  if v_new then
    insert into menu_products(name, internal_name, description, category_id, sst_rate_bp, print_route,
                              takeaway_fee_sen, is_active, is_addon, sort_order)
    values (v_name, v_internal, v_desc, v_cat, v_sst, v_route, v_fee, v_on, v_addon,
            coalesce((select max(sort_order) + 1 from menu_products), 0))
    returning id into v_id;
  else
    update menu_products
       set name = v_name, internal_name = v_internal, description = v_desc, category_id = v_cat,
           sst_rate_bp = v_sst, print_route = v_route, takeaway_fee_sen = v_fee,
           is_active = v_on, is_addon = v_addon, updated_at = now()
     where id = v_id;
  end if;

  -- ── write: variants. Existing ones keep their key; a new product sold in one variant
  --    gets the base ('') key for it, every other new variant a 'cos-…' key ──
  update menu_variants mv
     set name = t.name, price_sen = t.price_sen, sort_order = t.sort_order, is_active = t.is_active
    from pg_temp._ms_var t
   where t.id is not null and mv.id = t.id;
  for v_el in select t.ref, t.name, t.price_sen, t.is_active, t.sort_order
                from pg_temp._ms_var t where t.id is null order by t.sort_order loop
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order, is_active)
    values (v_id,
            case when v_new and v_el.is_active and (select count(*) from pg_temp._ms_var where is_active) = 1
                 then '' else menu_new_variant_key() end,
            v_el.name, v_el.price_sen, v_el.sort_order, v_el.is_active)
    returning id into v_vid;
    update pg_temp._ms_var set id = v_vid where ref = v_el.ref;
  end loop;
  -- a product sold in more than one variant has no base variant: tickets must name each one
  if (select count(*) from menu_variants where product_id = v_id and is_active) > 1 then
    update menu_variants set feedme_variant_key = menu_new_variant_key()
     where product_id = v_id and is_active and feedme_variant_key = '';
  end if;

  -- ── write: add-on group links (configuration: a removed link is deleted) ──
  delete from product_modifier_groups where product_id = v_id and not (group_id = any (v_groups));
  insert into product_modifier_groups(product_id, group_id, sort_order)
  select v_id, g.id, g.ord - 1 from unnest(v_groups) with ordinality as g(id, ord)
  on conflict (product_id, group_id) do update set sort_order = excluded.sort_order;

  -- ── write: catalogs. Out of a catalog = 'hidden'; the row and its prices stay ──
  update catalog_products cp set availability = c.availability
    from pg_temp._ms_cat c
   where cp.catalog_id = c.catalog_id and cp.product_id = v_id;
  insert into catalog_products(catalog_id, product_id, availability, sort_order)
  select c.catalog_id, v_id, c.availability,
         coalesce((select max(x.sort_order) + 1 from catalog_products x where x.catalog_id = c.catalog_id), 0)
    from pg_temp._ms_cat c
   where c.availability <> 'hidden'
     and not exists (select 1 from catalog_products cp where cp.catalog_id = c.catalog_id and cp.product_id = v_id);
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
  select pr.catalog_id, t.id, pr.price_sen
    from pg_temp._ms_price pr join pg_temp._ms_var t on t.ref = pr.ref
  on conflict (catalog_id, variant_id) do update set price_sen = excluded.price_sen;

  -- every catalog that sells it (listed or not) prices every active variant
  perform menu_check_catalog_prices(v_id);
  return v_id;
end $$;
revoke all on function menu_save_product(jsonb) from public, anon;
grant execute on function menu_save_product(jsonb) to authenticated;

-- ── Add-on groups ──────────────────────────────────────────────────────────
-- The group editor: the group, its options in order (each with its per-catalog
-- price overrides) and the active products that use it.
create or replace function menu_group_detail(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  perform menu_require_editor();
  select jsonb_build_object(
           'id', g.id, 'name', g.name, 'min', g.min_select, 'max', g.max_select, 'stackable', g.stackable,
           'isActive', g.is_active, 'feedmeGroupId', g.feedme_group_id,
           'options', coalesce((select jsonb_agg(jsonb_build_object(
                                         'id', o.id, 'name', o.name, 'priceDeltaSen', o.price_delta_sen,
                                         'productId', o.product_id, 'isDefault', o.is_default, 'availability', o.availability,
                                         'catalogPrices', coalesce((select jsonb_object_agg(cop.catalog_id::text, cop.price_delta_sen)
                                                                      from catalog_option_prices cop
                                                                     where cop.option_id = o.id), '{}'::jsonb))
                                       order by o.sort_order, o.name)
                                  from modifier_options o where o.group_id = g.id), '[]'::jsonb),
           'usedBy', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name)
                                 from product_modifier_groups pmg
                                 join menu_products p on p.id = pmg.product_id and p.is_active
                                where pmg.group_id = g.id), '[]'::jsonb))
    into v
    from modifier_groups g
   where g.id = p_group_id;
  if v is null then
    raise exception 'Add-on group not found';
  end if;
  return v;
end $$;
revoke all on function menu_group_detail(uuid) from public, anon;
grant execute on function menu_group_detail(uuid) to authenticated;

-- p = { id: uuid|null, name, min, max, stackable, isActive,
--       options: [{ ref, id: uuid|null, name, priceDeltaSen, productId: uuid|null, isDefault,
--                   availability: 'all'|'counter_only'|'hidden' }]           (array order = order on screen)
--       catalogPrices: [{ catalogId, ref, priceDeltaSen }] }                 (every override the group keeps)
-- An option is never deleted (order snapshots name it): 'hidden' switches it off.
-- A catalog override that is not listed any more is removed (the option's own price
-- applies again). Returns the group id.
create or replace function menu_save_group(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id      uuid;
  v_new     boolean;
  v_name    text;
  v_min     integer;
  v_max     integer;
  v_on      integer;
  v_el      record;
  v_oid     uuid;
  v_oname   text;
  v_price   integer;
  v_prod    uuid;
  v_avail   text;
  v_key     text;
  v_catalog uuid;
  v_cname   text;
  v_text    text;
begin
  perform menu_require_editor();
  if jsonb_typeof(p) is distinct from 'object'
     or jsonb_typeof(p->'options') is distinct from 'array'
     or jsonb_typeof(p->'catalogPrices') is distinct from 'array'
     or jsonb_typeof(p->'stackable') is distinct from 'boolean'
     or jsonb_typeof(p->'isActive') is distinct from 'boolean' then
    raise exception 'Invalid add-on group';
  end if;
  v_new := coalesce(jsonb_typeof(p->'id'), 'null') = 'null';
  if not v_new then
    v_id := menu_uuid(p->'id');
    if v_id is null or not exists (select 1 from modifier_groups where id = v_id) then
      raise exception 'Add-on group not found — refresh and try again';
    end if;
  end if;
  v_name := menu_clean_name(p->>'name', 'Add-on group', 80);
  v_min := menu_sen(p->'min');
  if v_min is null or v_min > 99 then raise exception 'Min must be a whole number from 0 to 99'; end if;
  v_max := menu_sen(p->'max');
  if v_max is null or v_max < 1 or v_max > 99 then raise exception 'Max must be a whole number from 1 to 99'; end if;
  if v_min > v_max then raise exception 'Min cannot be more than max'; end if;

  -- ── options, in the order given ──
  if jsonb_array_length(p->'options') > 100 then raise exception 'Too many options (at most 100)'; end if;
  drop table if exists pg_temp._mg_opt;
  create temp table pg_temp._mg_opt (
    ref text primary key, id uuid unique, name text not null, price_sen integer not null, product_id uuid,
    variant_key text not null, is_default boolean not null, availability text not null, sort_order integer not null
  ) on commit drop;
  for v_el in select e.v, e.ord from jsonb_array_elements(p->'options') with ordinality as e(v, ord) loop
    if jsonb_typeof(v_el.v) <> 'object' or jsonb_typeof(v_el.v->'ref') is distinct from 'string'
       or coalesce(v_el.v->>'ref', '') = '' or jsonb_typeof(v_el.v->'isDefault') is distinct from 'boolean' then
      raise exception 'Invalid add-on group';
    end if;
    v_oid := null;
    v_key := '';
    if coalesce(jsonb_typeof(v_el.v->'id'), 'null') <> 'null' then
      v_oid := menu_uuid(v_el.v->'id');
      if v_oid is null or v_new or not exists (select 1 from modifier_options where id = v_oid and group_id = v_id) then
        raise exception 'Option not found — refresh and try again';
      end if;
    end if;
    v_oname := menu_clean_name(v_el.v->>'name', 'Option', 80);
    v_price := menu_sen(v_el.v->'priceDeltaSen');
    if v_price is null then raise exception 'Invalid price for %', v_oname; end if;
    v_prod := null;
    if coalesce(jsonb_typeof(v_el.v->'productId'), 'null') <> 'null' then
      v_prod := menu_uuid(v_el.v->'productId');
      if v_prod is null or not exists (select 1 from menu_products where id = v_prod) then
        raise exception 'Add-on item not found — refresh and try again';
      end if;
    end if;
    -- an option keeps its add-on variant key while it keeps its add-on item
    if v_oid is not null then
      select o.feedme_variant_key into v_key from modifier_options o
       where o.id = v_oid and o.product_id is not distinct from v_prod;
      v_key := coalesce(v_key, '');
    end if;
    v_avail := v_el.v->>'availability';
    if v_avail is null or v_avail not in ('all', 'counter_only', 'hidden') then
      raise exception 'Invalid availability';
    end if;
    begin
      insert into pg_temp._mg_opt(ref, id, name, price_sen, product_id, variant_key, is_default, availability, sort_order)
      values (v_el.v->>'ref', v_oid, v_oname, v_price, v_prod, v_key, (v_el.v->>'isDefault')::boolean, v_avail, v_el.ord - 1);
    exception when unique_violation then
      raise exception 'Invalid add-on group';                  -- a ref or an option id twice
    end;
  end loop;
  if not v_new and exists (select 1 from modifier_options o where o.group_id = v_id
                             and not exists (select 1 from pg_temp._mg_opt t where t.id = o.id)) then
    raise exception 'The add-on group changed since you opened it — refresh and try again';
  end if;
  select mp.name into v_text
    from pg_temp._mg_opt t join menu_products mp on mp.id = t.product_id
   group by mp.name, t.product_id, t.variant_key having count(*) > 1
   order by mp.name limit 1;
  if v_text is not null then raise exception 'Two options use the same add-on item: %', v_text; end if;
  select t.name into v_text from pg_temp._mg_opt t where t.is_default and t.availability = 'hidden'
   order by t.sort_order limit 1;
  if v_text is not null then raise exception 'A switched-off option cannot be the default: %', v_text; end if;
  if (select count(*) from pg_temp._mg_opt where is_default) > v_max then
    raise exception 'At most % % the default', v_max, case when v_max = 1 then 'option can be' else 'options can be' end;
  end if;
  select count(*) into v_on from pg_temp._mg_opt where availability <> 'hidden';
  if (p->>'isActive')::boolean and v_min > v_on then
    raise exception 'Min is % but only % % on', v_min, v_on, case when v_on = 1 then 'option is' else 'options are' end;
  end if;

  -- ── catalog overrides ──
  drop table if exists pg_temp._mg_price;
  create temp table pg_temp._mg_price (
    catalog_id uuid not null, ref text not null, price_sen integer not null, primary key (catalog_id, ref)
  ) on commit drop;
  for v_el in select e.v from jsonb_array_elements(p->'catalogPrices') as e(v) loop
    if jsonb_typeof(v_el.v) <> 'object'
       or not exists (select 1 from pg_temp._mg_opt t where t.ref = v_el.v->>'ref') then
      raise exception 'Invalid add-on group';
    end if;
    v_catalog := menu_uuid(v_el.v->'catalogId');
    select name into v_cname from menu_catalogs where id = v_catalog;
    if v_cname is null then raise exception 'Catalog not found — refresh and try again'; end if;
    v_price := menu_sen(v_el.v->'priceDeltaSen');
    if v_price is null then
      raise exception '%: invalid price for %', v_cname, (select t.name from pg_temp._mg_opt t where t.ref = v_el.v->>'ref');
    end if;
    begin
      insert into pg_temp._mg_price(catalog_id, ref, price_sen) values (v_catalog, v_el.v->>'ref', v_price);
    exception when unique_violation then
      raise exception 'Invalid add-on group';                  -- an option priced twice in one catalog
    end;
  end loop;

  -- ── write: the group ──
  if v_new then
    insert into modifier_groups(name, min_select, max_select, stackable, is_active, sort_order)
    values (v_name, v_min, v_max, (p->>'stackable')::boolean, (p->>'isActive')::boolean,
            coalesce((select max(sort_order) + 1 from modifier_groups), 0))
    returning id into v_id;
  else
    update modifier_groups
       set name = v_name, min_select = v_min, max_select = v_max,
           stackable = (p->>'stackable')::boolean, is_active = (p->>'isActive')::boolean
     where id = v_id;
  end if;

  -- ── write: options ──
  begin
    update modifier_options o
       set name = t.name, price_delta_sen = t.price_sen, product_id = t.product_id, feedme_variant_key = t.variant_key,
           is_default = t.is_default, availability = t.availability, sort_order = t.sort_order
      from pg_temp._mg_opt t
     where t.id is not null and o.id = t.id;
    for v_el in select t.ref, t.name, t.price_sen, t.product_id, t.variant_key, t.is_default, t.availability, t.sort_order
                  from pg_temp._mg_opt t where t.id is null order by t.sort_order loop
      insert into modifier_options(group_id, product_id, feedme_variant_key, name, price_delta_sen, is_default, availability, sort_order)
      values (v_id, v_el.product_id, v_el.variant_key, v_el.name, v_el.price_sen, v_el.is_default, v_el.availability, v_el.sort_order)
      returning id into v_oid;
      update pg_temp._mg_opt set id = v_oid where ref = v_el.ref;
    end loop;
  exception when unique_violation then
    raise exception 'Two options use the same add-on item — change one and save again';
  end;

  -- ── write: catalog overrides (the listed ones are the whole set) ──
  delete from catalog_option_prices cop
   where cop.option_id in (select o.id from modifier_options o where o.group_id = v_id)
     and not exists (select 1 from pg_temp._mg_price x join pg_temp._mg_opt t on t.ref = x.ref
                      where x.catalog_id = cop.catalog_id and t.id = cop.option_id);
  insert into catalog_option_prices(catalog_id, option_id, price_delta_sen)
  select x.catalog_id, t.id, x.price_sen
    from pg_temp._mg_price x join pg_temp._mg_opt t on t.ref = x.ref
  on conflict (catalog_id, option_id) do update set price_delta_sen = excluded.price_delta_sen;
  return v_id;
end $$;
revoke all on function menu_save_group(jsonb) from public, anon;
grant execute on function menu_save_group(jsonb) to authenticated;

-- ── Catalogs ───────────────────────────────────────────────────────────────
-- Create (p_id null) or rename. The Feedme name a catalog was imported under is
-- kept, so a re-import still finds it (and leaves the new name alone).
create or replace function menu_save_catalog(p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text;
  v_id   uuid;
begin
  perform menu_require_editor();
  v_name := menu_clean_name(p_name, 'Catalog', 60);
  if exists (select 1 from menu_catalogs where lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'A catalog called % already exists', v_name;
  end if;
  if p_id is null then
    insert into menu_catalogs(name, sort_order)
    values (v_name, coalesce((select max(sort_order) + 1 from menu_catalogs), 0))
    returning id into v_id;
  else
    update menu_catalogs set name = v_name where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Catalog not found — refresh and try again'; end if;
  end if;
  return v_id;
end $$;
revoke all on function menu_save_catalog(uuid, text) from public, anon;
grant execute on function menu_save_catalog(uuid, text) to authenticated;

-- A new active catalog with the source's products (hidden ones too), variant prices
-- and add-on price overrides. Not linked to Feedme, not assigned to any branch.
create or replace function menu_duplicate_catalog(p_source_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  perform menu_require_editor();
  if not exists (select 1 from menu_catalogs where id = p_source_id) then
    raise exception 'Catalog not found — refresh and try again';
  end if;
  v_id := menu_save_catalog(null, p_name);
  insert into catalog_products(catalog_id, product_id, availability, sort_order)
  select v_id, cp.product_id, cp.availability, cp.sort_order from catalog_products cp where cp.catalog_id = p_source_id;
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
  select v_id, cvp.variant_id, cvp.price_sen from catalog_variant_prices cvp where cvp.catalog_id = p_source_id;
  insert into catalog_option_prices(catalog_id, option_id, price_delta_sen)
  select v_id, cop.option_id, cop.price_delta_sen from catalog_option_prices cop where cop.catalog_id = p_source_id;
  return v_id;
end $$;
revoke all on function menu_duplicate_catalog(uuid, text) from public, anon;
grant execute on function menu_duplicate_catalog(uuid, text) to authenticated;

-- The new order of every catalog (each id exactly once).
create or replace function menu_reorder_catalogs(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_ids is null
     or cardinality(p_ids) <> (select count(distinct u) from unnest(p_ids) u)
     or cardinality(p_ids) <> (select count(*) from menu_catalogs)
     or exists (select 1 from unnest(p_ids) u where not exists (select 1 from menu_catalogs m where m.id = u)) then
    raise exception 'The catalog list changed — refresh and try again';
  end if;
  update menu_catalogs m set sort_order = x.ord - 1
    from unnest(p_ids) with ordinality as x(id, ord)
   where m.id = x.id;
end $$;
revoke all on function menu_reorder_catalogs(uuid[]) from public, anon;
grant execute on function menu_reorder_catalogs(uuid[]) to authenticated;

-- Switch a catalog off or on. A catalog that an active branch uses for dine-in,
-- takeaway or QR cannot be switched off (that branch could not take those orders).
create or replace function menu_set_catalog_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text;
  v_use  text;
begin
  perform menu_require_editor();
  if p_active is null then raise exception 'Invalid catalog'; end if;
  select name into v_name from menu_catalogs where id = p_id;
  if v_name is null then raise exception 'Catalog not found — refresh and try again'; end if;
  if not p_active then
    select format('%s is the %s catalog of %s — choose another in POS settings first', v_name,
                  case bc.role when 'dine_in' then 'dine-in' when 'takeaway' then 'takeaway' else 'QR' end, b.name)
      into v_use
      from branch_catalogs bc join branches b on b.id = bc.branch_id and coalesce(b.is_active, true)
     where bc.catalog_id = p_id and bc.role <> 'additional'
     order by b.name, bc.role
     limit 1;
    if v_use is not null then raise exception '%', v_use; end if;
  end if;
  update menu_catalogs set is_active = p_active where id = p_id;
end $$;
revoke all on function menu_set_catalog_active(uuid, boolean) from public, anon;
grant execute on function menu_set_catalog_active(uuid, boolean) to authenticated;

-- The catalog page: every active product that is not an add-on item, in category
-- order, with its availability in this catalog and each variant's default and
-- catalog price (null = no price in this catalog).
create or replace function menu_catalog_grid(p_catalog_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cat menu_catalogs;
begin
  perform menu_require_editor();
  select * into v_cat from menu_catalogs where id = p_catalog_id;
  if not found then raise exception 'Catalog not found'; end if;
  return jsonb_build_object(
    'catalog', jsonb_build_object('id', v_cat.id, 'name', v_cat.name, 'isActive', v_cat.is_active),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name,
               'category', coalesce(c.name, 'Uncategorised'), 'categorySort', coalesce(c.sort_order, 9999),
               'availability', coalesce(cp.availability, 'hidden'),
               'variants', coalesce((select jsonb_agg(jsonb_build_object(
                                              'id', v.id, 'name', v.name, 'isActive', v.is_active,
                                              'defaultSen', v.price_sen, 'priceSen', cvp.price_sen)
                                            order by v.sort_order, v.name)
                                       from menu_variants v
                                       left join catalog_variant_prices cvp on cvp.catalog_id = p_catalog_id and cvp.variant_id = v.id
                                      where v.product_id = p.id), '[]'::jsonb))
             order by coalesce(c.sort_order, 9999), coalesce(c.name, 'Uncategorised'), coalesce(cp.sort_order, p.sort_order), p.name)
        from menu_products p
        left join menu_categories c on c.id = p.category_id
        left join catalog_products cp on cp.catalog_id = p_catalog_id and cp.product_id = p.id
       where p.is_active and not p.is_addon), '[]'::jsonb));
end $$;
revoke all on function menu_catalog_grid(uuid) from public, anon;
grant execute on function menu_catalog_grid(uuid) to authenticated;

-- One row of the catalog page: p = { catalogId, productId, availability,
-- prices: [{ variantId, priceSen }] }. Same rule as the product editor.
create or replace function menu_save_catalog_row(p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_catalog uuid;
  v_product uuid;
  v_avail   text;
  v_cname   text;
  v_el      record;
  v_vid     uuid;
  v_vname   text;
  v_price   integer;
begin
  perform menu_require_editor();
  if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'prices') is distinct from 'array' then
    raise exception 'Invalid catalog row';
  end if;
  v_catalog := menu_uuid(p->'catalogId');
  select name into v_cname from menu_catalogs where id = v_catalog;
  if v_cname is null then raise exception 'Catalog not found — refresh and try again'; end if;
  v_product := menu_uuid(p->'productId');
  if v_product is null or not exists (select 1 from menu_products where id = v_product and is_active) then
    raise exception 'Product not found — refresh and try again';
  end if;
  v_avail := p->>'availability';
  if v_avail is null or v_avail not in ('all', 'counter_only', 'hidden') then
    raise exception 'Invalid availability';
  end if;
  if (select count(*) from jsonb_array_elements(p->'prices'))
     <> (select count(distinct x->>'variantId') from jsonb_array_elements(p->'prices') x) then
    raise exception 'Invalid catalog row';
  end if;
  for v_el in select e.v from jsonb_array_elements(p->'prices') as e(v) loop
    v_vid := menu_uuid(v_el.v->'variantId');
    select name into v_vname from menu_variants where id = v_vid and product_id = v_product;
    if v_vname is null then raise exception 'Variant not found — refresh and try again'; end if;
    v_price := menu_sen(v_el.v->'priceSen');
    if v_price is null then raise exception '%: invalid price for %', v_cname, v_vname; end if;
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_vid, v_price)
    on conflict (catalog_id, variant_id) do update set price_sen = excluded.price_sen;
  end loop;
  update catalog_products set availability = v_avail where catalog_id = v_catalog and product_id = v_product;
  if not found and v_avail <> 'hidden' then
    insert into catalog_products(catalog_id, product_id, availability, sort_order)
    values (v_catalog, v_product, v_avail,
            coalesce((select max(x.sort_order) + 1 from catalog_products x where x.catalog_id = v_catalog), 0));
  end if;
  perform menu_check_catalog_prices(v_product);
end $$;
revoke all on function menu_save_catalog_row(jsonb) from public, anon;
grant execute on function menu_save_catalog_row(jsonb) to authenticated;

-- ── Categories ─────────────────────────────────────────────────────────────
-- Create (p_id null) or rename. (A re-import matches categories by name: it brings
-- a renamed Feedme category back under its old name.)
create or replace function menu_save_category(p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text;
  v_id   uuid;
begin
  perform menu_require_editor();
  v_name := menu_clean_name(p_name, 'Category', 60);
  if exists (select 1 from menu_categories where lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'A category called % already exists', v_name;
  end if;
  if p_id is null then
    insert into menu_categories(name, sort_order)
    values (v_name, coalesce((select max(sort_order) + 1 from menu_categories), 0))
    returning id into v_id;
  else
    update menu_categories set name = v_name where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Category not found — refresh and try again'; end if;
  end if;
  return v_id;
end $$;
revoke all on function menu_save_category(uuid, text) from public, anon;
grant execute on function menu_save_category(uuid, text) to authenticated;

create or replace function menu_reorder_categories(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_ids is null
     or cardinality(p_ids) <> (select count(distinct u) from unnest(p_ids) u)
     or cardinality(p_ids) <> (select count(*) from menu_categories)
     or exists (select 1 from unnest(p_ids) u where not exists (select 1 from menu_categories c where c.id = u)) then
    raise exception 'The category list changed — refresh and try again';
  end if;
  update menu_categories c set sort_order = x.ord - 1
    from unnest(p_ids) with ordinality as x(id, ord)
   where c.id = x.id;
end $$;
revoke all on function menu_reorder_categories(uuid[]) from public, anon;
grant execute on function menu_reorder_categories(uuid[]) to authenticated;

-- A switched-off category takes its products off the counter (pos_menu_rows) and
-- the QR page (qr_menu); they stay in their catalogs and come back when it is on.
create or replace function menu_set_category_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_active is null then raise exception 'Invalid category'; end if;
  update menu_categories set is_active = p_active where id = p_id;
  if not found then raise exception 'Category not found — refresh and try again'; end if;
end $$;
revoke all on function menu_set_category_active(uuid, boolean) from public, anon;
grant execute on function menu_set_category_active(uuid, boolean) to authenticated;

-- ── The order pad's menu in one read ───────────────────────────────────────
-- The rows buildPosMenu (src/features/pos/order/cart.ts) takes, for one catalog,
-- as one JSON value (PostgREST's 1000-row cap cut the flat reads short past 1000
-- links or prices). Products of switched-off categories are left out, as on QR.
-- Live staff with a branch only (pos_my_branch); sold-out is the caller's branch.
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
                                else jsonb_build_object('name', c.name, 'sort_order', c.sort_order) end,
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

-- PostgREST picks up the new functions now, not at its next poll
notify pgrst, 'reload schema';

select 'menu editor functions applied' as result;
