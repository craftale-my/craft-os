-- Self-check for the POS pre-pilot hardening. Run on craft-os-dev after
-- migration-2026-10-25-pos-hardening.sql. Everything is rolled back. Success = a
-- result row "VERIFY OK". Sections follow the design: H1 the checkout state, H2 a replay
-- with other payments, H3 an item void touches its bill, H4 a merged takeaway keeps its
-- fee, H5 voids between shifts, H6 wrong PINs per approver and caller, H7 print jobs
-- stay in their branch. Inside one transaction now() does not move: the script sets
-- shift and void times by hand where the order of events matters.
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
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_sup     uuid := 'eeeeeeee-0000-0000-0000-000000000051';   -- supervisor of VERIFY H (approves)
  v_a       uuid := 'eeeeeeee-0000-0000-0000-000000000052';   -- cashier A of VERIFY H
  v_b       uuid := 'eeeeeeee-0000-0000-0000-000000000053';   -- cashier B of VERIFY H
  v_far     uuid := 'eeeeeeee-0000-0000-0000-000000000054';   -- supervisor of another branch
  v_branch uuid; v_branch2 uuid;
  v_t1 dining_tables; v_t2 dining_tables; v_t3 dining_tables; v_t4 dining_tables;
  v_cat uuid; v_catalog uuid; v_plate uuid; v_plate_v uuid; v_tea uuid; v_tea_v uuid;
  v_cash uuid; v_card uuid;
  b1 uuid; b2 uuid; b3 uuid; b4 uuid; b5 uuid; b6 uuid; b7 uuid;
  s1 uuid; s2 uuid; v_far_shift uuid; c1 timestamptz;
  v_checkout uuid := 'eeeeeeee-2222-0000-0000-000000000001';
  v_pay jsonb;
  v_a_tot jsonb; v_b_tot jsonb; v_res jsonb; v_res2 jsonb; v_rep1 jsonb; v_rep2 jsonb;
  v_item uuid; v_item2 uuid; v_job1 uuid; v_job2 uuid; v_id uuid; v_until timestamptz;
  n integer; r record; v_role text; v_priv text;
begin
  -- ── A. schema, grants, internal helpers, search_path, canonical bodies ──────
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bills'
                  and column_name = 'updated_at' and is_nullable = 'NO') then
    raise exception 'FAIL schema: bills.updated_at is missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'order_items'
                  and column_name = 'order_type' and is_nullable = 'NO')
     or not exists (select 1 from pg_constraint where conname = 'order_items_order_type_check')
     or not exists (select 1 from pg_trigger where tgname = 'order_items_order_type' and tgrelid = 'order_items'::regclass) then
    raise exception 'FAIL schema: order_items.order_type, its check or its trigger is missing';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pos_pin_attempts')
     or not (select relrowsecurity from pg_class where relname = 'pos_pin_attempts' and relnamespace = 'public'::regnamespace) then
    raise exception 'FAIL rls: pos_pin_attempts must be read and written only through pos_pin_attempt';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(v_role, 'pos_pin_attempts', v_priv) then
        raise exception 'FAIL rls: % has % on pos_pin_attempts', v_role, v_priv;
      end if;
    end loop;
  end loop;
  for r in select f from unnest(array[
             'pos_compute_bill(jsonb)', 'pos_bill_totals(uuid)', 'pos_checkout_state(uuid,uuid[])', 'checkout_bill(uuid,jsonb,uuid)',
             'void_order_item(uuid,text,uuid,text)', 'set_my_pos_pin(text,text)', 'claim_print_job(uuid)',
             'finish_print_job(uuid,boolean,text)', 'requeue_print_job(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array[
             'pos_checkout_same_payments(uuid,jsonb)', 'pos_shift_report(uuid)', 'pos_pin_attempt(uuid,text)',
             'order_items_order_type()']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array[
              'order_items_order_type','pos_compute_bill','pos_bill_totals','pos_checkout_state','pos_checkout_same_payments',
              'checkout_bill','void_order_item','pos_shift_report','pos_pin_attempt','set_my_pos_pin',
              'claim_print_job','finish_print_job','requeue_print_job'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  if exists (select 1 from pg_proc where proname in ('claim_print_job', 'finish_print_job', 'requeue_print_job') and not prosecdef) then
    raise exception 'FAIL H7: the print job functions must be security definer';
  end if;
  for r in select x.f, count(p.oid) as n from unnest(array['pos_compute_bill','pos_bill_totals','checkout_bill','void_order_item',
              'pos_shift_report','pos_pin_attempt','set_my_pos_pin','claim_print_job','finish_print_job','requeue_print_job']) as x(f)
              left join pg_proc p on p.proname = x.f group by x.f loop
    if r.n <> 1 then raise exception 'FAIL: % has % definitions', r.f, r.n; end if;
  end loop;
  -- re-running shifts-fn, bill-actions-fn or checkout-fixes puts an old body back: re-run the hardening file
  if pg_get_functiondef('checkout_bill(uuid,jsonb,uuid)'::regprocedure) not like '%pos_checkout_same_payments%'
     or pg_get_functiondef('checkout_bill(uuid,jsonb,uuid)'::regprocedure) not like '%Open the shift first%'
     or pg_get_functiondef('pos_shift_report(uuid)'::regprocedure) not like '%prev_close%'
     or pg_get_functiondef('void_order_item(uuid,text,uuid,text)'::regprocedure) not like '%update bills set updated_at = now()%'
     or pg_get_functiondef('pos_pin_attempt(uuid,text)'::regprocedure) not like '%pos_pin_attempts%'
     or pg_get_functiondef('pos_pin_attempt(uuid,text)'::regprocedure) like '%update staff_pos_pins%'
     or pg_get_functiondef('set_my_pos_pin(text,text)'::regprocedure) like '%failed_attempts%'
     or pg_get_functiondef('pos_compute_bill(jsonb)'::regprocedure) not like '%orderType%ln.order_type%'
     or pg_get_functiondef('pos_bill_totals(uuid)'::regprocedure) not like '%oi.order_type%' then
    raise exception 'FAIL: an older body is back — re-run migration-2026-10-25-pos-hardening.sql';
  end if;

  -- ── B. fixture: two branches, two products with a packaging fee, two methods, staff ──
  update system_role_permissions set permissions = permissions - 'pos_supervise' - 'access_settings' where true;   -- code defaults
  insert into branches(name, address, receipt_title) values ('VERIFY H', 'verify', 'Verify H Cafe') returning id into v_branch;
  insert into branches(name, address) values ('VERIFY H FAR', 'far') returning id into v_branch2;
  insert into dining_tables(branch_id, label) values (v_branch, 'H1') returning * into v_t1;
  insert into dining_tables(branch_id, label) values (v_branch, 'H2') returning * into v_t2;
  insert into dining_tables(branch_id, label) values (v_branch, 'H3') returning * into v_t3;
  insert into dining_tables(branch_id, label) values (v_branch, 'H4') returning * into v_t4;
  insert into print_routes(branch_id, name, kind, address) values (v_branch, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_branch, 'Bar');
  -- 10% on dine-in at table H1 (and on takeaway at H1, which a takeaway never is), 5% on takeaway
  insert into service_charge_rules(branch_id, rate_bp, order_types, table_ids, sort_order)
  values (v_branch, 1000, array['dine_in', 'takeaway'], array[v_t1.id], 1);
  insert into service_charge_rules(branch_id, rate_bp, order_types, sort_order) values (v_branch, 500, array['takeaway'], 2);
  insert into menu_categories(name, sort_order) values ('VERIFY H FOOD', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp, takeaway_fee_sen) values ('Verify H Plate', v_cat, 600, 100) returning id into v_plate;
  insert into menu_products(name, category_id, sst_rate_bp, takeaway_fee_sen) values ('Verify H Tea', v_cat, 0, 50) returning id into v_tea;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 2000) returning id into v_plate_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_tea, '', 'Regular', 550) returning id into v_tea_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY H CATALOG', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_plate, 'all'), (v_catalog, v_tea, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_plate_v, 2000), (v_catalog, v_tea_v, 550);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', v_catalog), (v_branch, 'takeaway', v_catalog), (v_branch, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_branch, 'H Cash', 'cash', 1) returning id into v_cash;
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_branch, 'H Card', 'card', 2) returning id into v_card;
  update staff set branch_id = v_branch where id = v_owner;
  -- staff are inserted as 'staff' and promoted by the owner (the staff guard refuses anything else)
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_sup), (v_a), (v_b), (v_far);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_sup, 'Verify H Supervisor', 'trainee', true, current_date, 'staff', v_branch),
    (v_a,   'Verify H Cashier A',  'trainee', true, current_date, 'staff', v_branch),
    (v_b,   'Verify H Cashier B',  'trainee', true, current_date, 'staff', v_branch),
    (v_far, 'Verify H Far',        'trainee', true, current_date, 'staff', v_branch2);
  update staff set system_role = 'supervisor' where id in (v_sup, v_far);
  perform pg_temp.act(v_sup);
  if not (set_my_pos_pin('2468', null)->>'ok')::boolean then raise exception 'FAIL fixture: supervisor PIN'; end if;

  -- ── H4. a takeaway merged into a table keeps its fee, its SST and its service-charge rule ──
  perform pg_temp.act(v_a);
  v_id := place_counter_order(v_t1.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b1 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(null, 'takeaway', null, jsonb_build_array(
    jsonb_build_object('productId', v_plate, 'variantId', v_plate_v, 'qty', 2),
    jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b2 := (select bill_id from orders where id = v_id);
  if (select string_agg(order_type, ',') from order_items where bill_id = b1) is distinct from 'dine_in'
     or (select string_agg(distinct order_type, ',') from order_items where bill_id = b2) is distinct from 'takeaway' then
    raise exception 'FAIL H4: order_items.order_type is not set from the bill';
  end if;
  -- apart: H1 = 20.00 + 10% 2.00 + SST 1.20 = 23.20; takeaway = 45.50 + 5% 2.28 (2.275 half up)
  --        + SST 6% of (40.00 + fee 2.00) 2.52 + fee 2.50 = 52.80
  v_a_tot := pos_bill_totals(b1);
  v_b_tot := pos_bill_totals(b2);
  if (v_a_tot->>'totalSen')::int is distinct from 2320 or (v_b_tot->>'totalSen')::int is distinct from 5280
     or (v_b_tot->>'takeawayFeeSen')::int is distinct from 250 then
    raise exception 'FAIL H4 apart: % %', v_a_tot, v_b_tot;
  end if;
  perform merge_bills(b2, b1);
  -- merged = apart before rounding, exactly here: every rate's base rounds without a remainder
  -- (in general up to 1 sen per service-charge or SST rate both bills share)
  if (select count(*) from order_items where bill_id = b1 and order_type = 'takeaway') is distinct from 2 then
    raise exception 'FAIL H4: merge changed the takeaway items'' order type';
  end if;
  v_res := pos_bill_totals(b1);
  if v_res is distinct from '{"subtotalSen": 6550, "serviceChargeSen": 428, "sstSen": 372, "takeawayFeeSen": 250,
        "beforeRoundingSen": 7600, "roundingSen": 0, "totalSen": 7600,
        "sstGroups": [{"rateBp": 600, "baseSen": 6200, "amountSen": 372}],
        "serviceChargeGroups": [{"rateBp": 500, "baseSen": 4550, "amountSen": 228}, {"rateBp": 1000, "baseSen": 2000, "amountSen": 200}]}'::jsonb
     or (v_res->>'beforeRoundingSen')::int is distinct from (v_a_tot->>'beforeRoundingSen')::int + (v_b_tot->>'beforeRoundingSen')::int then
    raise exception 'FAIL H4 merged totals: %', v_res;
  end if;
  -- an order added to the table after the merge is dine-in
  v_id := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  if (select order_type from order_items where order_id = v_id) is distinct from 'dine_in' then
    raise exception 'FAIL H4: a new order on the merged bill is not dine-in';
  end if;
  perform void_order_item((select id from order_items where order_id = v_id), 'Wrong item keyed', v_sup, '2468');
  if (pos_bill_totals(b1)->>'totalSen')::int is distinct from 7600 then raise exception 'FAIL H4: the voided tea still counts'; end if;

  -- ── H1. the checkout state: open (with totals), merged (with the bill it went into) ──
  v_id := place_counter_order(v_t2.id, 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b3 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b4 := (select bill_id from orders where id = v_id);
  set local role authenticated;
  v_res := pos_checkout_state(b3, null);
  reset role;
  if v_res is distinct from jsonb_build_object('status', 'open', 'billNo', (select bill_no from bills where id = b3),
       'mergedIntoBillNo', null, 'totals', pos_bill_totals(b3), 'result', null) then
    raise exception 'FAIL H1 open: %', v_res;
  end if;
  perform merge_bills(b4, b3);
  v_res := pos_checkout_state(b4, null);
  if v_res->>'status' is distinct from 'merged' or v_res->>'mergedIntoBillNo' is distinct from (select bill_no from bills where id = b3)
     or v_res->'totals' is distinct from 'null'::jsonb or v_res->'result' is distinct from 'null'::jsonb then
    raise exception 'FAIL H1 merged: %', v_res;
  end if;
  perform pg_temp.act(v_far);
  perform pg_temp.expect_error(format('select pos_checkout_state(%L, null)', b3), 'Bill not found', 'H1 another branch');
  perform pg_temp.act(v_a);

  -- ── H2. a replayed checkout id must carry the very same payments ─────────────
  s1 := (open_shift(10000)->'shift'->>'id')::uuid;
  update pos_shifts set opened_at = now() - interval '3 hours' where id = s1;   -- the shift began three hours ago
  v_pay := jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 2000, 'reference', null),
                             jsonb_build_object('methodId', v_cash, 'amountSen', 5600, 'tenderedSen', 6000));
  v_res := checkout_bill(b1, v_pay, v_checkout);
  if (v_res->>'totalSen')::int is distinct from 7600 or (v_res->>'changeSen')::int is distinct from 400
     or (select takeaway_fee_sen from bills where id = b1) is distinct from 250 then
    raise exception 'FAIL H2 checkout: %', v_res;
  end if;
  -- the same payments again (the method id in capitals too): the first answer, nothing new
  v_res2 := checkout_bill(b1, jsonb_build_array(
    jsonb_build_object('methodId', upper(v_card::text), 'amountSen', 2000),
    jsonb_build_object('methodId', v_cash, 'amountSen', 5600, 'tenderedSen', 6000)), v_checkout);
  if v_res2 is distinct from v_res or (select count(*) from payments where bill_id = b1) is distinct from 2 then
    raise exception 'FAIL H2 replay: %', v_res2;
  end if;
  -- other amounts, other cash received, another order, fewer lines, none: refused, nothing written
  foreach v_pay in array array[
      jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 2600), jsonb_build_object('methodId', v_cash, 'amountSen', 5000)),
      jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 2000),
                        jsonb_build_object('methodId', v_cash, 'amountSen', 5600, 'tenderedSen', 10000)),
      jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 5600, 'tenderedSen', 6000),
                        jsonb_build_object('methodId', v_card, 'amountSen', 2000)),
      jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 7600)),
      '[]'::jsonb, '"x"'::jsonb] loop
    perform pg_temp.expect_error(format('select checkout_bill(%L, %L::jsonb, %L)', b1, v_pay, v_checkout),
      'This payment was already recorded with other amounts — check Today''s bills', 'H2 replay ' || v_pay::text);
  end loop;
  if (select count(*) from payments where bill_id = b1) is distinct from 2 then raise exception 'FAIL H2: a refused replay wrote payments'; end if;
  -- the sheet that paid gets its result back from the state — also when the paying id is an
  -- earlier one it sent (Check bill gave it a new id meanwhile); any other sheet does not
  if pos_checkout_state(b1, array[v_checkout]) is distinct from jsonb_build_object('status', 'paid', 'billNo', (select bill_no from bills where id = b1),
       'mergedIntoBillNo', null, 'totals', null, 'result', v_res)
     or pos_checkout_state(b1, array[v_checkout, gen_random_uuid()])->'result' is distinct from v_res
     or pos_checkout_state(b1, array[gen_random_uuid(), v_checkout])->'result' is distinct from v_res
     or pos_checkout_state(b1, array[gen_random_uuid()])->'result' is distinct from 'null'::jsonb
     or pos_checkout_state(b1, null)->'result' is distinct from 'null'::jsonb then
    raise exception 'FAIL H1 paid: %', pos_checkout_state(b1, array[v_checkout]);
  end if;

  -- ── H3. an item void touches its bill (a bills event for the other iPads) ───
  update bills set updated_at = now() - interval '1 hour' where id = b3;
  v_res := void_order_item((select id from order_items where bill_id = b3 and order_type = 'dine_in'), 'Wrong item keyed', v_sup, '0000');
  if (v_res->>'ok')::boolean or (select updated_at from bills where id = b3) is distinct from now() - interval '1 hour' then
    raise exception 'FAIL H3: a refused void touched the bill: %', v_res;
  end if;
  v_res := void_order_item((select id from order_items where bill_id = b3 and order_type = 'dine_in'), 'Wrong item keyed', v_sup, '2468');
  if not (v_res->>'ok')::boolean or (select updated_at from bills where id = b3) is distinct from now() then
    raise exception 'FAIL H3: the void did not touch the bill: %', v_res;
  end if;

  -- ── H5. voids between shifts go to the next shift, once ──────────────────────
  -- during shift 1: the tea on S1 (H4) and the dine-in tea on H2 (H3)
  v_res := close_shift(s1, pos_shift_expected_cash(s1), null, null, null, null);
  if not (v_res->>'ok')::boolean then raise exception 'FAIL H5 close 1: %', v_res; end if;
  v_rep1 := v_res->'report';
  c1 := (select closed_at from pos_shifts where id = s1);
  if jsonb_array_length(v_rep1->'voids'->'items') is distinct from 2 then raise exception 'FAIL H5 shift 1 voids: %', v_rep1->'voids'; end if;
  -- no shift open: voids are still allowed (ordering works without a shift)
  v_item := (select id from order_items where bill_id = b3 and order_type = 'takeaway');
  if not (void_order_item(v_item, 'Wrong item keyed', v_sup, '2468')->>'ok')::boolean then raise exception 'FAIL H5 void between shifts'; end if;
  update order_items set voided_at = c1 + interval '1 millisecond' where id = v_item;
  v_id := place_counter_order(v_t3.id, 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b5 := (select bill_id from orders where id = v_id);
  if not (void_bill(b5, 'Customer left', v_sup, '2468')->>'ok')::boolean then raise exception 'FAIL H5 bill void between shifts'; end if;
  -- H1: the checkout state of a voided bill — no totals, no result
  v_res := pos_checkout_state(b5, array[gen_random_uuid()]);
  if v_res is distinct from jsonb_build_object('status', 'voided', 'billNo', (select bill_no from bills where id = b5),
       'mergedIntoBillNo', null, 'totals', null, 'result', null) then
    raise exception 'FAIL H1 voided: %', v_res;
  end if;
  update order_items set voided_at = c1 + interval '2 milliseconds' where bill_id = b5;
  update bills set closed_at = c1 + interval '2 milliseconds' where id = b5;
  -- a void at the very moment of the close belongs to shift 1 (its report is frozen), never to shift 2
  v_id := place_counter_order(v_t4.id, 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b6 := (select bill_id from orders where id = v_id);
  v_item2 := (select id from order_items where bill_id = b6);
  perform void_order_item(v_item2, 'Wrong item keyed', v_sup, '2468');
  update order_items set voided_at = c1 where id = v_item2;
  -- another branch closes a shift later: it does not move this branch's window
  perform pg_sleep(0.02);
  perform pg_temp.act(v_far);
  v_far_shift := (open_shift(0)->'shift'->>'id')::uuid;
  if not (close_shift(v_far_shift, 0, null, null, null, null)->>'ok')::boolean then raise exception 'FAIL H5 far close'; end if;
  perform pg_temp.act(v_b);
  s2 := (open_shift(10000)->'shift'->>'id')::uuid;
  update pos_shifts set opened_at = c1 + interval '3 milliseconds' where id = s2;
  perform pg_sleep(0.02);
  v_res := close_shift(s2, pos_shift_expected_cash(s2), null, null, null, null);
  if not (v_res->>'ok')::boolean then raise exception 'FAIL H5 close 2: %', v_res; end if;
  v_rep2 := v_res->'report';
  if (select string_agg((v->>'qty') || ' ' || (v->>'name') || ' ' || (v->>'valueSen'), ', ' order by v->>'at')
        from jsonb_array_elements(v_rep2->'voids'->'items') v) is distinct from '1 Verify H Tea 550, 1 Verify H Plate 2000'
     or jsonb_array_length(v_rep2->'voids'->'bills') is distinct from 1
     or v_rep2->'voids'->'bills'->0->>'billNo' is distinct from (select bill_no from bills where id = b5)
     or (v_rep2->'summary'->>'voidBillCount')::int is distinct from 1 or (v_rep2->'summary'->>'voidSen')::int is distinct from 2550 then
    raise exception 'FAIL H5 shift 2 voids: % %', v_rep2->'voids', v_rep2->'summary';
  end if;
  if (select report from pos_shifts where id = s1) is distinct from v_rep1 then raise exception 'FAIL H5: shift 1''s report changed'; end if;
  -- the first shift of a branch: voids from its own open (nothing before it)
  if pos_shift_report(v_far_shift)->'voids' is distinct from '{"items": [], "bills": []}'::jsonb then
    raise exception 'FAIL H5 far report: %', pos_shift_report(v_far_shift)->'voids';
  end if;

  -- ── H6. wrong PINs count per approver and caller ───────────────────────────
  perform pg_temp.act(v_a);
  v_id := place_counter_order(v_t3.id, 'dine_in', 1, jsonb_build_array(
    jsonb_build_object('productId', v_tea, 'variantId', v_tea_v), jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b7 := (select bill_id from orders where id = v_id);
  v_item := (select id from order_items where order_id = v_id and product_id = v_tea);
  v_item2 := (select id from order_items where order_id = v_id and product_id = v_plate);
  for n in 1..4 loop
    v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
    if v_res->>'error' is distinct from format('Wrong PIN — %s %s left', 5 - n, case when n = 4 then 'try' else 'tries' end) then
      raise exception 'FAIL H6 try %: %', n, v_res;
    end if;
  end loop;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
  if v_res->>'error' is distinct from 'Wrong PIN — locked for 10 minutes after 5 wrong tries' then raise exception 'FAIL H6 lock: %', v_res; end if;
  v_until := (select locked_until from pos_pin_attempts where approver_id = v_sup and caller_id = v_a);
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '2468');
  if v_res->>'error' is distinct from 'Too many wrong PINs — try again after ' || to_char(v_until at time zone 'Asia/Kuala_Lumpur', 'HH24:MI')
     or v_until is distinct from now() + interval '10 minutes'
     or (select voided_at from order_items where id = v_item) is not null then
    raise exception 'FAIL H6 locked caller: %', v_res;
  end if;
  -- the approver's own row is not touched; caller B and the approver themself still approve
  if (select failed_attempts || ':' || coalesce(locked_until::text, '-') from staff_pos_pins where staff_id = v_sup) is distinct from '0:-' then
    raise exception 'FAIL H6: staff_pos_pins was written';
  end if;
  perform pg_temp.act(v_b);
  if not (void_order_item(v_item, 'Wrong item keyed', v_sup, '2468')->>'ok')::boolean then raise exception 'FAIL H6: caller B is locked out too'; end if;
  perform pg_temp.act(v_sup);
  if not (void_order_item(v_item2, 'Customer changed mind', v_sup, '2468')->>'ok')::boolean then raise exception 'FAIL H6: the approver is locked out'; end if;
  if (select failed_attempts from pos_pin_attempts where approver_id = v_sup and caller_id = v_b) is distinct from 0
     or (select locked_until from pos_pin_attempts where approver_id = v_sup and caller_id = v_a) is distinct from v_until then
    raise exception 'FAIL H6 rows: %', (select json_agg(p) from pos_pin_attempts p where p.approver_id = v_sup);
  end if;
  -- My PIN: the caller is the approver — the same table, the same rule
  v_res := set_my_pos_pin('1357', '0000');
  if (v_res->>'ok')::boolean or v_res->>'error' is distinct from 'Current PIN: Wrong PIN — 4 tries left'
     or (select failed_attempts from pos_pin_attempts where approver_id = v_sup and caller_id = v_sup) is distinct from 1 then
    raise exception 'FAIL H6 my PIN wrong: %', v_res;
  end if;
  v_res := set_my_pos_pin('1357', '2468');          -- called on its own: a condition's subqueries may run before it
  -- a new PIN starts every pair afresh: A's lock and every count against the approver are gone
  if not (v_res->>'ok')::boolean
     or exists (select 1 from pos_pin_attempts where approver_id = v_sup)
     or (select failed_attempts from staff_pos_pins where staff_id = v_sup) is distinct from 0 then
    raise exception 'FAIL H6 my PIN: % %', v_res, (select json_agg(p) from pos_pin_attempts p where p.approver_id = v_sup);
  end if;
  -- a day without a try forgets the count: 4 old failures + 1 new = "4 tries left", not a lock
  -- (the new PIN deleted A's row: insert it again)
  insert into pos_pin_attempts(approver_id, caller_id, failed_attempts, locked_until, updated_at)
  values (v_sup, v_a, 4, null, now() - interval '2 days')
  on conflict (approver_id, caller_id) do update
     set failed_attempts = excluded.failed_attempts, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
  perform pg_temp.act(v_a);
  v_id := place_counter_order(v_t3.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  v_res := void_order_item((select id from order_items where order_id = v_id), 'Wrong item keyed', v_sup, '0000');
  if v_res->>'error' is distinct from 'Wrong PIN — 4 tries left' then raise exception 'FAIL H6 idle day: %', v_res; end if;

  -- ── H7. print jobs: only the caller's branch ───────────────────────────────
  insert into print_jobs(branch_id, route, kind, payload) values (v_branch, 'Bar', 'ticket', '{}'::jsonb) returning id into v_job1;
  insert into print_jobs(branch_id, route, kind, payload) values (v_branch2, 'Bar', 'ticket', '{}'::jsonb) returning id into v_job2;
  if claim_print_job(v_job2) or (select status || ':' || attempts from print_jobs where id = v_job2) is distinct from 'pending:0' then
    raise exception 'FAIL H7: claimed another branch''s job';
  end if;
  if not claim_print_job(v_job1) then raise exception 'FAIL H7: own job claim'; end if;
  if claim_print_job(v_job1) then raise exception 'FAIL H7: own job claimed twice'; end if;
  update print_jobs set status = 'printing' where id = v_job2;
  perform finish_print_job(v_job2, true, null);
  if (select status from print_jobs where id = v_job2) is distinct from 'printing' then raise exception 'FAIL H7: finished another branch''s job'; end if;
  perform finish_print_job(v_job1, false, 'Not sent: paper out');
  if (select status || ':' || last_error from print_jobs where id = v_job1) is distinct from 'failed:Not sent: paper out' then
    raise exception 'FAIL H7: own job finish';
  end if;
  update print_jobs set status = 'failed' where id = v_job2;
  perform requeue_print_job(v_job2);
  if (select status from print_jobs where id = v_job2) is distinct from 'failed' then raise exception 'FAIL H7: requeued another branch''s job'; end if;
  perform requeue_print_job(v_job1);
  if (select status from print_jobs where id = v_job1) is distinct from 'pending' then raise exception 'FAIL H7: own job requeue'; end if;
  -- ...while the far branch's own host still can
  perform pg_temp.act(v_far);
  perform requeue_print_job(v_job2);
  if (select status from print_jobs where id = v_job2) is distinct from 'pending' or not claim_print_job(v_job2) then
    raise exception 'FAIL H7: the far branch cannot handle its own job';
  end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
