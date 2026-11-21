-- Self-check for the POS smaller Feedme habits (W7). Run on craft-os-dev after
-- migration-2026-11-22-pos-feedme-habits.sql. Everything is rolled back. Success = a result row "VERIFY OK".
-- Sections (one DO block each, ids in the temp table fixture): FIXTURE; V1 last-order time; V2 takeaway line;
-- V3 children and the receipts; V4 Serve.
-- Outlet VERIFY W7: tables W1–W5, a 10% dine-in service charge, receipt route Bar. Latte 10.00 (6%, packaging
-- 1.00) and Cake 8.00 (8%, packaging 0.50), both printed on Bar; one dine-in / takeaway / QR catalog. A cashier
-- with a PIN signed in on one tablet; the dev owner login for the settings.
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm is distinct from p_message then
      raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
    end if;
    return;
  end;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
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
-- one counter order: p_table null = takeaway; 'latte:2' orders 2 on one line, 'latte:1:ta' a takeaway line;
-- returns the order id
create function pg_temp.order_on(p_table text, p_pax integer, p_keys text[]) returns uuid
language sql as $$
  select place_counter_order(
           pg_temp.id(p_table), case when p_table is null then 'takeaway' else 'dine_in' end, p_pax,
           (select jsonb_agg(jsonb_build_object('productId', pg_temp.id(split_part(k, ':', 1)),
                                                'variantId', pg_temp.id(split_part(k, ':', 1) || '_v'),
                                                'qty', coalesce(nullif(split_part(k, ':', 2), ''), '1')::integer)
                             || case when split_part(k, ':', 3) = 'ta' then '{"takeaway": true}'::jsonb else '{}'::jsonb end
                             order by o)
              from unnest(p_keys) with ordinality as x(k, o)),
           gen_random_uuid())
$$;
create function pg_temp.bill_of(p_order uuid) returns uuid
language sql as $$ select bill_id from orders where id = p_order $$;

-- ── FIXTURE: outlet VERIFY W7, tables W1–W5, two products on the Bar route, a 10% dine-in service charge,
--    a cashier with a PIN signed in on one tablet ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000007c1';
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000007c3';
  v_a uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_p uuid; v_v uuid; v_res jsonb; r record; i integer;
begin
  -- the role defaults decide (owner: every outlet and access_settings)
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  insert into branches(name, address) values ('VERIFY W7', 'w') returning id into v_a;
  perform pg_temp.put('branch', v_a);
  for i in 1..5 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'W' || i, i) returning id into v_t;
    perform pg_temp.put('w' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into service_charge_rules(branch_id, rate_bp, order_types) values (v_a, 1000, array['dine_in']);
  insert into menu_categories(name, sort_order) values ('VERIFY W7 DRINKS', 917) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY W7 MENU', 917) returning id into v_catalog;
  for r in select * from (values ('latte', 'Verify W7 Latte', 1000, 600, 100), ('cake', 'Verify W7 Cake', 800, 800, 50))
                    as x(k, name, sen, bp, fee) loop
    insert into menu_products(name, category_id, sst_rate_bp, print_route, takeaway_fee_sen)
    values (r.name, v_cat, r.bp, 'Bar', r.fee) returning id into v_p;
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', r.sen) returning id into v_v;
    insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, r.sen);
    perform pg_temp.put(r.k, v_p); perform pg_temp.put(r.k || '_v', v_v);
  end loop;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_dev);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify W7 Cashier', 'trainee', true, current_date, 'staff', v_a);
  perform pg_temp.act(v_cash);
  if not coalesce((set_my_pos_pin('1111', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of the cashier'; end if;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'W7 Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('cashier', v_cash); perform pg_temp.put('dev', v_dev);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
end $$;

-- ── V1. Last-order time (spec §3): the rule (also across midnight), the sentence, qr_menu, the settings
--    checks, QR add / send / place_table_order refused outside, the POS orders outside, the remark lands ──
do $$
declare
  v_a     uuid := pg_temp.id('branch');
  v_tok   text := (select qr_token from dining_tables where id = pg_temp.id('w3'));
  v_line  jsonb := jsonb_build_object('productId', pg_temp.id('latte'), 'variantId', pg_temp.id('latte_v'), 'qty', 1,
                                      'note', 'less sweet', 'optionIds', '[]'::jsonb, 'takeaway', true);
  g       constant jsonb := '{"id":"aaaaaaaa-0000-4000-8000-0000000007a1","name":"Mei","avatar":"a2"}';
  v_now   time := date_trunc('minute', now() at time zone 'Asia/Kuala_Lumpur')::time;
  v_msg   text;
  v_s     branch_pos_settings;
  v_order uuid;
  v_bill  uuid;
  r       record;
begin
  -- no times: always open
  if not pos_orders_open(v_a, '2026-01-05 03:00+08') then raise exception 'FAIL V1 no window but closed'; end if;
  -- 09:00–21:30: the 09:00 minute to the end of the 21:30 minute
  update branch_pos_settings set orders_open_at = '09:00', last_order_at = '21:30' where branch_id = v_a;
  for r in select * from (values ('2026-01-05 08:59:59+08', false), ('2026-01-05 09:00+08', true),
                                 ('2026-01-05 21:30:59+08', true), ('2026-01-05 21:31+08', false)) as x(at, want) loop
    if pos_orders_open(v_a, r.at::timestamptz) is distinct from r.want then
      raise exception 'FAIL V1 09:00–21:30 at %: % (expected %)', r.at, pos_orders_open(v_a, r.at::timestamptz), r.want;
    end if;
  end loop;
  if pos_orders_closed_message(v_a) is distinct from 'Last orders were at 21:30. Ordering opens again at 09:00.' then
    raise exception 'FAIL V1 the sentence: %', pos_orders_closed_message(v_a);
  end if;
  -- 09:00–02:00 crosses midnight
  update branch_pos_settings set orders_open_at = '09:00', last_order_at = '02:00' where branch_id = v_a;
  for r in select * from (values ('2026-01-05 23:30+08', true), ('2026-01-06 01:59+08', true), ('2026-01-06 02:00:30+08', true),
                                 ('2026-01-06 02:01+08', false), ('2026-01-06 08:59+08', false), ('2026-01-06 09:00+08', true)) as x(at, want) loop
    if pos_orders_open(v_a, r.at::timestamptz) is distinct from r.want then
      raise exception 'FAIL V1 09:00–02:00 at %: % (expected %)', r.at, pos_orders_open(v_a, r.at::timestamptz), r.want;
    end if;
  end loop;
  if pos_orders_closed_message(v_a) is distinct from 'Last orders were at 02:00. Ordering opens again at 09:00.' then
    raise exception 'FAIL V1 the sentence across midnight: %', pos_orders_closed_message(v_a);
  end if;
  -- qr_menu tells the page
  if (qr_menu(v_tok)->>'ordersOpenAt') is distinct from '09:00' or (qr_menu(v_tok)->>'lastOrderAt') is distinct from '02:00' then
    raise exception 'FAIL V1 qr_menu: % / %', qr_menu(v_tok)->>'ordersOpenAt', qr_menu(v_tok)->>'lastOrderAt';
  end if;

  -- the settings: both or neither, not equal, HH:MM; absent keys keep; nulls clear; the table check
  perform pg_temp.act(pg_temp.id('owner'));
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L::jsonb)', v_a,
    '{"receiptTitle":"Verify W7","ordersOpenAt":"09:00"}'), 'Set both times or neither.', 'V1 one key');
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L::jsonb)', v_a,
    '{"receiptTitle":"Verify W7","ordersOpenAt":"09:00","lastOrderAt":null}'), 'Set both times or neither.', 'V1 one time');
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L::jsonb)', v_a,
    '{"receiptTitle":"Verify W7","ordersOpenAt":"10:00","lastOrderAt":"10:00"}'),
    'Orders open at and Last order at must be different times.', 'V1 equal times');
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L::jsonb)', v_a,
    '{"receiptTitle":"Verify W7","ordersOpenAt":"9am","lastOrderAt":"21:30"}'), 'Invalid settings', 'V1 not HH:MM');
  perform save_receipt_settings(v_a, '{"receiptTitle":"Verify W7","ordersOpenAt":"10:15","lastOrderAt":"22:45"}');
  select * into v_s from branch_pos_settings where branch_id = v_a;
  if v_s.orders_open_at is distinct from '10:15'::time or v_s.last_order_at is distinct from '22:45'::time then
    raise exception 'FAIL V1 saved: % – %', v_s.orders_open_at, v_s.last_order_at;
  end if;
  perform save_receipt_settings(v_a, '{"receiptTitle":"Verify W7"}');
  if (select orders_open_at from branch_pos_settings where branch_id = v_a) is distinct from '10:15'::time then
    raise exception 'FAIL V1 absent keys changed the times';
  end if;
  perform save_receipt_settings(v_a, '{"receiptTitle":"Verify W7","ordersOpenAt":null,"lastOrderAt":null}');
  if (select orders_open_at is not null or last_order_at is not null from branch_pos_settings where branch_id = v_a) then
    raise exception 'FAIL V1 nulls did not clear the times';
  end if;
  perform pg_temp.expect_error(format('update branch_pos_settings set orders_open_at = %L where branch_id = %L', '09:00', v_a),
    'new row for relation "branch_pos_settings" violates check constraint "branch_pos_settings_order_window_check"', 'V1 the table check');

  -- inside the window (an hour before now to an hour after): a guest adds a line — with a remark, and a
  -- takeaway flag a guest cannot set
  update branch_pos_settings set orders_open_at = v_now - interval '1 hour', last_order_at = v_now + interval '1 hour'
   where branch_id = v_a;
  perform qr_cart_put(v_tok, g, v_line, null);
  -- outside (opens in 2 hours, last order in 3): add, send and the one-phone order are refused with the sentence
  update branch_pos_settings set orders_open_at = v_now + interval '2 hours', last_order_at = v_now + interval '3 hours'
   where branch_id = v_a;
  v_msg := pos_orders_closed_message(v_a);
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', v_tok, g, v_line), v_msg, 'V1 QR add outside');
  perform pg_temp.expect_error(format('select qr_cart_send(%L, 2, %L, null, %L)', v_tok, qr_cart_state(v_tok)->>'version', gen_random_uuid()),
    v_msg, 'V1 QR send outside');
  perform pg_temp.expect_error(format('select place_table_order(%L, 2, %L::jsonb, %L)', v_tok, jsonb_build_array(v_line - 'note'), gen_random_uuid()),
    v_msg, 'V1 place_table_order outside');
  -- outside across midnight (opened an hour from now, last order an hour ago): still refused
  update branch_pos_settings set orders_open_at = v_now + interval '1 hour', last_order_at = v_now - interval '1 hour'
   where branch_id = v_a;
  perform pg_temp.expect_error(format('select qr_cart_send(%L, 2, %L, null, %L)', v_tok, qr_cart_state(v_tok)->>'version', gen_random_uuid()),
    pos_orders_closed_message(v_a), 'V1 QR send outside, across midnight');
  -- the POS orders outside the window
  perform pg_temp.act(pg_temp.id('dev'));
  v_order := pg_temp.order_on('w4', 2, array['latte']);
  if v_order is null then raise exception 'FAIL V1 the POS could not order outside the window'; end if;
  -- inside again: the cart goes in; the remark is the item's note; the guest's takeaway flag is ignored
  update branch_pos_settings set orders_open_at = v_now - interval '1 hour', last_order_at = v_now + interval '1 hour'
   where branch_id = v_a;
  perform qr_cart_send(v_tok, 2, qr_cart_state(v_tok)->>'version', null, gen_random_uuid());
  select id into v_bill from bills where table_id = pg_temp.id('w3') and status = 'open';
  if (select note from order_items where bill_id = v_bill) is distinct from 'less sweet' then
    raise exception 'FAIL V1 the remark: %', (select note from order_items where bill_id = v_bill);
  end if;
  if (select order_type from order_items where bill_id = v_bill) is distinct from 'dine_in'
     or (select takeaway_fee_sen from order_items where bill_id = v_bill) <> 0 then
    raise exception 'FAIL V1 a QR guest set a takeaway line';
  end if;
  update branch_pos_settings set orders_open_at = null, last_order_at = null where branch_id = v_a;
end $$;

-- ── V2. A takeaway line inside a dine-in bill (spec §4): fee, no service charge on it, ticket and void
--    ticket marked, the trigger keeps it; a takeaway bill unchanged ──
do $$
declare
  v_order uuid;
  v_d     uuid;
  v_ta    uuid;
  v_dine  uuid;
  v_tot   jsonb;
  v_job   jsonb;
  v_copy  uuid;
  v_type  text;
  v_tb    uuid;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  v_order := pg_temp.order_on('w1', 2, array['latte', 'latte:1:ta']);
  v_d := pg_temp.bill_of(v_order);
  perform pg_temp.put('D1', v_d);
  select id into v_ta from order_items where order_id = v_order and order_type = 'takeaway';
  select id into v_dine from order_items where order_id = v_order and order_type = 'dine_in';
  if v_ta is null or v_dine is null then
    raise exception 'FAIL V2 one takeaway and one dine-in line: %',
      (select jsonb_agg(jsonb_build_object('type', order_type, 'fee', takeaway_fee_sen)) from order_items where order_id = v_order);
  end if;
  perform pg_temp.put('TA1', v_ta);
  if (select takeaway_fee_sen from order_items where id = v_ta) <> 100 or (select takeaway_fee_sen from order_items where id = v_dine) <> 0 then
    raise exception 'FAIL V2 the fee: takeaway % / dine-in %',
      (select takeaway_fee_sen from order_items where id = v_ta), (select takeaway_fee_sen from order_items where id = v_dine);
  end if;
  -- the totals: the packaging fee once, the 10% service charge on the dine-in line only
  v_tot := pos_bill_totals(v_d);
  if (v_tot->>'takeawayFeeSen')::integer <> 100 or (v_tot->>'serviceChargeSen')::integer <> 100 then
    raise exception 'FAIL V2 totals: fee % and service charge % (expected 100 and 100)', v_tot->>'takeawayFeeSen', v_tot->>'serviceChargeSen';
  end if;
  -- the ticket marks the takeaway line, and only it
  select payload into v_job from print_jobs where kind = 'ticket' and order_id = v_order and not payload ? 'void';
  if (select count(*) from jsonb_array_elements(v_job->'lines') l where l->'takeaway' = 'true'::jsonb) <> 1
     or (select count(*) from jsonb_array_elements(v_job->'lines') l where not l ? 'takeaway') <> 1 then
    raise exception 'FAIL V2 the ticket: %', v_job;
  end if;
  -- a void ticket marks it too
  perform pos_queue_void_tickets(array[v_ta]);
  if not exists (select 1 from print_jobs where kind = 'ticket' and order_id = v_order and payload ? 'void'
                  and payload->'lines'->0->'takeaway' = 'true'::jsonb) then
    raise exception 'FAIL V2 the void ticket: %', (select payload from print_jobs where kind = 'ticket' and order_id = v_order and payload ? 'void');
  end if;
  -- the trigger: a line inserted as takeaway on a dine-in bill stays takeaway
  insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, modifiers_snapshot, qty, order_type)
  select order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, modifiers_snapshot, qty, 'takeaway'
    from order_items where id = v_dine
  returning id, order_type into v_copy, v_type;
  if v_type is distinct from 'takeaway' then raise exception 'FAIL V2 the trigger overwrote a takeaway line: %', v_type; end if;
  delete from order_items where id = v_copy;
  -- a takeaway bill: every line takeaway with its fee (the flag changes nothing), no takeaway key on its ticket
  v_tb := pg_temp.bill_of(pg_temp.order_on(null, null, array['cake:1:ta', 'latte']));
  perform pg_temp.put('T1', v_tb);
  if exists (select 1 from order_items where bill_id = v_tb and (order_type <> 'takeaway' or takeaway_fee_sen = 0)) then
    raise exception 'FAIL V2 the takeaway bill''s lines: %',
      (select jsonb_agg(jsonb_build_object('type', order_type, 'fee', takeaway_fee_sen)) from order_items where bill_id = v_tb);
  end if;
  if exists (select 1 from print_jobs j cross join jsonb_array_elements(j.payload->'lines') l
              where j.kind = 'ticket' and j.order_id = (select id from orders where bill_id = v_tb) and l ? 'takeaway') then
    raise exception 'FAIL V2 a takeaway bill''s ticket marks its lines';
  end if;
  -- and a line inserted as dine-in on a takeaway bill becomes takeaway
  insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, modifiers_snapshot, qty, order_type)
  select order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, modifiers_snapshot, qty, 'dine_in'
    from order_items where bill_id = v_tb limit 1
  returning id, order_type into v_copy, v_type;
  if v_type is distinct from 'takeaway' then raise exception 'FAIL V2 a takeaway bill''s line is %', v_type; end if;
  delete from order_items where id = v_copy;
end $$;

-- ── V3. Children (spec §5) and the receipts: the first order sets them, a later order keeps them, Pax changes
--    and clamps them, bad values refused, the table check, Open for QR, none from QR; the receipt carries
--    paxChildren and names the takeaway line ──
do $$
declare
  v_b    uuid;
  v_q    uuid;
  v_r    jsonb;
  v_pax  integer;
  v_kids integer;
  v_item jsonb := jsonb_build_array(jsonb_build_object('productId', pg_temp.id('cake'), 'variantId', pg_temp.id('cake_v'), 'qty', 1));
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- an empty table: 4 pax, 1 child, with its first order
  v_b := pg_temp.bill_of(place_counter_order(pg_temp.id('w2'), 'dine_in', 4, v_item, gen_random_uuid(), null, null, 1));
  select pax, pax_children into v_pax, v_kids from bills where id = v_b;
  if v_pax is distinct from 4 or v_kids is distinct from 1 then raise exception 'FAIL V3 the first order: % pax, % children', v_pax, v_kids; end if;
  -- a later order (with another count) keeps them
  perform place_counter_order(pg_temp.id('w2'), 'dine_in', null, v_item, gen_random_uuid(), null, null, 3);
  select pax, pax_children into v_pax, v_kids from bills where id = v_b;
  if v_pax is distinct from 4 or v_kids is distinct from 1 then raise exception 'FAIL V3 a later order: % pax, % children', v_pax, v_kids; end if;
  -- Pax: 3 with 2 children; 2 with 5 asked → 2; null clears; a two-argument call (an older till) clears too
  perform pos_set_bill_pax(v_b, 3, 2);
  select pax, pax_children into v_pax, v_kids from bills where id = v_b;
  if v_pax is distinct from 3 or v_kids is distinct from 2 then raise exception 'FAIL V3 3 with 2: % / %', v_pax, v_kids; end if;
  perform pos_set_bill_pax(v_b, 2, 5);
  select pax, pax_children into v_pax, v_kids from bills where id = v_b;
  if v_pax is distinct from 2 or v_kids is distinct from 2 then raise exception 'FAIL V3 clamped: % / %', v_pax, v_kids; end if;
  perform pos_set_bill_pax(v_b, 2, null);
  if (select pax_children from bills where id = v_b) is not null then raise exception 'FAIL V3 null did not clear'; end if;
  perform pos_set_bill_pax(v_b, 2, 1);
  perform pos_set_bill_pax(v_b, 5);
  select pax, pax_children into v_pax, v_kids from bills where id = v_b;
  if v_pax is distinct from 5 or v_kids is not null then raise exception 'FAIL V3 two arguments: % / %', v_pax, v_kids; end if;
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 2, -1)', v_b), 'Invalid number of children', 'V3 children below 0');
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, 2, %L::jsonb, %L, null, null, 100)',
    pg_temp.id('w5'), 'dine_in', v_item, gen_random_uuid()), 'Invalid number of children', 'V3 children above 99');
  perform pg_temp.expect_error(format('update bills set pax_children = 9 where id = %L', v_b),
    'new row for relation "bills" violates check constraint "bills_pax_children_check"', 'V3 the table check');
  -- Open for QR: 2 pax, 1 child
  v_q := open_table(pg_temp.id('w5'), 2, 1);
  select pax, pax_children into v_pax, v_kids from bills where id = v_q;
  if v_pax is distinct from 2 or v_kids is distinct from 1 then raise exception 'FAIL V3 open_table: % / %', v_pax, v_kids; end if;
  -- a QR order (W3, sent in V1) brings none
  if (select pax_children from bills where table_id = pg_temp.id('w3') and status = 'open') is not null then
    raise exception 'FAIL V3 a QR bill has children';
  end if;
  -- the receipt: paxChildren; a takeaway bill has none
  perform pos_set_bill_pax(v_b, 3, 1);
  if (pos_receipt_payload(v_b, false)->>'paxChildren')::integer is distinct from 1 then
    raise exception 'FAIL V3 the receipt''s paxChildren: %', pos_receipt_payload(v_b, false)->'paxChildren';
  end if;
  if (pos_receipt_payload(pg_temp.id('T1'), false)->'paxChildren') is distinct from 'null'::jsonb then
    raise exception 'FAIL V3 a takeaway receipt''s paxChildren: %', pos_receipt_payload(pg_temp.id('T1'), false)->'paxChildren';
  end if;
  -- the receipt names D1's takeaway line "(Takeaway)" and not its other line; a takeaway bill's lines keep their names
  v_r := pos_receipt_payload(pg_temp.id('D1'), false);
  if (select count(*) from jsonb_array_elements(v_r->'items') i where i->>'name' = 'Verify W7 Latte (Takeaway)') <> 1
     or (select count(*) from jsonb_array_elements(v_r->'items') i where i->>'name' = 'Verify W7 Latte') <> 1 then
    raise exception 'FAIL V3 the receipt''s names: %', v_r->'items';
  end if;
  if exists (select 1 from jsonb_array_elements(pos_receipt_payload(pg_temp.id('T1'), false)->'items') i
              where i->>'name' like '%(Takeaway)') then
    raise exception 'FAIL V3 a takeaway bill''s receipt marks its lines';
  end if;
  -- the part receipt is built the same way
  if pg_get_functiondef('pos_part_receipt_payload(uuid)'::regprocedure) not like '%(Takeaway)%'
     or pg_get_functiondef('pos_part_receipt_payload(uuid)'::regprocedure) not like '%paxChildren%' then
    raise exception 'FAIL V3 the part receipt is not the W7 version';
  end if;
end $$;

-- ── V4. Serve (spec §6): serve, again (0), not served, Mark all served, money and printing unchanged, a voided
--    line never served, the refusals ──
do $$
declare
  v_d    uuid := pg_temp.id('D1');
  v_ids  uuid[];
  v_one  uuid;
  v_tot  jsonb;
  v_jobs integer := (select count(*) from print_jobs where branch_id = pg_temp.id('branch'));
  v_n    integer;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  select array_agg(id order by id) into v_ids from order_items where bill_id = v_d and voided_at is null;
  v_one := v_ids[1];
  v_tot := pos_bill_totals(v_d);
  v_n := set_items_served(array[v_one], true);
  if v_n <> 1 or (select served_at is null or served_by is distinct from pg_temp.id('cashier') from order_items where id = v_one) then
    raise exception 'FAIL V4 serve: % changed, %', v_n, (select row(served_at, served_by) from order_items where id = v_one);
  end if;
  v_n := set_items_served(array[v_one], true);
  if v_n <> 0 then raise exception 'FAIL V4 serving a served line again changed %', v_n; end if;
  v_n := set_items_served(array[v_one], false);
  if v_n <> 1 or (select served_at is not null or served_by is not null from order_items where id = v_one) then
    raise exception 'FAIL V4 not served: % changed, %', v_n, (select row(served_at, served_by) from order_items where id = v_one);
  end if;
  -- Mark all served: every live line of the bill
  v_n := set_items_served(v_ids, true);
  if v_n <> cardinality(v_ids) then raise exception 'FAIL V4 mark all: % of %', v_n, cardinality(v_ids); end if;
  if pos_bill_totals(v_d) is distinct from v_tot then raise exception 'FAIL V4 serving changed the money'; end if;
  if (select count(*) from print_jobs where branch_id = pg_temp.id('branch')) <> v_jobs then raise exception 'FAIL V4 serving printed'; end if;
  -- a voided line is never served
  update order_items set voided_at = now(), served_at = null, served_by = null where id = pg_temp.id('TA1');
  v_n := set_items_served(array[pg_temp.id('TA1')], true);
  if v_n <> 0 or (select served_at from order_items where id = pg_temp.id('TA1')) is not null then
    raise exception 'FAIL V4 a voided line was served';
  end if;
  -- the refusals
  perform pg_temp.expect_error('select set_items_served(''{}''::uuid[], true)', 'Choose the items first.', 'V4 no items');
  perform pg_temp.expect_error(format('select set_items_served(%L::uuid[], true)', array[gen_random_uuid()]), 'Item not found', 'V4 an unknown item');
  perform pg_temp.expect_error(format('select set_items_served(%L::uuid[], true)',
    array[v_one, (select id from order_items where bill_id = pg_temp.id('T1') limit 1)]), 'The items must be on one bill.', 'V4 two bills');
end $$;

select 'VERIFY OK' as result;
rollback;
