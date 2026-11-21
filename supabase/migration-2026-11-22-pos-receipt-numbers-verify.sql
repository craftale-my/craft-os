-- Self-check for the POS receipt template, call numbers and cash drawer (W4). Run on craft-os-dev after
-- migration-2026-11-22-pos-receipt-numbers.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections (one DO block each, ids in the temp table fixture): FIXTURE; V1 call numbers;
-- V2 receipt template; V3 drawer kicks; V4 Open drawer; V5 Z report, Reports → Cash drawer, no shift.
-- Outlet VERIFY W4: receipt route Bar (an agent route), SST registered, 5 sen rounding, no service charge.
-- Latte 10.00 (6%) and Cake 8.00 (8%), both printed on Bar. A card and a cash method, a cashier and a
-- supervisor with PINs, one tablet signed in, a shift open with a float of 100.00.
-- Bills: T1 takeaway Latte + Cake (TA001; its Cake paid on its own by item), T2 takeaway Latte (TA002;
-- a card part of 5.00 in V2, the rest in cash in V3), D1 table W1 Latte (no number; card in V3).
begin;

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
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create temp table fixture (k text primary key, v uuid);
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;
create function pg_temp.ok(p_res jsonb, p_label text) returns void
language plpgsql as $$
begin
  if not coalesce((p_res->>'ok')::boolean, false) then
    raise exception 'FAIL %: %', p_label, p_res;
  end if;
end $$;
-- one payment of a method (fixture key 'card' or 'cash'); tendered only for cash
create function pg_temp.pay(p_method text, p_sen integer, p_tendered integer default null) returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('methodId', pg_temp.id(p_method), 'amountSen', p_sen,
                                                                 'tenderedSen', p_tendered)))
$$;
-- one counter order: p_table null = takeaway; a key 'latte:2' orders 2 on one line; returns the order id
create function pg_temp.order_on(p_table text, p_pax integer, p_keys text[]) returns uuid
language sql as $$
  select place_counter_order(
           pg_temp.id(p_table), case when p_table is null then 'takeaway' else 'dine_in' end, p_pax,
           (select jsonb_agg(jsonb_build_object('productId', pg_temp.id(split_part(k, ':', 1)),
                                                'variantId', pg_temp.id(split_part(k, ':', 1) || '_v'),
                                                'qty', coalesce(nullif(split_part(k, ':', 2), ''), '1')::integer)
                             order by o)
              from unnest(p_keys) with ordinality as x(k, o)),
           gen_random_uuid())
$$;
create function pg_temp.bill_of(p_order uuid) returns uuid
language sql as $$ select bill_id from orders where id = p_order $$;

-- ── FIXTURE: outlet VERIFY W4, tables W1–W2, two products on the Bar route, a card and a cash method,
--    a cashier and a supervisor with PINs, one tablet signed in, a shift open ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000008c1';
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-0000000008c2';
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000008c3';
  v_a uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_p uuid; v_v uuid; v_res jsonb; r record; i integer;
begin
  -- the role defaults decide (owner: every outlet and access_settings)
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  insert into branches(name, address) values ('VERIFY W4', 'w') returning id into v_a;
  perform pg_temp.put('branch', v_a);
  for i in 1..2 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'W' || i, i) returning id into v_t;
    perform pg_temp.put('w' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into menu_categories(name, sort_order) values ('VERIFY W4 DRINKS', 911) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY W4 MENU', 911) returning id into v_catalog;
  for r in select * from (values ('latte', 'Verify W4 Latte', 1000, 600), ('cake', 'Verify W4 Cake', 800, 800))
                    as x(k, name, sen, bp) loop
    insert into menu_products(name, category_id, sst_rate_bp, print_route) values (r.name, v_cat, r.bp, 'Bar') returning id into v_p;
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', r.sen) returning id into v_v;
    insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, r.sen);
    perform pg_temp.put(r.k, v_p); perform pg_temp.put(r.k || '_v', v_v);
  end loop;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'W4 Card', 'card', 1) returning id into v_t;
  perform pg_temp.put('card', v_t);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'W4 Cash', 'cash', 2) returning id into v_t;
  perform pg_temp.put('cash', v_t);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_dev);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify W4 Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify W4 Supervisor', 'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'supervisor' where id = v_sup;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'W4 Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('sup', v_sup); perform pg_temp.put('cashier', v_cash);
  perform pg_temp.put('dev', v_dev);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_res := open_shift(10000);
  perform pg_temp.put('shift', (v_res->'shift'->>'id')::uuid);
  if pg_temp.id('shift') is null then raise exception 'FAIL fixture: no shift: %', v_res; end if;
end $$;

-- ── V1. Call numbers (spec §2): TA001/TA002, none for dine-in, the ticket carries it, a split part copies
--    it, the 06:00 reset (05:30 and 06:30 straddle it; 01:00 continues the night), TA999 → TA001 ──
do $$
declare
  v_a     uuid := pg_temp.id('branch');
  v_t1    uuid;
  v_t2    uuid;
  v_d     uuid;
  v_items jsonb;
  v_res   jsonb;
  v_no    text;
  r       record;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- two takeaway orders: two bills (pos_insert_order opens a bill per takeaway order)
  v_t1 := pg_temp.bill_of(pg_temp.order_on(null, null, array['latte', 'cake']));
  v_t2 := pg_temp.bill_of(pg_temp.order_on(null, null, array['latte']));
  perform pg_temp.put('T1', v_t1); perform pg_temp.put('T2', v_t2);
  if (select call_no from bills where id = v_t1) is distinct from 'TA001'
     or (select call_no from bills where id = v_t2) is distinct from 'TA002' then
    raise exception 'FAIL V1 two takeaway bills: % and %',
      (select call_no from bills where id = v_t1), (select call_no from bills where id = v_t2);
  end if;
  -- a dine-in bill has none
  v_d := pg_temp.bill_of(pg_temp.order_on('w1', 2, array['latte']));
  perform pg_temp.put('D1', v_d);
  if (select call_no from bills where id = v_d) is not null then
    raise exception 'FAIL V1 a dine-in bill has a call number: %', (select call_no from bills where id = v_d);
  end if;
  -- the takeaway ticket carries the number; the dine-in ticket has no callNo key
  if (select payload->>'callNo' from print_jobs where kind = 'ticket' and order_id = (select id from orders where bill_id = v_t1))
     is distinct from 'TA001' then
    raise exception 'FAIL V1 the takeaway ticket: %',
      (select payload from print_jobs where kind = 'ticket' and order_id = (select id from orders where bill_id = v_t1));
  end if;
  if exists (select 1 from print_jobs where kind = 'ticket' and payload ? 'callNo'
              and order_id = (select id from orders where bill_id = v_d)) then
    raise exception 'FAIL V1 the dine-in ticket has a callNo';
  end if;
  -- T1's Cake paid on its own by item: the part copies TA001
  v_items := jsonb_build_array(jsonb_build_object(
               'itemId', (select id from order_items where bill_id = v_t1 and product_id = pg_temp.id('cake')), 'qty', 1));
  v_res := checkout_items(v_t1, v_items, pg_temp.pay('card', (pos_split_totals(v_t1, v_items)->>'totalSen')::integer),
                          gen_random_uuid());
  if (select call_no from bills where id = (v_res->>'billId')::uuid) is distinct from 'TA001' then
    raise exception 'FAIL V1 the split part: %', (select call_no from bills where id = (v_res->>'billId')::uuid);
  end if;
  -- the business day: 05:30 belongs to the night before, 06:30 starts a new day, 01:00 continues it
  for r in select * from (values ('W4-N1', '2026-01-05 05:30+08', 'TA001'), ('W4-N2', '2026-01-05 06:30+08', 'TA001'),
                                 ('W4-N3', '2026-01-06 01:00+08', 'TA002'), ('W4-N4', '2026-01-05 05:45+08', 'TA002'))
                    as x(no, at, want) loop
    insert into bills(branch_id, bill_no, order_type, opened_at) values (v_a, r.no, 'takeaway', r.at::timestamptz)
    returning call_no into v_no;
    if v_no is distinct from r.want then
      raise exception 'FAIL V1 % opened %: % (expected %)', r.no, r.at, v_no, r.want;
    end if;
  end loop;
  -- TA999, then TA001 again
  update pos_call_counters set next_no = 999
   where branch_id = v_a and channel = 'takeaway' and business_day = '2026-01-05';
  insert into bills(branch_id, bill_no, order_type, opened_at) values (v_a, 'W4-N5', 'takeaway', '2026-01-05 12:00+08')
  returning call_no into v_no;
  if v_no is distinct from 'TA999' then raise exception 'FAIL V1 TA999: %', v_no; end if;
  insert into bills(branch_id, bill_no, order_type, opened_at) values (v_a, 'W4-N6', 'takeaway', '2026-01-05 12:05+08')
  returning call_no into v_no;
  if v_no is distinct from 'TA001' then raise exception 'FAIL V1 after TA999: %', v_no; end if;
end $$;

-- ── V2. Receipt template (spec §3): saved, checked, carried by both receipts; free add-ons left off ──
do $$
declare
  v_a    uuid := pg_temp.id('branch');
  v_logo jsonb := jsonb_build_object('width', 16, 'height', 2, 'data', '/wAP8A==');   -- ff 00 0f f0: 2 bytes a row
  v_s    branch_pos_settings;
  v      jsonb;
  v_part uuid := gen_random_uuid();
begin
  perform pg_temp.act(pg_temp.id('owner'));
  perform save_receipt_settings(v_a, jsonb_build_object('receiptTitle', 'Verify W4', 'receiptLogo', v_logo,
            'footerQr', '  https://g.page/r/verify-w4  ', 'fontSize', 'small', 'hideFreeMods', true));
  select * into v_s from branch_pos_settings where branch_id = v_a;
  if v_s.receipt_logo is distinct from v_logo or v_s.receipt_footer_qr is distinct from 'https://g.page/r/verify-w4'
     or v_s.receipt_font_size is distinct from 'small' or not v_s.receipt_hide_free_mods then
    raise exception 'FAIL V2 saved: % / % / % / %', v_s.receipt_logo, v_s.receipt_footer_qr, v_s.receipt_font_size, v_s.receipt_hide_free_mods;
  end if;
  -- a key that is absent leaves its column as it is
  perform save_receipt_settings(v_a, jsonb_build_object('receiptTitle', 'Verify W4'));
  if (select receipt_logo from branch_pos_settings where branch_id = v_a) is distinct from v_logo then
    raise exception 'FAIL V2 an absent receiptLogo changed the logo';
  end if;
  -- refused: 400 dots wide, a raster of the wrong size, a width not a multiple of 8, a font size, a long QR text
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L)', v_a, jsonb_build_object('receiptTitle', 'Verify W4',
            'receiptLogo', jsonb_build_object('width', 400, 'height', 8, 'data', encode(decode(repeat('00', 400), 'hex'), 'base64')))),
    'The logo must be at most 384 × 240 dots.', 'V2 logo 400 dots wide');
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L)', v_a, jsonb_build_object('receiptTitle', 'Verify W4',
            'receiptLogo', jsonb_build_object('width', 16, 'height', 2, 'data', '/wAP'))),
    'The logo could not be read. Upload it again.', 'V2 logo 3 bytes for 4');
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L)', v_a, jsonb_build_object('receiptTitle', 'Verify W4',
            'receiptLogo', jsonb_build_object('width', 12, 'height', 2, 'data', '/wAP8A=='))),
    'The logo could not be read. Upload it again.', 'V2 logo width 12');
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L)', v_a,
            jsonb_build_object('receiptTitle', 'Verify W4', 'fontSize', 'huge')),
    'Choose a font size: small, normal or large.', 'V2 font size');
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L)', v_a,
            jsonb_build_object('receiptTitle', 'Verify W4', 'footerQr', repeat('x', 301))),
    'The QR text is too long (300 characters at most).', 'V2 QR 301 characters');
  -- T2's Latte with a free and a paid add-on (the snapshot only; the price stays as charged)
  update order_items
     set modifiers_snapshot = '[{"optionId": null, "group": "Milk", "name": "Oat milk", "priceDeltaSen": 0, "route": null},
                                {"optionId": null, "group": "Extra", "name": "Extra shot", "priceDeltaSen": 200, "route": null}]'
   where bill_id = pg_temp.id('T2');
  v := pos_receipt_payload(pg_temp.id('T2'), false);
  if v->>'callNo' is distinct from 'TA002' or v->>'fontSize' is distinct from 'small' or v->'header'->'logo' is distinct from v_logo
     or v->>'footerQr' is distinct from 'https://g.page/r/verify-w4' then
    raise exception 'FAIL V2 receipt keys: %', v - 'items';
  end if;
  if v->'items'->0->'mods' is distinct from '["Extra shot"]'::jsonb then
    raise exception 'FAIL V2 hide free add-ons on the receipt: %', v->'items';
  end if;
  -- the part receipt: a card part of 5.00 on T2, the same keys and the same rule
  perform pg_temp.act(pg_temp.id('dev'));
  perform pay_bill_part(pg_temp.id('T2'), v_part, 500, null, pg_temp.pay('card', 500), 0);
  v := pos_part_receipt_payload(v_part);
  if v->>'callNo' is distinct from 'TA002' or v->>'fontSize' is distinct from 'small' or v->'header'->'logo' is distinct from v_logo
     or v->>'footerQr' is distinct from 'https://g.page/r/verify-w4' or v->'items'->0->'mods' is distinct from '["Extra shot"]'::jsonb then
    raise exception 'FAIL V2 part receipt: %', v;
  end if;
  -- the switch off shows both add-ons; "receiptLogo": null removes the logo; a dine-in receipt has no number
  perform pg_temp.act(pg_temp.id('owner'));
  perform save_receipt_settings(v_a, jsonb_build_object('receiptTitle', 'Verify W4', 'hideFreeMods', false,
            'receiptLogo', null, 'fontSize', 'normal'));
  v := pos_receipt_payload(pg_temp.id('T2'), false);
  if v->'items'->0->'mods' is distinct from '["Oat milk", "Extra shot"]'::jsonb or v->'header'->'logo' is distinct from 'null'::jsonb
     or v->>'fontSize' is distinct from 'normal' then
    raise exception 'FAIL V2 switch off: %', v;
  end if;
  if pos_receipt_payload(pg_temp.id('D1'), false)->'callNo' is distinct from 'null'::jsonb then
    raise exception 'FAIL V2 a dine-in receipt has a callNo';
  end if;
end $$;

-- ── V3. Drawer kicks (spec §5): a payment, a part, a refund with a method that opens the drawer queue a
--    drawer job before their receipt / slip; a card one does not; pay in / out kick; a reprint never ──
do $$
declare
  v_a     uuid := pg_temp.id('branch');
  v_since bigint;
  v_kinds text[];
  v_jobs  jsonb[];
  v_t     uuid;
  v_due   integer;
begin
  update payment_methods set opens_drawer = (kind = 'cash') where branch_id = v_a;
  perform pg_temp.act(pg_temp.id('dev'));
  -- T2 (a card part of 5.00 in V2): the rest in cash → drawer, then the receipt
  v_due := (pos_bill_totals(pg_temp.id('T2'))->>'totalSen')::integer - pos_bill_paid_parts(pg_temp.id('T2'));
  v_since := (select coalesce(max(seq), 0) from print_jobs);
  perform checkout_bill(pg_temp.id('T2'), pg_temp.pay('cash', v_due, v_due), gen_random_uuid());
  select array_agg(payload->>'kind' order by seq), array_agg(payload order by seq) into v_kinds, v_jobs
    from print_jobs where branch_id = v_a and seq > v_since;
  if v_kinds is distinct from array['drawer', 'receipt'] then raise exception 'FAIL V3 cash checkout: %', v_kinds; end if;
  if v_jobs[1] is distinct from '{"kind": "drawer", "route": "Bar", "reason": "Payment"}'::jsonb
     or (select kind from print_jobs where branch_id = v_a and seq > v_since order by seq limit 1) is distinct from 'receipt' then
    raise exception 'FAIL V3 the drawer job: %', v_jobs[1];
  end if;
  -- D1 by card: the receipt only
  v_since := (select coalesce(max(seq), 0) from print_jobs);
  perform checkout_bill(pg_temp.id('D1'), pg_temp.pay('card', (pos_bill_totals(pg_temp.id('D1'))->>'totalSen')::integer), gen_random_uuid());
  select array_agg(payload->>'kind' order by seq) into v_kinds from print_jobs where branch_id = v_a and seq > v_since;
  if v_kinds is distinct from array['receipt'] then raise exception 'FAIL V3 card checkout: %', v_kinds; end if;
  -- a cash part on a new takeaway T3: drawer, then the part receipt
  v_t := pg_temp.bill_of(pg_temp.order_on(null, null, array['latte']));
  perform pg_temp.put('T3', v_t);
  v_since := (select coalesce(max(seq), 0) from print_jobs);
  perform pay_bill_part(v_t, gen_random_uuid(), 500, null, pg_temp.pay('cash', 500, 500), 0);
  select array_agg(payload->>'kind' order by seq), array_agg(payload order by seq) into v_kinds, v_jobs
    from print_jobs where branch_id = v_a and seq > v_since;
  if v_kinds is distinct from array['drawer', 'part'] or v_jobs[1]->>'reason' is distinct from 'Part payment' then
    raise exception 'FAIL V3 cash part: %', v_jobs;
  end if;
  -- refunds on T2 (5.00 card, 5.60 cash): cash → drawer, slip; card → the slip only
  v_since := (select coalesce(max(seq), 0) from print_jobs);
  perform pg_temp.ok(refund_bill(gen_random_uuid(), pg_temp.id('T2'), 100, pg_temp.id('cash'), 'Cold drink', pg_temp.id('sup'), '2222'), 'V3 cash refund');
  select array_agg(payload->>'kind' order by seq), array_agg(payload order by seq) into v_kinds, v_jobs
    from print_jobs where branch_id = v_a and seq > v_since;
  if v_kinds is distinct from array['drawer', 'refund'] or v_jobs[1]->>'reason' is distinct from 'Refund' then
    raise exception 'FAIL V3 cash refund: %', v_jobs;
  end if;
  v_since := (select coalesce(max(seq), 0) from print_jobs);
  perform pg_temp.ok(refund_bill(gen_random_uuid(), pg_temp.id('T2'), 100, pg_temp.id('card'), 'Cold drink', pg_temp.id('sup'), '2222'), 'V3 card refund');
  select array_agg(payload->>'kind' order by seq) into v_kinds from print_jobs where branch_id = v_a and seq > v_since;
  if v_kinds is distinct from array['refund'] then raise exception 'FAIL V3 card refund: %', v_kinds; end if;
  -- pay in and pay out: a kick each
  v_since := (select coalesce(max(seq), 0) from print_jobs);
  perform pg_temp.ok(record_cash_move(gen_random_uuid(), 'pay_in', 2000, 'Float top-up', null, null), 'V3 pay in');
  perform pg_temp.ok(record_cash_move(gen_random_uuid(), 'pay_out', 500, 'Ice', pg_temp.id('sup'), '2222'), 'V3 pay out');
  select array_agg(payload->>'reason' order by seq) into v_kinds from print_jobs where branch_id = v_a and seq > v_since;
  if v_kinds is distinct from array['Pay in', 'Pay out'] then raise exception 'FAIL V3 pay in / out: %', v_kinds; end if;
  -- a reprint never kicks
  v_since := (select coalesce(max(seq), 0) from print_jobs);
  perform reprint_receipt(pg_temp.id('T2'));
  select array_agg(payload->>'kind' order by seq) into v_kinds from print_jobs where branch_id = v_a and seq > v_since;
  if v_kinds is distinct from array['receipt'] then raise exception 'FAIL V3 reprint: %', v_kinds; end if;
  -- cash that does not open the drawer: no kick
  update payment_methods set opens_drawer = false where id = pg_temp.id('cash');
  v_t := pg_temp.bill_of(pg_temp.order_on(null, null, array['latte']));
  v_due := (pos_bill_totals(v_t)->>'totalSen')::integer;
  v_since := (select coalesce(max(seq), 0) from print_jobs);
  perform checkout_bill(v_t, pg_temp.pay('cash', v_due, v_due), gen_random_uuid());
  select array_agg(payload->>'kind' order by seq) into v_kinds from print_jobs where branch_id = v_a and seq > v_since;
  if v_kinds is distinct from array['receipt'] then raise exception 'FAIL V3 opens_drawer off: %', v_kinds; end if;
  update payment_methods set opens_drawer = true where id = pg_temp.id('cash');
end $$;

-- ── V4. Open drawer (spec §5): a reason needed, logged with its shift and cashier, one kick per id, the
--    outlet's template, no receipt printer refused ──
do $$
declare
  v_a     uuid := pg_temp.id('branch');
  v_id    uuid := gen_random_uuid();
  v_since bigint;
  v_row   pos_drawer_opens;
  v_jobs  jsonb[];
begin
  perform pg_temp.act(pg_temp.id('dev'));
  perform pg_temp.expect_error(format('select pos_open_drawer(%L, %L)', gen_random_uuid(), ' '), 'Choose a reason', 'V4 no reason');
  v_since := (select coalesce(max(seq), 0) from print_jobs);
  perform pg_temp.ok(pos_open_drawer(v_id, 'Give change'), 'V4 open');
  select * into v_row from pos_drawer_opens where id = v_id;
  if v_row.branch_id is distinct from v_a or v_row.shift_id is distinct from pg_temp.id('shift')
     or v_row.opened_by is distinct from pg_temp.id('cashier') or v_row.reason is distinct from 'Give change' then
    raise exception 'FAIL V4 the log: %', to_jsonb(v_row);
  end if;
  -- a resend of the same id: logged once, kicked once
  perform pg_temp.ok(pos_open_drawer(v_id, 'Give change'), 'V4 resend');
  if (select count(*) from pos_drawer_opens where id = v_id) <> 1 then raise exception 'FAIL V4 a resend logged twice'; end if;
  select array_agg(payload order by seq) into v_jobs from print_jobs where branch_id = v_a and seq > v_since;
  if v_jobs is distinct from array['{"kind": "drawer", "route": "Bar", "reason": "Give change"}'::jsonb] then
    raise exception 'FAIL V4 the kick: %', v_jobs;
  end if;
  -- a second open; the live Z report counts both
  perform pg_temp.ok(pos_open_drawer(gen_random_uuid(), 'Swap a note'), 'V4 second open');
  if pos_shift_report(pg_temp.id('shift'))->'cash'->>'noSaleOpens' is distinct from '2' then
    raise exception 'FAIL V4 live Z report: %', pos_shift_report(pg_temp.id('shift'))->'cash';
  end if;
  -- the outlet's template without Other: only its reasons
  insert into reason_templates(branch_id, action, reasons, compulsory, allow_other) values (v_a, 'open_drawer', '{Give change}', true, false);
  perform pg_temp.expect_error(format('select pos_open_drawer(%L, %L)', gen_random_uuid(), 'Felt like it'),
    'Choose one of the listed reasons', 'V4 listed reasons');
  -- no receipt printer: refused, nothing logged
  update branch_pos_settings set receipt_route = null where branch_id = v_a;
  perform pg_temp.expect_error(format('select pos_open_drawer(%L, %L)', gen_random_uuid(), 'Give change'),
    'No receipt printer is set — choose one in POS settings', 'V4 no receipt printer');
  update branch_pos_settings set receipt_route = 'Bar' where branch_id = v_a;
  if (select count(*) from pos_drawer_opens where branch_id = v_a) <> 2 then
    raise exception 'FAIL V4 opens logged: %', (select count(*) from pos_drawer_opens where branch_id = v_a);
  end if;
end $$;

-- ── V5. Reports → Cash drawer counts the opens; the frozen Z report keeps them; no shift, no Open drawer ──
do $$
declare
  v_a   uuid := pg_temp.id('branch');
  v     jsonb;
  v_exp integer;
  v_day date := pos_business_day(now());
begin
  perform pg_temp.act(pg_temp.id('owner'));
  v := pos_report_drawer(array[v_a], v_day, v_day);
  if jsonb_array_length(v->'shifts') <> 1 or v->'shifts'->0->>'noSaleOpens' is distinct from '2' then
    raise exception 'FAIL V5 Cash drawer report: %', v;
  end if;
  -- close the shift at the expected cash: the frozen report keeps the count
  perform pg_temp.act(pg_temp.id('dev'));
  v_exp := pos_shift_expected_cash(pg_temp.id('shift'));
  v := close_shift(pg_temp.id('shift'), v_exp, null, null, null, v_exp);
  if not coalesce((v->>'ok')::boolean, false) or v->'report'->'cash'->>'noSaleOpens' is distinct from '2' then
    raise exception 'FAIL V5 frozen Z report: %', v;
  end if;
  perform pg_temp.expect_error(format('select pos_open_drawer(%L, %L)', gen_random_uuid(), 'Give change'),
    'Open a shift first.', 'V5 no shift');
end $$;


select 'VERIFY OK' as result;
rollback;
