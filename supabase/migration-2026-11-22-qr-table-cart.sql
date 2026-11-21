-- QR guest names and shared table cart (docs/superpowers/specs/2026-11-22-qr-shared-table-cart-design.md).
-- Run on craft-os-dev after the POS chain up to migration-2026-11-18-pos-reports.sql. Safe to re-run.
--   1 qr_cart_lines: one cart per table, written only through the functions below
--   2 order_items.guest_id / guest_label / guest_avatar
--   3 helpers (not callable by clients) and the five cart RPCs (anon)
--   4 pos_insert_order re-created: the live text with the lines marked "-- G" changed
--   5 qr_table_state re-created: each item says which guest ordered it

-- ── 1 ─────────────────────────────────────────────────────────────────────────
create table if not exists qr_cart_lines (
  id           uuid primary key default gen_random_uuid(),
  table_id     uuid not null references dining_tables(id) on delete cascade,
  guest_id     uuid not null,
  guest_name   text not null,
  guest_avatar text not null,
  product_id   uuid not null,
  variant_id   uuid not null,
  option_ids   uuid[] not null default '{}',
  qty          integer not null check (qty between 1 and 20),
  note         text,
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp()
);
create index if not exists qr_cart_lines_table on qr_cart_lines(table_id, created_at);
alter table qr_cart_lines enable row level security;   -- no policies: functions only
revoke all on qr_cart_lines from public, anon, authenticated;

-- ── 2 ─────────────────────────────────────────────────────────────────────────
alter table order_items add column if not exists guest_id     uuid;
alter table order_items add column if not exists guest_label  text;   -- 'Eric', 'Guest 2'; null = counter
alter table order_items add column if not exists guest_avatar text;   -- 'a1'…'a8'; shown on the QR page only

-- ── 3 helpers ─────────────────────────────────────────────────────────────────
-- The table a token names, for a write: unknown, switched off or paused is refused.
create or replace function qr_cart_table(p_token text) returns dining_tables
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v dining_tables;
begin
  select * into v from dining_tables where qr_token = p_token;
  if not found or not v.is_active then raise exception 'Invalid table code'; end if;
  if v.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;
  return v;
end $$;
revoke all on function qr_cart_table(text) from public, anon, authenticated;

-- {id, name, avatar} as the client sent it → cleaned: a well-formed id, a name of 1–20 characters
-- ('Guest' when empty), one of the eight avatars.
create or replace function qr_cart_guest(p_guest jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_name   text;
  v_avatar text;
begin
  if p_guest is null or jsonb_typeof(p_guest) <> 'object'
     or jsonb_typeof(p_guest->'id') is distinct from 'string'
     or (p_guest->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Invalid guest';
  end if;
  v_name := case when jsonb_typeof(p_guest->'name') = 'string' then p_guest->>'name' else '' end;
  v_name := btrim(left(btrim(regexp_replace(v_name, '[[:cntrl:]]', '', 'g')), 20));
  if v_name = '' then v_name := 'Guest'; end if;
  v_avatar := case when jsonb_typeof(p_guest->'avatar') = 'string' then p_guest->>'avatar' end;
  if v_avatar is null or v_avatar !~ '^a[1-8]$' then v_avatar := 'a1'; end if;
  return jsonb_build_object('id', lower(p_guest->>'id'), 'name', v_name, 'avatar', v_avatar);
end $$;
revoke all on function qr_cart_guest(jsonb) from public, anon, authenticated;

-- One cart writer per table at a time (transaction-scoped).
create or replace function qr_cart_lock(p_table_id uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  select pg_advisory_xact_lock(hashtextextended('qr_cart:' || p_table_id::text, 0));
$$;
revoke all on function qr_cart_lock(uuid) from public, anon, authenticated;

-- Stale lines go: older than 2 hours, or created before the table's last bill was closed (paid or
-- voided) — the next party never inherits a cart, whether or not their bill is open yet. A paid part
-- of a split bill (split_from set) is not the table closing.
create or replace function qr_cart_purge(p_table_id uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from qr_cart_lines l
   where l.table_id = p_table_id
     and (l.created_at < now() - interval '2 hours'
          or l.created_at < (select max(b.closed_at) from bills b
                              where b.table_id = p_table_id and b.status <> 'open' and b.split_from is null));
$$;
revoke all on function qr_cart_purge(uuid) from public, anon, authenticated;

-- What a sender must have seen: changes with every add, edit, removal and rename.
create or replace function qr_cart_version(p_table_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(md5(string_agg(l.id::text || ':' || extract(epoch from l.updated_at)::text, ','
                                 order by l.created_at, l.id)), 'empty')
    from qr_cart_lines l where l.table_id = p_table_id;
$$;
revoke all on function qr_cart_version(uuid) from public, anon, authenticated;

-- guest id → the label shown everywhere, unique on the table. A guest with lines on the table's
-- open bill keeps that label; the others take their name, or name + ' 2', ' 3' … when it is taken,
-- in the order of their first cart line.
create or replace function qr_cart_labels(p_table_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_bill  uuid;
  v_out   jsonb := '{}'::jsonb;
  v_taken text[] := '{}';
  r       record;
  v_label text;
  v_n     integer;
begin
  select id into v_bill from bills where table_id = p_table_id and status = 'open';
  if v_bill is not null then
    for r in select oi.guest_id, min(oi.guest_label) as label from order_items oi
              where oi.bill_id = v_bill and oi.guest_id is not null and oi.guest_label is not null
              group by oi.guest_id
    loop
      v_out := v_out || jsonb_build_object(r.guest_id::text, r.label);
      v_taken := v_taken || lower(r.label);
    end loop;
  end if;
  for r in select l.guest_id, (array_agg(l.guest_name order by l.updated_at desc, l.id))[1] as name
             from qr_cart_lines l where l.table_id = p_table_id
            group by l.guest_id order by min(l.created_at), l.guest_id
  loop
    if v_out ? r.guest_id::text then continue; end if;
    v_label := r.name;
    v_n := 1;
    while lower(v_label) = any (v_taken) loop
      v_n := v_n + 1;
      v_label := r.name || ' ' || v_n;
    end loop;
    v_out := v_out || jsonb_build_object(r.guest_id::text, v_label);
    v_taken := v_taken || lower(v_label);
  end loop;
  return v_out;
end $$;
revoke all on function qr_cart_labels(uuid) from public, anon, authenticated;

-- ── 3 the cart RPCs ───────────────────────────────────────────────────────────
-- Not STABLE: it deletes stale lines (PostgREST runs STABLE functions read-only).
create or replace function qr_cart_state(p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table  dining_tables;
  v_labels jsonb;
begin
  select * into v_table from dining_tables where qr_token = p_token and is_active;
  if not found then return null; end if;
  perform qr_cart_purge(v_table.id);
  v_labels := qr_cart_labels(v_table.id);
  return jsonb_build_object(
    'version', qr_cart_version(v_table.id),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'guestId', l.guest_id, 'guestLabel', v_labels->>(l.guest_id::text),
               'guestAvatar', l.guest_avatar, 'productId', l.product_id, 'variantId', l.variant_id,
               'optionIds', to_jsonb(l.option_ids), 'qty', l.qty, 'note', l.note)
             order by l.created_at, l.id)
        from qr_cart_lines l where l.table_id = v_table.id), '[]'::jsonb),
    'lastOrder', (select o.id from orders o join bills b on b.id = o.bill_id
                   where b.table_id = v_table.id and o.source = 'qr'
                   order by o.placed_at desc, o.id desc limit 1));
end $$;
revoke all on function qr_cart_state(text) from public;
grant execute on function qr_cart_state(text) to anon, authenticated;

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

create or replace function qr_cart_remove(p_token text, p_guest_id uuid, p_line_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table dining_tables;
begin
  v_table := qr_cart_table(p_token);
  perform qr_cart_lock(v_table.id);
  delete from qr_cart_lines where id = p_line_id and table_id = v_table.id and guest_id = p_guest_id;
  if not found and exists (select 1 from qr_cart_lines where id = p_line_id and table_id = v_table.id) then
    raise exception 'You can only change your own items.';
  end if;
end $$;
revoke all on function qr_cart_remove(text, uuid, uuid) from public;
grant execute on function qr_cart_remove(text, uuid, uuid) to anon, authenticated;

create or replace function qr_cart_rename(p_token text, p_guest jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table dining_tables;
  v_g     jsonb;
begin
  v_table := qr_cart_table(p_token);
  v_g := qr_cart_guest(p_guest);
  perform qr_cart_lock(v_table.id);
  update qr_cart_lines set guest_name = v_g->>'name', guest_avatar = v_g->>'avatar', updated_at = clock_timestamp()
   where table_id = v_table.id and guest_id = (v_g->>'id')::uuid
     and (guest_name, guest_avatar) is distinct from (v_g->>'name', v_g->>'avatar');
end $$;
revoke all on function qr_cart_rename(text, jsonb) from public;
grant execute on function qr_cart_rename(text, jsonb) to anon, authenticated;

-- The table's cart becomes one order. p_version is the cart the sender confirmed; p_skip the lines
-- their phone showed as unavailable. The checks before the lock are place_table_order's.
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

-- ── 4 pos_insert_order: migration-2026-10-24-pos-slots-photos-fn.sql's text, lines marked "-- G" changed ──
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
                            guest_id, guest_label, guest_avatar)                                    -- G
    values (v_order_id, v_bill_id, v_prod.id, v_var.id,
            v_prod.name || case when v_var.feedme_variant_key <> '' then ' (' || v_var.name || ')' else '' end,
            v_unit + v_price, v_prod.sst_rate_bp, v_mods, v_prod.print_route,          -- M1: v_unit (was v_var.price_sen)
            coalesce((v_item->'qty')::numeric::integer, 1),
            nullif(trim(left(case when jsonb_typeof(v_item->'note') = 'string' then v_item->>'note' end, 200)), ''),
            -- Sub-plan 3: the packaging fee is fixed when the item is ordered (takeaway bills only)
            case when p_order_type = 'takeaway' then v_prod.takeaway_fee_sen else 0 end,
            case when p_source = 'qr' and current_setting('craft.qr_cart_send', true) = 'on' and (v_item->>'guestId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 then (v_item->>'guestId')::uuid end,                                                -- G
            case when p_source = 'qr' and current_setting('craft.qr_cart_send', true) = 'on' then nullif(left(btrim(coalesce(v_item->>'guestLabel', '')), 24), '') end,   -- G
            case when p_source = 'qr' and current_setting('craft.qr_cart_send', true) = 'on' and (v_item->>'guestAvatar') ~ '^a[1-8]$' then v_item->>'guestAvatar' end);  -- G
  end loop;

  -- ── tickets: one job per route, shaped exactly like TicketPayload (ticket.ts) ──
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select p_branch_id, v_order_id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', v_label, 'orderNo', v_order_no,
           'source', p_source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              || case when l.guest is null then '{}'::jsonb else jsonb_build_object('guest', l.guest) end   -- G
                              order by l.kind_order, l.name))
    from (
      -- the item on its own route, modifiers as sub-lines
      select oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods,
             oi.guest_label as guest                                                             -- G
        from order_items oi
       where oi.order_id = v_order_id and oi.print_route is not null
      union all
      -- a modifier whose add-on product prints somewhere else gets its own line there
      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb, oi.guest_label   -- G
        from order_items oi cross join jsonb_array_elements(oi.modifiers_snapshot) m
       where oi.order_id = v_order_id and m->>'route' is not null
         and m->>'route' is distinct from oi.print_route
    ) l
   group by l.route;

  return v_order_id;
end $$;
revoke all on function pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid) from public, anon, authenticated;

-- ── 5 qr_table_state: migration-2026-10-30-pos-discounts.sql's text + guestLabel / guestAvatar ──
create or replace function qr_table_state(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'tableLabel', t.label,
    'billNo', b.bill_no,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', oi.name_snapshot, 'qty', oi.qty, 'unitPriceSen', oi.unit_price_sen,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)),
               'note', oi.note, 'voided', oi.voided_at is not null, 'placedAt', o.placed_at,
               'guestLabel', oi.guest_label, 'guestAvatar', oi.guest_avatar)                                  -- G
             order by o.placed_at, oi.name_snapshot)
        from order_items oi join orders o on o.id = oi.order_id
       where oi.bill_id = b.id), '[]'::jsonb),
    'subtotalSen', coalesce((select (x.tot->>'subtotalSen')::integer - (x.tot->>'billDiscountSen')::integer
                               from (select pos_bill_totals(b.id) as tot) x), 0))
  from dining_tables t
  left join bills b on b.table_id = t.id and b.status = 'open'
  where t.qr_token = p_token and t.is_active
$$;
revoke all on function qr_table_state(text) from public;
grant execute on function qr_table_state(text) to anon, authenticated;

notify pgrst, 'reload schema';
select 'qr table cart applied' as result;
