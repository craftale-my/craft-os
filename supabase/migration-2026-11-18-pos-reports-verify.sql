-- Self-check for the POS sales reports (W3). Run on craft-os-dev after
-- migration-2026-11-18-pos-reports.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections (one DO block each, ids in the temp table fixture): FIXTURE; R1 scope and
-- access; R2 sales; R3 products, payments and SST; R4 discounts, voids, refunds, cash drawer, ledger.
-- Outlet VERIFY R: SST registered, no service charge, 5 sen rounding. Latte 10.00 (6%), Cake 8.00 and
-- Muffin 10.20 (8%), Water 2.00 (0%). Business days D1 = Mon 5 Jan 2026, D2 = Tue 6 Jan 2026; the
-- times below are Malaysia time:
--   A   R1 pax 2  Latte, Cake (10% off), Water; a RM 1.00 bill discount set, then cleared   card 20.40   D1 12:00
--   B   R2 pax 1  Latte x2 (Water voided D1 13:00), RM 2.00 off the bill                     cash 19.10   6 Jan 01:30 = D1
--   C   takeaway  Cake, Muffin, Muffin                                                       cash 30.65   D2 10:00; RM 3.00 refunded 10:30
--   D'  R3        Water, split off D by item                                                 card  2.00   D2 13:00
--   D   R3 pax 2  Latte                                                                      card 10.60   D2 13:10
--   E   R4 pax 2  Cake, Latte (a QR order)                       card 10.00 part (13:50) + cash 9.25   D2 14:00
--   F   R5 pax 2  Water                                                                      card  2.00   7 Jan 06:00 = outside
--   G   R6 pax 2  Water; the bill voided                                                                  D2 15:00
--   P   R7 pax 2  Latte                                                       card 10.60   5 Jan 05:59 = 4 Jan, previous period
-- D1..D2: 6 bills, pax 7, nett 102.00, discounts 2.80, voids 4.00, refunds 3.00 (never taken off).
-- Shifts: S1 (D2 08:00–22:00, closed) holds C's and E's cash, C's refund, pay in 20.00, pay out 5.00;
-- the tablet's own shift stays open, moved to D2 20:00, with B's cash.
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
    raise exception 'FAIL fixture %: %', p_label, p_res;
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

-- ── FIXTURE: outlets VERIFY R and VERIFY R OTHER, tables R1–R7, four products in two categories, a
--    card and a cash method, a cashier and a supervisor with PINs, a manager of VERIFY R OTHER only, one
--    tablet signed in, a shift open; then the bills of the header, moved to their business days ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000007b1';
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-0000000007b2';
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000007b3';
  v_mgr   uuid := 'eeeeeeee-0000-0000-0000-0000000007b4';
  v_a uuid; v_other uuid; v_t uuid; v_drinks uuid; v_food uuid; v_catalog uuid; v_p uuid; v_v uuid;
  v_o uuid; v_b uuid; v_s1 uuid; v_res jsonb; r record; i integer;
begin
  -- the role defaults decide (owner: every outlet; manager: access_settings) — and a manager is held to
  -- their own outlets here
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';
  insert into branches(name, address) values ('VERIFY R', 'r') returning id into v_a;
  insert into branches(name, address) values ('VERIFY R OTHER', 'r') returning id into v_other;
  perform pg_temp.put('branch', v_a); perform pg_temp.put('other', v_other);
  for i in 1..7 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'R' || i, i) returning id into v_t;
    perform pg_temp.put('r' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into menu_categories(name, sort_order) values ('VERIFY R DRINKS', 901) returning id into v_drinks;
  insert into menu_categories(name, sort_order) values ('VERIFY R FOOD', 902) returning id into v_food;
  insert into menu_catalogs(name, sort_order) values ('VERIFY R MENU', 901) returning id into v_catalog;
  for r in select * from (values ('latte', 'Verify R Latte', 1000, 600, v_drinks), ('cake', 'Verify R Cake', 800, 800, v_food),
                                 ('muffin', 'Verify R Muffin', 1020, 800, v_food), ('water', 'Verify R Water', 200, 0, v_drinks))
                    as x(k, name, sen, bp, cat) loop
    insert into menu_products(name, category_id, sst_rate_bp) values (r.name, r.cat, r.bp) returning id into v_p;
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', r.sen) returning id into v_v;
    insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, r.sen);
    perform pg_temp.put(r.k, v_p); perform pg_temp.put(r.k || '_v', v_v);
  end loop;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'R Card', 'card', 1) returning id into v_t;
  perform pg_temp.put('card', v_t);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'R Cash', 'cash', 2) returning id into v_t;
  perform pg_temp.put('cash', v_t);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_dev), (v_mgr);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify R Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify R Supervisor', 'trainee', true, current_date, 'staff', v_a),
    (v_mgr,  'Verify R Manager',    'trainee', true, current_date, 'staff', v_other);
  update staff set system_role = 'supervisor' where id = v_sup;
  update staff set system_role = 'manager' where id = v_mgr;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'R Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('sup', v_sup); perform pg_temp.put('cashier', v_cash);
  perform pg_temp.put('dev', v_dev); perform pg_temp.put('mgr', v_mgr);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_res := open_shift(10000);
  perform pg_temp.put('shift', (v_res->'shift'->>'id')::uuid);

  -- A: a bill discount set and cleared, then 10% off the Cake; 20.00 − 0.80 + SST 0.60 + 0.58 = 20.38 → 20.40
  v_b := pg_temp.bill_of(pg_temp.order_on('r1', 2, array['latte', 'cake', 'water']));
  perform pg_temp.put('A', v_b);
  perform pg_temp.ok(set_bill_discount(v_b, 'amount', 100, 'Regular', v_sup, '2222'), 'A bill discount');
  perform pg_temp.ok(clear_bill_discount(v_b), 'A clear');
  perform pg_temp.ok(set_item_discount((select id from order_items where bill_id = v_b and product_id = pg_temp.id('cake')),
                                       'percent', 1000, 'Regular', v_sup, '2222'), 'A item discount');
  perform checkout_bill(v_b, pg_temp.pay('card', 2040), gen_random_uuid());
  -- B: Water voided, RM 2.00 off; 20.00 − 2.00 + SST 1.08 = 19.08 → 19.10
  v_b := pg_temp.bill_of(pg_temp.order_on('r2', 1, array['latte:2', 'water']));
  perform pg_temp.put('B', v_b);
  perform pg_temp.put('Bwater', (select id from order_items where bill_id = v_b and product_id = pg_temp.id('water')));
  perform pg_temp.ok(void_order_item(pg_temp.id('Bwater'), 'Wrong item keyed', v_sup, '2222'), 'B void');
  perform pg_temp.ok(set_bill_discount(v_b, 'amount', 200, 'Regular', v_sup, '2222'), 'B bill discount');
  perform checkout_bill(v_b, pg_temp.pay('cash', 1910, 2000), gen_random_uuid());
  -- C: takeaway, 28.40 + SST 2.27 = 30.67 → 30.65; RM 3.00 refunded in cash
  v_b := pg_temp.bill_of(pg_temp.order_on(null, null, array['cake', 'muffin', 'muffin']));
  perform pg_temp.put('C', v_b);
  if (select count(*) from order_items where bill_id = v_b and product_id = pg_temp.id('muffin')) <> 2 then
    raise exception 'FAIL fixture: C should have two Muffin lines';
  end if;
  perform checkout_bill(v_b, pg_temp.pay('cash', 3065, 5000), gen_random_uuid());
  perform pg_temp.ok(refund_bill(gen_random_uuid(), v_b, 300, pg_temp.id('cash'), 'Cold cake', v_sup, '2222'), 'C refund');
  -- D: the Water split off by item (its own paid bill D'), then the Latte
  v_b := pg_temp.bill_of(pg_temp.order_on('r3', 2, array['latte', 'water']));
  perform pg_temp.put('D', v_b);
  v_res := checkout_items(v_b, jsonb_build_array(jsonb_build_object(
             'itemId', (select id from order_items where bill_id = v_b and product_id = pg_temp.id('water')), 'qty', 1)),
           pg_temp.pay('card', 200), gen_random_uuid());
  perform pg_temp.put('Dpart', (v_res->>'billId')::uuid);
  perform checkout_bill(v_b, pg_temp.pay('card', 1060), gen_random_uuid());
  -- E: a QR order; RM 10.00 paid as a part, the rest (19.24 → 19.25) in cash
  v_o := pg_temp.order_on('r4', 2, array['cake', 'latte']);
  v_b := pg_temp.bill_of(v_o);
  perform pg_temp.put('E', v_b);
  update orders set source = 'qr' where id = v_o;
  perform pg_temp.put('Epart', gen_random_uuid());
  perform pay_bill_part(v_b, pg_temp.id('Epart'), 1000, null, pg_temp.pay('card', 1000), 0);
  perform checkout_bill(v_b, pg_temp.pay('cash', 925, 925), gen_random_uuid());
  -- F: outside the range; G: a voided bill; P: the previous period
  v_b := pg_temp.bill_of(pg_temp.order_on('r5', 2, array['water']));
  perform pg_temp.put('F', v_b);
  perform checkout_bill(v_b, pg_temp.pay('card', 200), gen_random_uuid());
  v_b := pg_temp.bill_of(pg_temp.order_on('r6', 2, array['water']));
  perform pg_temp.put('G', v_b);
  perform pg_temp.ok(void_bill(v_b, 'Guest left', v_sup, '2222'), 'G void');
  v_b := pg_temp.bill_of(pg_temp.order_on('r7', 2, array['latte']));
  perform pg_temp.put('P', v_b);
  perform checkout_bill(v_b, pg_temp.pay('card', 1060), gen_random_uuid());

  -- add-ons as the lines carry them (the snapshot only; the prices above stay as charged)
  update order_items
     set modifiers_snapshot = '[{"optionId": null, "group": "Milk", "name": "Oat milk", "priceDeltaSen": 150, "route": null}]'
   where bill_id in (pg_temp.id('A'), pg_temp.id('E')) and product_id = pg_temp.id('latte');
  update order_items
     set modifiers_snapshot = '[{"optionId": null, "group": "Extra", "name": "Extra shot", "priceDeltaSen": 100, "route": null}]'
   where bill_id = pg_temp.id('B') and product_id = pg_temp.id('latte');

  -- the business days of the story (all of it ran at now(), in one transaction)
  for r in select * from (values ('A', '2026-01-05 12:00+08'), ('B', '2026-01-06 01:30+08'), ('C', '2026-01-06 10:00+08'),
                                 ('Dpart', '2026-01-06 13:00+08'), ('D', '2026-01-06 13:10+08'), ('E', '2026-01-06 14:00+08'),
                                 ('F', '2026-01-07 06:00+08'), ('G', '2026-01-06 15:00+08'), ('P', '2026-01-05 05:59+08'))
                    as x(k, at) loop
    update bills set closed_at = r.at::timestamptz where id = pg_temp.id(r.k);
    update payments set taken_at = r.at::timestamptz where bill_id = pg_temp.id(r.k);
  end loop;
  update payments set taken_at = '2026-01-06 13:50+08' where part_id = pg_temp.id('Epart');
  update order_items set voided_at = '2026-01-05 13:00+08' where id = pg_temp.id('Bwater');
  update order_items set voided_at = '2026-01-06 15:00+08' where bill_id = pg_temp.id('G');
  update refunds set created_at = '2026-01-06 10:30+08' where bill_id = pg_temp.id('C');
  update pos_discount_log set created_at = '2026-01-05 11:40+08'
   where bill_id = pg_temp.id('A') and order_item_id is null and action = 'set';
  update pos_discount_log set created_at = '2026-01-05 11:45+08' where bill_id = pg_temp.id('A') and action = 'clear';
  update pos_discount_log set created_at = '2026-01-05 11:50+08' where bill_id = pg_temp.id('A') and order_item_id is not null;
  update pos_discount_log set created_at = '2026-01-05 13:05+08' where bill_id = pg_temp.id('B');

  -- the cash drawer: S1 (D2 08:00–22:00) takes C's and E's cash, C's refund, a pay in and a pay out;
  -- expected 100.00 + 30.65 + 9.25 − 3.00 + 20.00 − 5.00 = 151.90, counted 151.50
  insert into pos_shifts(branch_id, opened_by, opened_at, opening_float_sen, status, counted_cash_sen, expected_cash_sen,
                         variance_sen, variance_reason, variance_approved_by, closed_by, closed_at)
  values (v_a, v_cash, '2026-01-06 08:00+08', 10000, 'closed', 15150, 15190, -40, 'Short at close', v_sup, v_cash,
          '2026-01-06 22:00+08')
  returning id into v_s1;
  perform pg_temp.put('S1', v_s1);
  update payments set shift_id = v_s1 where bill_id in (pg_temp.id('C'), pg_temp.id('E')) and kind = 'cash';
  update refunds set shift_id = v_s1 where bill_id = pg_temp.id('C');
  insert into pos_cash_moves(id, shift_id, branch_id, kind, amount_sen, reason, created_by, approved_by, created_at) values
    (gen_random_uuid(), v_s1, v_a, 'pay_in', 2000, 'Float top-up', v_cash, null, '2026-01-06 09:00+08'),
    (gen_random_uuid(), v_s1, v_a, 'pay_out', 500, 'Ice', v_cash, v_sup, '2026-01-06 16:00+08');
  -- the tablet's shift stays open: opened D2 20:00, B's cash in it, expected 100.00 + 19.10 = 119.10
  update pos_shifts set opened_at = '2026-01-06 20:00+08' where id = pg_temp.id('shift');
end $$;

-- ── R1. Scope and access (spec §2, §3) ──────────────────────────────────────
do $$
declare
  v_a     uuid := pg_temp.id('branch');
  v_other uuid := pg_temp.id('other');
  v_b     record;
  r       record;
begin
  -- grants: the report to authenticated only; the helpers to nobody; the index
  if not has_function_privilege('authenticated', 'pos_report_sales(uuid[],date,date)', 'execute')
     or has_function_privilege('anon', 'pos_report_sales(uuid[],date,date)', 'execute') then
    raise exception 'FAIL R1 grants: pos_report_sales';
  end if;
  for r in select f from unnest(array['pos_business_day(timestamptz)', 'pos_report_scope(uuid[],date,date)',
                                      'pos_report_paid_bills(uuid[],timestamptz,timestamptz)',
                                      'pos_report_cards(uuid[],timestamptz,timestamptz)']) f loop
    if has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL R1 grants: % is internal', r.f;
    end if;
  end loop;
  if to_regclass('public.pos_discount_log_branch_created_idx') is null then
    raise exception 'FAIL R1: index pos_discount_log_branch_created_idx is missing';
  end if;
  if to_regclass('public.order_items_voided_idx') is null then
    raise exception 'FAIL R1: index order_items_voided_idx is missing';
  end if;
  -- pos_business_day is a plain immutable function (not security definer) so the planner can inline it
  if (select p.prosecdef from pg_proc p where p.oid = 'pos_business_day(timestamptz)'::regprocedure)
     or (select p.provolatile from pg_proc p where p.oid = 'pos_business_day(timestamptz)'::regprocedure) <> 'i' then
    raise exception 'FAIL R1: pos_business_day must be immutable and not security definer';
  end if;
  -- the business day: 06:00 to 05:59 the next morning, Malaysia time
  if pos_business_day('2026-01-06 01:30+08') <> date '2026-01-05'
     or pos_business_day('2026-01-05 06:00+08') <> date '2026-01-05'
     or pos_business_day('2026-01-05 05:59:59+08') <> date '2026-01-04' then
    raise exception 'FAIL R1 business day';
  end if;
  -- D1..D2 = D1 06:00 up to (not including) 7 Jan 06:00
  perform pg_temp.act(pg_temp.id('owner'));
  select * into v_b from pos_report_scope(array[v_a], '2026-01-05', '2026-01-06');
  if v_b.start_at <> '2026-01-05 06:00+08'::timestamptz or v_b.end_at <> '2026-01-07 06:00+08'::timestamptz then
    raise exception 'FAIL R1 bounds: % %', v_b.start_at, v_b.end_at;
  end if;
  -- the range: from <= to, at most 366 days, at least one outlet, both dates
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_a], '2026-01-06', '2026-01-05'),
    'The start date is after the end date.', 'R1 from after to');
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_a], '2026-01-01', '2027-01-02'),
    'Choose at most 366 days.', 'R1 367 days');
  perform pos_report_sales(array[v_a], '2026-01-01', '2027-01-01');                 -- 366 days pass
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', '{}'::uuid[], '2026-01-05', '2026-01-06'),
    'Choose at least one outlet.', 'R1 no outlet');
  perform pg_temp.expect_error(format('select pos_report_sales(%L, null, %L)', array[v_a], '2026-01-06'),
    'Choose a valid date range.', 'R1 no start date');
  -- every outlet asked for must be one the caller manages, from a back-office login
  perform pg_temp.act(pg_temp.id('mgr'));
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_a], '2026-01-05', '2026-01-06'),
    'You cannot see reports for this outlet.', 'R1 a manager of another outlet');
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_other, v_a], '2026-01-05', '2026-01-06'),
    'You cannot see reports for this outlet.', 'R1 one outlet of two not theirs');
  if (pos_report_sales(array[v_other], '2026-01-05', '2026-01-06')->'current'->>'bills')::int <> 0 then
    raise exception 'FAIL R1 the manager''s own outlet';
  end if;
  perform pg_temp.act(pg_temp.id('cashier'));
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_a], '2026-01-05', '2026-01-06'),
    'You cannot see reports for this outlet.', 'R1 a cashier');
  perform pg_temp.act(pg_temp.id('dev'));
  perform pg_temp.expect_error(format('select pos_report_sales(%L, %L, %L)', array[v_a], '2026-01-05', '2026-01-06'),
    'You cannot see reports for this outlet.', 'R1 a tablet session');
end $$;

-- ── R2. Sales: Overview, Sales summary, Daily and Hourly (spec §4, §5.1–5.4) ─
do $$
declare
  v_a uuid := pg_temp.id('branch');
  v   jsonb;
begin
  perform pg_temp.act(pg_temp.id('owner'));
  v := pos_report_sales(array[v_a], '2026-01-05', '2026-01-06');
  -- A B C D' D E; F (7 Jan 06:00) and P (5 Jan 05:59) are outside; voids: B's and G's Water; C's refund apart
  if v->'current' <> '{"nettSen": 10200, "bills": 6, "pax": 7, "discountSen": 280, "voidSen": 400, "refundSen": 300}'::jsonb then
    raise exception 'FAIL R2 current: %', v->'current';
  end if;
  -- the period of the same length before, 3–4 Jan: P only
  if v->'previous' <> '{"nettSen": 1060, "bills": 1, "pax": 2, "discountSen": 0, "voidSen": 0, "refundSen": 0}'::jsonb then
    raise exception 'FAIL R2 previous: %', v->'previous';
  end if;
  -- one row per outlet and business day; B (6 Jan 01:30) counts to 5 Jan
  if v->'daily' <> jsonb_build_array(
       jsonb_build_object('branchId', v_a, 'outlet', 'VERIFY R', 'day', '2026-01-05', 'bills', 2, 'pax', 3,
                          'grossSen', 4000, 'discountSen', 280, 'takeawayFeeSen', 0, 'serviceChargeSen', 0,
                          'sstSen', 226, 'roundingSen', 4, 'nettSen', 3950, 'refundSen', 0),
       jsonb_build_object('branchId', v_a, 'outlet', 'VERIFY R', 'day', '2026-01-06', 'bills', 4, 'pax', 4,
                          'grossSen', 5840, 'discountSen', 0, 'takeawayFeeSen', 0, 'serviceChargeSen', 0,
                          'sstSen', 411, 'roundingSen', -1, 'nettSen', 6250, 'refundSen', 300)) then
    raise exception 'FAIL R2 daily: %', v->'daily';
  end if;
  -- 24 rows, the Malaysia hour of closed_at
  if jsonb_array_length(v->'hourly') <> 24
     or (select jsonb_agg(x.h order by (x.h->>'hour')::int) from jsonb_array_elements(v->'hourly') as x(h)
          where (x.h->>'bills')::int > 0)
        <> '[{"hour": 1, "bills": 1, "nettSen": 1910}, {"hour": 10, "bills": 1, "nettSen": 3065},
             {"hour": 12, "bills": 1, "nettSen": 2040}, {"hour": 13, "bills": 2, "nettSen": 1260},
             {"hour": 14, "bills": 1, "nettSen": 1925}]'::jsonb then
    raise exception 'FAIL R2 hourly: %', v->'hourly';
  end if;
  -- Feedme's order: 98.40 − 0.80 − 2.00 = 95.60 + SST 6.37 + rounding 0.03 = 102.00
  if v->'summary' <> '{"beforeDiscountsSen": 9840, "catalogDiscountSen": 0, "itemDiscountSen": 80, "billDiscountSen": 200,
                       "grossSen": 9560, "takeawayFeeSen": 0, "serviceChargeSen": 0, "sstSen": 637, "roundingSen": 3,
                       "nettSen": 10200}'::jsonb then
    raise exception 'FAIL R2 summary: %', v->'summary';
  end if;
  if v->'orderTypes' <> '[{"orderType": "dine_in", "bills": 5, "nettSen": 7135},
                          {"orderType": "takeaway", "bills": 1, "nettSen": 3065}]'::jsonb then
    raise exception 'FAIL R2 order types: %', v->'orderTypes';
  end if;
  -- orders, not bills: D and its split part D' are one counter order; E is the QR order
  if v->'sources' <> '[{"source": "counter", "orders": 4, "itemSen": 8040}, {"source": "qr", "orders": 1, "itemSen": 1800}]'::jsonb then
    raise exception 'FAIL R2 sources: %', v->'sources';
  end if;
  if v->'topProducts' <> '[{"name": "Verify R Latte", "qty": 5, "valueSen": 5000}, {"name": "Verify R Cake", "qty": 3, "valueSen": 2400},
                           {"name": "Verify R Muffin", "qty": 2, "valueSen": 2040}, {"name": "Verify R Water", "qty": 2, "valueSen": 400}]'::jsonb then
    raise exception 'FAIL R2 top products: %', v->'topProducts';
  end if;
  -- two outlets add up; an outlet with no sales answers zeros and empty lists
  if (pos_report_sales(array[v_a, pg_temp.id('other')], '2026-01-05', '2026-01-06')->'current'->>'nettSen')::int <> 10200 then
    raise exception 'FAIL R2 two outlets';
  end if;
  v := pos_report_sales(array[pg_temp.id('other')], '2026-01-05', '2026-01-06');
  if v->'current' <> '{"nettSen": 0, "bills": 0, "pax": 0, "discountSen": 0, "voidSen": 0, "refundSen": 0}'::jsonb
     or v->'daily' <> '[]'::jsonb or v->'topProducts' <> '[]'::jsonb or jsonb_array_length(v->'hourly') <> 24
     or (v->'summary'->>'nettSen')::int <> 0 or (v->'orderTypes'->0->>'bills')::int <> 0 then
    raise exception 'FAIL R2 an outlet with no sales: %', v;
  end if;
end $$;

-- ── R3. Products, payments and SST (spec §4, §5.5–5.7) ───────────────────────
do $$
declare
  v_a uuid := pg_temp.id('branch');
  v   jsonb;
  r   record;
begin
  for r in select f from unnest(array['pos_report_products(uuid[],date,date)', 'pos_report_payments(uuid[],date,date)',
                                      'pos_report_sst(uuid[],date,date)']) f loop
    if not has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL R3 grants: %', r.f;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'pos_report_lines(uuid[],timestamptz,timestamptz)', 'execute') then
    raise exception 'FAIL R3 grants: pos_report_lines is internal';
  end if;
  perform pg_temp.act(pg_temp.id('mgr'));
  for r in select f from unnest(array['pos_report_products', 'pos_report_payments', 'pos_report_sst']) f loop
    perform pg_temp.expect_error(format('select %s(%L, %L, %L)', r.f, array[v_a], '2026-01-05', '2026-01-06'),
      'You cannot see reports for this outlet.', 'R3 ' || r.f || ' of another outlet');
  end loop;
  perform pg_temp.act(pg_temp.id('owner'));

  -- products: today's name and category; net after every discount (B's RM 2.00 sits on its Latte)
  v := pos_report_products(array[v_a], '2026-01-05', '2026-01-06');
  if v->'products' <> '[
       {"name": "Verify R Latte",  "category": "VERIFY R DRINKS", "qty": 5, "grossSen": 5000, "discountSen": 200, "netSen": 4800},
       {"name": "Verify R Cake",   "category": "VERIFY R FOOD",   "qty": 3, "grossSen": 2400, "discountSen": 80,  "netSen": 2320},
       {"name": "Verify R Muffin", "category": "VERIFY R FOOD",   "qty": 2, "grossSen": 2040, "discountSen": 0,   "netSen": 2040},
       {"name": "Verify R Water",  "category": "VERIFY R DRINKS", "qty": 2, "grossSen": 400,  "discountSen": 0,   "netSen": 400}]'::jsonb then
    raise exception 'FAIL R3 products: %', v->'products';
  end if;
  -- add-ons: the options on the live lines, priceDeltaSen × qty (A's and E's Latte; B's two Lattes)
  if v->'addOns' <> '[{"name": "Oat milk", "count": 2, "valueSen": 300}, {"name": "Extra shot", "count": 2, "valueSen": 200}]'::jsonb then
    raise exception 'FAIL R3 add-ons: %', v->'addOns';
  end if;
  if v->'categories' <> '[{"category": "VERIFY R DRINKS", "qty": 7, "netSen": 5200},
                          {"category": "VERIFY R FOOD", "qty": 5, "netSen": 4360}]'::jsonb then
    raise exception 'FAIL R3 categories: %', v->'categories';
  end if;

  -- payments of the bills sold in the range (E's part is a payment like any other); refunds by their own
  -- time; the amounts add up to Nett sales (102.00)
  v := pos_report_payments(array[v_a], '2026-01-05', '2026-01-06');
  if v <> '{"methods": [
       {"name": "R Card", "kind": "card", "count": 4, "amountSen": 4300, "refundCount": 0, "refundSen": 0, "netSen": 4300},
       {"name": "R Cash", "kind": "cash", "count": 3, "amountSen": 5900, "refundCount": 1, "refundSen": 300, "netSen": 5600}]}'::jsonb then
    raise exception 'FAIL R3 payments: %', v;
  end if;

  -- SST from the bills' sstGroups: 6% on 10.00 + 18.00 + 10.00 + 10.00; 8% on 7.20 + 28.40 + 8.00;
  -- exempt = the 0% lines' SST base, no fee here (the Water of A and of D': 2.00 + 2.00)
  v := pos_report_sst(array[v_a], '2026-01-05', '2026-01-06');
  if v <> '{"rates": [{"rateBp": 600, "baseSen": 4800, "sstSen": 288}, {"rateBp": 800, "baseSen": 4360, "sstSen": 349}],
            "exemptSen": 400,
            "months": [{"month": "2026-01",
                        "rates": [{"rateBp": 600, "baseSen": 4800, "sstSen": 288}, {"rateBp": 800, "baseSen": 4360, "sstSen": 349}],
                        "exemptSen": 400}]}'::jsonb then
    raise exception 'FAIL R3 SST: %', v;
  end if;

  -- an outlet with no sales
  if pos_report_products(array[pg_temp.id('other')], '2026-01-05', '2026-01-06') <> '{"products": [], "addOns": [], "categories": []}'::jsonb
     or pos_report_payments(array[pg_temp.id('other')], '2026-01-05', '2026-01-06') <> '{"methods": []}'::jsonb
     or pos_report_sst(array[pg_temp.id('other')], '2026-01-05', '2026-01-06') <> '{"rates": [], "exemptSen": 0, "months": []}'::jsonb then
    raise exception 'FAIL R3 an outlet with no sales';
  end if;
end $$;

-- ── R4. Discounts, voids, refunds, the cash drawer and the ledger (spec §5.8–5.12) ─
do $$
declare
  v_a    uuid := pg_temp.id('branch');
  v_no_a text := (select bill_no from bills where id = pg_temp.id('A'));
  v_no_b text := (select bill_no from bills where id = pg_temp.id('B'));
  v_no_c text := (select bill_no from bills where id = pg_temp.id('C'));
  v_no_e text := (select bill_no from bills where id = pg_temp.id('E'));
  v_no_g text := (select bill_no from bills where id = pg_temp.id('G'));
  v      jsonb;
  r      record;
begin
  for r in select f from unnest(array['pos_report_audit(uuid[],date,date)', 'pos_report_drawer(uuid[],date,date)',
                                      'pos_report_ledger(uuid[],date,date)']) f loop
    if not has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL R4 grants: %', r.f;
    end if;
  end loop;
  perform pg_temp.act(pg_temp.id('mgr'));
  for r in select f from unnest(array['pos_report_audit', 'pos_report_drawer', 'pos_report_ledger']) f loop
    perform pg_temp.expect_error(format('select %s(%L, %L, %L)', r.f, array[v_a], '2026-01-05', '2026-01-06'),
      'You cannot see reports for this outlet.', 'R4 ' || r.f || ' of another outlet');
  end loop;
  perform pg_temp.act(pg_temp.id('owner'));

  -- discounts: every one set and cleared, oldest first; a clear keeps what it cleared and has no approver
  v := pos_report_audit(array[v_a], '2026-01-05', '2026-01-06');
  if v->'discounts' <> jsonb_build_array(
       jsonb_build_object('at', '2026-01-05T03:40:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_a, 'item', null,
                          'action', 'set', 'kind', 'amount', 'value', 100, 'reason', 'Regular',
                          'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor'),
       jsonb_build_object('at', '2026-01-05T03:45:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_a, 'item', null,
                          'action', 'clear', 'kind', 'amount', 'value', 100, 'reason', 'Regular',
                          'by', 'Verify R Cashier', 'approvedBy', null),
       jsonb_build_object('at', '2026-01-05T03:50:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_a, 'item', 'Verify R Cake',
                          'action', 'set', 'kind', 'percent', 'value', 1000, 'reason', 'Regular',
                          'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor'),
       jsonb_build_object('at', '2026-01-05T05:05:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_b, 'item', null,
                          'action', 'set', 'kind', 'amount', 'value', 200, 'reason', 'Regular',
                          'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor')) then
    raise exception 'FAIL R4 discounts: %', v->'discounts';
  end if;
  if v->'discountTotals' <> '{"catalogSen": 0, "catalogBills": 0, "itemSen": 80, "itemCount": 1, "billSen": 200, "billCount": 1}'::jsonb then
    raise exception 'FAIL R4 discount totals: %', v->'discountTotals';
  end if;
  -- voids: B's Water, and G's Water voided with its bill
  if v->'voidItems' <> jsonb_build_array(
       jsonb_build_object('at', '2026-01-05T05:00:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_b, 'name', 'Verify R Water',
                          'qty', 1, 'valueSen', 200, 'reason', 'Wrong item keyed',
                          'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor'),
       jsonb_build_object('at', '2026-01-06T07:00:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_g, 'name', 'Verify R Water',
                          'qty', 1, 'valueSen', 200, 'reason', 'Guest left',
                          'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor'))
     or v->'voidBills' <> jsonb_build_array(
       jsonb_build_object('at', '2026-01-06T07:00:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_g, 'valueSen', 200,
                          'reason', 'Guest left', 'by', 'Verify R Cashier', 'approvedBy', 'Verify R Supervisor')) then
    raise exception 'FAIL R4 voids: % %', v->'voidItems', v->'voidBills';
  end if;
  if v->'refunds' <> jsonb_build_array(
       jsonb_build_object('at', '2026-01-06T02:30:00.000Z', 'outlet', 'VERIFY R', 'billNo', v_no_c, 'method', 'R Cash',
                          'amountSen', 300, 'reason', 'Cold cake', 'approvedBy', 'Verify R Supervisor')) then
    raise exception 'FAIL R4 refunds: %', v->'refunds';
  end if;

  -- the cash drawer: S1 by its close (D2 22:00), the open shift by its open (D2 20:00)
  v := pos_report_drawer(array[v_a], '2026-01-05', '2026-01-06');
  if v <> jsonb_build_object('shifts', jsonb_build_array(
       jsonb_build_object('outlet', 'VERIFY R', 'openedAt', '2026-01-06T00:00:00.000Z', 'closedAt', '2026-01-06T14:00:00.000Z',
                          'openedBy', 'Verify R Cashier', 'closedBy', 'Verify R Cashier', 'floatSen', 10000,
                          'cashSalesSen', 3990, 'cashRefundSen', 300, 'payInSen', 2000, 'payOutSen', 500,
                          'expectedSen', 15190, 'countedSen', 15150, 'varianceSen', -40, 'reason', 'Short at close'),
       jsonb_build_object('outlet', 'VERIFY R', 'openedAt', '2026-01-06T12:00:00.000Z', 'closedAt', null,
                          'openedBy', 'Verify R Cashier', 'closedBy', null, 'floatSen', 10000,
                          'cashSalesSen', 1910, 'cashRefundSen', 0, 'payInSen', 0, 'payOutSen', 0,
                          'expectedSen', 11910, 'countedSen', null, 'varianceSen', null, 'reason', null))) then
    raise exception 'FAIL R4 drawer: %', v;
  end if;

  -- the ledger
  v := pos_report_ledger(array[v_a], '2026-01-05', '2026-01-06');
  -- bills.csv: the six paid bills by closing time
  if (select jsonb_agg(x.b->>'billNo' order by x.o) from jsonb_array_elements(v->'bills') with ordinality as x(b, o))
     <> (select jsonb_agg(bill_no order by closed_at) from bills
          where id in (pg_temp.id('A'), pg_temp.id('B'), pg_temp.id('C'), pg_temp.id('Dpart'), pg_temp.id('D'), pg_temp.id('E')))
     or v->'bills'->0 <> jsonb_build_object('outlet', 'VERIFY R', 'businessDate', '2026-01-05', 'closedAt', '2026-01-05T04:00:00.000Z',
                          'billNo', v_no_a, 'orderType', 'dine_in', 'table', 'R1', 'pax', 2, 'grossSen', 2000, 'discountSen', 80,
                          'takeawayFeeSen', 0, 'serviceChargeSen', 0, 'sstSen', 118, 'roundingSen', 2, 'totalSen', 2040,
                          'refundedSen', 0)
     or v->'bills'->2 <> jsonb_build_object('outlet', 'VERIFY R', 'businessDate', '2026-01-06', 'closedAt', '2026-01-06T02:00:00.000Z',
                          'billNo', v_no_c, 'orderType', 'takeaway', 'table', null, 'pax', null, 'grossSen', 2840, 'discountSen', 0,
                          'takeawayFeeSen', 0, 'serviceChargeSen', 0, 'sstSen', 227, 'roundingSen', -2, 'totalSen', 3065,
                          'refundedSen', 300) then
    raise exception 'FAIL R4 ledger bills: %', v->'bills';
  end if;
  -- lines.csv: 11 live lines; each bill's line SST adds up to its rate group
  if jsonb_array_length(v->'lines') <> 11
     or (select sum((l->>'sstSen')::int) from jsonb_array_elements(v->'lines') l) <> 637
     or exists (
          select 1
            from (select l->>'billNo' as bill_no, (l->>'sstRateBp')::int as rate_bp, sum((l->>'sstSen')::int) as sst
                    from jsonb_array_elements(v->'lines') l group by 1, 2) x
            join bills b on b.branch_id = v_a and b.bill_no = x.bill_no
            left join lateral (select (g->>'amountSen')::int as amt from jsonb_array_elements(b.totals->'sstGroups') g
                                where (g->>'rateBp')::int = x.rate_bp) g on true
           where x.sst <> coalesce(g.amt, 0)) then
    raise exception 'FAIL R4 ledger lines do not add up: %', v->'lines';
  end if;
  -- largest remainder: C's 8% group of 227 sen on 8.00 + 10.20 + 10.20 is 63.94 / 81.53 / 81.53 sen → 64, 82, 81
  -- (rounding each line would give 64 + 82 + 82 = 228)
  if (select jsonb_agg((l->>'sstSen')::int order by (l->>'sstSen')::int) from jsonb_array_elements(v->'lines') l
       where l->>'billNo' = v_no_c) <> '[64, 81, 82]'::jsonb then
    raise exception 'FAIL R4 ledger largest remainder';
  end if;
  if (select l from jsonb_array_elements(v->'lines') l where l->>'billNo' = v_no_a and l->>'item' = 'Verify R Cake')
       <> jsonb_build_object('outlet', 'VERIFY R', 'billNo', v_no_a, 'item', 'Verify R Cake', 'qty', 1, 'unitPriceSen', 800,
                             'catalogDiscountSen', 0, 'itemDiscountSen', 80, 'billShareSen', 0, 'netSen', 720,
                             'sstRateBp', 800, 'sstSen', 58)
     or (select l from jsonb_array_elements(v->'lines') l where l->>'billNo' = v_no_b)
       <> jsonb_build_object('outlet', 'VERIFY R', 'billNo', v_no_b, 'item', 'Verify R Latte', 'qty', 2, 'unitPriceSen', 1000,
                             'catalogDiscountSen', 0, 'itemDiscountSen', 0, 'billShareSen', 200, 'netSen', 1800,
                             'sstRateBp', 600, 'sstSen', 108) then
    raise exception 'FAIL R4 ledger line values';
  end if;
  -- payments.csv: 7 payments adding up to Nett sales; E's part keeps its part number
  if jsonb_array_length(v->'payments') <> 7
     or (select sum((p->>'amountSen')::int) from jsonb_array_elements(v->'payments') p) <> 10200
     or (select jsonb_agg(p) from jsonb_array_elements(v->'payments') p where p->'partNo' <> 'null'::jsonb)
        <> jsonb_build_array(jsonb_build_object('outlet', 'VERIFY R', 'billNo', v_no_e, 'partNo', 1, 'method', 'R Card',
                             'kind', 'card', 'amountSen', 1000, 'tenderedSen', null, 'changeSen', 0, 'reference', null,
                             'takenAt', '2026-01-06T05:50:00.000Z'))
     or (select p from jsonb_array_elements(v->'payments') p where p->>'billNo' = v_no_c)
        <> jsonb_build_object('outlet', 'VERIFY R', 'billNo', v_no_c, 'partNo', null, 'method', 'R Cash', 'kind', 'cash',
                              'amountSen', 3065, 'tenderedSen', 5000, 'changeSen', 1935, 'reference', null,
                              'takenAt', '2026-01-06T02:00:00.000Z') then
    raise exception 'FAIL R4 ledger payments: %', v->'payments';
  end if;

  -- an outlet with no sales
  if pos_report_audit(array[pg_temp.id('other')], '2026-01-05', '2026-01-06')
       <> '{"discounts": [], "discountTotals": {"catalogSen": 0, "catalogBills": 0, "itemSen": 0, "itemCount": 0, "billSen": 0, "billCount": 0},
            "voidItems": [], "voidBills": [], "refunds": []}'::jsonb
     or pos_report_drawer(array[pg_temp.id('other')], '2026-01-05', '2026-01-06') <> '{"shifts": []}'::jsonb
     or pos_report_ledger(array[pg_temp.id('other')], '2026-01-05', '2026-01-06') <> '{"bills": [], "lines": [], "payments": []}'::jsonb then
    raise exception 'FAIL R4 an outlet with no sales';
  end if;
end $$;

-- ── R5. Fix-pass cases (run last: they change the fixture, the earlier sections are already checked) ──
do $$
declare
  v_a     uuid := pg_temp.id('branch');
  v       jsonb;
  v_h     uuid;
  v_water uuid;
  v_no_h  text;
begin
  perform pg_temp.act(pg_temp.id('owner'));

  -- SST exempt is the 0% lines' SST base: D' (Water 2.00, 0%) becomes a takeaway line with a 0.50 fee, so its
  -- base is 2.00 + 0.50 = 2.50. And SST months follow the CALENDAR month of closed_at in Malaysia time:
  -- A is moved to 1 Feb 01:30 (business day 31 Jan, inside the range 5 Jan to 1 Feb; the bounds are
  -- 5 Jan 06:00 up to 2 Feb 06:00). F (7 Jan 06:00, Water 2.00, 0%) is inside this wider range; P (5 Jan 05:59) is not.
  --   A (moved)  6%: base 10.00, SST 0.60;  8%: base 7.20, SST 0.58;  exempt 2.00   → February
  --   rest of January: 6%: 18.00 + 10.00 + 10.00 = 38.00, SST 1.08 + 0.60 + 0.60 = 2.28
  --                    8%: 43.60 − 7.20 = 36.40, SST 3.49 − 0.58 = 2.91
  --                    exempt: D' 2.50 + F 2.00 = 4.50
  --   totals: 6% 48.00 / 2.88, 8% 43.60 / 3.49, exempt 2.50 + 2.00 (A) + 2.00 (F) = 6.50
  update order_items set order_type = 'takeaway', takeaway_fee_sen = 50 where bill_id = pg_temp.id('Dpart');
  update bills set closed_at = '2026-02-01 01:30+08'::timestamptz where id = pg_temp.id('A');
  v := pos_report_sst(array[v_a], '2026-01-05', '2026-02-01');
  if v <> '{"rates": [{"rateBp": 600, "baseSen": 4800, "sstSen": 288}, {"rateBp": 800, "baseSen": 4360, "sstSen": 349}],
            "exemptSen": 650,
            "months": [{"month": "2026-01",
                        "rates": [{"rateBp": 600, "baseSen": 3800, "sstSen": 228}, {"rateBp": 800, "baseSen": 3640, "sstSen": 291}],
                        "exemptSen": 450},
                       {"month": "2026-02",
                        "rates": [{"rateBp": 600, "baseSen": 1000, "sstSen": 60}, {"rateBp": 800, "baseSen": 720, "sstSen": 58}],
                        "exemptSen": 200}]}'::jsonb then
    raise exception 'FAIL R5 SST exempt base and calendar months: %', v;
  end if;

  -- voidBills value = only the items voided together with the bill. H: Latte 10.00 + Water 2.00; the Water is
  -- voided at 15:30, then the bill at 16:00 (void_bill stamps the Latte and the bill with one time) → 10.00, not 12.00
  perform pg_temp.act(pg_temp.id('dev'));
  v_h := pg_temp.bill_of(pg_temp.order_on('r7', 1, array['latte', 'water']));
  v_water := (select id from order_items where bill_id = v_h and product_id = pg_temp.id('water'));
  perform pg_temp.ok(void_order_item(v_water, 'Wrong item keyed', pg_temp.id('sup'), '2222'), 'R5 H item void');
  perform pg_temp.ok(void_bill(v_h, 'Guest left', pg_temp.id('sup'), '2222'), 'R5 H void');
  update bills set closed_at = '2026-01-06 16:00+08'::timestamptz where id = v_h;
  update order_items set voided_at = case when id = v_water then '2026-01-06 15:30+08'::timestamptz
                                          else '2026-01-06 16:00+08'::timestamptz end
   where bill_id = v_h;
  perform pg_temp.act(pg_temp.id('owner'));
  v_no_h := (select bill_no from bills where id = v_h);
  v := pos_report_audit(array[v_a], '2026-01-05', '2026-01-06');
  if (select x->>'valueSen' from jsonb_array_elements(v->'voidBills') x where x->>'billNo' = v_no_h) is distinct from '1000' then
    raise exception 'FAIL R5 voided bill value should exclude the earlier voided item: %', v->'voidBills';
  end if;

  -- the ledger export: 92 days pass, 93 do not (5 Jan to 6 Apr is 27 + 28 + 31 + 6 = 92 days)
  perform pos_report_ledger(array[v_a], '2026-01-05', '2026-04-06');
  perform pg_temp.expect_error(format('select pos_report_ledger(%L, %L, %L)', array[v_a], '2026-01-05', '2026-04-07'),
    'Export at most 92 days at a time.', 'R5 ledger 93 days');
end $$;

select 'VERIFY OK' as result;
rollback;
