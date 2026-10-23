-- ============================================================================
-- Craft OS — POS menu catalogs · M3 functions: time slots and product photos (2026-10-24).
-- Run on craft-os-dev after migration-2026-10-24-pos-slots-photos.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m3.md
-- Design: docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md §2, §3, §5
--
-- New functions: the time maths (menu_window_open, menu_product_open — mirrored by
-- src/features/pos/menu/timeSlots.ts, checked against the same vectors), the
-- Schedules page and the product editor's Time slots and Photo sections (Edit menu
-- only), the import's photo targets, and the counter's pos_menu_windows.
--
-- Canonical from here on: pos_insert_order and qr_menu. Each is the live text of
-- migration-2026-10-24-pos-catalogs-fn.sql with only the lines marked "M3" added
-- (pos_insert_order refuses a product outside its time slots; qr_menu hides it and
-- returns the product photo). Re-running migration-2026-10-24-pos-catalogs-fn.sql
-- (or an older file defining them) brings the old bodies back — re-run this file
-- afterwards. No M1 or M2 function other than these two is re-created.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regclass('public.menu_schedule_windows') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-slots-photos.sql first (menu_schedule_windows is missing)';
  end if;
  if to_regprocedure('pos_order_catalog(uuid,text,text,uuid)') is null
     or to_regprocedure('menu_require_editor()') is null
     or to_regprocedure('menu_clean_name(text,text,integer)') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-catalogs-fn.sql and migration-2026-10-24-pos-menu-editor-fn.sql first';
  end if;
  if pg_get_functiondef('has_menu_cap(text)'::regprocedure) not like '%manage_menu%' then
    raise exception 'STOP: has_menu_cap does not know manage_menu — re-run migration-2026-10-24-pos-catalogs.sql first';
  end if;
end $$;

-- ── Time maths. Malaysia keeps UTC+8 all year. Mirrored by windowOpen() /
--    availableAt() in src/features/pos/menu/timeSlots.ts; the verify script runs
--    the shared vectors (src/features/pos/menu/slotVectors.json) through it ─────
-- One window at one instant: the Malaysian day and minute (seconds dropped) inside
-- start..end, both minutes included. end < start crosses midnight: the window runs
-- from start on one of `days` to end on the next day.
create or replace function menu_window_open(p_days smallint[], p_start time, p_end time, p_at timestamptz)
returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select case
           when p_start < p_end then c.d = any (p_days) and c.t between p_start and p_end
           else (c.d = any (p_days) and c.t >= p_start)
             or ((case when c.d = 1 then 7 else c.d - 1 end)::smallint = any (p_days) and c.t <= p_end)
         end
    from (select extract(isodow from l)::smallint as d, date_trunc('minute', l)::time as t
            from (select p_at at time zone 'Asia/Kuala_Lumpur' as l) x) c
$$;
revoke all on function menu_window_open(smallint[], time, time, timestamptz) from public, anon, authenticated;

-- A product may be sold at p_at when it follows no schedule, or when one window of
-- one of its schedules is open (spec §3, Feedme's Scheduler).
create or replace function menu_product_open(p_product_id uuid, p_at timestamptz) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select not exists (select 1 from product_schedules ps where ps.product_id = p_product_id)
      or exists (select 1 from product_schedules ps
                   join menu_schedule_windows w on w.schedule_id = ps.schedule_id
                  where ps.product_id = p_product_id
                    and menu_window_open(w.days, w.start_time, w.end_time, p_at))
$$;
revoke all on function menu_product_open(uuid, timestamptz) from public, anon, authenticated;

-- A window as every client reads it: { days: [1..7], start: 'HH:MM', end: 'HH:MM' }.
create or replace function menu_window_json(w menu_schedule_windows) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('days', to_jsonb(w.days), 'start', to_char(w.start_time, 'HH24:MI'),
                            'end', to_char(w.end_time, 'HH24:MI'))
$$;
revoke all on function menu_window_json(menu_schedule_windows) from public, anon, authenticated;

-- 'HH:MM' from 00:00 to 23:59 as a time, else null.
create or replace function menu_hm(p_value jsonb) returns time
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if jsonb_typeof(p_value) is distinct from 'string'
     or (p_value #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return null;
  end if;
  return (p_value #>> '{}')::time;
end $$;
revoke all on function menu_hm(jsonb) from public, anon, authenticated;

-- A JSON array of ISO days (whole numbers 1..7) as a sorted array without repeats
-- (empty when the array is); null when it is not such an array.
create or replace function menu_days(p_value jsonb) returns smallint[]
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v smallint[];
begin
  if jsonb_typeof(p_value) is distinct from 'array' then return null; end if;
  if exists (select 1 from jsonb_array_elements(p_value) e
              where jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[1-7]$') then
    return null;
  end if;
  select coalesce(array_agg(distinct (e #>> '{}')::smallint order by (e #>> '{}')::smallint), '{}')
    into v from jsonb_array_elements(p_value) e;
  return v;
end $$;
revoke all on function menu_days(jsonb) from public, anon, authenticated;

-- ── Reads for the Schedules page and the product editor (Edit menu; one JSON value each) ──
-- Every schedule with its windows and how many products follow it.
create or replace function menu_schedule_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'name', s.name, 'sortOrder', s.sort_order,
             'windows', coalesce((select jsonb_agg(menu_window_json(w) order by w.sort_order)
                                    from menu_schedule_windows w where w.schedule_id = s.id), '[]'::jsonb),
             -- products on sale (add-on items are not on the counter or QR)
             'productCount', (select count(*) from product_schedules ps
                                join menu_products p on p.id = ps.product_id and p.is_active and not p.is_addon
                               where ps.schedule_id = s.id))
           order by s.sort_order, s.name)
      from menu_schedules s), '[]'::jsonb);
end $$;
revoke all on function menu_schedule_list() from public, anon;
grant execute on function menu_schedule_list() to authenticated;

-- The schedule editor: the schedule, its windows in order and every product linked to it.
create or replace function menu_schedule_detail(p_schedule_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  perform menu_require_editor();
  select jsonb_build_object(
           'id', s.id, 'name', s.name,
           'windows', coalesce((select jsonb_agg(menu_window_json(w) order by w.sort_order)
                                  from menu_schedule_windows w where w.schedule_id = s.id), '[]'::jsonb),
           'productIds', coalesce((select jsonb_agg(ps.product_id order by ps.product_id)
                                     from product_schedules ps where ps.schedule_id = s.id), '[]'::jsonb))
    into v
    from menu_schedules s
   where s.id = p_schedule_id;
  if v is null then
    raise exception 'Schedule not found';
  end if;
  return v;
end $$;
revoke all on function menu_schedule_detail(uuid) from public, anon;
grant execute on function menu_schedule_detail(uuid) to authenticated;

-- The product editor's Photo and Time slots sections.
create or replace function menu_product_extras(p_product_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  perform menu_require_editor();
  select jsonb_build_object(
           'imagePath', p.image_path, 'imageUpdatedAt', p.image_updated_at,
           'scheduleIds', coalesce((select jsonb_agg(ps.schedule_id order by s.sort_order, s.name)
                                      from product_schedules ps join menu_schedules s on s.id = ps.schedule_id
                                     where ps.product_id = p.id), '[]'::jsonb))
    into v
    from menu_products p
   where p.id = p_product_id;
  if v is null then
    raise exception 'Product not found';
  end if;
  return v;
end $$;
revoke all on function menu_product_extras(uuid) from public, anon;
grant execute on function menu_product_extras(uuid) to authenticated;

-- The import's Photos step: every product with its Feedme id and whether it has a photo.
create or replace function menu_photo_targets() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'feedmeProductId', p.feedme_product_id, 'imagePath', p.image_path,
             'isActive', p.is_active, 'isAddon', p.is_addon)
           order by p.sort_order, p.name)
      from menu_products p), '[]'::jsonb);
end $$;
revoke all on function menu_photo_targets() from public, anon;
grant execute on function menu_photo_targets() to authenticated;

-- ── Schedules: save, reorder, delete ───────────────────────────────────────
-- p = { id: uuid|null (null = new), name,
--       windows: [{ days: [1..7], start: 'HH:MM', end: 'HH:MM' }]   (array order = order on screen; replaces them all)
--       productIds: [uuid] (optional; left out = links kept, else the whole set of products that follow it) }
-- Returns the schedule id.
create or replace function menu_save_schedule(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id     uuid;
  v_new    boolean;
  v_name   text;
  v_text   text;
  v_el     record;
  v_days   smallint[];
  v_start  time;
  v_end    time;
  v_ids    uuid[];
begin
  perform menu_require_editor();
  if jsonb_typeof(p) is distinct from 'object'
     or jsonb_typeof(p->'windows') is distinct from 'array'
     or (p ? 'productIds' and jsonb_typeof(p->'productIds') is distinct from 'array') then
    raise exception 'Invalid schedule';
  end if;
  v_new := coalesce(jsonb_typeof(p->'id'), 'null') = 'null';
  if not v_new then
    v_id := menu_uuid(p->'id');
    if v_id is null or not exists (select 1 from menu_schedules where id = v_id) then
      raise exception 'Schedule not found — refresh and try again';
    end if;
  end if;
  v_name := menu_clean_name(p->>'name', 'Schedule', 60);
  if exists (select 1 from menu_schedules where lower(name) = lower(v_name) and id is distinct from v_id) then
    raise exception 'A schedule called % already exists', v_name;
  end if;

  -- ── windows: all checked before anything is written ──
  if jsonb_array_length(p->'windows') = 0 then raise exception 'A schedule needs at least one time window'; end if;
  if jsonb_array_length(p->'windows') > 10 then raise exception 'Too many time windows (at most 10)'; end if;
  for v_el in select e.v from jsonb_array_elements(p->'windows') as e(v) loop
    if jsonb_typeof(v_el.v) <> 'object' then raise exception 'Invalid schedule'; end if;
    v_days := menu_days(v_el.v->'days');
    if v_days is null then raise exception 'Invalid schedule'; end if;
    if cardinality(v_days) = 0 then raise exception 'Pick at least one day for each time window'; end if;
    v_start := menu_hm(v_el.v->'start');
    v_end := menu_hm(v_el.v->'end');
    if v_start is null or v_end is null then raise exception 'Enter each time as HH:MM, e.g. 08:00'; end if;
    if v_start = v_end then raise exception 'A time window cannot start and end at the same time'; end if;
  end loop;

  -- ── products that follow it ──
  if p ? 'productIds' then
    if exists (select 1 from jsonb_array_elements(p->'productIds') g where menu_uuid(g) is null) then
      raise exception 'Invalid schedule';
    end if;
    select coalesce(array_agg(distinct menu_uuid(g)), '{}') into v_ids from jsonb_array_elements(p->'productIds') g;
    if exists (select 1 from unnest(v_ids) u where not exists (select 1 from menu_products mp where mp.id = u)) then
      raise exception 'Product not found — refresh and try again';
    end if;
    -- the product editor's limit, kept from this side too
    select mp.name into v_text
      from unnest(v_ids) u join menu_products mp on mp.id = u
     where (select count(*) from product_schedules ps where ps.product_id = u and ps.schedule_id is distinct from v_id) >= 20
     order by mp.name limit 1;
    if v_text is not null then raise exception '% follows too many schedules (at most 20)', v_text; end if;
  end if;

  -- ── write ──
  begin
    if v_new then
      insert into menu_schedules(name, sort_order)
      values (v_name, coalesce((select max(sort_order) + 1 from menu_schedules), 0))
      returning id into v_id;
    else
      update menu_schedules set name = v_name where id = v_id;
    end if;
  exception when unique_violation then
    raise exception 'A schedule called % already exists', v_name;    -- another save took the name meanwhile
  end;
  delete from menu_schedule_windows where schedule_id = v_id;
  insert into menu_schedule_windows(schedule_id, days, start_time, end_time, sort_order)
  select v_id, menu_days(e.v->'days'), menu_hm(e.v->'start'), menu_hm(e.v->'end'), e.ord - 1
    from jsonb_array_elements(p->'windows') with ordinality as e(v, ord);
  if p ? 'productIds' then
    delete from product_schedules where schedule_id = v_id and not (product_id = any (v_ids));
    insert into product_schedules(product_id, schedule_id)
    select u, v_id from unnest(v_ids) u
    on conflict (product_id, schedule_id) do nothing;
  end if;
  return v_id;
end $$;
revoke all on function menu_save_schedule(jsonb) from public, anon;
grant execute on function menu_save_schedule(jsonb) to authenticated;

create or replace function menu_reorder_schedules(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_ids is null
     or cardinality(p_ids) <> (select count(distinct u) from unnest(p_ids) u)
     or cardinality(p_ids) <> (select count(*) from menu_schedules)
     or exists (select 1 from unnest(p_ids) u where not exists (select 1 from menu_schedules s where s.id = u)) then
    raise exception 'The schedule list changed — refresh and try again';
  end if;
  update menu_schedules s set sort_order = x.ord - 1
    from unnest(p_ids) with ordinality as x(id, ord)
   where s.id = x.id;
end $$;
revoke all on function menu_reorder_schedules(uuid[]) from public, anon;
grant execute on function menu_reorder_schedules(uuid[]) to authenticated;

-- Feedme's Delete (a scheduler has no on/off switch): the schedule, its windows and its
-- product links go. No order refers to them; its products then sell at any time unless
-- another schedule they follow says otherwise. The one hard delete of M3.
create or replace function menu_delete_schedule(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_id is null or not exists (select 1 from menu_schedules where id = p_id) then
    raise exception 'Schedule not found — refresh and try again';
  end if;
  delete from product_schedules where schedule_id = p_id;
  delete from menu_schedule_windows where schedule_id = p_id;
  delete from menu_schedules where id = p_id;
end $$;
revoke all on function menu_delete_schedule(uuid) from public, anon;
grant execute on function menu_delete_schedule(uuid) to authenticated;

-- ── The product editor: which schedules a product follows, and its photo ────
-- p_schedule_ids is the whole set (empty = always available).
create or replace function menu_set_product_schedules(p_product_id uuid, p_schedule_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids uuid[];
begin
  perform menu_require_editor();
  if p_schedule_ids is null then raise exception 'Invalid schedule'; end if;
  if not exists (select 1 from menu_products where id = p_product_id) then
    raise exception 'Product not found — refresh and try again';
  end if;
  select coalesce(array_agg(distinct u), '{}') into v_ids from unnest(p_schedule_ids) u;
  if cardinality(v_ids) > 20 then raise exception 'Too many schedules (at most 20)'; end if;
  if exists (select 1 from unnest(v_ids) u where u is null or not exists (select 1 from menu_schedules s where s.id = u)) then
    raise exception 'Schedule not found — refresh and try again';
  end if;
  delete from product_schedules where product_id = p_product_id and not (schedule_id = any (v_ids));
  insert into product_schedules(product_id, schedule_id)
  select p_product_id, u from unnest(v_ids) u
  on conflict (product_id, schedule_id) do nothing;
end $$;
revoke all on function menu_set_product_schedules(uuid, uuid[]) from public, anon;
grant execute on function menu_set_product_schedules(uuid, uuid[]) to authenticated;

-- p_path: a file the editor has just uploaded to menu-images, products/<this product>/<random>.webp|.jpg;
-- null = no photo. Returns the path it replaced (the editor then deletes that file), or null.
create or replace function menu_set_product_image(p_product_id uuid, p_path text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old text;
begin
  perform menu_require_editor();
  select image_path into v_old from menu_products where id = p_product_id for update;
  if not found then
    raise exception 'Product not found — refresh and try again';
  end if;
  if p_path is not null then
    if p_path !~ ('^products/' || p_product_id::text || '/[A-Za-z0-9_-]{8,64}\.(webp|jpg)$') then
      raise exception 'Invalid photo path';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'menu-images' and o.name = p_path) then
      raise exception 'Photo not found — upload it again';
    end if;
  end if;
  update menu_products
     set image_path = p_path, image_updated_at = case when p_path is null then null else now() end, updated_at = now()
   where id = p_product_id;
  return case when v_old is distinct from p_path then v_old end;
end $$;
revoke all on function menu_set_product_image(uuid, text) from public, anon;
grant execute on function menu_set_product_image(uuid, text) to authenticated;

-- ── The counter: time slots of one catalog's products, with the server's clock ──
-- Each window of each schedule followed by a product the catalog sells (switched on,
-- not an add-on item, as pos_menu_rows lists them). The pad re-reads it every minute and
-- greys a product out by the server's time (the iPad's own clock only counts the
-- seconds since this read). Live staff with a branch only.
create or replace function pos_menu_windows(p_catalog_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform pos_my_branch();
  return jsonb_build_object(
    'now', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'windows', coalesce((
      select jsonb_agg(menu_window_json(w) || jsonb_build_object('productId', cp.product_id)
                       order by cp.product_id, s.sort_order, s.name, w.sort_order)
        from catalog_products cp
        join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
        join product_schedules ps on ps.product_id = cp.product_id
        join menu_schedules s on s.id = ps.schedule_id
        join menu_schedule_windows w on w.schedule_id = s.id
       where cp.catalog_id = p_catalog_id and cp.availability <> 'hidden'), '[]'::jsonb));
end $$;
revoke all on function pos_menu_windows(uuid) from public, anon;
grant execute on function pos_menu_windows(uuid) to authenticated;

-- ── pos_insert_order, re-created: a product outside its time slots is refused
--    (offline orders too: they are judged by the server's clock when they arrive) ──
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

-- ── qr_menu, re-created: products outside their time slots are left out; each
--    product carries its photo path (the QR page builds the public URL) ─────
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

-- PostgREST picks up the new functions now, not at its next poll
notify pgrst, 'reload schema';

select 'time slots and photos functions applied' as result;
