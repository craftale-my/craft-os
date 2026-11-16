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

-- ── A2. checkout_items (spec §4.3; §8 tests 1–4) ──────────────────────────────
do $$
declare
  v_b1  uuid := pg_temp.id('b1');
  v_sel jsonb := jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 1), pg_temp.sel(pg_temp.id('C1'), 1));
  v_cid uuid := gen_random_uuid();
  v_res jsonb; v_res2 jsonb; v_part bills; v_cut order_items; v_tot jsonb;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- payments are checked against the part's total, with checkout_bill's words
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', v_b1, v_sel, pg_temp.card(3000), gen_random_uuid()),
    'Payments (RM 30.00) do not match the total (RM 32.50)', 'A2 wrong amount');
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, null)', v_b1, v_sel, pg_temp.card(3250)),
    'Checkout id is missing', 'A2 no checkout id');
  -- 1. 1 of 3 lattes + the cake: their own paid bill of RM 32.50
  v_res := checkout_items(v_b1, v_sel, pg_temp.card(3250), v_cid);
  select * into v_part from bills where id = (v_res->>'billId')::uuid;
  if v_part.id is null or v_part.id = v_b1 or v_part.split_from is distinct from v_b1 or v_part.status <> 'paid'
     or v_part.pax is not null or v_part.table_id is distinct from pg_temp.id('t1') or v_part.order_type <> 'dine_in'
     or v_part.total_sen <> 3250 or v_part.checkout_id <> v_cid or v_part.shift_id is distinct from pg_temp.id('shift')
     or v_part.closed_by is distinct from pg_temp.id('cashier') or v_part.closed_device_id is distinct from pg_temp.id('dev')
     or (v_res->>'totalSen')::int <> 3250 or not (v_res->>'receiptQueued')::boolean
     or v_part.bill_no = (select bill_no from bills where id = v_b1) then
    raise exception 'FAIL A2 paid part: % %', v_res, row_to_json(v_part);
  end if;
  -- the table bill keeps 2 lattes on the same row and stays open; the part has the cut latte and the cake
  select * into v_cut from order_items where split_from_item = pg_temp.id('L1');
  if (select qty from order_items where id = pg_temp.id('L1')) <> 2
     or (select bill_id from order_items where id = pg_temp.id('L1')) <> v_b1
     or v_cut.id is null or v_cut.bill_id <> v_part.id or v_cut.qty <> 1
     or v_cut.order_id <> (select order_id from order_items where id = pg_temp.id('L1'))
     or (select bill_id from order_items where id = pg_temp.id('C1')) <> v_part.id
     or (select status from bills where id = v_b1) <> 'open'
     or (select count(*) from order_items where bill_id = v_part.id) <> 2 then
    raise exception 'FAIL A2 units';
  end if;
  if (select count(*) from payments where bill_id = v_part.id and amount_sen = 3250 and line_no = 1) <> 1
     or exists (select 1 from payments where bill_id = v_b1) then
    raise exception 'FAIL A2 payments';
  end if;
  -- what is left: Latte ×2 = 26.00 + SC 2.60 + SST 1.56 = 30.16 → 30.15
  v_tot := pos_bill_totals(v_b1);
  if (v_tot->>'totalSen')::int <> 3015 then raise exception 'FAIL A2 rest: %', v_tot; end if;
  -- the frozen lines carry the cut row's new id (the receipt reads line discounts by id)
  if not exists (select 1 from jsonb_array_elements(v_part.totals->'lines') l where l->>'id' = v_cut.id::text) then
    raise exception 'FAIL A2 frozen lines: %', v_part.totals;
  end if;
  if (select count(*) from print_jobs where payload->>'kind' = 'receipt' and payload->>'billNo' = v_part.bill_no) <> 1 then
    raise exception 'FAIL A2 receipt job';
  end if;
  -- 2. a resend with the same id and payments gets the first answer (the selection is gone now)
  v_res2 := checkout_items(v_b1, v_sel, pg_temp.card(3250), v_cid);
  if v_res2 <> v_res then raise exception 'FAIL A2 replay: % vs %', v_res2, v_res; end if;
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', v_b1, v_sel, pg_temp.card(3000), v_cid),
    'This payment was already recorded with other amounts — check Today''s bills', 'A2 replay other amounts');
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', pg_temp.id('b2'), v_sel, pg_temp.card(3250), v_cid),
    'This checkout id belongs to another bill', 'A2 replay on another bill');
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L, %L)', v_b1, pg_temp.card(3250), v_cid),
    'This checkout id belongs to another bill', 'A2 checkout_bill with a split id');
  -- the Payment screen's follow: the table bill is open, and the result is the part paid under its id
  v_res2 := pos_checkout_state(v_b1, array[v_cid]);
  if v_res2->>'status' <> 'open' or (v_res2->'result'->>'billId')::uuid is distinct from v_part.id then
    raise exception 'FAIL A2 checkout state: %', v_res2;
  end if;
  if pos_checkout_state(v_b1, array[gen_random_uuid()])->'result' <> 'null'::jsonb then
    raise exception 'FAIL A2 checkout state with another id';
  end if;
  perform pg_temp.put('p1', v_part.id);
  perform pg_temp.put('L1cut', v_cut.id);

  -- 3. item amount RM 3.00 on 3 lattes, take 1: the cut row 1.00, the line keeps 2.00 (pays 13.90)
  v_res := checkout_items(pg_temp.id('b2'), jsonb_build_array(pg_temp.sel(pg_temp.id('L2'), 1)), pg_temp.card(1390), gen_random_uuid());
  select * into v_cut from order_items where split_from_item = pg_temp.id('L2');
  if v_cut.bill_id <> (v_res->>'billId')::uuid or v_cut.discount_kind <> 'amount' or v_cut.discount_value <> 100
     or v_cut.discount_reason <> 'Regular' or v_cut.discount_approved_by <> pg_temp.id('sup')
     or (select discount_value from order_items where id = pg_temp.id('L2')) <> 200
     or (select qty from order_items where id = pg_temp.id('L2')) <> 2
     or (pos_bill_totals(pg_temp.id('b2'))->>'itemDiscountSen')::int <> 200 then
    raise exception 'FAIL A2 item share: % %', v_res, row_to_json(v_cut);
  end if;
  perform pg_temp.put('p2', (v_res->>'billId')::uuid);

  -- 4a. bill amount RM 10.00: the cake's part carries 2.78, the table bill keeps 7.22, both logged.
  --     The rest: Latte ×3 = 39.00 − 7.22 = 31.78 + SC 3.18 + SST 1.91 = 36.87 → 36.85
  v_res := checkout_items(pg_temp.id('b5'), jsonb_build_array(pg_temp.sel(pg_temp.id('C5'), 1)), pg_temp.card(1415), gen_random_uuid());
  select * into v_part from bills where id = (v_res->>'billId')::uuid;
  if v_part.discount_kind <> 'amount' or v_part.discount_value <> 278 or v_part.discount_reason <> 'Regular'
     or v_part.discount_approved_by <> pg_temp.id('sup') or (v_part.totals->>'billDiscountSen')::int <> 278
     or (select discount_value from bills where id = pg_temp.id('b5')) <> 722
     or (pos_bill_totals(pg_temp.id('b5'))->>'totalSen')::int <> 3685 then
    raise exception 'FAIL A2 bill amount share: %', row_to_json(v_part);
  end if;
  if (select count(*) from pos_discount_log where bill_id = v_part.id and action = 'split' and kind = 'amount' and value = 278
         and reason = 'Regular' and approved_by = pg_temp.id('sup') and actor = pg_temp.id('cashier')) <> 1
     or (select count(*) from pos_discount_log where bill_id = pg_temp.id('b5') and action = 'split' and kind = 'amount' and value = 722) <> 1 then
    raise exception 'FAIL A2 discount log (amount)';
  end if;
  perform pg_temp.put('p5', v_part.id);
  -- 4b. bill 10%: copied onto the part, kept by the table bill, one log row (the part's)
  v_res := checkout_items(pg_temp.id('b6'), jsonb_build_array(pg_temp.sel(pg_temp.id('C6'), 1)), pg_temp.card(1565), gen_random_uuid());
  select * into v_part from bills where id = (v_res->>'billId')::uuid;
  if v_part.discount_kind <> 'percent' or v_part.discount_value <> 1000
     or (select discount_kind || ':' || discount_value from bills where id = pg_temp.id('b6')) <> 'percent:1000'
     or (select count(*) from pos_discount_log where bill_id = v_part.id and action = 'split') <> 1
     or (select count(*) from pos_discount_log where bill_id = pg_temp.id('b6') and action = 'split') <> 0 then
    raise exception 'FAIL A2 bill percent: %', row_to_json(v_part);
  end if;
  perform pg_temp.put('p6', v_part.id);

  -- checkout_bill on the shared helpers, as before: Latte 13.00 + SC 1.30 + SST 0.78 = 15.08 → 15.10; cash 20.00
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L, %L)', pg_temp.id('b9'), pg_temp.card(1500), gen_random_uuid()),
    'Payments (RM 15.00) do not match the total (RM 15.10)', 'A2 checkout_bill wrong amount');
  v_res := checkout_bill(pg_temp.id('b9'), jsonb_build_array(jsonb_build_object('methodId', pg_temp.id('cash'), 'amountSen', 1510,
                                                                                 'tenderedSen', 2000)), gen_random_uuid());
  if (v_res->>'totalSen')::int <> 1510 or (v_res->>'changeSen')::int <> 490 or (select status from bills where id = pg_temp.id('b9')) <> 'paid'
     or (select count(*) from payments where bill_id = pg_temp.id('b9') and tendered_sen = 2000 and change_sen = 490 and line_no = 1) <> 1 then
    raise exception 'FAIL A2 checkout_bill: %', v_res;
  end if;
end $$;

-- ── A2. More checks: grants; the cut row's catalog discount and order type (the S1 triggers);
--    an item percent discount; a bill amount discount above what is left; the §4.2 refusals
--    A1 left out. Everything this block writes is undone at its end (the S2RB0 exception), so
--    the fixture A3 and A4 see is the one the block above leaves.
do $$
declare
  v_far   uuid;
  v_t10   uuid;
  v_order uuid;
  v_tb    uuid;   -- a takeaway bill
  v_db    uuid;   -- table S10's bill
  v_line  uuid;
  v_cake  uuid;
  v_res   jsonb;
  v_tot   jsonb;
  v_part  bills;
  v_cut   order_items;
  r       record;
begin
  -- grants: the RPC for signed-in users only, the helpers for nobody
  if not has_function_privilege('authenticated', 'checkout_items(uuid,jsonb,jsonb,uuid)', 'execute')
     or has_function_privilege('anon', 'checkout_items(uuid,jsonb,jsonb,uuid)', 'execute') then
    raise exception 'FAIL A2 grants: checkout_items';
  end if;
  for r in select f from unnest(array['pos_check_payments(uuid,jsonb,integer)', 'pos_insert_payments(uuid,uuid,uuid,jsonb,uuid)',
                                      'pos_pay_and_close(uuid,uuid,uuid,jsonb,jsonb,uuid)', 'pos_move_units(jsonb,uuid)']) as f loop
    if has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL A2 grants: % is internal', r.f; end if;
  end loop;

  perform pg_temp.act(pg_temp.id('dev'));
  -- §4.2 refusals: another branch's bill, a paid bill, qty above 100, more than 100 entries, a string qty
  insert into branches(name, address) values ('VERIFY S FAR', 'far') returning id into v_far;
  insert into bills(branch_id, bill_no, order_type) values (v_far, 'VSFAR-1', 'takeaway') returning id into v_tb;
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_tb, jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 1))),
    'Bill not found', 'A2 preview of another branch''s bill');
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', v_tb, jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 1)),
      pg_temp.card(100), gen_random_uuid()),
    'Bill not found', 'A2 pay selected on another branch''s bill');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', pg_temp.id('b9'), jsonb_build_array(pg_temp.sel(pg_temp.id('L9'), 1))),
    'This bill is already paid', 'A2 preview of a paid bill');
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', pg_temp.id('b9'), jsonb_build_array(pg_temp.sel(pg_temp.id('L9'), 1)),
      pg_temp.card(100), gen_random_uuid()),
    'This bill is already paid', 'A2 pay selected on a paid bill');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', pg_temp.id('b1'), jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 101))),
    'Invalid selection', 'A2 qty 101');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', pg_temp.id('b1'),
      (select jsonb_agg(pg_temp.sel(gen_random_uuid(), 1)) from generate_series(1, 101))),
    'Invalid selection', 'A2 101 entries');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', pg_temp.id('b1'),
      jsonb_build_array(jsonb_build_object('itemId', pg_temp.id('L1'), 'qty', '1'))),
    'Invalid selection', 'A2 string qty');
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', pg_temp.id('b1'),
      jsonb_build_array(jsonb_build_object('itemId', pg_temp.id('L1'), 'qty', '1')), pg_temp.card(1300), gen_random_uuid()),
    'Invalid selection', 'A2 pay selected with a string qty');

  -- a cut row keeps its line's catalog discount and order type (the S1 triggers return early):
  -- a takeaway Latte ×3 ordered at 20% off is merged into table S10's bill, the catalog then goes
  -- back to 0%, and one latte is paid on its own.
  --   The part: 13.00 − 2.60 = 10.40, no service charge (takeaway), SST 0.62 = 11.02 → 11.00.
  --   S10 keeps Latte ×2 (26.00 − 5.20 = 20.80, takeaway) + Cake 15.00 (dine-in, SC 1.50);
  --   SST 6% of 35.80 = 2.15 → 39.45.
  insert into dining_tables(branch_id, label, sort_order) values (pg_temp.id('branch'), 'S10', 10) returning id into v_t10;
  v_order := place_counter_order(v_t10, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', pg_temp.id('cake'), 'variantId', pg_temp.id('cake_v'))), gen_random_uuid());
  v_db := (select bill_id from orders where id = v_order);
  update menu_catalogs set discount_bp = 2000 where id = pg_temp.id('catalog');
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', pg_temp.id('latte'), 'variantId', pg_temp.id('latte_v'), 'qty', 3)), gen_random_uuid());
  v_tb := (select bill_id from orders where id = v_order);
  v_line := (select id from order_items where order_id = v_order);
  update menu_catalogs set discount_bp = 0 where id = pg_temp.id('catalog');
  perform merge_bills(v_tb, v_db);
  if (select catalog_discount_bp || ':' || order_type || ':' || bill_id from order_items where id = v_line)
     <> '2000:takeaway:' || v_db then
    raise exception 'FAIL A2 trigger fixture';
  end if;
  v_res := checkout_items(v_db, jsonb_build_array(pg_temp.sel(v_line, 1)), pg_temp.card(1100), gen_random_uuid());
  select * into v_cut from order_items where split_from_item = v_line;
  select * into v_part from bills where id = (v_res->>'billId')::uuid;
  if v_cut.bill_id is distinct from v_part.id or v_cut.catalog_discount_bp <> 2000
     or v_cut.catalog_discount_name is distinct from 'VERIFY S MENU' or v_cut.order_type <> 'takeaway'
     or v_part.order_type <> 'dine_in' or v_part.total_sen <> 1100 or (v_part.totals->>'catalogDiscountSen')::int <> 260
     or (select catalog_discount_bp || ':' || order_type || ':' || qty from order_items where id = v_line) <> '2000:takeaway:2'
     or (pos_bill_totals(v_db)->>'totalSen')::int <> 3945 then
    raise exception 'FAIL A2 cut row catalog discount / order type: % % %', v_res, row_to_json(v_cut), pos_bill_totals(v_db);
  end if;

  -- an item percent discount is carried as it is: takeaway Latte ×2 at 10% off, take 1:
  -- 13.00 − 1.30 = 11.70 + SST 0.70 = 12.40, in the preview and on the cut row; the line keeps it
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', pg_temp.id('latte'), 'variantId', pg_temp.id('latte_v'), 'qty', 2)), gen_random_uuid());
  v_tb := (select bill_id from orders where id = v_order);
  v_line := (select id from order_items where order_id = v_order);
  v_res := set_item_discount(v_line, 'percent', 1000, 'Regular', pg_temp.id('sup'), '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL A2 percent fixture: %', v_res; end if;
  v_tot := pos_split_totals(v_tb, jsonb_build_array(pg_temp.sel(v_line, 1)));
  if (v_tot->>'itemDiscountSen')::int is distinct from 130 or (v_tot->>'totalSen')::int is distinct from 1240
     or (v_tot->'lines'->0->>'itemDiscountSen')::int is distinct from 130 then
    raise exception 'FAIL A2 preview item percent: %', v_tot;
  end if;
  v_res := checkout_items(v_tb, jsonb_build_array(pg_temp.sel(v_line, 1)), pg_temp.card(1240), gen_random_uuid());
  select * into v_cut from order_items where split_from_item = v_line;
  if (v_res->>'totalSen')::int <> 1240 or v_cut.discount_kind <> 'percent' or v_cut.discount_value <> 1000
     or v_cut.discount_reason <> 'Regular' or v_cut.discount_approved_by <> pg_temp.id('sup')
     or (select discount_kind || ':' || discount_value || ':' || qty from order_items where id = v_line) <> 'percent:1000:1' then
    raise exception 'FAIL A2 cut row item percent: % %', v_res, row_to_json(v_cut);
  end if;

  -- a bill amount discount above what is left (set, then items voided): the raw shares are kept,
  -- so the two bills still add up to it, and pos_compute_bill caps what each applies.
  --   Takeaway Latte ×3 + Cake ×3, RM 50.00 off; the lattes voided → 45.00 left. Take 1 cake:
  --   round(5000 × 1500 / 4500) = 16.67 to the part (15.00 applied, pays 0.00), 33.33 stays
  --   (30.00 applied on the 2 cakes left).
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', pg_temp.id('latte'), 'variantId', pg_temp.id('latte_v'), 'qty', 3),
                      jsonb_build_object('productId', pg_temp.id('cake'), 'variantId', pg_temp.id('cake_v'), 'qty', 3)), gen_random_uuid());
  v_tb := (select bill_id from orders where id = v_order);
  v_line := (select id from order_items where order_id = v_order and product_id = pg_temp.id('latte'));
  v_cake := (select id from order_items where order_id = v_order and product_id = pg_temp.id('cake'));
  v_res := set_bill_discount(v_tb, 'amount', 5000, 'Regular', pg_temp.id('sup'), '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL A2 over-discount fixture: %', v_res; end if;
  v_res := void_order_item(v_line, 'Wrong item keyed', pg_temp.id('sup'), '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL A2 over-discount void: %', v_res; end if;
  v_res := checkout_items(v_tb, jsonb_build_array(pg_temp.sel(v_cake, 1)), '[]'::jsonb, gen_random_uuid());
  select * into v_part from bills where id = (v_res->>'billId')::uuid;
  v_tot := pos_bill_totals(v_tb);
  if v_part.discount_kind <> 'amount' or v_part.discount_value <> 1667 or (v_part.totals->>'billDiscountSen')::int <> 1500
     or v_part.total_sen <> 0 or (v_res->>'totalSen')::int <> 0
     or (select discount_value from bills where id = v_tb) <> 3333
     or (v_tot->>'billDiscountSen')::int <> 3000 or (v_tot->>'totalSen')::int <> 0
     or (select count(*) from pos_discount_log where bill_id = v_part.id and action = 'split' and value = 1667) <> 1
     or (select count(*) from pos_discount_log where bill_id = v_tb and action = 'split' and value = 3333) <> 1 then
    raise exception 'FAIL A2 bill amount above what is left: % % %', v_res, row_to_json(v_part), v_tot;
  end if;

  raise exception 'A2 extra checks done' using errcode = 'S2RB0';
exception when sqlstate 'S2RB0' then
  null;   -- undo this block's writes; a FAIL (any other error) still stops the script
end $$;

select 'VERIFY OK' as result;
rollback;
