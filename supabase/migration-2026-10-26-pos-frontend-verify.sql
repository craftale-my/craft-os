-- Self-check for the POS Feedme-layout front end data additions. Run on craft-os-dev after
-- migration-2026-10-26-pos-frontend.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections follow the migration: A schema, grants and search_path; F1 the area
-- column and its guard; F2 the open bill summaries match pos_bill_totals and stay in their
-- branch; F3 the guests of an open dine-in bill.
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- act(staff id): the next calls run as this signed-in staff member
create function pg_temp.act(p_staff uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_staff, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  v_owner  uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_a      uuid := 'eeeeeeee-0000-0000-0000-000000000061';   -- cashier of VERIFY F
  v_far    uuid := 'eeeeeeee-0000-0000-0000-000000000062';   -- cashier of another branch
  v_branch uuid; v_branch2 uuid;
  v_t1 dining_tables; v_t2 dining_tables; v_t3 dining_tables;
  v_cat uuid; v_catalog uuid; v_plate uuid; v_plate_v uuid;
  b1 uuid; b2 uuid; b3 uuid; b4 uuid; b5 uuid; v_id uuid; v_o2 uuid;
  v_tf uuid;
  n integer; m integer; r record;
begin
  -- ── A. schema, grants, search_path, the guard's body ──────────────────────
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dining_tables'
                  and column_name = 'area' and is_nullable = 'YES') then
    raise exception 'FAIL F1 schema: dining_tables.area is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dining_tables_area_check') then
    raise exception 'FAIL F1 schema: dining_tables_area_check is missing';
  end if;
  for r in select f from unnest(array['pos_open_bill_summaries(uuid)', 'pos_set_bill_pax(uuid,integer)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array['pos_open_bill_summaries', 'pos_set_bill_pax', 'dining_tables_guard'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  if pg_get_functiondef('dining_tables_guard()'::regprocedure) not like '%new.area%' then
    raise exception 'FAIL F1: dining_tables_guard does not guard area — re-run migration-2026-10-26-pos-frontend.sql';
  end if;

  -- ── B. fixture: two branches, three tables, one product, one catalog, two cashiers ──
  update system_role_permissions set permissions = permissions - 'pos_supervise' - 'access_settings' where true;   -- code defaults
  insert into branches(name, address) values ('VERIFY F', 'verify') returning id into v_branch;
  insert into branches(name, address) values ('VERIFY F FAR', 'far') returning id into v_branch2;
  insert into dining_tables(branch_id, label, area, sort_order) values (v_branch, 'F1', 'Patio', 1) returning * into v_t1;
  insert into dining_tables(branch_id, label, sort_order) values (v_branch, 'F2', 2) returning * into v_t2;
  insert into dining_tables(branch_id, label, sort_order) values (v_branch, 'F3', 3) returning * into v_t3;
  insert into dining_tables(branch_id, label, sort_order) values (v_branch2, 'FAR1', 1) returning id into v_tf;
  insert into menu_categories(name, sort_order) values ('VERIFY F FOOD', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp, takeaway_fee_sen) values ('Verify F Plate', v_cat, 600, 100) returning id into v_plate;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 2000) returning id into v_plate_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY F CATALOG', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_plate, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_plate_v, 2000);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', v_catalog), (v_branch, 'takeaway', v_catalog), (v_branch, 'qr', v_catalog);
  update staff set branch_id = v_branch where id = v_owner;
  -- staff are inserted as 'staff' by the owner (the staff guard refuses anything else)
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_a), (v_far);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_a,   'Verify F Cashier', 'trainee', true, current_date, 'staff', v_branch),
    (v_far, 'Verify F Far',     'trainee', true, current_date, 'staff', v_branch2);

  -- ── F1. area: trimmed, 1–40 characters or null; only a manager changes it ──
  begin
    update dining_tables set area = ' Patio' where id = v_t2.id;
    raise exception 'FAIL F1: an untrimmed area was accepted';
  exception when check_violation then null;
  end;
  begin
    update dining_tables set area = '' where id = v_t2.id;
    raise exception 'FAIL F1: an empty area was accepted';
  exception when check_violation then null;
  end;
  begin
    update dining_tables set area = repeat('x', 41) where id = v_t2.id;
    raise exception 'FAIL F1: a 41-character area was accepted';
  exception when check_violation then null;
  end;
  update dining_tables set area = repeat('x', 40) where id = v_t2.id;
  update dining_tables set area = 'Hall' where id = v_t2.id;          -- the owner may
  update dining_tables set area = null where id = v_t3.id;
  if (select area from dining_tables where id = v_t2.id) is distinct from 'Hall' then
    raise exception 'FAIL F1: a manager could not set the area';
  end if;
  perform pg_temp.act(v_a);
  perform pg_temp.expect_error(format('update dining_tables set area = %L where id = %L', 'Bar', v_t2.id),
    'Only a manager can change this table''s QR code, branch or status', 'F1 a cashier sets an area');
  update dining_tables set qr_paused = true where id = v_t2.id;      -- any staff may still pause QR
  if not (select qr_paused from dining_tables where id = v_t2.id) then raise exception 'FAIL F1: a cashier can no longer pause QR'; end if;

  -- ── F2. summaries: every open bill of the branch, totals from pos_bill_totals ──
  v_id := place_counter_order(v_t1.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v, 'qty', 2)), gen_random_uuid());
  b1 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  v_o2 := v_id;                                                      -- the table's second order (voided below)
  v_id := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b2 := (select bill_id from orders where id = v_id);
  b3 := open_table(v_t2.id, 3);                                      -- open, nothing on it yet
  perform pg_temp.act(v_far);
  b5 := open_table(v_tf, 2);                                         -- an open bill of the other branch: must not be listed
  perform pg_temp.act(v_a);
  -- one line of the table's second order voided (set by hand: the void path is checked elsewhere)
  reset role;
  update order_items set voided_at = now() where order_id = v_o2;
  perform pg_temp.act(v_a);
  set local role authenticated;
  select count(*), count(*) filter (where
           (s.bill_id = b1 and s.total_sen = (pos_bill_totals(b1)->>'totalSen')::int and s.item_count = 2)
        or (s.bill_id = b2 and s.total_sen = (pos_bill_totals(b2)->>'totalSen')::int and s.item_count = 1)
        or (s.bill_id = b3 and s.total_sen = (pos_bill_totals(b3)->>'totalSen')::int and s.item_count = 0))
    into n, m
    from pos_open_bill_summaries(v_branch) s;
  reset role;
  if n <> 3 or m <> 3 then raise exception 'FAIL F2: % rows, % matching pos_bill_totals (expected 3 and 3)', n, m; end if;
  if exists (select 1 from pos_open_bill_summaries(v_branch) s where s.bill_id = b5) then
    raise exception 'FAIL F2: a bill of another branch is listed';
  end if;
  -- the table: 2 × 20.00 + SST 6% 2.40 = 42.40 (the voided plate does not count)
  if (select s.total_sen from pos_open_bill_summaries(v_branch) s where s.bill_id = b1) is distinct from 4240 then
    raise exception 'FAIL F2: table total is not 42.40';
  end if;
  -- a merged bill is closed: it leaves the list and its items count on the bill it went into
  perform merge_bills(b2, b1);
  select count(*) into n from pos_open_bill_summaries(v_branch);
  if n <> 2 or exists (select 1 from pos_open_bill_summaries(v_branch) s where s.bill_id = b2)
     or (select s.item_count from pos_open_bill_summaries(v_branch) s where s.bill_id = b1) is distinct from 3
     or (select s.total_sen from pos_open_bill_summaries(v_branch) s where s.bill_id = b1)
        is distinct from (pos_bill_totals(b1)->>'totalSen')::int then
    raise exception 'FAIL F2: the merged bill is still listed or the bill it went into is wrong';
  end if;
  -- another branch's staff and anon are refused
  perform pg_temp.act(v_far);
  perform pg_temp.expect_error(format('select * from pos_open_bill_summaries(%L)', v_branch), 'Not your branch', 'F2 another branch');
  set local role anon;
  begin
    perform * from pos_open_bill_summaries(v_branch);
    raise exception 'FAIL F2: anon could read the summaries';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ── F3. the guests of an open dine-in bill ─────────────────────────────────
  perform pg_temp.act(v_a);
  perform pos_set_bill_pax(b1, 5);
  if (select pax from bills where id = b1) is distinct from 5 then raise exception 'FAIL F3: pax was not changed'; end if;
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 0)', b1), 'Invalid number of guests', 'F3 zero guests');
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, null)', b1), 'Invalid number of guests', 'F3 null guests');
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 100)', b1), 'Invalid number of guests', 'F3 100 guests');
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 2)', b2), 'Bill not found', 'F3 a merged bill');
  v_id := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b4 := (select bill_id from orders where id = v_id);
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 2)', b4), 'Bill not found', 'F3 a takeaway bill');
  perform pg_temp.act(v_far);
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 4)', b1), 'Bill not found', 'F3 another branch');
  if (select pax from bills where id = b1) is distinct from 5 then raise exception 'FAIL F3: another branch changed the pax'; end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
