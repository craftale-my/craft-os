-- ============================================================================
-- Craft OS — POS menu catalogs · M1 functions (2026-10-24). Run on craft-os-dev
-- after migration-2026-10-24-pos-catalogs.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m1.md
-- Design: docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md §3, §6
--
-- Canonical from here on: pos_insert_order (now 9 arguments), place_counter_order
-- (now 6, the last defaulting to null), place_table_order, qr_menu and menu_import.
-- Each is the live text (pos_insert_order / place_counter_order / place_table_order
-- from migration-2026-10-24-pos-checkout-fn.sql, qr_menu from
-- migration-2026-10-23-pos-ordering-fn.sql, menu_import from
-- migration-2026-10-22-pos-menu-import-fn.sql) with only the lines marked "M1"
-- changed. Re-running one of those files afterwards brings the old body back (for
-- pos_insert_order / place_counter_order as a second, old-signature function next
-- to the new one) — re-run this file afterwards.
-- ============================================================================

do $$ begin
  if to_regclass('public.branch_catalogs') is null or to_regprocedure('pos_caller_branch()') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-catalogs.sql first (branch_catalogs is missing)';
  end if;
end $$;

-- ── Which catalog prices an order ──────────────────────────────────────────
-- The branch's catalog for the order's role (dine_in / takeaway; qr for QR orders)
-- when none is asked for or the default itself is asked for; at the counter also
-- one of the branch's 'additional' catalogs. Active catalogs only. Internal.
create or replace function pos_order_catalog(p_branch_id uuid, p_order_type text, p_source text, p_catalog_id uuid)
returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_role    text := case when p_source = 'qr' then 'qr' else p_order_type end;
  v_default uuid;
  v_active  boolean;
begin
  select bc.catalog_id, m.is_active into v_default, v_active
    from branch_catalogs bc join menu_catalogs m on m.id = bc.catalog_id
   where bc.branch_id = p_branch_id and bc.role = v_role;
  if p_catalog_id is null or p_catalog_id = v_default then
    if v_default is null then
      raise exception 'No menu catalog is set for % — set it in POS settings',
        case v_role when 'dine_in' then 'dine-in' when 'takeaway' then 'takeaway' else 'QR' end;
    end if;
    if not v_active then
      raise exception 'This catalog is not available at this branch';
    end if;
    return v_default;
  end if;
  if p_source = 'counter' and exists (
       select 1 from branch_catalogs bc join menu_catalogs m on m.id = bc.catalog_id and m.is_active
        where bc.branch_id = p_branch_id and bc.role = 'additional' and bc.catalog_id = p_catalog_id) then
    return p_catalog_id;
  end if;
  raise exception 'This catalog is not available at this branch';
end $$;
revoke all on function pos_order_catalog(uuid, text, text, uuid) from public, anon, authenticated;

-- ── The old signatures go: PostgREST must see one place_counter_order only ──
drop function if exists place_counter_order(uuid, text, integer, jsonb, uuid);
drop function if exists pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid);

-- ── pos_insert_order, re-created: the order's catalog decides what sells and
--    at what price; orders.catalog_id records it ─────────────────────────────
create or replace function pos_insert_order(
  p_branch_id uuid, p_table_id uuid, p_order_type text, p_pax integer,
  p_source text, p_placed_by uuid, p_items jsonb, p_client_order_id uuid,
  p_catalog_id uuid                     -- M1: the catalog asked for; null = the branch's default for this order
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing   uuid;
  v_bill_id    uuid;
  v_bill_no    text;
  v_order_id   uuid;
  v_order_no   text;
  v_label      text;
  v_item       jsonb;
  v_opt_id     uuid;
  v_opt_ids    uuid[];
  v_prod       menu_products;
  v_var        menu_variants;
  v_opt_row    record;
  v_grp        record;
  v_qty        numeric;
  v_n          integer;
  v_price      integer;
  v_mods       jsonb;
  v_allowed    text[] := case when p_source = 'qr' then array['all'] else array['all', 'counter_only'] end;
  v_catalog    uuid;                    -- M1
  v_avail      text;                    -- M1
  v_unit       integer;                 -- M1
begin
  if p_client_order_id is null then
    raise exception 'Order id is missing';
  end if;
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then
    return v_existing;                         -- resend: already in
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order has no items';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'Too many items in one order';
  end if;
  if p_order_type is null or p_order_type not in ('dine_in', 'takeaway') then
    raise exception 'Invalid order type';
  end if;
  if (p_order_type = 'dine_in') <> (p_table_id is not null) then
    raise exception 'Dine-in orders need a table; takeaway orders have none';
  end if;
  if p_pax is not null and (p_pax < 1 or p_pax > 99) then
    raise exception 'Invalid number of guests';
  end if;
  -- M1: the catalog this order is priced from; refuses one the branch does not offer for it
  v_catalog := pos_order_catalog(p_branch_id, p_order_type, p_source, p_catalog_id);

  -- ── validate every line before writing anything (bad input is always P0001 = final) ──
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item->'productId') is distinct from 'string'
       or jsonb_typeof(v_item->'variantId') is distinct from 'string'
       or (v_item->>'productId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (v_item->>'variantId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid item';
    end if;
    -- M1: the product must be in the catalog with an availability this source may order
    --     (menu_products.availability is no longer read)
    v_avail := null;
    select * into v_prod from menu_products
     where id = (v_item->>'productId')::uuid and is_active and not is_addon;
    if found then
      select cp.availability into v_avail from catalog_products cp
       where cp.catalog_id = v_catalog and cp.product_id = v_prod.id;
    end if;
    if v_avail is null or not (v_avail = any (v_allowed)) then
      raise exception 'Item is not available: %', coalesce(v_prod.name, v_item->>'productId');
    end if;
    if exists (select 1 from branch_menu_status s
                where s.branch_id = p_branch_id and s.product_id = v_prod.id and s.is_sold_out) then
      raise exception 'Sold out: %', v_prod.name;
    end if;
    select * into v_var from menu_variants
     where id = (v_item->>'variantId')::uuid and product_id = v_prod.id and is_active;
    -- M1: ...and the catalog must have a price for this variant
    if not found or not exists (select 1 from catalog_variant_prices cvp
                                 where cvp.catalog_id = v_catalog and cvp.variant_id = v_var.id) then
      raise exception 'Item is not available: %', v_prod.name;
    end if;
    if v_item->'qty' is not null then
      if jsonb_typeof(v_item->'qty') <> 'number' then raise exception 'Invalid quantity'; end if;
      v_qty := (v_item->'qty')::numeric;
      if v_qty < 1 or v_qty > 20 or v_qty <> trunc(v_qty) then raise exception 'Invalid quantity'; end if;
    end if;
    if v_item->'optionIds' is not null and jsonb_typeof(v_item->'optionIds') <> 'array' then
      raise exception 'Invalid add-ons';
    end if;
    -- each option must be a well-formed uuid string, appear once (compared as uuids, so
    -- letter case cannot sneak a duplicate past), belong to a group linked to this
    -- product, and be orderable here
    if exists (select 1 from jsonb_array_elements(coalesce(v_item->'optionIds', '[]'::jsonb)) e
                where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'Invalid add-ons';
    end if;
    select coalesce(array_agg(x.v::uuid), '{}') into v_opt_ids
      from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) as x(v);
    if cardinality(v_opt_ids) <> (select count(distinct u) from unnest(v_opt_ids) u) then
      raise exception 'Invalid add-ons';
    end if;
    foreach v_opt_id in array v_opt_ids loop
      select o.id, o.name, o.availability, o.product_id, g.name as group_name into v_opt_row
        from modifier_options o
        join modifier_groups g on g.id = o.group_id and g.is_active
        join product_modifier_groups pmg on pmg.group_id = g.id and pmg.product_id = v_prod.id
       where o.id = v_opt_id;
      if not found then
        raise exception 'Add-on is not available for %', v_prod.name;
      end if;
      if not (v_opt_row.availability = any (v_allowed))
         or exists (select 1 from branch_menu_status s
                     where s.branch_id = p_branch_id and s.product_id = v_opt_row.product_id and s.is_sold_out) then
        raise exception 'Sold out: %', v_opt_row.name;
      end if;
    end loop;
    -- per linked group: min..max
    for v_grp in
      select g.name, g.min_select, g.max_select,
             (select count(*) from modifier_options o
               where o.group_id = g.id
                 and o.id = any (v_opt_ids)) as chosen
        from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id and g.is_active
       where pmg.product_id = v_prod.id
    loop
      if v_grp.chosen < v_grp.min_select then
        raise exception 'Choose at least % for %: %', v_grp.min_select, v_prod.name, v_grp.name;
      end if;
      if v_grp.chosen > v_grp.max_select then
        raise exception 'Choose at most % for %: %', v_grp.max_select, v_prod.name, v_grp.name;
      end if;
    end loop;
  end loop;

  -- ── bill + order share one savepoint: a concurrent resend that wins the
  --    client_order_id race rolls both back, so no orphan bill is left ──
  begin
    if p_table_id is not null then
      select label into v_label from dining_tables
       where id = p_table_id and branch_id = p_branch_id and is_active;
      if not found then raise exception 'Invalid table'; end if;
      select id, bill_no into v_bill_id, v_bill_no from bills
       where table_id = p_table_id and status = 'open';
      if v_bill_id is null then
        v_bill_no := pos_next_bill_no(p_branch_id);
        insert into bills(branch_id, bill_no, table_id, order_type, pax)
        values (p_branch_id, v_bill_no, p_table_id, 'dine_in', p_pax)
        on conflict (table_id) where status = 'open' and table_id is not null do nothing
        returning id into v_bill_id;
        if v_bill_id is null then                 -- lost the race: use the winner's bill
          select id, bill_no into v_bill_id, v_bill_no from bills
           where table_id = p_table_id and status = 'open';
        end if;
      elsif p_pax is not null then
        update bills set pax = p_pax where id = v_bill_id and pax is null;
      end if;
    else
      v_bill_no := pos_next_bill_no(p_branch_id);
      insert into bills(branch_id, bill_no, table_id, order_type, pax)
      values (p_branch_id, v_bill_no, null, 'takeaway', p_pax)
      returning id into v_bill_id;
    end if;

    -- serialise order numbering on this bill, and refuse a bill that was closed meanwhile
    perform 1 from bills where id = v_bill_id and status = 'open' for update;
    if not found then
      raise exception 'This bill was just closed. Please send the order again.';
    end if;
    select count(*) + 1 into v_n from orders where bill_id = v_bill_id;
    v_order_no := v_bill_no || '/' || v_n;
    insert into orders(bill_id, branch_id, order_no, source, placed_by, client_order_id, catalog_id)   -- M1: catalog_id
    values (v_bill_id, p_branch_id, v_order_no, p_source, p_placed_by, p_client_order_id, v_catalog)
    returning id into v_order_id;
  exception when unique_violation then
    select id into v_order_id from orders where client_order_id = p_client_order_id;
    if v_order_id is not null then return v_order_id; end if;
    raise;
  end;

  -- ── items: snapshot name, price, SST and modifiers from the menu ──
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from menu_products where id = (v_item->>'productId')::uuid;
    select * into v_var  from menu_variants where id = (v_item->>'variantId')::uuid;
    -- M1: the variant's price in this order's catalog
    select cvp.price_sen into v_unit from catalog_variant_prices cvp
     where cvp.catalog_id = v_catalog and cvp.variant_id = v_var.id;
    -- M1: an add-on costs the catalog's price when the catalog sets one, else the option's own
    select coalesce(jsonb_agg(jsonb_build_object(
             'optionId', o.id, 'group', g.name, 'name', o.name,
             'priceDeltaSen', coalesce(cop.price_delta_sen, o.price_delta_sen), 'route', ap.print_route)
             order by pmg.sort_order, g.name, o.sort_order, o.name), '[]'::jsonb),
           coalesce(sum(coalesce(cop.price_delta_sen, o.price_delta_sen)), 0)
      into v_mods, v_price
      from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) as x(v)
      join modifier_options o on o.id = x.v::uuid
      join modifier_groups g on g.id = o.group_id
      join product_modifier_groups pmg on pmg.group_id = g.id and pmg.product_id = v_prod.id
      left join catalog_option_prices cop on cop.catalog_id = v_catalog and cop.option_id = o.id
      left join menu_products ap on ap.id = o.product_id;
    insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen,
                            sst_rate_bp, modifiers_snapshot, print_route, qty, note, takeaway_fee_sen)
    values (v_order_id, v_bill_id, v_prod.id, v_var.id,
            v_prod.name || case when v_var.feedme_variant_key <> '' then ' (' || v_var.name || ')' else '' end,
            v_unit + v_price, v_prod.sst_rate_bp, v_mods, v_prod.print_route,          -- M1: v_unit (was v_var.price_sen)
            coalesce((v_item->'qty')::numeric::integer, 1),
            nullif(trim(left(case when jsonb_typeof(v_item->'note') = 'string' then v_item->>'note' end, 200)), ''),
            -- Sub-plan 3: the packaging fee is fixed when the item is ordered (takeaway bills only)
            case when p_order_type = 'takeaway' then v_prod.takeaway_fee_sen else 0 end);
  end loop;

  -- ── tickets: one job per route, shaped exactly like TicketPayload (ticket.ts) ──
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select p_branch_id, v_order_id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', v_label, 'orderNo', v_order_no,
           'source', p_source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              order by l.kind_order, l.name))
    from (
      -- the item on its own route, modifiers as sub-lines
      select oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods
        from order_items oi
       where oi.order_id = v_order_id and oi.print_route is not null
      union all
      -- a modifier whose add-on product prints somewhere else gets its own line there
      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb
        from order_items oi cross join jsonb_array_elements(oi.modifiers_snapshot) m
       where oi.order_id = v_order_id and m->>'route' is not null
         and m->>'route' is distinct from oi.print_route
    ) l
   group by l.route;

  return v_order_id;
end $$;
revoke all on function pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid) from public, anon, authenticated;

-- ── place_counter_order, re-created: the cashier may name the catalog ───────
-- p_catalog_id null (an order queued on an iPad before catalogs existed, or an
-- older app) = the branch's default for the order type.
create or replace function place_counter_order(
  p_table_id uuid, p_order_type text, p_pax integer, p_items jsonb, p_client_order_id uuid,
  p_catalog_id uuid default null                                         -- M1
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return pos_insert_order(pos_my_branch(), p_table_id, p_order_type, p_pax, 'counter', auth.uid(), p_items,
                          p_client_order_id, p_catalog_id);              -- M1: p_catalog_id
end $$;
revoke all on function place_counter_order(uuid, text, integer, jsonb, uuid, uuid) from public, anon;
grant execute on function place_counter_order(uuid, text, integer, jsonb, uuid, uuid) to authenticated;

-- ── place_table_order, re-created: priced from the branch's qr catalog ──────
create or replace function place_table_order(p_token text, p_pax integer, p_items jsonb, p_client_order_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table   dining_tables;
  v_recent  integer;
  v_existing uuid;
begin
  select * into v_table from dining_tables where qr_token = p_token;
  if not found then raise exception 'Invalid table code'; end if;
  -- resend of an order that already went in: return it even if the table was paused since
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then return v_existing; end if;
  if not v_table.is_active then raise exception 'Invalid table code'; end if;
  if v_table.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;
  -- Sub-plan 3: with the branch switch on, a table orders by QR only after staff open it
  if coalesce((select s.qr_requires_open_bill from branch_pos_settings s where s.branch_id = v_table.branch_id), false)
     and not exists (select 1 from bills b where b.table_id = v_table.id and b.status = 'open') then
    raise exception 'Please ask our staff to open your table before ordering.';
  end if;
  select count(*) into v_recent
    from orders o join bills b on b.id = o.bill_id
   where b.table_id = v_table.id and o.source = 'qr' and o.placed_at > now() - interval '1 minute';
  if v_recent >= 5 then
    raise exception 'Too many orders from this table. Please wait a minute.';
  end if;
  -- M1: a QR order is always priced from the branch's qr catalog (pos_order_catalog with source 'qr')
  return pos_insert_order(v_table.branch_id, v_table.id, 'dine_in', p_pax, 'qr', null, p_items, p_client_order_id, null);
end $$;
revoke all on function place_table_order(text, integer, jsonb, uuid) from public;
grant execute on function place_table_order(text, integer, jsonb, uuid) to anon, authenticated;

-- ── qr_menu, re-created: the branch's qr catalog, same JSON shape as before ─
create or replace function qr_menu(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'tableLabel', t.label,
    'paused', t.qr_paused,
    'needsPax', not exists (select 1 from bills b where b.table_id = t.id and b.status = 'open' and b.pax is not null),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'products', c.products) order by c.sort_order, c.name)
      from (
        select mc.name, mc.sort_order,
          jsonb_agg(jsonb_build_object(
            'id', p.id, 'name', p.name, 'description', p.description,
            'soldOut', coalesce(bms.is_sold_out, false),
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
           and exists (select 1 from menu_variants v
                         join catalog_variant_prices cvp on cvp.catalog_id = qc.catalog_id and cvp.variant_id = v.id
                        where v.product_id = p.id and v.is_active)
         group by mc.name, mc.sort_order
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

-- ── POS settings → Menu catalogs: the caller's branch, managers only ───────
-- p: { dineIn: uuid, takeaway: uuid, qr: uuid, additional: uuid[] }. All three
-- defaults are required; the branch's rows are replaced in one go (they are
-- settings, not history: orders keep their own catalog_id).
create or replace function save_branch_catalogs(p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_uuid   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_role   record;
  v_add    uuid[];
begin
  if not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change the menu catalogs';
  end if;
  if jsonb_typeof(p) is distinct from 'object'
     or jsonb_typeof(coalesce(p->'additional', '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid catalog settings';
  end if;
  for v_role in select * from (values ('dineIn', 'dine-in'), ('takeaway', 'takeaway'), ('qr', 'QR')) as x(key, label) loop
    if jsonb_typeof(p->v_role.key) is distinct from 'string' then
      raise exception 'Choose the % catalog', v_role.label;
    end if;
    if (p->>v_role.key) !~* v_uuid then raise exception 'Invalid catalog settings'; end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(coalesce(p->'additional', '[]'::jsonb)) e
              where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* v_uuid) then
    raise exception 'Invalid catalog settings';
  end if;
  select coalesce(array_agg(distinct x.v::uuid), '{}') into v_add
    from jsonb_array_elements_text(coalesce(p->'additional', '[]'::jsonb)) as x(v);
  if exists (select 1 from unnest(array[(p->>'dineIn')::uuid, (p->>'takeaway')::uuid, (p->>'qr')::uuid] || v_add) as c(id)
              where not exists (select 1 from menu_catalogs m where m.id = c.id and m.is_active)) then
    raise exception 'This catalog is not available — refresh and try again';
  end if;
  delete from branch_catalogs where branch_id = v_branch;
  insert into branch_catalogs(branch_id, role, catalog_id)
  select v_branch, r.role, r.id
    from (values ('dine_in', (p->>'dineIn')::uuid), ('takeaway', (p->>'takeaway')::uuid), ('qr', (p->>'qr')::uuid)) as r(role, id)
  union all
  select v_branch, 'additional', a.id from unnest(v_add) as a(id);
end $$;
revoke all on function save_branch_catalogs(jsonb) from public, anon;
grant execute on function save_branch_catalogs(jsonb) to authenticated;

-- ── menu_import, re-created: needs Edit menu ───────────────────────────────
create or replace function menu_import(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n_cat int; n_prod int; n_var int; n_grp int; n_opt int; n_link int;
begin
  if not has_menu_cap('manage_menu') then                -- M1: Edit menu (was access_settings)
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

-- ── /menu: put a product in a catalog, take it out, or change its channel ──
-- 'hidden' takes it out (the row and its prices stay, so nothing is lost);
-- 'all' / 'counter_only' puts it in, pre-filling any missing variant price
-- from the default price (menu_variants.price_sen).
create or replace function menu_set_catalog_product(p_catalog_id uuid, p_product_id uuid, p_availability text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('manage_menu') then
    raise exception 'Not allowed to edit the menu';
  end if;
  if p_availability is null or p_availability not in ('all', 'counter_only', 'hidden') then
    raise exception 'Invalid availability';
  end if;
  if not exists (select 1 from menu_catalogs where id = p_catalog_id) then
    raise exception 'Catalog not found';
  end if;
  if not exists (select 1 from menu_products where id = p_product_id and is_active) then
    raise exception 'Product not found';
  end if;
  insert into catalog_products(catalog_id, product_id, availability, sort_order)
  select p_catalog_id, p.id, p_availability, p.sort_order from menu_products p where p.id = p_product_id
  on conflict (catalog_id, product_id) do update set availability = excluded.availability;
  if p_availability <> 'hidden' then
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
    select p_catalog_id, v.id, v.price_sen from menu_variants v
     where v.product_id = p_product_id and v.is_active
    on conflict (catalog_id, variant_id) do nothing;
  end if;
end $$;
revoke all on function menu_set_catalog_product(uuid, uuid, text) from public, anon;
grant execute on function menu_set_catalog_product(uuid, uuid, text) to authenticated;

-- ── /menu/import: the whole Feedme export in one transaction ───────────────
-- p_payload = menu_import's payload (the Default Catalog / Default AddonGroup
-- master) plus catalogs: [{ name, sortOrder,
--   products: [{ feedmeId, availability 'all'|'counter_only', sortOrder, prices: [{ key, priceSen }] }],
--   optionPrices: [{ groupFeedmeId, productFeedmeId, variantKey, priceSen }] }]   (only prices that differ)
-- A catalog is matched by feedme_catalog_name. Its products not in the file are set
-- to 'hidden' (never deleted); catalogs not in the file and branch assignments are
-- left alone. Returns menu_import's counts plus catalogs: [{ name, products, prices, optionPrices }].
create or replace function menu_import_catalogs(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_master  jsonb;
  v_cat     record;
  v_id      uuid;
  v_report  jsonb := '[]'::jsonb;
  v_missing text;
  n_prod    integer;
  n_price   integer;
  n_opt     integer;
begin
  if not has_menu_cap('manage_menu') then
    raise exception 'Not allowed to import the menu';
  end if;
  if p_payload is null or jsonb_typeof(p_payload->'catalogs') is distinct from 'array' then
    raise exception 'Invalid import file';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'catalogs') c
              where jsonb_typeof(c) <> 'object' or coalesce(trim(c->>'name'), '') = ''
                 or jsonb_typeof(c->'products') is distinct from 'array'
                 or jsonb_typeof(c->'optionPrices') is distinct from 'array') then
    raise exception 'Invalid import file: a catalog has no name or no product list';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'catalogs') c
              where jsonb_typeof(c->'sortOrder') is distinct from 'number') then
    raise exception 'Invalid import file: a catalog has no order';
  end if;
  if (select count(*) from jsonb_array_elements(p_payload->'catalogs'))
     <> (select count(distinct trim(c->>'name')) from jsonb_array_elements(p_payload->'catalogs') c) then
    raise exception 'Invalid import file: a catalog appears twice';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'catalogs') c
               cross join lateral jsonb_array_elements(c->'products') x
              where jsonb_typeof(x) <> 'object'
                 or coalesce(x->>'availability', '') not in ('all', 'counter_only')
                 or jsonb_typeof(x->'feedmeId') is distinct from 'string'
                 or jsonb_typeof(x->'sortOrder') is distinct from 'number'
                 or jsonb_typeof(x->'prices') is distinct from 'array') then
    raise exception 'Invalid import file: a catalog product has no availability or prices';
  end if;
  -- every price a whole number of sen, never negative (CASE: no cast before the type is known)
  if exists (select 1 from jsonb_array_elements(p_payload->'catalogs') c
               cross join lateral (
                 select pr->'priceSen' as v from jsonb_array_elements(c->'products') x
                   cross join lateral jsonb_array_elements(x->'prices') pr
                 union all
                 select op->'priceSen' from jsonb_array_elements(c->'optionPrices') op) p
              where case when jsonb_typeof(p.v) = 'number'
                         then (p.v #>> '{}')::numeric < 0 or (p.v #>> '{}')::numeric <> trunc((p.v #>> '{}')::numeric)
                         else true end) then
    raise exception 'Invalid import file: a catalog price is not a whole number of sen';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'catalogs') c
              where (select count(*) from jsonb_array_elements(c->'products'))
                    <> (select count(distinct x->>'feedmeId') from jsonb_array_elements(c->'products') x)) then
    raise exception 'Invalid import file: a catalog lists a product twice';
  end if;

  -- the master first: products, variants and default prices, add-on groups, links
  v_master := menu_import(p_payload);

  drop table if exists pg_temp._imp_cat;
  create temp table pg_temp._imp_cat (
    product_id uuid primary key, availability text, sort_order integer, prices jsonb
  ) on commit drop;

  for v_cat in
    select trim(c->>'name') as name, coalesce((c->>'sortOrder')::integer, 0) as sort_order,
           c->'products' as products, c->'optionPrices' as option_prices
      from jsonb_array_elements(p_payload->'catalogs') c
  loop
    -- a catalog of that name made in Craft OS is adopted rather than duplicated; one of
    -- that name that already stands for another Feedme sheet is refused in plain words
    if not exists (select 1 from menu_catalogs where feedme_catalog_name = v_cat.name)
       and exists (select 1 from menu_catalogs where name = v_cat.name and feedme_catalog_name is not null) then
      raise exception 'Catalog % already exists under another Feedme name', v_cat.name;
    end if;
    update menu_catalogs set feedme_catalog_name = v_cat.name
     where name = v_cat.name and feedme_catalog_name is null;
    insert into menu_catalogs(name, feedme_catalog_name, sort_order, is_active)
    values (v_cat.name, v_cat.name, v_cat.sort_order, true)
    on conflict (feedme_catalog_name) do update set sort_order = excluded.sort_order, is_active = true
    returning id into v_id;

    delete from pg_temp._imp_cat;
    insert into pg_temp._imp_cat(product_id, availability, sort_order, prices)
    select mp.id, x.availability, x."sortOrder", x.prices
      from jsonb_to_recordset(v_cat.products) as x("feedmeId" text, availability text, "sortOrder" integer, prices jsonb)
      join menu_products mp on mp.feedme_product_id = x."feedmeId";
    get diagnostics n_prod = row_count;
    if n_prod <> jsonb_array_length(v_cat.products) then
      raise exception 'Invalid import file: catalog % lists a product that is not in the menu', v_cat.name;
    end if;

    -- the file decides what this catalog sells; whatever else it had becomes hidden
    update catalog_products cp set availability = 'hidden'
     where cp.catalog_id = v_id and cp.availability <> 'hidden'
       and not exists (select 1 from pg_temp._imp_cat i where i.product_id = cp.product_id);
    insert into catalog_products(catalog_id, product_id, availability, sort_order)
    select v_id, i.product_id, i.availability, i.sort_order from pg_temp._imp_cat i
    on conflict (catalog_id, product_id) do update
      set availability = excluded.availability, sort_order = excluded.sort_order;

    insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
    select v_id, mv.id, pr."priceSen"
      from pg_temp._imp_cat i
      cross join lateral jsonb_to_recordset(i.prices) as pr(key text, "priceSen" integer)
      join menu_variants mv on mv.product_id = i.product_id and mv.feedme_variant_key = coalesce(pr.key, '')
    on conflict (catalog_id, variant_id) do update set price_sen = excluded.price_sen;
    get diagnostics n_price = row_count;

    -- every active variant of a product the catalog sells needs a price
    select format('%s / %s', mp.name, mv.name) into v_missing
      from pg_temp._imp_cat i
      join menu_products mp on mp.id = i.product_id
      join menu_variants mv on mv.product_id = i.product_id and mv.is_active
     where not exists (select 1 from catalog_variant_prices c where c.catalog_id = v_id and c.variant_id = mv.id)
     order by mp.name, mv.name
     limit 1;
    if v_missing is not null then
      raise exception 'Catalog %: % has no price', v_cat.name, v_missing;
    end if;

    -- add-on prices that differ from the option's default (menu_import re-created the
    -- options of every imported group, so their old catalog prices are already gone)
    insert into catalog_option_prices(catalog_id, option_id, price_delta_sen)
    select v_id, o.id, op."priceSen"
      from jsonb_to_recordset(v_cat.option_prices)
             as op("groupFeedmeId" text, "productFeedmeId" text, "variantKey" text, "priceSen" integer)
      join modifier_groups g on g.feedme_group_id = op."groupFeedmeId"
      join menu_products ap on ap.feedme_product_id = op."productFeedmeId"
      join modifier_options o on o.group_id = g.id and o.product_id = ap.id
                             and o.feedme_variant_key = coalesce(op."variantKey", '')
    on conflict (catalog_id, option_id) do update set price_delta_sen = excluded.price_delta_sen;
    get diagnostics n_opt = row_count;

    v_report := v_report || jsonb_build_object('name', v_cat.name, 'products', n_prod,
                                               'prices', n_price, 'optionPrices', n_opt);
  end loop;

  return v_master || jsonb_build_object('catalogs', v_report);
end $$;
revoke all on function menu_import_catalogs(jsonb) from public, anon;
grant execute on function menu_import_catalogs(jsonb) to authenticated;

-- PostgREST picks up the new place_counter_order signature now, not at its next poll
notify pgrst, 'reload schema';

select 'catalog functions applied' as result;
