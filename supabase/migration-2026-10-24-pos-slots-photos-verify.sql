-- Self-check for the POS menu time slots and photos (M3). Run on craft-os-dev after
-- migration-2026-10-24-pos-slots-photos.sql and -slots-photos-fn.sql. Everything is rolled back.
-- Success = a result row "VERIFY OK". Every refusal is paired with the success it guards; the
-- Edit menu checks call each function as `authenticated` (grants too).
-- The vectors below are a byte-for-byte copy of src/features/pos/menu/slotVectors.json
-- (slotVectorsSql.test.ts fails if the two differ).
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
exception when raise_exception then
  if sqlerrm <> p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- A minute of the day (any whole number, taken modulo one day) as a time.
create function pg_temp.hm(p_minute integer) returns time
language sql immutable as $$
  select make_time(((p_minute % 1440 + 1440) % 1440) / 60, ((p_minute % 1440 + 1440) % 1440) % 60, 0)
$$;

-- A window as menu_save_schedule takes it.
create function pg_temp.win(p_days integer[], p_start time, p_end time) returns jsonb
language sql immutable as $$
  select jsonb_build_object('days', to_jsonb(p_days), 'start', to_char(p_start, 'HH24:MI'), 'end', to_char(p_end, 'HH24:MI'))
$$;

do $$
declare
  v_vectors jsonb := $vectors$
[
  {"name": "inside a weekday window: Mon 09:00", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T01:00:00Z", "open": true},
  {"name": "the start minute counts: Mon 08:00", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T00:00:00Z", "open": true},
  {"name": "the end minute counts, to its last second: Mon 11:30:59", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T03:30:59Z", "open": true},
  {"name": "a minute after the end: Mon 11:31", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T03:31:00Z", "open": false},
  {"name": "a minute before the start: Mon 07:59 (still Sunday in UTC)", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-25T23:59:00Z", "open": false},
  {"name": "Malaysian day, not the UTC day: Mon 00:30 is Sunday 16:30 UTC", "days": [1], "start": "00:00", "end": "08:00", "at": "2026-10-25T16:30:00Z", "open": true},
  {"name": "a day that is not listed: Sat 09:00", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-24T01:00:00Z", "open": false},
  {"name": "crossing midnight, before midnight on the start day: Fri 23:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T15:00:00Z", "open": true},
  {"name": "crossing midnight, after midnight belongs to the start day: Sat 01:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T17:00:00Z", "open": true},
  {"name": "crossing midnight, the end minute counts: Sat 02:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T18:00:00Z", "open": true},
  {"name": "crossing midnight, a minute after the end: Sat 02:01", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T18:01:00Z", "open": false},
  {"name": "crossing midnight, early morning of the start day belongs to the day before: Fri 01:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-22T17:00:00Z", "open": false},
  {"name": "crossing midnight, evening of a day that is not listed: Sat 23:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-24T15:00:00Z", "open": false},
  {"name": "Sunday is day 7: Sun 12:00", "days": [7], "start": "10:00", "end": "23:59", "at": "2026-10-25T04:00:00Z", "open": true},
  {"name": "Sunday night into Monday: Mon 01:30", "days": [7], "start": "22:00", "end": "02:00", "at": "2026-10-25T17:30:00Z", "open": true},
  {"name": "Feedme's 10:00–23:59 runs to midnight: Sat 23:59:30", "days": [1, 2, 3, 4, 5, 6, 7], "start": "10:00", "end": "23:59", "at": "2026-10-24T15:59:30Z", "open": true},
  {"name": "Feedme's 10:00–23:59 is closed at midnight: Sun 00:00", "days": [1, 2, 3, 4, 5, 6, 7], "start": "10:00", "end": "23:59", "at": "2026-10-24T16:00:00Z", "open": false},
  {"name": "an end of 00:00 is the first minute of the next day: Tue 00:00", "days": [1], "start": "18:00", "end": "00:00", "at": "2026-10-26T16:00:00Z", "open": true},
  {"name": "an end of 00:00, a minute later: Tue 00:01", "days": [1], "start": "18:00", "end": "00:00", "at": "2026-10-26T16:01:00Z", "open": false}
]
$vectors$;
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_mgr     uuid := 'dddddddd-0000-0000-0000-000000000031';   -- manager of VERIFY M3: no manage_menu
  v_cashier uuid := 'dddddddd-0000-0000-0000-000000000032';   -- staff of VERIFY M3
  v_boss    uuid := 'dddddddd-0000-0000-0000-000000000033';   -- a second owner, resigned in J
  v_branch uuid; v_t1 dining_tables;
  v_cat uuid; c_dine uuid; c_qr uuid;
  v_pancake uuid; v_latte uuid; v_toast uuid; v_soup uuid; v_noodle uuid;
  v_pancake_v uuid; v_latte_v uuid; v_toast_v uuid; v_soup_v uuid; v_noodle_v uuid;
  s_late uuid; s_open uuid; s_closed uuid; s_cross_open uuid; s_cross_closed uuid;
  v_local timestamp; v_dow integer; v_min integer; v_yesterday integer; v_later integer;
  v_s jsonb; v_res jsonb; v_text text; v_id uuid; v_order uuid; n integer; r record;
  v_path text; v_path2 text; v_res_ids uuid[]; v_skip_i boolean;
begin
  -- ── A. grants, internal helpers, search_path, policies ────────────────────
  for r in select f from unnest(array[
             'menu_schedule_list()', 'menu_schedule_detail(uuid)', 'menu_product_extras(uuid)', 'menu_photo_targets()',
             'menu_save_schedule(jsonb)', 'menu_reorder_schedules(uuid[])', 'menu_delete_schedule(uuid)',
             'menu_set_product_schedules(uuid,uuid[])', 'menu_set_product_image(uuid,text)', 'pos_menu_windows(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array[
             'menu_window_open(smallint[],time,time,timestamptz)', 'menu_product_open(uuid,timestamptz)',
             'menu_window_json(menu_schedule_windows)', 'menu_hm(jsonb)', 'menu_days(jsonb)',
             'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'qr_menu(text)', 'execute') then raise exception 'FAIL grants: the QR page cannot call qr_menu'; end if;
  if (select count(*) from pg_proc where proname = 'pos_insert_order') <> 1 then
    raise exception 'FAIL: more than one pos_insert_order — an old file was re-run; re-run the M1 and M3 function files';
  end if;
  -- re-running M1's function file silently drops the slot check and the QR filter
  if pg_get_functiondef('pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)'::regprocedure) not like '%menu_product_open%'
     or pg_get_functiondef('qr_menu(text)'::regprocedure) not like '%menu_product_open%' then
    raise exception 'FAIL: pos_insert_order or qr_menu has no time-slot check — re-run migration-2026-10-24-pos-slots-photos-fn.sql';
  end if;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array[
              'menu_window_open','menu_product_open','menu_window_json','menu_hm','menu_days','menu_schedule_list',
              'menu_schedule_detail','menu_product_extras','menu_photo_targets','menu_save_schedule','menu_reorder_schedules',
              'menu_delete_schedule','menu_set_product_schedules','menu_set_product_image','pos_menu_windows',
              'pos_insert_order','qr_menu'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  -- the three new tables are written only through the Edit menu functions
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('menu_schedules','menu_schedule_windows','product_schedules') and cmd <> 'SELECT') then
    raise exception 'FAIL rls: a time-slot table can be written directly';
  end if;
  if exists (select 1 from pg_class where relname in ('menu_schedules','menu_schedule_windows','product_schedules')
              and relnamespace = 'public'::regnamespace and not relrowsecurity) then
    raise exception 'FAIL rls: a time-slot table has row level security off';
  end if;
  if not exists (select 1 from storage.buckets where id = 'menu-images' and public
                   and allowed_mime_types @> array['image/webp', 'image/jpeg'] and file_size_limit = 2097152) then
    raise exception 'FAIL storage: bucket menu-images is missing or not public';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'menu_images_read' and cmd = 'SELECT' and roles = array['authenticated']::name[]) then
    raise exception 'FAIL storage: menu-images must be listable by signed-in staff only (public URLs need no policy)';
  end if;
  for r in select x.cmd from unnest(array['INSERT', 'UPDATE', 'DELETE']) as x(cmd) loop
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd = r.cmd
                     and coalesce(qual, '') || coalesce(with_check, '') like '%menu-images%'
                     and coalesce(qual, '') || coalesce(with_check, '') like '%has_menu_cap(''manage_menu''::text)%') then
      raise exception 'FAIL storage: no Edit menu % policy on menu-images', r.cmd;
    end if;
  end loop;
  -- M3 final fixes: the delete policy spares a file a product points at; menu_window_open is stable
  -- (it reads the time zone database); schedule names are unique whatever their case
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'menu_images_delete' and cmd = 'DELETE' and qual like '%image_path%') then
    raise exception 'FAIL storage: menu_images_delete must refuse a file a product still points at — re-run migration-2026-10-24-pos-slots-photos.sql';
  end if;
  if (select provolatile from pg_proc where oid = 'menu_window_open(smallint[],time,time,timestamptz)'::regprocedure) <> 's' then
    raise exception 'FAIL: menu_window_open must be stable — re-run migration-2026-10-24-pos-slots-photos-fn.sql';
  end if;
  if to_regclass('public.menu_schedules_name_lower_idx') is null then
    raise exception 'FAIL: no case-insensitive unique index on schedule names — re-run migration-2026-10-24-pos-slots-photos.sql';
  end if;

  -- ── B. the time maths: the shared vectors ─────────────────────────────────
  if jsonb_array_length(v_vectors) <> 19 then raise exception 'FAIL vectors: expected 19, got %', jsonb_array_length(v_vectors); end if;
  for r in select v from jsonb_array_elements(v_vectors) v loop
    if menu_window_open(array(select jsonb_array_elements_text(r.v->'days')::smallint), (r.v->>'start')::time,
                        (r.v->>'end')::time, (r.v->>'at')::timestamptz) is distinct from (r.v->>'open')::boolean then
      raise exception 'FAIL B %: expected open = %', r.v->>'name', r.v->>'open';
    end if;
  end loop;

  -- ── C. fixture: a branch, two catalogs, five products, staff ──────────────
  update system_role_permissions set permissions = permissions - 'manage_menu';   -- code defaults for this run
  insert into branches(name, address) values ('VERIFY M3', 'verify') returning id into v_branch;
  insert into dining_tables(branch_id, label) values (v_branch, 'M3') returning * into v_t1;
  insert into menu_categories(name, sort_order) values ('VERIFY M3 FOOD', 900) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY M3 Dine', 900) returning id into c_dine;
  insert into menu_catalogs(name, sort_order) values ('VERIFY M3 QR', 901) returning id into c_qr;
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', c_dine), (v_branch, 'takeaway', c_dine), (v_branch, 'qr', c_qr);
  insert into menu_products(name, category_id) values ('Verify M3 Pancake', v_cat) returning id into v_pancake;
  insert into menu_products(name, category_id) values ('Verify M3 Latte', v_cat) returning id into v_latte;
  insert into menu_products(name, category_id) values ('Verify M3 Toast', v_cat) returning id into v_toast;
  insert into menu_products(name, category_id) values ('Verify M3 Soup', v_cat) returning id into v_soup;
  insert into menu_products(name, category_id) values ('Verify M3 Noodle', v_cat) returning id into v_noodle;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_pancake, '', 'Regular', 1500) returning id into v_pancake_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_latte, '', 'Regular', 1200) returning id into v_latte_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_toast, '', 'Regular', 800) returning id into v_toast_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_soup, '', 'Regular', 900) returning id into v_soup_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_noodle, '', 'Regular', 1100) returning id into v_noodle_v;
  insert into catalog_products(catalog_id, product_id, availability)
  select c, p, 'all' from unnest(array[c_dine, c_qr]) c cross join unnest(array[v_pancake, v_latte, v_toast, v_soup, v_noodle]) p;
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
  select c, v, 1000 from unnest(array[c_dine, c_qr]) c cross join unnest(array[v_pancake_v, v_latte_v, v_toast_v, v_soup_v, v_noodle_v]) v;
  -- staff are inserted as 'staff' and promoted by the owner (the staff guard refuses anything else)
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  insert into auth.users (id) values (v_mgr), (v_cashier), (v_boss);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_mgr,     'Verify M3 Manager', 'trainee', true, current_date, 'staff', v_branch),
    (v_cashier, 'Verify M3 Cashier', 'trainee', true, current_date, 'staff', v_branch),
    (v_boss,    'Verify M3 Boss',    'trainee', true, current_date, 'staff', v_branch);
  update staff set system_role = 'manager' where id = v_mgr;
  update staff set system_role = 'owner' where id = v_boss;
  if not staff_has_cap(v_owner, 'manage_menu') then raise exception 'FAIL fixture: the test login (owner) lacks manage_menu'; end if;

  -- ── D. menu_save_schedule and menu_delete_schedule ───────────────────────
  v_s := jsonb_build_object('id', null, 'name', '  Verify  M3 Late night ',
    'windows', jsonb_build_array(pg_temp.win(array[5, 6], '22:00', '02:00'), pg_temp.win(array[1, 2, 3, 4, 5], '11:00', '14:00')),
    'productIds', jsonb_build_array(v_soup));
  -- D1. every refusal leaves nothing behind, and says why in the editor's words
  select count(*) into n from menu_schedules;
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', '[]'), 'Invalid schedule', 'D1 not an object');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{name}', '" "')),
    'Schedule name is required', 'D1 blank name');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{name}', to_jsonb(repeat('x', 61)))),
    'Schedule name is too long (at most 60 characters)', 'D1 long name');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows}', '[]')),
    'A schedule needs at least one time window', 'D1 no window');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)',
      jsonb_set(v_s, '{windows}', (select jsonb_agg(pg_temp.win(array[1], '08:00', '09:00')) from generate_series(1, 11)))),
    'Too many time windows (at most 10)', 'D1 eleven windows');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,days}', '[]')),
    'Pick at least one day for each time window', 'D1 no day');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,days}', '[0, 1]')),
    'Invalid schedule', 'D1 day 0');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,days}', '["1"]')),
    'Invalid schedule', 'D1 day as text');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,start}', '"24:00"')),
    'Enter each time as HH:MM, e.g. 08:00', 'D1 24:00');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,end}', '"2:00"')),
    'Enter each time as HH:MM, e.g. 08:00', 'D1 2:00');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,end}', '"22:00"')),
    'A time window cannot start and end at the same time', 'D1 empty window');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{productIds}', '{"a": 1}')),
    'Invalid schedule', 'D1 productIds not a list');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{productIds}', jsonb_build_array(gen_random_uuid()))),
    'Product not found — refresh and try again', 'D1 unknown product');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{productIds}', '["x"]')),
    'Invalid schedule', 'D1 product id not a uuid');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{id}', to_jsonb(gen_random_uuid()))),
    'Schedule not found — refresh and try again', 'D1 unknown schedule');
  if (select count(*) from menu_schedules) <> n then raise exception 'FAIL D1: a refused save left a schedule behind'; end if;
  -- D2. created: name cleaned, windows in order (days sorted, minutes kept), linked product
  s_late := menu_save_schedule(v_s);
  if (select name from menu_schedules where id = s_late) <> 'Verify M3 Late night'
     or (select jsonb_agg(menu_window_json(w) order by w.sort_order) from menu_schedule_windows w where w.schedule_id = s_late)
        <> jsonb_build_array(jsonb_build_object('days', jsonb_build_array(5, 6), 'start', '22:00', 'end', '02:00'),
                             jsonb_build_object('days', jsonb_build_array(1, 2, 3, 4, 5), 'start', '11:00', 'end', '14:00'))
     or not exists (select 1 from product_schedules where product_id = v_soup and schedule_id = s_late) then
    raise exception 'FAIL D2: the created schedule';
  end if;
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{name}', '"verify m3 LATE night"')),
    'A schedule called verify m3 LATE night already exists', 'D2 twin name');
  -- D2b. two names differing only in case are refused by the table too (two saves at the same
  --      moment both pass the function's check; the index stops the second)
  begin
    insert into menu_schedules(name) values ('VERIFY M3 LATE NIGHT');
    raise exception 'FAIL D2b: the table accepted a name differing only in case';
  exception when unique_violation then
    null;
  end;
  begin
    insert into menu_schedules(name) values ('Verify M3 Case'), ('verify m3 case');
    raise exception 'FAIL D2b: the table accepted two names differing only in case';
  exception when unique_violation then
    null;
  end;
  if exists (select 1 from menu_schedules where lower(name) = 'verify m3 case') then
    raise exception 'FAIL D2b: a refused name was written';
  end if;
  -- renaming a schedule to its own name in another case is allowed (same row)
  perform menu_save_schedule(jsonb_set(jsonb_set(v_s, '{id}', to_jsonb(s_late)), '{name}', '"VERIFY M3 LATE NIGHT"'));
  if (select name from menu_schedules where id = s_late) <> 'VERIFY M3 LATE NIGHT' then
    raise exception 'FAIL D2b: a schedule could not change the case of its own name';
  end if;
  perform menu_save_schedule(jsonb_set(v_s, '{id}', to_jsonb(s_late)));
  -- D3. edited: windows replaced, productIds left out = links kept
  perform menu_save_schedule(jsonb_build_object('id', s_late, 'name', 'Verify M3 Late night',
    'windows', jsonb_build_array(pg_temp.win(array[6, 5, 5], '22:00', '02:00'))));
  if (select count(*) from menu_schedule_windows where schedule_id = s_late) <> 1
     or (select days from menu_schedule_windows where schedule_id = s_late) <> array[5, 6]::smallint[]
     or not exists (select 1 from product_schedules where product_id = v_soup and schedule_id = s_late) then
    raise exception 'FAIL D3: a save that left out productIds changed the links, or the windows were not replaced';
  end if;
  -- D4. productIds given = the whole set of products that follow it
  perform menu_save_schedule(jsonb_build_object('id', s_late, 'name', 'Verify M3 Late night',
    'windows', jsonb_build_array(pg_temp.win(array[5, 6], '22:00', '02:00'), pg_temp.win(array[1, 2, 3, 4, 5], '11:00', '14:00')),
    'productIds', jsonb_build_array(v_noodle, v_noodle)));
  if exists (select 1 from product_schedules where product_id = v_soup and schedule_id = s_late)
     or (select count(*) from product_schedules where schedule_id = s_late) <> 1 then
    raise exception 'FAIL D4: the linked products were not replaced by the list';
  end if;
  -- D5. a product follows at most 20 schedules, from the schedule's side too
  for n in 1 .. 20 loop
    perform menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Many ' || n,
      'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], '00:00', '23:59')), 'productIds', jsonb_build_array(v_latte)));
  end loop;
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_build_object('id', null, 'name', 'Verify M3 Many 21',
      'windows', jsonb_build_array(pg_temp.win(array[1], '08:00', '09:00')), 'productIds', jsonb_build_array(v_latte))),
    'Verify M3 Latte follows too many schedules (at most 20)', 'D5 twenty-first schedule');
  v_id := (select id from menu_schedules where name = 'Verify M3 Many 20');
  perform menu_save_schedule(jsonb_build_object('id', v_id, 'name', 'Verify M3 Many 20',          -- one of its 20 may be saved again
    'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], '00:00', '23:59')), 'productIds', jsonb_build_array(v_latte)));
  -- D6. Delete (Feedme's way, no on/off switch): the schedule, its windows and its links go
  for r in select id from menu_schedules where name like 'Verify M3 Many %' loop
    perform menu_delete_schedule(r.id);
  end loop;
  if exists (select 1 from menu_schedules where name like 'Verify M3 Many %')
     or exists (select 1 from product_schedules where product_id = v_latte)
     or exists (select 1 from menu_schedule_windows w where not exists (select 1 from menu_schedules s where s.id = w.schedule_id)) then
    raise exception 'FAIL D6: a deleted schedule left its windows or links behind';
  end if;
  perform pg_temp.expect_error(format('select menu_delete_schedule(%L)', gen_random_uuid()),
    'Schedule not found — refresh and try again', 'D6 unknown');
  perform pg_temp.expect_error('select menu_delete_schedule(null)', 'Schedule not found — refresh and try again', 'D6 null');

  -- ── E. menu_product_open at fixed instants: any window of any schedule it follows ─
  -- Noodle follows Late night: Fri + Sat 22:00–02:00 and Mon–Fri 11:00–14:00.
  for r in select * from (values
      ('2026-10-23T15:00:00Z'::timestamptz, true,  'Fri 23:00'),
      ('2026-10-24T17:30:00Z'::timestamptz, true,  'Sun 01:30 (Saturday night)'),
      ('2026-10-24T18:01:00Z'::timestamptz, false, 'Sun 02:01'),
      ('2026-10-25T15:00:00Z'::timestamptz, false, 'Sun 23:00'),
      ('2026-10-26T04:00:00Z'::timestamptz, true,  'Mon 12:00 (lunch window)'),
      ('2026-10-26T06:01:00Z'::timestamptz, false, 'Mon 14:01')) as x(at, open, label) loop
    if menu_product_open(v_noodle, r.at) is distinct from r.open then
      raise exception 'FAIL E %: expected open = %', r.label, r.open;
    end if;
  end loop;
  if not menu_product_open(v_latte, '2026-10-25T19:00:00Z') then raise exception 'FAIL E: a product with no schedule is always open'; end if;
  perform menu_save_schedule(jsonb_build_object('id', s_late, 'name', 'Verify M3 Late night',
    'windows', jsonb_build_array(pg_temp.win(array[5, 6], '22:00', '02:00')), 'productIds', '[]'::jsonb));
  if not menu_product_open(v_noodle, '2026-10-25T15:00:00Z') then
    raise exception 'FAIL E: a product that no longer follows a schedule must be open';
  end if;

  -- ── F. ordering by the server's clock (windows built around the current Malaysian minute) ─
  v_local := now() at time zone 'Asia/Kuala_Lumpur';
  v_dow := extract(isodow from v_local)::integer;
  v_min := (extract(hour from v_local) * 60 + extract(minute from v_local))::integer;
  v_yesterday := case when v_dow = 1 then 7 else v_dow - 1 end;
  v_later := v_dow % 7 + 2;                                        -- neither today nor yesterday
  if v_later > 7 then v_later := v_later - 7; end if;
  s_open := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Open now',
    'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], pg_temp.hm(v_min - 1), pg_temp.hm(v_min + 1))),
    'productIds', jsonb_build_array(v_toast)));
  s_closed := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Closed now',
    'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], pg_temp.hm(v_min + 60), pg_temp.hm(v_min + 120))),
    'productIds', jsonb_build_array(v_pancake, v_toast)));
  -- crossing midnight and open now: started yesterday at 23:59, ends at this very minute
  -- (at 23:59 itself: started today at 23:59, ends at 00:00)
  s_cross_open := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Cross open',
    'windows', jsonb_build_array(case when v_min < 1439 then pg_temp.win(array[v_yesterday], '23:59', pg_temp.hm(v_min))
                                      else pg_temp.win(array[v_dow], '23:59', '00:00') end),
    'productIds', jsonb_build_array(v_soup)));
  -- crossing midnight and closed now: from the next minute round to the minute before
  -- (at 00:00 and 23:59: a crossing window on a day that is neither today nor yesterday)
  s_cross_closed := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Cross closed',
    'windows', jsonb_build_array(case when v_min between 1 and 1438 then pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], pg_temp.hm(v_min + 1), pg_temp.hm(v_min - 1))
                                      else pg_temp.win(array[v_later], '23:00', '01:00') end),
    'productIds', jsonb_build_array(v_noodle)));
  if (select count(*) from menu_schedule_windows w where w.schedule_id in (s_cross_open, s_cross_closed) and w.end_time < w.start_time) <> 2 then
    raise exception 'FAIL F fixture: both cross windows must cross midnight';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  -- F1. outside every window: refused in the server's words, nothing written
  select count(*) into n from orders;
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, 2, %L::jsonb, %L)', v_t1.id, 'dine_in',
      jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_latte_v),
                        jsonb_build_object('productId', v_pancake, 'variantId', v_pancake_v)), gen_random_uuid()),
    'Verify M3 Pancake is not available at this time', 'F1 pancake (closed window)');
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, 2, %L::jsonb, %L)', v_t1.id, 'dine_in',
      jsonb_build_array(jsonb_build_object('productId', v_noodle, 'variantId', v_noodle_v)), gen_random_uuid()),
    'Verify M3 Noodle is not available at this time', 'F1 noodle (closed window crossing midnight)');
  perform pg_temp.expect_error(format('select place_table_order(%L, 2, %L::jsonb, %L)', v_t1.qr_token,
      jsonb_build_array(jsonb_build_object('productId', v_pancake, 'variantId', v_pancake_v)), gen_random_uuid()),
    'Verify M3 Pancake is not available at this time', 'F1 pancake by QR');
  if (select count(*) from orders) <> n then raise exception 'FAIL F1: a refused order was written'; end if;
  -- F2. inside a window (any one), or no schedule at all: accepted
  v_order := place_counter_order(v_t1.id, 'dine_in', 2, jsonb_build_array(
    jsonb_build_object('productId', v_latte, 'variantId', v_latte_v),
    jsonb_build_object('productId', v_toast, 'variantId', v_toast_v),
    jsonb_build_object('productId', v_soup, 'variantId', v_soup_v)), gen_random_uuid());
  if (select count(*) from order_items where order_id = v_order) <> 3 then
    raise exception 'FAIL F2: latte (no schedule), toast (one open window) and soup (open, crossing midnight) must sell';
  end if;
  -- F3. a deleted schedule no longer refuses: the latte follows a closed one, then it is deleted
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_id := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Gone',
    'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], pg_temp.hm(v_min + 60), pg_temp.hm(v_min + 120))),
    'productIds', jsonb_build_array(v_latte)));
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, null, %L::jsonb, %L)', v_t1.id, 'dine_in',
      jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_latte_v)), gen_random_uuid()),
    'Verify M3 Latte is not available at this time', 'F3 latte before the delete');
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform menu_delete_schedule(v_id);
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_latte_v)), gen_random_uuid());
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- ── G. what the QR page and the counter read ──────────────────────────────
  -- G1. qr_menu leaves out products outside their slots and gives each product its photo path
  update menu_products set image_path = 'products/' || v_latte || '/verifyphoto1.webp' where id = v_latte;
  v_res := (select jsonb_agg(pr) from jsonb_array_elements(qr_menu(v_t1.qr_token)->'categories') c
              cross join jsonb_array_elements(c->'products') pr where c->>'name' = 'VERIFY M3 FOOD');
  if exists (select 1 from jsonb_array_elements(v_res) pr where pr->>'id' in (v_pancake::text, v_noodle::text))
     or (select count(*) from jsonb_array_elements(v_res) pr where pr->>'id' in (v_latte::text, v_toast::text, v_soup::text)) <> 3
     or (select pr->>'imagePath' from jsonb_array_elements(v_res) pr where pr->>'id' = v_latte::text)
        is distinct from 'products/' || v_latte || '/verifyphoto1.webp'
     or not (select pr ? 'imagePath' from jsonb_array_elements(v_res) pr where pr->>'id' = v_toast::text) then
    raise exception 'FAIL G1: qr_menu %', v_res;
  end if;
  -- G2. the counter: windows of the catalog's scheduled products, by the server's clock; the menu itself is unchanged
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := pos_menu_windows(c_dine);
  reset role;
  if (select count(*) from jsonb_array_elements(v_res->'windows') w where w->>'productId' = v_toast::text) <> 2
     or (select count(*) from jsonb_array_elements(v_res->'windows') w where w->>'productId' = v_pancake::text) <> 1
     or exists (select 1 from jsonb_array_elements(v_res->'windows') w where w->>'productId' = v_latte::text)
     or not exists (select 1 from jsonb_array_elements(v_res->'windows') w
                     where w->>'productId' = v_pancake::text and w->>'start' = to_char(pg_temp.hm(v_min + 60), 'HH24:MI')
                       and w->'days' = '[1, 2, 3, 4, 5, 6, 7]'::jsonb)
     or abs(extract(epoch from (v_res->>'now')::timestamptz - now())) > 1 then
    raise exception 'FAIL G2: pos_menu_windows %', v_res;
  end if;
  if not exists (select 1 from jsonb_array_elements(pos_menu_rows(c_dine)->'products') pr where pr->>'id' = v_pancake::text) then
    raise exception 'FAIL G2: the pad still lists a product outside its slots (it greys it out)';
  end if;
  -- a switched-off product is not on the pad, so its windows are not sent either
  update menu_products set is_active = false where id = v_pancake;
  if exists (select 1 from jsonb_array_elements(pos_menu_windows(c_dine)->'windows') w where w->>'productId' = v_pancake::text) then
    raise exception 'FAIL G2: a switched-off product''s windows reach the counter';
  end if;
  update menu_products set is_active = true where id = v_pancake;
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select pos_menu_windows(%L)', c_dine), 'Your account is not active', 'G2 not staff');
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- ── H. the Schedules page and the product editor's Time slots ─────────────
  v_res := (select x from jsonb_array_elements(menu_schedule_list()) x where x->>'id' = s_closed::text);
  if (v_res->>'productCount')::int <> 2 or jsonb_array_length(v_res->'windows') <> 1 or v_res->>'name' <> 'Verify M3 Closed now' then
    raise exception 'FAIL H: menu_schedule_list %', v_res;
  end if;
  -- H0. linkCount counts every linked product (what the Delete confirm says the delete unlinks),
  --     productCount only those on sale
  update menu_products set is_active = false where id = v_toast;
  v_res := (select x from jsonb_array_elements(menu_schedule_list()) x where x->>'id' = s_closed::text);
  if (v_res->>'productCount')::int <> 1 or (v_res->>'linkCount')::int <> 2 then
    raise exception 'FAIL H0: a switched-off product must count in linkCount only %', v_res;
  end if;
  update menu_products set is_active = true where id = v_toast;
  v_res := menu_schedule_detail(s_closed);
  if not (v_res->'productIds' @> jsonb_build_array(v_pancake, v_toast)) or jsonb_array_length(v_res->'windows') <> 1 then
    raise exception 'FAIL H: menu_schedule_detail %', v_res;
  end if;
  perform pg_temp.expect_error(format('select menu_schedule_detail(%L)', gen_random_uuid()), 'Schedule not found', 'H unknown');
  -- H1. a product's schedules: the whole set, empty = always available
  perform menu_set_product_schedules(v_toast, array[s_closed, s_open, s_open]);
  if (select count(*) from product_schedules where product_id = v_toast) <> 2 then
    raise exception 'FAIL H1: the product''s schedules';
  end if;
  v_res := menu_product_extras(v_toast);
  if not (v_res->'scheduleIds' @> jsonb_build_array(s_closed, s_open)) or v_res->'imagePath' <> 'null'::jsonb then
    raise exception 'FAIL H1: menu_product_extras %', v_res;
  end if;
  perform menu_set_product_schedules(v_toast, '{}');
  if exists (select 1 from product_schedules where product_id = v_toast) then raise exception 'FAIL H1: links not removed'; end if;
  perform pg_temp.expect_error(format('select menu_set_product_schedules(%L, %L::uuid[])', v_toast, array[gen_random_uuid()]),
    'Schedule not found — refresh and try again', 'H1 unknown schedule');
  perform pg_temp.expect_error(format('select menu_set_product_schedules(%L, %L::uuid[])', v_toast,
      (select array_agg(gen_random_uuid()) from generate_series(1, 21))),
    'Too many schedules (at most 20)', 'H1 twenty-one schedules');
  perform pg_temp.expect_error(format('select menu_set_product_schedules(%L, null)', v_toast), 'Invalid schedule', 'H1 null list');
  perform pg_temp.expect_error(format('select menu_set_product_schedules(%L, %L::uuid[])', gen_random_uuid(), array[s_open]),
    'Product not found — refresh and try again', 'H1 unknown product');
  perform pg_temp.expect_error(format('select menu_product_extras(%L)', gen_random_uuid()), 'Product not found', 'H1 extras unknown');
  -- H2. reorder
  select array_agg(id order by sort_order desc, name desc) into v_res_ids from menu_schedules;
  perform menu_reorder_schedules(v_res_ids);
  if (select array_agg(id order by sort_order) from menu_schedules) <> v_res_ids then raise exception 'FAIL H2: reorder'; end if;
  perform pg_temp.expect_error(format('select menu_reorder_schedules(%L::uuid[])', v_res_ids[2:]),
    'The schedule list changed — refresh and try again', 'H2 one missing');

  -- ── J. Edit menu for every editor function: manager refused, owner allowed, resigned owner refused ─
  --    (before I: section I depends on dev's Storage internals, this must not)
  update staff set status = 'resigned' where id = v_boss;                    -- is_active stays true, as in real life
  select array_agg(id order by sort_order, name) into v_res_ids from menu_schedules;
  for r in select * from (values (v_mgr, false, 'manager'), (v_owner, true, 'owner'), (v_boss, false, 'resigned owner'))
                          as x(who, allowed, label) loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    v_id := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 J ' || r.label,     -- for the delete below
      'windows', jsonb_build_array(pg_temp.win(array[1], '08:00', '09:00'))));
    perform set_config('request.jwt.claims', json_build_object('sub', r.who, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin perform menu_schedule_list();
      if not r.allowed then raise exception 'FAIL J %: menu_schedule_list', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_schedule_detail(s_open);
      if not r.allowed then raise exception 'FAIL J %: menu_schedule_detail', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_product_extras(v_latte);
      if not r.allowed then raise exception 'FAIL J %: menu_product_extras', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_photo_targets();
      if not r.allowed then raise exception 'FAIL J %: menu_photo_targets', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_schedule(jsonb_build_object('id', s_open, 'name', 'Verify M3 Open now',
            'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], pg_temp.hm(v_min - 1), pg_temp.hm(v_min + 1)))));
      if not r.allowed then raise exception 'FAIL J %: menu_save_schedule', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_reorder_schedules(v_res_ids || (select array_agg(id) from menu_schedules where name like 'Verify M3 J %'));
      if not r.allowed then raise exception 'FAIL J %: menu_reorder_schedules', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_delete_schedule(v_id);
      if not r.allowed then raise exception 'FAIL J %: menu_delete_schedule', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_set_product_schedules(v_latte, '{}');
      if not r.allowed then raise exception 'FAIL J %: menu_set_product_schedules', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_set_product_image(v_soup, null);
      if not r.allowed then raise exception 'FAIL J %: menu_set_product_image', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    reset role;
  end loop;
  if exists (select 1 from menu_schedules where name = 'Verify M3 J owner')
     or (select count(*) from menu_schedules where name like 'Verify M3 J %') <> 2 then
    raise exception 'FAIL J: only the owner''s delete may go through';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- ── I. photos (last: it writes test rows into storage.objects, and dev's real Storage may
  --    refuse those for reasons of its own — then the parts that need them are skipped with
  --    a SKIP notice, and the rest still reaches VERIFY OK) ──────────────────
  v_path := 'products/' || v_pancake || '/verifyphotoA1.webp';
  v_path2 := 'products/' || v_pancake || '/verifyphotoB2.jpg';
  v_skip_i := false;
  -- I1. storage policies: a manager cannot upload; the owner can, under products/ only. A refusal
  --     counts only when the RLS policy on "objects" made it (not a trigger).
  for r in select * from (values (v_mgr, v_path, 'a manager uploaded a menu photo'),
                                 (v_owner, 'elsewhere/verifyphotoX.webp', 'a menu photo outside products/ was accepted'))
                          as x(who, name, label) loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.who, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      insert into storage.objects(bucket_id, name) values ('menu-images', r.name);
      raise exception 'FAIL I1: %', r.label;
    exception when others then
      if sqlerrm like 'FAIL %' then raise; end if;
      if sqlerrm not like '%row-level security policy for table "objects"%' then
        raise notice 'SKIP I: storage refused the test row for its own reasons (%)', sqlerrm;
        v_skip_i := true;
      end if;
    end;
    reset role;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  if not v_skip_i then
    begin
      set local role authenticated;
      insert into storage.objects(bucket_id, name) values ('menu-images', v_path), ('menu-images', v_path2);
    exception when others then
      raise notice 'SKIP I: storage refused the owner''s test rows (%)', sqlerrm;
      v_skip_i := true;
    end;
    reset role;
  end if;
  -- I2. menu_set_product_image: only an uploaded file in the product's own folder (needs no storage row)
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_pancake, 'products/' || v_latte || '/verifyphotoA1.webp'),
    'Invalid photo path', 'I2 another product''s folder');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_pancake, v_path || '.png'),
    'Invalid photo path', 'I2 not webp or jpg');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_pancake, 'products/' || v_pancake || '/verifymissing.webp'),
    'Photo not found — upload it again', 'I2 not uploaded');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', gen_random_uuid(), v_path),
    'Product not found — refresh and try again', 'I2 unknown product');
  if not v_skip_i then
    -- I3. set, replace (returns the old path, which the editor deletes), clear. Each call is made
    --     before the rows are read: one IF does not fix the order its parts run in.
    v_text := menu_set_product_image(v_pancake, v_path);
    if v_text is not null
       or (select image_path from menu_products where id = v_pancake) is distinct from v_path
       or (select image_updated_at from menu_products where id = v_pancake) is null then
      raise exception 'FAIL I3: first photo';
    end if;
    v_text := menu_set_product_image(v_pancake, v_path2);
    if v_text is distinct from v_path then raise exception 'FAIL I3: replacing must return the old path'; end if;
    v_text := menu_set_product_image(v_pancake, v_path2);
    if v_text is not null then raise exception 'FAIL I3: the same path again replaces nothing'; end if;
    v_text := menu_set_product_image(v_pancake, null);
    if v_text is distinct from v_path2
       or (select image_path is null and image_updated_at is null from menu_products where id = v_pancake) is not true then
      raise exception 'FAIL I3: clearing the photo';
    end if;
    -- I3b. a customer (anon) cannot list the bucket; anon and a manager cannot change or delete a photo; the owner can change one
    for r in select * from (values ('anon', null::uuid), ('authenticated', v_mgr)) as x(role, who) loop
      perform set_config('request.jwt.claims', coalesce(json_build_object('sub', r.who, 'role', r.role)::text, '{"role": "anon"}'), true);
      begin
        if r.role = 'anon' then set local role anon; else set local role authenticated; end if;
        if r.role = 'anon' and exists (select 1 from storage.objects where bucket_id = 'menu-images') then
          raise exception 'FAIL I3b: anon can list menu-images';
        end if;
        update storage.objects set metadata = '{"verify": true}' where bucket_id = 'menu-images' and name = v_path;
        get diagnostics n = row_count;
        if n <> 0 then raise exception 'FAIL I3b: % changed a menu photo', r.role; end if;
        delete from storage.objects where bucket_id = 'menu-images' and name = v_path;
        get diagnostics n = row_count;
        if n <> 0 then raise exception 'FAIL I3b: % deleted a menu photo', r.role; end if;
      exception when others then
        if sqlerrm like 'FAIL %' then raise; end if;
        raise notice 'SKIP I3b (%): storage refused the statement for its own reasons (%)', r.role, sqlerrm;
      end;
      reset role;
    end loop;
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      update storage.objects set metadata = '{"verify": true}' where bucket_id = 'menu-images' and name = v_path;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'FAIL I3b: the owner could not change a menu photo'; end if;
    exception when others then
      if sqlerrm like 'FAIL %' then raise; end if;
      raise notice 'SKIP I3b (owner): storage refused the statement for its own reasons (%)', sqlerrm;
    end;
    reset role;
    -- I3c. (M3 final fixes) even the owner cannot delete a file a product still points at — the
    --      delete removes nothing; once the pointer moved off it, the same delete goes through
    v_text := menu_set_product_image(v_pancake, v_path);
    begin
      set local role authenticated;
      delete from storage.objects where bucket_id = 'menu-images' and name = v_path;
      get diagnostics n = row_count;
      if n <> 0 then raise exception 'FAIL I3c: a photo a product points at was deleted'; end if;
      reset role;
      v_text := menu_set_product_image(v_pancake, null);
      set local role authenticated;
      delete from storage.objects where bucket_id = 'menu-images' and name = v_path;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'FAIL I3c: the owner could not delete a photo no product points at'; end if;
    exception when others then
      if sqlerrm like 'FAIL %' then raise; end if;
      raise notice 'SKIP I3c: storage refused the statement for its own reasons (%)', sqlerrm;
    end;
    reset role;
  end if;
  -- I4. the table refuses a path that is not a menu photo, whoever writes it
  begin
    update menu_products set image_path = 'http://example.com/x.png' where id = v_pancake;
    raise exception 'FAIL I4: menu_products accepted a foreign image path';
  exception when check_violation then
    null;
  end;
  -- I5. the import's targets
  v_res := (select x from jsonb_array_elements(menu_photo_targets()) x where x->>'id' = v_latte::text);
  if v_res->>'imagePath' <> 'products/' || v_latte || '/verifyphoto1.webp' or (v_res->>'isAddon')::boolean then
    raise exception 'FAIL I5: menu_photo_targets %', v_res;
  end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
