-- Self-check for POS part payments (split equally / by amount, Part B). Run on craft-os-dev after
-- migration-2026-11-17-pos-bill-parts.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections (one DO block each, ids in the temp table fixture): FIXTURE; B1 quote and
-- part payments; B1f fixes after the B1 review (rolled back inside the block); B2 the balance by
-- checkout_bill and the guards; B2p pay_bill_part's p_paid_sen (rolled back inside the block); B3
-- receipts and screen reads.
-- Numbers: no service charge, 0% SST, 5 sen rounding; Set A 70.35, Set B 70.40, Extra 3.00.
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
create function pg_temp.card(p_sen integer) returns jsonb
language sql as $$ select jsonb_build_array(jsonb_build_object('methodId', pg_temp.id('card'), 'amountSen', p_sen)) $$;
-- one order of products on a table (or onto its open bill); returns the order id
create function pg_temp.order_on(p_table text, p_products text[]) returns uuid
language sql as $$
  select place_counter_order(pg_temp.id(p_table), 'dine_in', 2,
           (select jsonb_agg(jsonb_build_object('productId', pg_temp.id(p), 'variantId', pg_temp.id(p || '_v'))) from unnest(p_products) p),
           gen_random_uuid())
$$;

-- ── FIXTURE: outlet VERIFY P, tables P1–P6, Set A 70.35, Set B 70.40, Extra 3.00 (0% SST), no
--    service charge, a card and a cash method, staff with PINs, one tablet signed in, a shift open;
--    bills X (P1: Set A), Y (P2: Set B), Z (P3: Set A), W (P4: Set A + Extra), V (P5: Set A) ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000006a1';
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-0000000006a2';
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000006a3';
  v_a uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_p uuid; v_v uuid; v_res jsonb; v_order uuid; r record; i integer;
begin
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  insert into branches(name, address) values ('VERIFY P', 'p') returning id into v_a;
  perform pg_temp.put('branch', v_a);
  for i in 1..6 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'P' || i, i) returning id into v_t;
    perform pg_temp.put('t' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into menu_categories(name, sort_order) values ('VERIFY P SETS', 900) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY P MENU', 900) returning id into v_catalog;
  for r in select * from (values ('seta', 'Verify P Set A', 7035), ('setb', 'Verify P Set B', 7040), ('extra', 'Verify P Extra', 300)) as x(k, name, sen) loop
    insert into menu_products(name, category_id, sst_rate_bp) values (r.name, v_cat, 0) returning id into v_p;
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', r.sen) returning id into v_v;
    insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, r.sen);
    perform pg_temp.put(r.k, v_p); perform pg_temp.put(r.k || '_v', v_v);
  end loop;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'P Card', 'card', 1) returning id into v_t;
  perform pg_temp.put('card', v_t);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'P Cash', 'cash', 2) returning id into v_t;
  perform pg_temp.put('cash', v_t);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_dev);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify P Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify P Supervisor', 'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'supervisor' where id = v_sup;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'P Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('sup', v_sup); perform pg_temp.put('cashier', v_cash); perform pg_temp.put('dev', v_dev);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_res := open_shift(10000);
  perform pg_temp.put('shift', (v_res->'shift'->>'id')::uuid);
  for r in select * from (values ('bX', 't1', array['seta']), ('bY', 't2', array['setb']), ('bZ', 't3', array['seta']),
                                 ('bW', 't4', array['seta', 'extra']), ('bV', 't5', array['seta'])) as x(k, t, products) loop
    v_order := pg_temp.order_on(r.t, r.products);
    perform pg_temp.put(r.k, (select bill_id from orders where id = v_order));
    if r.k = 'bW' then perform pg_temp.put('Wx', (select id from order_items where order_id = v_order and product_id = pg_temp.id('extra'))); end if;
  end loop;
  for r in select k from unnest(array['x1', 'x2', 'y1', 'y2', 'z1', 'z2', 'w1']) k loop
    perform pg_temp.put(r.k, gen_random_uuid());
  end loop;
end $$;

-- ── B1. Quotes and part payments (spec §4.6; §8 Part B) ──────────────────────
do $$
declare
  v_x uuid := pg_temp.id('bX');
  v_q jsonb; v_res jsonb; v_cash jsonb;
  r record;
begin
  -- schema and grants
  if not (select relrowsecurity from pg_class where relname = 'bill_parts' and relnamespace = 'public'::regnamespace)
     or has_table_privilege('authenticated', 'bill_parts', 'insert')
     or not has_table_privilege('authenticated', 'bill_parts', 'select')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'part_id') then
    raise exception 'FAIL B1 schema: bill_parts RLS / privileges / payments.part_id';
  end if;
  for r in select f from unnest(array['pos_part_quote(uuid,integer)', 'pay_bill_part(uuid,uuid,integer,integer,jsonb,integer)']) f loop
    if not has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL B1 grants: %', r.f;
    end if;
  end loop;
  for r in select f from unnest(array['pos_bill_paid_parts(uuid)', 'pos_part_result(uuid)', 'pos_part_same_payments(uuid,jsonb)',
                                      'pos_part_receipt_payload(uuid)', 'pos_queue_part_receipt(uuid)',
                                      'pos_part_replay(bill_parts,uuid,uuid,integer,jsonb)',
                                      'pos_insert_payments(uuid,uuid,uuid,jsonb,uuid)']) f loop
    if has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL B1 grants: % is internal', r.f; end if;
  end loop;

  perform pg_temp.act(pg_temp.id('dev'));
  -- RM 70.35 in 3: floor(7035 / 3 / 5) × 5 = 23.45
  v_q := pos_part_quote(v_x, 3);
  if v_q is distinct from '{"totalSen": 7035, "paidSen": 0, "balanceSen": 7035, "partsPaid": 0, "sharesPaid": 0, "ways": 3, "shareSen": 2345}'::jsonb then
    raise exception 'FAIL B1 quote X: %', v_q;
  end if;
  v_q := pos_part_quote(v_x, null);
  if v_q->'ways' <> 'null'::jsonb or v_q->'shareSen' <> 'null'::jsonb or (v_q->>'balanceSen')::int <> 7035 then
    raise exception 'FAIL B1 quote by amount: %', v_q;
  end if;
  perform pg_temp.expect_error(format('select pos_part_quote(%L, 1)', v_x), 'Invalid split', 'B1 1 way');
  perform pg_temp.expect_error(format('select pos_part_quote(%L, 21)', v_x), 'Invalid split', 'B1 21 ways');

  -- share 1 of 3 in cash, RM 50.00 received: change 26.55
  v_cash := jsonb_build_array(jsonb_build_object('methodId', pg_temp.id('cash'), 'amountSen', 2345, 'tenderedSen', 5000));
  v_res := pay_bill_part(v_x, pg_temp.id('x1'), 2345, 3, v_cash);
  if (v_res->>'partId')::uuid <> pg_temp.id('x1') or (v_res->>'partNo')::int <> 1 or (v_res->>'ways')::int <> 3
     or (v_res->>'amountSen')::int <> 2345 or (v_res->>'paidSen')::int <> 2345 or (v_res->>'balanceSen')::int <> 4690
     or (v_res->>'changeSen')::int <> 2655 or not (v_res->>'receiptQueued')::boolean
     or jsonb_array_length(v_res->'payments') <> 1
     or (select count(*) from payments where part_id = pg_temp.id('x1') and bill_id = v_x and line_no = 1
            and tendered_sen = 5000 and change_sen = 2655 and shift_id = pg_temp.id('shift')) <> 1
     or (select status from bills where id = v_x) <> 'open'
     or (select taken_by from bill_parts where id = pg_temp.id('x1')) <> pg_temp.id('cashier') then
    raise exception 'FAIL B1 part 1 of X: %', v_res;
  end if;
  -- a resend answers again: the part's own fields (partId, partNo, ways, amountSen, payments, changeSen,
  -- receiptQueued) are the first answer, paidSen / balanceSen the bill's current values (unchanged
  -- here); other amounts or another bill are refused
  if pay_bill_part(v_x, pg_temp.id('x1'), 2345, 3, v_cash) <> v_res or (select count(*) from bill_parts where bill_id = v_x) <> 1 then
    raise exception 'FAIL B1 replay';
  end if;
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2340, 3, %L)', v_x, pg_temp.id('x1'), pg_temp.card(2340)),
    'This payment was already recorded with other amounts — check Today''s bills', 'B1 replay other amount');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2345, 3, %L)', v_x, pg_temp.id('x1'), pg_temp.card(2345)),
    'This payment was already recorded with other amounts — check Today''s bills', 'B1 replay other payments');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2345, 3, %L)', pg_temp.id('bY'), pg_temp.id('x1'), v_cash),
    'This part id belongs to another bill', 'B1 replay on another bill');
  -- the N is now fixed at 3
  v_q := pos_part_quote(v_x, 5);
  if (v_q->>'ways')::int <> 3 or (v_q->>'sharesPaid')::int <> 1 or (v_q->>'partsPaid')::int <> 1 or (v_q->>'shareSen')::int <> 2345 then
    raise exception 'FAIL B1 fixed N: %', v_q;
  end if;
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2345, 4, %L)', v_x, gen_random_uuid(), pg_temp.card(2345)),
    'The bill changed. Check the split again.', 'B1 another N');
  v_res := pay_bill_part(v_x, pg_temp.id('x2'), 2345, 3, pg_temp.card(2345));
  if (v_res->>'partNo')::int <> 2 or (v_res->>'balanceSen')::int <> 2345 then raise exception 'FAIL B1 part 2 of X: %', v_res; end if;
  -- the last share and anything at or above the balance are not parts
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2345, 3, %L)', v_x, gen_random_uuid(), pg_temp.card(2345)),
    'Pay the rest with Pay, not as a part', 'B1 last share');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 3000, null, %L)', v_x, gen_random_uuid(), pg_temp.card(3000)),
    'The amount is more than the balance', 'B1 above the balance');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 0, null, %L)', v_x, gen_random_uuid(), '[]'),
    'Invalid payment amount', 'B1 zero');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 1000, null, %L)', v_x, gen_random_uuid(), pg_temp.card(900)),
    'Payments (RM 9.00) do not match the total (RM 10.00)', 'B1 payments short');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, null, 1000, null, %L)', v_x, pg_temp.card(1000)),
    'Part id is missing', 'B1 no part id');

  -- RM 70.40 in 3: 23.45, 23.45 (the last, 23.50, by checkout_bill in B2)
  v_res := pay_bill_part(pg_temp.id('bY'), pg_temp.id('y1'), 2345, 3, pg_temp.card(2345));
  v_q := pos_part_quote(pg_temp.id('bY'), 3);
  if (v_q->>'shareSen')::int <> 2345 or (v_q->>'balanceSen')::int <> 4695 then raise exception 'FAIL B1 Y share 2: %', v_q; end if;
  v_res := pay_bill_part(pg_temp.id('bY'), pg_temp.id('y2'), 2345, 3, pg_temp.card(2345));
  if (v_res->>'balanceSen')::int <> 2350 then raise exception 'FAIL B1 Y after 2 shares: %', v_res; end if;

  -- Z: an item added after share 1 changes share 2 (49.90 left in 2 → 24.95); the old share is refused
  v_res := pay_bill_part(pg_temp.id('bZ'), pg_temp.id('z1'), 2345, 3, pg_temp.card(2345));
  perform pg_temp.order_on('t3', array['extra']);
  v_q := pos_part_quote(pg_temp.id('bZ'), 3);
  if (v_q->>'balanceSen')::int <> 4990 or (v_q->>'shareSen')::int <> 2495 then raise exception 'FAIL B1 Z re-quote: %', v_q; end if;
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2345, 3, %L)', pg_temp.id('bZ'), gen_random_uuid(), pg_temp.card(2345)),
    'The bill changed. Check the split again.', 'B1 stale share');
  v_res := pay_bill_part(pg_temp.id('bZ'), pg_temp.id('z2'), 2495, 3, pg_temp.card(2495));
  if (v_res->>'balanceSen')::int <> 2495 then raise exception 'FAIL B1 Z share 2: %', v_res; end if;

  -- W: by amount, RM 10.00 of 73.35
  v_res := pay_bill_part(pg_temp.id('bW'), pg_temp.id('w1'), 1000, null, pg_temp.card(1000));
  if (v_res->>'partNo')::int <> 1 or v_res->'ways' <> 'null'::jsonb or (v_res->>'balanceSen')::int <> 6335 then
    raise exception 'FAIL B1 W by amount: %', v_res;
  end if;

  -- one part receipt per part; a part's cash counts in its shift though no bill closed yet
  if (select count(*) from print_jobs where branch_id = pg_temp.id('branch') and payload->>'kind' = 'part') <> 7 then
    raise exception 'FAIL B1 part receipts queued';
  end if;
  v_res := pos_shift_report(pg_temp.id('shift'));
  if (v_res->'cash'->>'cashSalesSen')::int <> 2345 or (v_res->'summary'->>'billCount')::int <> 0 then
    raise exception 'FAIL B1 Z report: % %', v_res->'cash', v_res->'summary';
  end if;
end $$;

-- ── B1f. Fixes after the B1 review: a share is never 0, a part id taken on another bill at the
--    same moment, a stale pos_insert_payments. Everything here is undone at the end of the block
--    (SQLSTATE B1FRB), so B2 / B3 see the bills as B1 left them. ─
do $$
declare
  v_b uuid; v_q jsonb; v_res jsonb; v_race uuid := gen_random_uuid();
begin
  begin
    perform pg_temp.act(pg_temp.id('dev'));
    -- P6: Set A 70.35; RM 70.25 by amount leaves 10 sen with 3 equal shares to go: a share of 5, not 0
    v_b := pg_temp.order_on('t6', array['seta']);
    v_b := (select bill_id from orders where id = v_b);
    v_res := pay_bill_part(v_b, gen_random_uuid(), 7025, null, pg_temp.card(7025));
    v_q := pos_part_quote(v_b, 3);
    if (v_q->>'balanceSen')::int <> 10 or (v_q->>'shareSen')::int <> 5 then raise exception 'FAIL B1f share never 0: %', v_q; end if;
    v_res := pay_bill_part(v_b, gen_random_uuid(), 5, 3, pg_temp.card(5));
    if (v_res->>'partNo')::int <> 2 or (v_res->>'ways')::int <> 3 or (v_res->>'balanceSen')::int <> 5 then
      raise exception 'FAIL B1f share of 5: %', v_res;
    end if;

    -- the same part id taken on bill Y while this payment waits (a trigger plays the other till)
    execute format($f$
      create function public.verify_b1f_race() returns trigger language plpgsql as $t$
      begin
        if new.id = %L and new.bill_id <> %L then
          insert into bill_parts(id, bill_id, branch_id, part_no, ways, amount_sen, shift_id)
          values (new.id, %L, new.branch_id, (select max(part_no) + 1 from bill_parts where bill_id = %L), null, 100, new.shift_id);
        end if;
        return new;
      end $t$ $f$, v_race, pg_temp.id('bY'), pg_temp.id('bY'), pg_temp.id('bY'));
    execute 'create trigger verify_b1f_race before insert on bill_parts for each row execute function public.verify_b1f_race()';
    perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 1, null, %L)', v_b, v_race, pg_temp.card(1)),
      'This part id belongs to another bill', 'B1f part id raced on another bill');

    -- a pos_insert_payments that writes no part_id (11-16's text before B1f) makes pay_bill_part stop
    execute $f$
      create or replace function pos_insert_payments(p_bill_id uuid, p_branch uuid, p_shift uuid, p_payments jsonb,
                                                     p_part_id uuid default null) returns void
      language plpgsql set search_path = public, pg_temp as $t$ begin end $t$ $f$;
    perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 1, null, %L)', v_b, gen_random_uuid(), pg_temp.card(1)),
      'STOP: pos_insert_payments is stale — re-run migration-2026-11-17-pos-bill-parts.sql', 'B1f stale pos_insert_payments');

    raise exception 'B1f rollback' using errcode = 'B1FRB';
  exception when sqlstate 'B1FRB' then
    null;
  end;
  if exists (select 1 from bill_parts bp join bills b on b.id = bp.bill_id where b.table_id = pg_temp.id('t6'))
     or to_regprocedure('verify_b1f_race()') is not null then
    raise exception 'FAIL B1f: not rolled back';
  end if;
end $$;

-- ── B2. The balance by checkout_bill; the guards (spec §4.6) ─────────────────
do $$
declare
  v_x   uuid := pg_temp.id('bX');
  v_w   uuid := pg_temp.id('bW');
  v_v   uuid := pg_temp.id('bV');
  v_cid uuid := gen_random_uuid();
  v_res jsonb; v_res2 jsonb; v_order uuid;
  v_wx  jsonb := jsonb_build_array(jsonb_build_object('itemId', pg_temp.id('Wx'), 'qty', 1));
  v_msg text := 'This bill has a part payment. Pay the rest first.';
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- X (70.35, two shares paid): checkout_bill takes exactly the balance, 23.45
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L, %L)', v_x, pg_temp.card(7035), gen_random_uuid()),
    'Payments (RM 70.35) do not match the total (RM 23.45)', 'B2 the whole total');
  v_res := checkout_bill(v_x, pg_temp.card(2345), v_cid);
  if (v_res->>'billId')::uuid <> v_x or (v_res->>'totalSen')::int <> 7035 or (v_res->>'changeSen')::int <> 0
     or (select status from bills where id = v_x) <> 'paid' or (select total_sen from bills where id = v_x) <> 7035
     or (select count(*) from payments where bill_id = v_x) <> 3
     or (select count(*) from payments where bill_id = v_x and part_id is null and line_no = 1 and amount_sen = 2345) <> 1 then
    raise exception 'FAIL B2 X paid: %', v_res;
  end if;
  -- its replay still works; other amounts are refused
  v_res2 := checkout_bill(v_x, pg_temp.card(2345), v_cid);
  if v_res2 <> v_res then raise exception 'FAIL B2 replay: % vs %', v_res2, v_res; end if;
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L, %L)', v_x, pg_temp.card(2340), v_cid),
    'This payment was already recorded with other amounts — check Today''s bills', 'B2 replay other amounts');
  -- Y: the last share 23.50; Z: 24.95 after the extra item
  v_res := checkout_bill(pg_temp.id('bY'), pg_temp.card(2350), gen_random_uuid());
  if (v_res->>'totalSen')::int <> 7040 then raise exception 'FAIL B2 Y: %', v_res; end if;
  v_res := checkout_bill(pg_temp.id('bZ'), pg_temp.card(2495), gen_random_uuid());
  if (v_res->>'totalSen')::int <> 7335 then raise exception 'FAIL B2 Z: %', v_res; end if;

  -- guards on W (RM 10.00 paid as a part)
  perform pg_temp.expect_error(format('select void_order_item(%L, %L, %L, %L)', pg_temp.id('Wx'), 'Wrong item keyed', pg_temp.id('sup'), '2222'),
    v_msg, 'B2 void item');
  perform pg_temp.expect_error(format('select void_bill(%L, %L, %L, %L)', v_w, 'Customer left', pg_temp.id('sup'), '2222'),
    v_msg, 'B2 void bill');
  perform pg_temp.expect_error(format('select set_item_discount(%L, %L, 1000, %L, %L, %L)', pg_temp.id('Wx'), 'percent', 'Regular', pg_temp.id('sup'), '2222'),
    v_msg, 'B2 item discount');
  perform pg_temp.expect_error(format('select set_bill_discount(%L, %L, 1000, %L, %L, %L)', v_w, 'percent', 'Regular', pg_temp.id('sup'), '2222'),
    v_msg, 'B2 bill discount');
  perform pg_temp.expect_error(format('select merge_bills(%L, %L)', v_w, v_v), v_msg, 'B2 merge it away');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_w, v_wx), v_msg, 'B2 split preview');
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', v_w, v_wx, pg_temp.card(300), gen_random_uuid()),
    v_msg, 'B2 split by item');
  perform pg_temp.expect_error(format('select move_items(%L, %L, %L)', v_w, v_wx, pg_temp.id('t6')), v_msg, 'B2 move items');
  -- allowed: merge another bill into it, move it to a free table, add items
  perform merge_bills(v_v, v_w);
  perform move_bill(v_w, pg_temp.id('t6'));
  v_order := pg_temp.order_on('t6', array['extra']);
  if (select bill_id from orders where id = v_order) <> v_w or (select table_id from bills where id = v_w) <> pg_temp.id('t6')
     or (select status from bills where id = v_v) <> 'merged' then
    raise exception 'FAIL B2 merge in, move, add items on W';
  end if;

  -- Z report: 3 bills closed (X, Y, Z = 214.10); every payment in its shift (cash 23.45, card 200.65)
  v_res := pos_shift_report(pg_temp.id('shift'));
  if (v_res->'summary'->>'billCount')::int <> 3 or (v_res->'summary'->>'nettSen')::int <> 21410
     or (v_res->'cash'->>'cashSalesSen')::int <> 2345
     or (select (p->>'amountSen')::int from jsonb_array_elements(v_res->'payments') p where p->>'name' = 'P Card') <> 20065 then
    raise exception 'FAIL B2 Z report: % % %', v_res->'summary', v_res->'cash', v_res->'payments';
  end if;
end $$;

-- ── B2p. pay_bill_part's p_paid_sen: the paid parts the screen saw (null: not checked). A part whose
--    reply was lost commits late after Check bill said "not recorded"; the same guest's second Pay
--    (a new part id, the old paidSen) is refused instead of paid twice. Undone at the end (SQLSTATE
--    B2PRB). ─
do $$
declare
  v_b uuid; v_res jsonb; v_first jsonb; v_lost uuid := gen_random_uuid();
  v_sig text := 'pay_bill_part(uuid,uuid,integer,integer,jsonb,integer)';
begin
  -- one pay_bill_part (the 5-argument one dropped, no overload), granted as before
  if to_regprocedure('pay_bill_part(uuid,uuid,integer,integer,jsonb)') is not null
     or (select count(*) from pg_proc where proname = 'pay_bill_part' and pronamespace = 'public'::regnamespace) <> 1
     or not has_function_privilege('authenticated', v_sig, 'execute') or has_function_privilege('anon', v_sig, 'execute') then
    raise exception 'FAIL B2p signature / grants';
  end if;
  begin
    perform pg_temp.act(pg_temp.id('dev'));
    v_b := pg_temp.order_on('t1', array['seta']);                     -- RM 70.35 on P1 (X is paid)
    v_b := (select bill_id from orders where id = v_b);
    -- named arguments, as PostgREST sends them: without p_paid_sen (the client today) ...
    v_res := pay_bill_part(p_bill_id => v_b, p_part_id => gen_random_uuid(), p_amount_sen => 1000, p_ways => null,
                           p_payments => pg_temp.card(1000));
    if (v_res->>'partNo')::int <> 1 or (v_res->>'paidSen')::int <> 1000 then raise exception 'FAIL B2p without p_paid_sen: %', v_res; end if;
    -- ... and with it: the screen saw RM 10.00 paid
    v_first := pay_bill_part(p_bill_id => v_b, p_part_id => v_lost, p_amount_sen => 1000, p_ways => null,
                             p_payments => pg_temp.card(1000), p_paid_sen => 1000);
    if (v_first->>'partNo')::int <> 2 or (v_first->>'paidSen')::int <> 2000 then raise exception 'FAIL B2p with p_paid_sen: %', v_first; end if;
    -- that reply was lost; the same guest pays again under a new id, the screen still at RM 10.00: refused
    perform pg_temp.expect_error(format('select pay_bill_part(p_bill_id => %L, p_part_id => %L, p_amount_sen => 1000, p_ways => null, p_payments => %L, p_paid_sen => 1000)',
                                        v_b, gen_random_uuid(), pg_temp.card(1000)),
      'The bill changed. Check the split again.', 'B2p paid twice');
    perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 1000, null, %L, 3000)', v_b, gen_random_uuid(), pg_temp.card(1000)),
      'The bill changed. Check the split again.', 'B2p paidSen above');
    -- the lost one's resend still gets its first answer; with the bill's paidSen the next part goes through
    if pay_bill_part(v_b, v_lost, 1000, null, pg_temp.card(1000), 1000) <> v_first then raise exception 'FAIL B2p replay'; end if;
    v_res := pay_bill_part(v_b, gen_random_uuid(), 1000, null, pg_temp.card(1000), 2000);
    if (v_res->>'partNo')::int <> 3 or (v_res->>'paidSen')::int <> 3000 then raise exception 'FAIL B2p next part: %', v_res; end if;
    if (select count(*) from bill_parts where bill_id = v_b) <> 3 or (select count(*) from payments where bill_id = v_b) <> 3 then
      raise exception 'FAIL B2p parts written';
    end if;
    raise exception 'B2p rollback' using errcode = 'B2PRB';
  exception when sqlstate 'B2PRB' then
    null;
  end;
  if exists (select 1 from bills where table_id = pg_temp.id('t1') and status = 'open') then
    raise exception 'FAIL B2p: not rolled back';
  end if;
end $$;

select 'VERIFY OK' as result;
rollback;
