-- ============================================================================
-- Craft OS — POS smaller Feedme habits, W7 (2026-11-22). Run on craft-os-dev after
-- migration-2026-11-22-pos-receipt-numbers.sql and migration-2026-11-22-qr-table-cart.sql.
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-22-pos-feedme-habits.md
-- Design: docs/superpowers/specs/2026-11-22-pos-feedme-habits-design.md
--
-- H1  Last-order time: branch_pos_settings.orders_open_at / last_order_at (Malaysia time; both or neither;
--     the window may cross midnight), saved by save_receipt_settings (ordersOpenAt, lastOrderAt);
--     pos_orders_open and pos_orders_closed_message; qr_menu carries the two times; qr_cart_put,
--     qr_cart_send and pos_insert_order (source 'qr' — which also covers place_table_order) refuse outside
--     the window with the sentence. The POS orders at any time.
-- H2  A takeaway line inside a dine-in bill: an item sent from the counter with "takeaway": true is stored
--     with order_type 'takeaway' and its product's packaging fee (pos_insert_order); order_items_order_type
--     keeps a line's own 'takeaway'; kitchen / bar tickets (new and void) mark it "takeaway": true; both
--     receipts name it "<name> (Takeaway)".
-- H3  Children in the pax: bills.pax_children (0 ≤ children ≤ pax); place_counter_order (p_pax_children),
--     pos_set_bill_pax and open_table (p_children) set it; both receipts carry paxChildren.
-- H4  Serve: order_items.served_at / served_by and set_items_served (no PIN; money unchanged; nothing prints).
-- Re-run hazards: re-running migration-2026-11-22-qr-table-cart.sql puts back pos_insert_order, qr_cart_put
-- and qr_cart_send without H1 / H2; migration-2026-10-24-pos-slots-photos-fn.sql qr_menu (and
-- pos_insert_order); migration-2026-11-22-pos-receipt-numbers.sql save_receipt_settings and both receipt
-- payloads; migration-2026-11-16-pos-split-bill.sql order_items_order_type;
-- migration-2026-10-24-pos-bill-actions-fn.sql pos_queue_void_tickets and a second open_table(uuid, integer);
-- migration-2026-10-26-pos-frontend.sql a second pos_set_bill_pax(uuid, integer);
-- migration-2026-10-29-pos-device-till.sql a second place_counter_order (seven arguments), which PostgREST
-- then cannot choose between — re-run this file after any of them.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_open_drawer(uuid,text)') is null or to_regprocedure('qr_cart_send(text,integer,text,uuid[],uuid)') is null then
    raise exception 'STOP: run migration-2026-11-22-pos-receipt-numbers.sql and migration-2026-11-22-qr-table-cart.sql first (pos_open_drawer or qr_cart_send is missing)';
  end if;
end $$;

-- ── H1. Last-order time (spec §3) ───────────────────────────────────────────
alter table branch_pos_settings add column if not exists orders_open_at time;                    -- H1: Malaysia time
alter table branch_pos_settings add column if not exists last_order_at time;                     -- H1
alter table branch_pos_settings drop constraint if exists branch_pos_settings_order_window_check;
alter table branch_pos_settings add constraint branch_pos_settings_order_window_check
  check ((orders_open_at is null) = (last_order_at is null)
         and (orders_open_at is null or orders_open_at <> last_order_at));

-- Is ordering open at an outlet at p_at? No times (or no settings row) = always. The window runs from
-- the orders_open_at minute to the end of the last_order_at minute, Malaysia time, and crosses midnight
-- when it opens later than it closes (09:00–02:00). The client mirrors it (orderWindow.ts). Internal.
create or replace function pos_orders_open(p_branch_id uuid, p_at timestamptz default now()) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
           when s.orders_open_at is null or s.last_order_at is null then true
           when s.orders_open_at <= s.last_order_at then x.m between s.orders_open_at and s.last_order_at
           else x.m >= s.orders_open_at or x.m <= s.last_order_at
         end
    from (select date_trunc('minute', p_at at time zone 'Asia/Kuala_Lumpur')::time as m) x
    left join branch_pos_settings s on s.branch_id = p_branch_id
$$;
revoke all on function pos_orders_open(uuid, timestamptz) from public, anon, authenticated;

-- The sentence the QR page shows and the QR functions refuse with outside the window (spec §3):
-- "Last orders were at 21:30. Ordering opens again at 09:00." Null when the outlet has no window. Internal.
create or replace function pos_orders_closed_message(p_branch_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select 'Last orders were at ' || to_char(s.last_order_at, 'HH24:MI') || '. Ordering opens again at '
         || to_char(s.orders_open_at, 'HH24:MI') || '.'
    from branch_pos_settings s
   where s.branch_id = p_branch_id
$$;
revoke all on function pos_orders_closed_message(uuid) from public, anon, authenticated;

-- save_receipt_settings: the live text of migration-2026-11-22-pos-receipt-numbers.sql (C2) with the lines
-- marked H1 added — ordersOpenAt / lastOrderAt: "HH:MM" or null, both or neither, not equal; either key
-- present saves both. A key that is absent leaves its column as it is.
create or replace function save_receipt_settings(p_branch_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := p_branch_id;                                                              -- O7
  v_route  text;
  v_round  text;
  v_footer constant text := 'This is an official receipt. Thank you for visiting us.';
  v_logo   jsonb;                                                                            -- C2
  v_w      numeric;                                                                          -- C2
  v_h      numeric;                                                                          -- C2
  v_bytes  bytea;                                                                            -- C2
  v_qr     text;                                                                             -- C2
  v_open   time;                                                                             -- H1
  v_last   time;                                                                             -- H1
begin
  if not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change the receipt settings';
  end if;
  if not pos_manages_outlet(v_branch) then raise exception 'This outlet is not one of yours'; end if;   -- O7
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid settings'; end if;
  if nullif(trim(p->>'receiptTitle'), '') is null then raise exception 'Enter the receipt title'; end if;
  v_route := nullif(trim(p->>'receiptRoute'), '');
  v_round := coalesce(p->>'cashRounding', 'nearest_5_sen');
  if v_round not in ('none', 'nearest_5_sen') then raise exception 'Invalid rounding setting'; end if;
  if v_route is not null and not exists (select 1 from print_routes where branch_id = v_branch and name = v_route) then
    raise exception 'No printer is set for route %', v_route;
  end if;
  if p ? 'receiptLogo' and jsonb_typeof(p->'receiptLogo') is distinct from 'null' then                  -- C2
    v_logo := p->'receiptLogo';                                                                         -- C2
    if jsonb_typeof(v_logo) is distinct from 'object' or jsonb_typeof(v_logo->'width') is distinct from 'number'   -- C2
       or jsonb_typeof(v_logo->'height') is distinct from 'number'                                       -- C2
       or jsonb_typeof(v_logo->'data') is distinct from 'string' then                                    -- C2
      raise exception 'The logo could not be read. Upload it again.';                                    -- C2
    end if;                                                                                              -- C2
    v_w := (v_logo->>'width')::numeric;                                                                  -- C2
    v_h := (v_logo->>'height')::numeric;                                                                 -- C2
    if v_w > 384 or v_h > 240 then raise exception 'The logo must be at most 384 × 240 dots.'; end if;   -- C2
    if v_w < 8 or v_h < 1 or v_w <> trunc(v_w) or v_h <> trunc(v_h) or mod(v_w, 8) <> 0 then           -- C2
      raise exception 'The logo could not be read. Upload it again.';                                    -- C2
    end if;                                                                                              -- C2
    begin                                                                                                -- C2
      v_bytes := decode(v_logo->>'data', 'base64');                                                      -- C2
    exception when others then                                                                           -- C2
      v_bytes := null;                                                                                   -- C2
    end;                                                                                                 -- C2
    if v_bytes is null or length(v_bytes) <> (v_w / 8 * v_h)::integer then                              -- C2
      raise exception 'The logo could not be read. Upload it again.';                                    -- C2
    end if;                                                                                              -- C2
    v_logo := jsonb_build_object('width', v_w::integer, 'height', v_h::integer, 'data', v_logo->>'data'); -- C2
  end if;                                                                                                -- C2
  if p ? 'fontSize' and coalesce(p->>'fontSize', '') not in ('small', 'normal', 'large') then           -- C2
    raise exception 'Choose a font size: small, normal or large.';                                       -- C2
  end if;                                                                                                -- C2
  v_qr := nullif(trim(p->>'footerQr'), '');                                                              -- C2
  if length(v_qr) > 300 then raise exception 'The QR text is too long (300 characters at most).'; end if; -- C2
  if p ? 'ordersOpenAt' or p ? 'lastOrderAt' then                                                        -- H1
    if (nullif(p->>'ordersOpenAt', '') is null) <> (nullif(p->>'lastOrderAt', '') is null) then          -- H1
      raise exception 'Set both times or neither.';                                                      -- H1
    end if;                                                                                              -- H1
    if nullif(p->>'ordersOpenAt', '') is not null then                                                   -- H1
      if p->>'ordersOpenAt' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'                                         -- H1
         or p->>'lastOrderAt' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then                                  -- H1
        raise exception 'Invalid settings';                                                              -- H1
      end if;                                                                                            -- H1
      v_open := (p->>'ordersOpenAt')::time;                                                              -- H1
      v_last := (p->>'lastOrderAt')::time;                                                               -- H1
      if v_open = v_last then                                                                            -- H1
        raise exception 'Orders open at and Last order at must be different times.';                    -- H1
      end if;                                                                                            -- H1
    end if;                                                                                              -- H1
  end if;                                                                                                -- H1
  -- a key that is absent leaves its column as it is (branches.address is shown all over Craft OS)
  update branches
     set receipt_title   = trim(p->>'receiptTitle'),
         legal_name      = case when p ? 'legalName'      then nullif(trim(p->>'legalName'), '')      else legal_name end,
         registration_no = case when p ? 'registrationNo' then nullif(trim(p->>'registrationNo'), '') else registration_no end,
         sst_no          = case when p ? 'sstNo'          then nullif(trim(p->>'sstNo'), '')          else sst_no end,
         address         = case when p ? 'address'        then nullif(trim(p->>'address'), '')        else address end,
         phone           = case when p ? 'phone'          then nullif(trim(p->>'phone'), '')          else phone end,
         email           = case when p ? 'email'          then nullif(trim(p->>'email'), '')          else email end
   where id = v_branch;
  insert into branch_pos_settings(branch_id) values (v_branch) on conflict (branch_id) do nothing;
  update branch_pos_settings
     set sst_registered        = case when p ? 'sstRegistered' then coalesce((p->>'sstRegistered')::boolean, sst_registered) else sst_registered end,
         cash_rounding         = case when p ? 'cashRounding' then v_round else cash_rounding end,
         receipt_route         = case when p ? 'receiptRoute' then v_route else receipt_route end,
         receipt_footer        = case when p ? 'footer' then coalesce(nullif(trim(left(p->>'footer', 300)), ''), v_footer) else receipt_footer end,
         qr_requires_open_bill = case when p ? 'qrRequiresOpenBill' then coalesce((p->>'qrRequiresOpenBill')::boolean, qr_requires_open_bill) else qr_requires_open_bill end,
         receipt_logo          = case when p ? 'receiptLogo' then v_logo else receipt_logo end,                                 -- C2
         receipt_footer_qr     = case when p ? 'footerQr' then v_qr else receipt_footer_qr end,                                 -- C2
         receipt_font_size     = case when p ? 'fontSize' then p->>'fontSize' else receipt_font_size end,                       -- C2
         receipt_hide_free_mods = case when p ? 'hideFreeMods'                                                                  -- C2
                                       then coalesce((p->>'hideFreeMods')::boolean, receipt_hide_free_mods)                     -- C2
                                       else receipt_hide_free_mods end,                                                         -- C2
         orders_open_at        = case when p ? 'ordersOpenAt' or p ? 'lastOrderAt' then v_open else orders_open_at end,      -- H1
         last_order_at         = case when p ? 'ordersOpenAt' or p ? 'lastOrderAt' then v_last else last_order_at end,       -- H1
         updated_at            = now()
   where branch_id = v_branch;
end $$;
revoke all on function save_receipt_settings(uuid, jsonb) from public, anon;
grant execute on function save_receipt_settings(uuid, jsonb) to authenticated;

-- qr_menu: the live text of migration-2026-10-24-pos-slots-photos-fn.sql (M3) with the lines marked H1 added —
-- the outlet's two times, so the QR page can say when ordering stops.
create or replace function qr_menu(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'tableLabel', t.label,
    'paused', t.qr_paused,
    'needsPax', not exists (select 1 from bills b where b.table_id = t.id and b.status = 'open' and b.pax is not null),
    'ordersOpenAt', (select to_char(s.orders_open_at, 'HH24:MI') from branch_pos_settings s where s.branch_id = t.branch_id),   -- H1
    'lastOrderAt', (select to_char(s.last_order_at, 'HH24:MI') from branch_pos_settings s where s.branch_id = t.branch_id),     -- H1
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'products', c.products) order by c.sort_order, c.name)
      from (
        select mc.name, mc.sort_order,
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

-- qr_cart_put and qr_cart_send: the live texts of migration-2026-11-22-qr-table-cart.sql with the lines marked
-- H1 added — outside the outlet's window a guest can neither add nor send (server time decides).
create or replace function qr_cart_put(p_token text, p_guest jsonb, p_line jsonb, p_line_id uuid) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table dining_tables;
  v_g     jsonb;
  v_qty   numeric;
  v_opts  uuid[];
  v_note  text;
  v_id    uuid;
  c_uuid  constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  v_table := qr_cart_table(p_token);
  if not pos_orders_open(v_table.branch_id) then                                         -- H1
    raise exception using message = pos_orders_closed_message(v_table.branch_id);        -- H1
  end if;                                                                                -- H1
  v_g := qr_cart_guest(p_guest);
  if p_line is null or jsonb_typeof(p_line) <> 'object'
     or jsonb_typeof(p_line->'productId') is distinct from 'string' or (p_line->>'productId') !~* c_uuid
     or jsonb_typeof(p_line->'variantId') is distinct from 'string' or (p_line->>'variantId') !~* c_uuid then
    raise exception 'Invalid item';
  end if;
  if not exists (select 1 from menu_variants v join menu_products p on p.id = v.product_id
                  where v.id = (p_line->>'variantId')::uuid and p.id = (p_line->>'productId')::uuid
                    and v.is_active and p.is_active and not p.is_addon) then
    raise exception 'Invalid item';
  end if;
  if jsonb_typeof(p_line->'qty') is distinct from 'number' then raise exception 'Invalid quantity'; end if;
  v_qty := (p_line->'qty')::numeric;
  if v_qty < 1 or v_qty > 20 or v_qty <> trunc(v_qty) then raise exception 'Invalid quantity'; end if;
  if p_line->'optionIds' is not null and jsonb_typeof(p_line->'optionIds') <> 'array' then
    raise exception 'Invalid add-ons';
  end if;
  if jsonb_array_length(coalesce(p_line->'optionIds', '[]'::jsonb)) > 30
     or exists (select 1 from jsonb_array_elements(coalesce(p_line->'optionIds', '[]'::jsonb)) e
                 where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* c_uuid) then
    raise exception 'Invalid add-ons';
  end if;
  select coalesce(array_agg(x.v::uuid), '{}') into v_opts
    from jsonb_array_elements_text(coalesce(p_line->'optionIds', '[]'::jsonb)) as x(v);
  if cardinality(v_opts) <> (select count(distinct u) from unnest(v_opts) u) then
    raise exception 'Invalid add-ons';
  end if;
  v_note := nullif(btrim(left(case when jsonb_typeof(p_line->'note') = 'string' then p_line->>'note' end, 200)), '');

  perform qr_cart_lock(v_table.id);
  perform qr_cart_purge(v_table.id);
  if p_line_id is null then
    if (select count(*) from qr_cart_lines where table_id = v_table.id) >= 50 then
      raise exception 'This table''s order is full. Please send it first.';
    end if;
    insert into qr_cart_lines(table_id, guest_id, guest_name, guest_avatar, product_id, variant_id, option_ids, qty, note)
    values (v_table.id, (v_g->>'id')::uuid, v_g->>'name', v_g->>'avatar',
            (p_line->>'productId')::uuid, (p_line->>'variantId')::uuid, v_opts, v_qty::integer, v_note)
    returning id into v_id;
  else
    if not exists (select 1 from qr_cart_lines where id = p_line_id and table_id = v_table.id) then
      raise exception 'That item is no longer in the order.';
    end if;
    update qr_cart_lines
       set product_id = (p_line->>'productId')::uuid, variant_id = (p_line->>'variantId')::uuid,
           option_ids = v_opts, qty = v_qty::integer, note = v_note, updated_at = clock_timestamp()
     where id = p_line_id and table_id = v_table.id and guest_id = (v_g->>'id')::uuid
    returning id into v_id;
    if v_id is null then raise exception 'You can only change your own items.'; end if;
  end if;
  -- one name and avatar per guest across their lines
  update qr_cart_lines set guest_name = v_g->>'name', guest_avatar = v_g->>'avatar', updated_at = clock_timestamp()
   where table_id = v_table.id and guest_id = (v_g->>'id')::uuid
     and (guest_name, guest_avatar) is distinct from (v_g->>'name', v_g->>'avatar');
  return v_id;
end $$;
revoke all on function qr_cart_put(text, jsonb, jsonb, uuid) from public;
grant execute on function qr_cart_put(text, jsonb, jsonb, uuid) to anon, authenticated;

create or replace function qr_cart_send(p_token text, p_pax integer, p_version text, p_skip uuid[], p_client_order_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table    dining_tables;
  v_existing uuid;
  v_recent   integer;
  v_labels   jsonb;
  v_items    jsonb;
  v_order    uuid;
begin
  select * into v_table from dining_tables where qr_token = p_token;
  if not found then raise exception 'Invalid table code'; end if;
  if p_client_order_id is null then raise exception 'Order id is missing'; end if;
  -- resend of an order that already went in: return it even if the table was paused since
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then return jsonb_build_object('status', 'sent', 'orderId', v_existing); end if;
  if not v_table.is_active then raise exception 'Invalid table code'; end if;
  if v_table.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;
  if not pos_orders_open(v_table.branch_id) then                                         -- H1
    raise exception using message = pos_orders_closed_message(v_table.branch_id);        -- H1
  end if;                                                                                -- H1
  if coalesce((select s.qr_requires_open_bill from branch_pos_settings s where s.branch_id = v_table.branch_id), false)
     and not exists (select 1 from bills b where b.table_id = v_table.id and b.status = 'open') then
    raise exception 'Please ask our staff to open your table before ordering.';
  end if;

  perform qr_cart_lock(v_table.id);
  select id into v_existing from orders where client_order_id = p_client_order_id;   -- a resend that waited on the lock
  if v_existing is not null then return jsonb_build_object('status', 'sent', 'orderId', v_existing); end if;
  perform qr_cart_purge(v_table.id);
  if qr_cart_version(v_table.id) is distinct from p_version then
    return jsonb_build_object('status', 'changed');
  end if;
  select count(*) into v_recent
    from orders o join bills b on b.id = o.bill_id
   where b.table_id = v_table.id and o.source = 'qr' and o.placed_at > now() - interval '1 minute';
  if v_recent >= 5 then
    raise exception 'Too many orders from this table. Please wait a minute.';
  end if;

  v_labels := qr_cart_labels(v_table.id);
  select jsonb_agg(jsonb_build_object(
           'productId', l.product_id, 'variantId', l.variant_id, 'qty', l.qty, 'note', l.note,
           'optionIds', to_jsonb(l.option_ids), 'guestId', l.guest_id,
           'guestLabel', v_labels->>(l.guest_id::text), 'guestAvatar', l.guest_avatar)
         order by l.created_at, l.id)
    into v_items
    from qr_cart_lines l
   where l.table_id = v_table.id and not (l.id = any (coalesce(p_skip, '{}'::uuid[])));
  if v_items is null then raise exception 'Nothing to send.'; end if;

  -- only this function may name guests on order items (pos_insert_order reads the flag; place_table_order
  -- and the counter never set it)
  perform set_config('craft.qr_cart_send', 'on', true);
  v_order := pos_insert_order(v_table.branch_id, v_table.id, 'dine_in', p_pax, 'qr', null, v_items, p_client_order_id, null);
  perform set_config('craft.qr_cart_send', 'off', true);
  delete from qr_cart_lines where table_id = v_table.id;
  return jsonb_build_object('status', 'sent', 'orderId', v_order);
end $$;
revoke all on function qr_cart_send(text, integer, text, uuid[], uuid) from public;
grant execute on function qr_cart_send(text, integer, text, uuid[], uuid) to anon, authenticated;

-- ── H2. A takeaway line inside a dine-in bill (spec §4) ────────────────────
-- order_items_order_type: the live text of migration-2026-11-16-pos-split-bill.sql (S1) with the line marked
-- H2 added — a line inserted as 'takeaway' keeps it (a takeaway line on a dine-in bill); anything else takes
-- the bill's type, so a takeaway bill's lines stay takeaway. The trigger itself (migration-2026-10-25-pos-
-- hardening.sql) is unchanged.
create or replace function order_items_order_type() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.split_from_item is not null then return new; end if;                          -- S1
  if new.order_type = 'takeaway' then return new; end if;                              -- H2
  select b.order_type into new.order_type from bills b where b.id = new.bill_id;
  return new;
end $$;
revoke all on function order_items_order_type() from public, anon, authenticated;

-- pos_insert_order: the live text of migration-2026-11-22-qr-table-cart.sql (G) with the lines marked H1 / H2
-- changed — H1: a QR order outside the outlet's window is refused (qr_cart_send and place_table_order both
-- come here); H2: on a dine-in order from the counter, an item with "takeaway": true is a takeaway line —
-- order_type 'takeaway', its product's packaging fee, "takeaway": true on its ticket line.
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
  v_ta         boolean;                 -- H2: a takeaway line on a dine-in order from the counter
begin
  if p_client_order_id is null then
    raise exception 'Order id is missing';
  end if;
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then
    return v_existing;                         -- resend: already in
  end if;
  if p_source = 'qr' and not pos_orders_open(p_branch_id) then                           -- H1
    raise exception using message = pos_orders_closed_message(p_branch_id);             -- H1
  end if;                                                                                -- H1
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
    -- M3: inside one of its time slots now (Asia/Kuala_Lumpur, the server's clock), or it has none
    if not menu_product_open(v_prod.id, now()) then
      raise exception '% is not available at this time', v_prod.name;
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
    v_ta := p_order_type = 'dine_in' and p_source <> 'qr' and coalesce(v_item->'takeaway' = 'true'::jsonb, false);   -- H2
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
                            sst_rate_bp, modifiers_snapshot, print_route, qty, note, takeaway_fee_sen,
                            guest_id, guest_label, guest_avatar, order_type)                        -- G, H2
    values (v_order_id, v_bill_id, v_prod.id, v_var.id,
            v_prod.name || case when v_var.feedme_variant_key <> '' then ' (' || v_var.name || ')' else '' end,
            v_unit + v_price, v_prod.sst_rate_bp, v_mods, v_prod.print_route,          -- M1: v_unit (was v_var.price_sen)
            coalesce((v_item->'qty')::numeric::integer, 1),
            nullif(trim(left(case when jsonb_typeof(v_item->'note') = 'string' then v_item->>'note' end, 200)), ''),
            -- Sub-plan 3: the packaging fee is fixed when the item is ordered (takeaway bills and W7 takeaway lines)   -- H2
            case when p_order_type = 'takeaway' or v_ta then v_prod.takeaway_fee_sen else 0 end,                      -- H2
            case when p_source = 'qr' and current_setting('craft.qr_cart_send', true) = 'on' and (v_item->>'guestId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (v_item->>'guestId')::uuid end,                                                -- G
            case when p_source = 'qr' and current_setting('craft.qr_cart_send', true) = 'on' then nullif(left(btrim(coalesce(v_item->>'guestLabel', '')), 24), '') end,   -- G
            case when p_source = 'qr' and current_setting('craft.qr_cart_send', true) = 'on' and (v_item->>'guestAvatar') ~ '^a[1-8]$' then v_item->>'guestAvatar' end,   -- G, H2
            case when v_ta then 'takeaway' end);                                                    -- H2: null = the bill's type (trigger)
  end loop;

  -- ── tickets: one job per route, shaped exactly like TicketPayload (ticket.ts) ──
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select p_branch_id, v_order_id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', v_label, 'orderNo', v_order_no,
           'source', p_source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              || case when l.guest is null then '{}'::jsonb else jsonb_build_object('guest', l.guest) end   -- G
                              || case when l.takeaway then jsonb_build_object('takeaway', true) else '{}'::jsonb end   -- H2
                              order by l.kind_order, l.name))
    from (
      -- the item on its own route, modifiers as sub-lines
      select oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods,
             oi.guest_label as guest,                                                            -- G, H2
             oi.order_type = 'takeaway' and p_order_type = 'dine_in' as takeaway                 -- H2
        from order_items oi
       where oi.order_id = v_order_id and oi.print_route is not null
      union all
      -- a modifier whose add-on product prints somewhere else gets its own line there
      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb, oi.guest_label,   -- G, H2
             oi.order_type = 'takeaway' and p_order_type = 'dine_in'                                      -- H2
        from order_items oi cross join jsonb_array_elements(oi.modifiers_snapshot) m
       where oi.order_id = v_order_id and m->>'route' is not null
         and m->>'route' is distinct from oi.print_route
    ) l
   group by l.route;

  return v_order_id;
end $$;
revoke all on function pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid) from public, anon, authenticated;

-- pos_queue_void_tickets: the live text of migration-2026-10-24-pos-bill-actions-fn.sql with the lines marked
-- H2 changed — a voided takeaway line of a dine-in bill reads TAKEAWAY on the VOID ticket too.
create or replace function pos_queue_void_tickets(p_item_ids uuid[]) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select o.branch_id, o.id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', t.label, 'orderNo', o.order_no,
           'source', o.source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'void', true,
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              || case when l.takeaway and b.order_type = 'dine_in'                                  -- H2
                                      then jsonb_build_object('takeaway', true) else '{}'::jsonb end                -- H2
                              order by l.kind_order, l.name))
    from (
      select oi.order_id, oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods,   -- H2
             oi.order_type = 'takeaway' as takeaway                                                                 -- H2
        from order_items oi
       where oi.id = any (p_item_ids) and oi.print_route is not null
      union all
      select oi.order_id, m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb,              -- H2
             oi.order_type = 'takeaway'                                                                             -- H2
        from order_items oi cross join jsonb_array_elements(oi.modifiers_snapshot) m
       where oi.id = any (p_item_ids) and m->>'route' is not null
         and m->>'route' is distinct from oi.print_route
    ) l
    join orders o on o.id = l.order_id
    join bills b on b.id = o.bill_id
    left join dining_tables t on t.id = b.table_id
   group by o.id, o.branch_id, o.order_no, o.source, t.label, l.route
$$;
revoke all on function pos_queue_void_tickets(uuid[]) from public, anon, authenticated;

-- PostgREST picks up the new and changed functions now, not at its next poll
notify pgrst, 'reload schema';
select 'pos feedme habits applied' as result;
