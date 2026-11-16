-- Self-check for POS split bill and move items (Part A). Run on craft-os-dev after
-- migration-2026-11-16-pos-split-bill.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections (one DO block each; the fixture's ids are kept in the temp table
-- fixture): FIXTURE; A1 schema, grants, discount shares, preview and selection checks;
-- A2 checkout_items; A3 move_items; A4 receipt and Z report.
-- Numbers: Latte 13.00 and Cake 15.00, both SST 6%; service charge 10% on dine-in; 5 sen rounding.
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message using errcode = 'assert_failure';
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- act(user id): the next calls run as this signed-in user (a staff login or a POS device)
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

-- the fixture's ids, by name, for every section
create temp table fixture (k text primary key, v uuid);
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;
-- one p_items entry, and one card payment of an amount
create function pg_temp.sel(p_item uuid, p_qty integer) returns jsonb
language sql as $$ select jsonb_build_object('itemId', p_item, 'qty', p_qty) $$;
create function pg_temp.card(p_sen integer) returns jsonb
language sql as $$ select jsonb_build_array(jsonb_build_object('methodId', pg_temp.id('card'), 'amountSen', p_sen)) $$;

-- ── FIXTURE: outlet VERIFY S with tables S1–S9, Latte 13.00 and Cake 15.00 (SST 6%), service
--    charge 10% on dine-in, a card and a cash method, a cashier and a supervisor with PINs, one
--    tablet with the cashier signed in and a shift open; then these bills:
--    S1 (pax 4): Latte ×3 (L1), Cake ×1 (C1), and a voided Cake (C1v) on a second order
--    S2 (pax 2): Latte ×3 (L2) with an item discount of RM 3.00, Cake ×1 (C2)
--    S3 (pax 2): Latte ×3 (L3) with an item discount of RM 1.00, Cake ×1 (C3)
--    S5 (pax 2): Latte ×3 (L5), Cake ×1 (C5), bill discount RM 10.00
--    S6 (pax 2): Latte ×3 (L6), Cake ×1 (C6), bill discount 10%
--    S9 (pax 1): Latte ×1 (L9)
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000005a1';   -- cashier of VERIFY S
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-0000000005a2';   -- supervisor of VERIFY S (approves)
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000005a3';   -- a tablet of VERIFY S
  v_a uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_latte uuid; v_latte_v uuid; v_cake uuid; v_cake_v uuid;
  v_order uuid; v_bill uuid; v_res jsonb; v_items jsonb; r record; i integer;
begin
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;                                                                         -- code defaults
  insert into branches(name, address) values ('VERIFY S', 's') returning id into v_a;
  perform pg_temp.put('branch', v_a);
  for i in 1..9 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'S' || i, i) returning id into v_t;
    perform pg_temp.put('t' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into service_charge_rules(branch_id, rate_bp, order_types, sort_order) values (v_a, 1000, array['dine_in'], 1);
  insert into menu_categories(name, sort_order) values ('VERIFY S DRINKS', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify S Latte', v_cat, 600) returning id into v_latte;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_latte, '', 'Regular', 1300) returning id into v_latte_v;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify S Cake', v_cat, 600) returning id into v_cake;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_cake, '', 'Regular', 1500) returning id into v_cake_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY S MENU', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_latte, 'all'), (v_catalog, v_cake, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_latte_v, 1300), (v_catalog, v_cake_v, 1500);
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  perform pg_temp.put('catalog', v_catalog);
  perform pg_temp.put('latte', v_latte); perform pg_temp.put('latte_v', v_latte_v);
  perform pg_temp.put('cake', v_cake);   perform pg_temp.put('cake_v', v_cake_v);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'S Card', 'card', 1) returning id into v_t;
  perform pg_temp.put('card', v_t);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'S Cash', 'cash', 2) returning id into v_t;
  perform pg_temp.put('cash', v_t);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_dev);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify S Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify S Supervisor', 'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'supervisor' where id = v_sup;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'S Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('sup', v_sup); perform pg_temp.put('cashier', v_cash); perform pg_temp.put('dev', v_dev);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_res := open_shift(10000);
  perform pg_temp.put('shift', (v_res->'shift'->>'id')::uuid);

  -- the bills (as the tablet)
  v_items := jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_latte_v, 'qty', 3),
                               jsonb_build_object('productId', v_cake, 'variantId', v_cake_v));
  for r in select * from (values (1, 4), (2, 2), (3, 2), (5, 2), (6, 2)) as x(n, pax) loop
    v_order := place_counter_order(pg_temp.id('t' || r.n), 'dine_in', r.pax, v_items, gen_random_uuid());
    perform pg_temp.put('b' || r.n, (select bill_id from orders where id = v_order));
    perform pg_temp.put('L' || r.n, (select id from order_items where order_id = v_order and product_id = v_latte));
    perform pg_temp.put('C' || r.n, (select id from order_items where order_id = v_order and product_id = v_cake));
  end loop;
  v_order := place_counter_order(pg_temp.id('t1'), 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_cake, 'variantId', v_cake_v)), gen_random_uuid());
  perform pg_temp.put('C1v', (select id from order_items where order_id = v_order));
  v_res := void_order_item(pg_temp.id('C1v'), 'Wrong item keyed', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: void C1v: %', v_res; end if;
  v_order := place_counter_order(pg_temp.id('t9'), 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_latte_v)), gen_random_uuid());
  perform pg_temp.put('b9', (select bill_id from orders where id = v_order));
  perform pg_temp.put('L9', (select id from order_items where order_id = v_order));
  v_res := set_item_discount(pg_temp.id('L2'), 'amount', 300, 'Regular', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: item discount L2: %', v_res; end if;
  v_res := set_item_discount(pg_temp.id('L3'), 'amount', 100, 'Regular', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: item discount L3: %', v_res; end if;
  v_res := set_bill_discount(pg_temp.id('b5'), 'amount', 1000, 'Regular', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: bill discount b5: %', v_res; end if;
  v_res := set_bill_discount(pg_temp.id('b6'), 'percent', 1000, 'Regular', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: bill discount b6: %', v_res; end if;
end $$;

-- ── A1. Schema, grants, discount shares (§5), the preview and the selection checks (§4.2) ──
do $$
declare
  v_tot jsonb;
  v_b1 uuid := pg_temp.id('b1');
  r record;
begin
  -- schema and grants
  for r in select t, c from (values ('bills', 'split_from'), ('order_items', 'split_from_item')) as x(t, c) loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.t and column_name = r.c) then
      raise exception 'FAIL A1 schema: %.% is missing', r.t, r.c;
    end if;
  end loop;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'pos_discount_log_action_check')) not like '%split%' then
    raise exception 'FAIL A1 schema: pos_discount_log.action does not allow split';
  end if;
  if not has_function_privilege('authenticated', 'pos_split_totals(uuid,jsonb)', 'execute')
     or has_function_privilege('anon', 'pos_split_totals(uuid,jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'pos_bill_input(uuid)', 'execute') then
    raise exception 'FAIL A1 grants: pos_split_totals / pos_bill_input';
  end if;
  for r in select f from unnest(array['pos_split_check(bills,jsonb)', 'pos_split_input(uuid,jsonb)',
                                      'pos_split_line_discount(text,integer,integer,integer)']) as f loop
    if has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL A1 grants: % is internal', r.f; end if;
  end loop;

  -- §5 item discount shares: percent copied; amount floor(value × k / q); all of it for the whole line; 0 → none
  if pos_split_line_discount('amount', 300, 3, 1) is distinct from '{"kind": "amount", "value": 100}'::jsonb
     or pos_split_line_discount('amount', 100, 3, 2) is distinct from '{"kind": "amount", "value": 66}'::jsonb
     or pos_split_line_discount('amount', 300, 3, 3) is distinct from '{"kind": "amount", "value": 300}'::jsonb
     or pos_split_line_discount('percent', 1000, 3, 1) is distinct from '{"kind": "percent", "value": 1000}'::jsonb
     or pos_split_line_discount('amount', 2, 3, 1) is not null
     or pos_split_line_discount(null, null, 3, 1) is not null then
    raise exception 'FAIL A1 item discount shares';
  end if;

  perform pg_temp.act(pg_temp.id('dev'));
  -- pos_bill_totals is unchanged by its re-creation: Latte ×3 + Cake = 54.00 + SC 5.40 + SST 3.24 = 62.64 → 62.65
  v_tot := pos_bill_totals(v_b1);
  if (v_tot->>'totalSen')::int is distinct from 6265 or (v_tot->>'subtotalSen')::int is distinct from 5400 then
    raise exception 'FAIL A1 pos_bill_totals: %', v_tot;
  end if;
  -- 1 of 3 lattes + the cake: 28.00 + SC 2.80 + SST 1.68 = 32.48 → 32.50
  v_tot := pos_split_totals(v_b1, jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 1), pg_temp.sel(pg_temp.id('C1'), 1)));
  if (v_tot->>'totalSen')::int is distinct from 3250 or (v_tot->>'subtotalSen')::int is distinct from 2800
     or (v_tot->>'serviceChargeSen')::int is distinct from 280 or (v_tot->>'sstSen')::int is distinct from 168
     or jsonb_array_length(v_tot->'lines') <> 2 then
    raise exception 'FAIL A1 preview S1: %', v_tot;
  end if;
  -- item amount RM 3.00 on 3 lattes, take 1 → 1.00 off: 12.00 + SC 1.20 + SST 0.72 = 13.92 → 13.90
  v_tot := pos_split_totals(pg_temp.id('b2'), jsonb_build_array(pg_temp.sel(pg_temp.id('L2'), 1)));
  if (v_tot->>'itemDiscountSen')::int is distinct from 100 or (v_tot->>'totalSen')::int is distinct from 1390 then
    raise exception 'FAIL A1 preview item share 100: %', v_tot;
  end if;
  -- item amount RM 1.00 on 3 lattes, take 2 → 0.66 off
  v_tot := pos_split_totals(pg_temp.id('b3'), jsonb_build_array(pg_temp.sel(pg_temp.id('L3'), 2)));
  if (v_tot->>'itemDiscountSen')::int is distinct from 66 then raise exception 'FAIL A1 preview item share 66: %', v_tot; end if;
  -- bill amount RM 10.00 on a 54.00 base, take the cake (15.00): round(1000 × 1500 / 5400) = 2.78;
  -- 15.00 − 2.78 = 12.22 + SC 1.22 + SST 0.73 = 14.17 → 14.15
  v_tot := pos_split_totals(pg_temp.id('b5'), jsonb_build_array(pg_temp.sel(pg_temp.id('C5'), 1)));
  if (v_tot->>'billDiscountSen')::int is distinct from 278 or (v_tot->>'totalSen')::int is distinct from 1415 then
    raise exception 'FAIL A1 preview bill amount share: %', v_tot;
  end if;
  -- bill 10%, take the cake: 15.00 − 1.50 = 13.50 + SC 1.35 + SST 0.81 = 15.66 → 15.65
  v_tot := pos_split_totals(pg_temp.id('b6'), jsonb_build_array(pg_temp.sel(pg_temp.id('C6'), 1)));
  if (v_tot->>'billDiscountSen')::int is distinct from 150 or (v_tot->>'totalSen')::int is distinct from 1565 then
    raise exception 'FAIL A1 preview bill percent: %', v_tot;
  end if;

  -- §4.2 messages
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1,
      jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 3), pg_temp.sel(pg_temp.id('C1'), 1))),
    'Select fewer items, or pay the whole bill', 'A1 every unit');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 4))),
    'The bill changed. Check the items again.', 'A1 more units than the line');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, jsonb_build_array(pg_temp.sel(pg_temp.id('C1v'), 1))),
    'The bill changed. Check the items again.', 'A1 voided item');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, jsonb_build_array(pg_temp.sel(pg_temp.id('L2'), 1))),
    'The bill changed. Check the items again.', 'A1 item of another bill');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1,
      jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 1), pg_temp.sel(pg_temp.id('L1'), 1))),
    'Invalid selection', 'A1 same item twice');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, '[]'), 'Invalid selection', 'A1 empty');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, '{"itemId": "x"}'), 'Invalid selection', 'A1 not an array');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 0))),
    'Invalid selection', 'A1 qty 0');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1,
      jsonb_build_array(jsonb_build_object('itemId', pg_temp.id('L1'), 'qty', 1.5))), 'Invalid selection', 'A1 qty 1.5');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1,
      jsonb_build_array(jsonb_build_object('itemId', 'not-a-uuid', 'qty', 1))), 'Invalid selection', 'A1 bad uuid');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', gen_random_uuid(), jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 1))),
    'Bill not found', 'A1 unknown bill');
end $$;

select 'VERIFY OK' as result;
rollback;
