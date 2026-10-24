-- Self-check for POS Sub-plan 4a (shifts, Pay in / Pay out, the Z report). Run on
-- craft-os-dev after migration-2026-10-24-pos-shifts.sql and -shifts-fn.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- Every refusal is paired with the success it guards. Inside one transaction now() does
-- not move, so the script sets the first shift's open time and its voids back by hand.
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
  v_sup     uuid := 'eeeeeeee-0000-0000-0000-000000000041';   -- supervisor of VERIFY 4A (approves)
  v_cashier uuid := 'eeeeeeee-0000-0000-0000-000000000042';   -- staff of VERIFY 4A
  v_far     uuid := 'eeeeeeee-0000-0000-0000-000000000043';   -- supervisor of another branch
  v_branch uuid; v_branch2 uuid;
  v_t1 dining_tables; v_t2 dining_tables; v_t3 dining_tables; v_t4 dining_tables;
  v_cat uuid; v_catalog uuid; v_plate uuid; v_plate_v uuid; v_tea uuid; v_tea_v uuid; v_water uuid; v_water_v uuid;
  v_cash uuid; v_card uuid;
  b1 uuid; b2 uuid; b3 uuid; b4 uuid; b5 uuid; b6 uuid; b7 uuid;
  s1 uuid; s2 uuid;
  v_move uuid := 'eeeeeeee-1111-0000-0000-000000000001';
  v_move2 uuid := 'eeeeeeee-1111-0000-0000-000000000002';
  v_res jsonb; v_rep jsonb; v_rep1 jsonb; v_text text; v_id uuid; n integer; r record; v_role text; v_tbl text; v_priv text;
begin
  -- ── A. grants, internal helpers, search_path, RLS, the canonical money functions ──
  for r in select f from unnest(array[
             'pos_current_shift()', 'open_shift(integer)', 'record_cash_move(uuid,text,integer,text,uuid,text)',
             'close_shift(uuid,integer,text,uuid,text,integer)', 'pos_shift_list()', 'pos_shift_zreport(uuid)',
             'reprint_zreport(uuid)', 'save_shift_settings(integer)', 'checkout_bill(uuid,jsonb,uuid)',
             'refund_bill(uuid,uuid,integer,uuid,text,uuid,text)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array[
             'pos_shift_expected_cash(uuid)', 'pos_shift_report(uuid)', 'pos_queue_zreport(uuid,jsonb,boolean)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array[
              'pos_shifts_guard','pos_current_shift','open_shift','record_cash_move','pos_shift_expected_cash',
              'pos_shift_report','pos_queue_zreport','close_shift','pos_shift_list','pos_shift_zreport',
              'reprint_zreport','save_shift_settings','checkout_bill','refund_bill'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('pos_shifts', 'pos_cash_moves'))
     or exists (select 1 from pg_class where relname in ('pos_shifts', 'pos_cash_moves')
                 and relnamespace = 'public'::regnamespace and not relrowsecurity) then
    raise exception 'FAIL rls: pos_shifts and pos_cash_moves must be read and written only through the functions';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_tbl in array array['pos_shifts', 'pos_cash_moves'] loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
        if has_table_privilege(v_role, v_tbl, v_priv) then
          raise exception 'FAIL rls: % has % on % (the functions only)', v_role, v_priv, v_tbl;
        end if;
      end loop;
    end loop;
  end loop;
  if (select count(*) from pg_proc where proname = 'checkout_bill') is distinct from 1 or (select count(*) from pg_proc where proname = 'refund_bill') is distinct from 1 then
    raise exception 'FAIL: more than one checkout_bill or refund_bill';
  end if;
  -- re-running checkout-fn, bill-actions-fn or checkout-fixes silently drops the shift check
  if pg_get_functiondef('checkout_bill(uuid,jsonb,uuid)'::regprocedure) not like '%Open the shift first%'
     or pg_get_functiondef('refund_bill(uuid,uuid,integer,uuid,text,uuid,text)'::regprocedure) not like '%Open the shift first%'
     or pg_get_functiondef('refund_bill(uuid,uuid,integer,uuid,text,uuid,text)'::regprocedure) not like '%Refunds go back the way the bill was paid%' then
    raise exception 'FAIL: checkout_bill or refund_bill has no shift check — re-run migration-2026-10-24-pos-shifts-fn.sql';
  end if;
  -- the race rule: money functions hold the open shift FOR SHARE, close_shift takes it FOR UPDATE,
  -- so a close waits for a checkout in flight and then counts it (one session cannot race itself)
  if pg_get_functiondef('checkout_bill(uuid,jsonb,uuid)'::regprocedure) not like '%status = ''open'' for share%'
     or pg_get_functiondef('refund_bill(uuid,uuid,integer,uuid,text,uuid,text)'::regprocedure) not like '%status = ''open'' for share%'
     or pg_get_functiondef('record_cash_move(uuid,text,integer,text,uuid,text)'::regprocedure) not like '%status = ''open'' for share%'
     or pg_get_functiondef('close_shift(uuid,integer,text,uuid,text,integer)'::regprocedure) not like '%for update%' then
    raise exception 'FAIL race: the shift lock modes changed (money FOR SHARE, close FOR UPDATE)';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'pos_shifts_guard' and tgrelid = 'pos_shifts'::regclass)
     or to_regclass('public.pos_shifts_one_open') is null then
    raise exception 'FAIL schema: the closed-shift guard or the one-open-shift index is missing';
  end if;
  if (select column_default from information_schema.columns
       where table_name = 'branch_pos_settings' and column_name = 'cash_variance_limit_sen') is distinct from '500' then
    raise exception 'FAIL schema: cash_variance_limit_sen must default to 500 (RM 5.00)';
  end if;

  -- ── B. fixture: two branches, a catalog with two products, two methods, staff ──
  update system_role_permissions set permissions = permissions - 'pos_supervise' - 'access_settings' where true;   -- code defaults
  insert into branches(name, address, receipt_title) values ('VERIFY 4A', 'verify', 'Verify 4A Cafe') returning id into v_branch;
  insert into branches(name, address) values ('VERIFY 4A FAR', 'far') returning id into v_branch2;
  insert into dining_tables(branch_id, label) values (v_branch, 'S1') returning * into v_t1;
  insert into dining_tables(branch_id, label) values (v_branch, 'S2') returning * into v_t2;
  insert into dining_tables(branch_id, label) values (v_branch, 'S3') returning * into v_t3;
  insert into dining_tables(branch_id, label) values (v_branch, 'S4') returning * into v_t4;
  insert into print_routes(branch_id, name, kind, address) values (v_branch, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_branch, 'Bar');
  insert into menu_categories(name, sort_order) values ('VERIFY 4A FOOD', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp, takeaway_fee_sen) values ('Verify 4A Plate', v_cat, 600, 100) returning id into v_plate;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify 4A Tea', v_cat, 0) returning id into v_tea;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify 4A Water', v_cat, 0) returning id into v_water;   -- free
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 2000) returning id into v_plate_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_tea, '', 'Regular', 550) returning id into v_tea_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_water, '', 'Regular', 0) returning id into v_water_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY 4A CATALOG', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values
    (v_catalog, v_plate, 'all'), (v_catalog, v_tea, 'all'), (v_catalog, v_water, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values
    (v_catalog, v_plate_v, 2000), (v_catalog, v_tea_v, 550), (v_catalog, v_water_v, 0);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', v_catalog), (v_branch, 'takeaway', v_catalog), (v_branch, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_branch, 'V Cash', 'cash', 1) returning id into v_cash;
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_branch, 'V Card', 'card', 2) returning id into v_card;
  update staff set branch_id = v_branch where id = v_owner;
  -- staff are inserted as 'staff' and promoted by the owner (the staff guard refuses anything else)
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_sup), (v_cashier), (v_far);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_sup,     'Verify 4A Supervisor', 'trainee', true, current_date, 'staff', v_branch),
    (v_cashier, 'Verify 4A Cashier',    'trainee', true, current_date, 'staff', v_branch),
    (v_far,     'Verify 4A Far',        'trainee', true, current_date, 'staff', v_branch2);
  update staff set system_role = 'supervisor' where id in (v_sup, v_far);
  perform pg_temp.act(v_sup);
  if not (set_my_pos_pin('2468', null)->>'ok')::boolean then raise exception 'FAIL fixture: supervisor PIN'; end if;
  perform pg_temp.act(v_cashier);
  v_id := place_counter_order(v_t1.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v, 'qty', 2)), gen_random_uuid());
  b1 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(null, 'takeaway', null, jsonb_build_array(
    jsonb_build_object('productId', v_plate, 'variantId', v_plate_v), jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)),
    gen_random_uuid());
  b2 := (select bill_id from orders where id = v_id);
  v_id := place_table_order(v_t2.qr_token, 2,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b3 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(v_t3.id, 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b4 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b5 := (select bill_id from orders where id = v_id);
  if (pos_bill_totals(b1)->>'totalSen')::int is distinct from 4240 or (pos_bill_totals(b2)->>'totalSen')::int is distinct from 2775
     or (pos_bill_totals(b3)->>'totalSen')::int is distinct from 550 or b4 is null or b5 is null then
    raise exception 'FAIL fixture: totals % % %', pos_bill_totals(b1), pos_bill_totals(b2), pos_bill_totals(b3);
  end if;

  -- ── C. no open shift: no money moves; ordering still works (the bills above) ──
  set local role authenticated;
  v_res := pos_current_shift();
  reset role;
  if v_res->'shift' is distinct from 'null'::jsonb or (v_res->>'openBillCount')::int is distinct from 5 or v_res->'lastFloatSen' is distinct from 'null'::jsonb then
    raise exception 'FAIL C status without a shift: %', v_res;
  end if;
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L::jsonb, %L)', b1,
      jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 4240)), gen_random_uuid()),
    'Open the shift first', 'C checkout without a shift');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 1000, %L, null, null)', gen_random_uuid(), 'pay_in', 'Float'),
    'Open the shift first', 'C pay in without a shift');
  if exists (select 1 from payments where bill_id = b1) or (select status from bills where id = b1) is distinct from 'open' then
    raise exception 'FAIL C: a refused checkout wrote something';
  end if;
  perform pg_temp.expect_error('select open_shift(-1)', 'Enter the opening float (RM 0.00 to RM 100000.00)', 'C negative float');
  perform pg_temp.expect_error('select open_shift(null)', 'Enter the opening float (RM 0.00 to RM 100000.00)', 'C no float');
  perform pg_temp.expect_error('select open_shift(10000001)', 'Enter the opening float (RM 0.00 to RM 100000.00)', 'C float above RM 100000');
  perform pg_temp.expect_error(format('select close_shift(%L, 0, null, null, null, null)', gen_random_uuid()), 'Shift not found', 'C close unknown');

  -- ── D. open: one shift per branch; the top bar never sees the expected cash ──
  v_res := open_shift(10000);
  s1 := (v_res->'shift'->>'id')::uuid;
  if s1 is null or v_res->'shift'->>'openedByName' is distinct from 'Verify 4A Cashier' or (v_res->'shift'->>'openingFloatSen')::int is distinct from 10000
     or v_res::text ilike '%expected%' or v_res::text ilike '%count%Sen%' then
    raise exception 'FAIL D open: %', v_res;
  end if;
  perform pg_temp.act(v_sup);
  perform pg_temp.expect_error('select open_shift(5000)',
    format('A shift is already open — opened by Verify 4A Cashier at %s', to_char(now() at time zone 'Asia/Kuala_Lumpur', 'HH24:MI')),
    'D open twice');
  begin
    insert into pos_shifts(branch_id, opened_by, opening_float_sen) values (v_branch, v_sup, 0);
    raise exception 'FAIL D: a second open shift was stored';
  exception when unique_violation then null;
  end;
  perform pg_temp.act(v_far);                                            -- another branch opens its own
  if (open_shift(0)->'shift'->>'id')::uuid = s1 then raise exception 'FAIL D: branches share a shift'; end if;
  perform pg_temp.act(v_cashier);
  update pos_shifts set opened_at = now() - interval '2 hours' where id = s1;   -- the shift began two hours ago

  -- ── E. money inside shift 1: every row stamped; pay in / pay out; a cash and a card refund ──
  -- a tea added to S1 and voided before payment: a void of a paid bill, not in its product sales
  v_id := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  perform void_order_item((select id from order_items where order_id = v_id), 'Wrong item keyed', v_sup, '2468');
  v_res := checkout_bill(b1, jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 4240, 'tenderedSen', 5000)), gen_random_uuid());
  if (v_res->>'changeSen')::int is distinct from 760 then raise exception 'FAIL E checkout b1: %', v_res; end if;
  perform checkout_bill(b2, jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 2000),
                                              jsonb_build_object('methodId', v_cash, 'amountSen', 775)), gen_random_uuid());
  perform checkout_bill(b3, jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 550)), gen_random_uuid());
  if exists (select 1 from payments where bill_id in (b1, b2, b3) and shift_id is distinct from s1)
     or (select count(*) from payments where shift_id = s1) is distinct from 4
     or exists (select 1 from bills where id in (b1, b2, b3) and shift_id is distinct from s1)
     or (select count(*) from bills where shift_id = s1) is distinct from 3 then
    raise exception 'FAIL E stamps: payments or bills not stamped with shift 1';
  end if;
  -- voids: one item of an open bill, one whole bill (listed by time, they move no money)
  perform void_order_item((select id from order_items where bill_id = b4), 'Wrong item keyed', v_sup, '2468');
  perform void_bill(b5, 'Customer left', v_sup, '2468');
  update order_items set voided_at = now() - interval '1 hour' where bill_id in (b1, b4, b5) and voided_at is not null;
  update bills set closed_at = now() - interval '1 hour' where id = b5;
  -- pay in: no approver; idempotent on its id
  v_res := record_cash_move(v_move, 'pay_in', 2000, '  Float top-up ', null, null);
  if not (v_res->>'ok')::boolean or record_cash_move(v_move, 'pay_in', 2000, 'Float top-up', null, null) is distinct from v_res then
    raise exception 'FAIL E pay in: %', v_res;
  end if;
  v_res := record_cash_move(v_move, 'pay_in', 3000, 'Float top-up', null, null);
  if (v_res->>'ok')::boolean or v_res->>'error' is distinct from 'This was already recorded as Pay in RM 20.00 — close and reopen to record another' then
    raise exception 'FAIL E pay in resend with another amount: %', v_res;
  end if;
  if (select count(*) from pos_cash_moves where shift_id = s1) is distinct from 1
     or (select reason || ':' || coalesce(approved_by::text, '-') from pos_cash_moves where id = v_move) is distinct from 'Float top-up:-' then
    raise exception 'FAIL E pay in row';
  end if;
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 0, %L, null, null)', v_move2, 'pay_out', 'Ice'),
    'Enter the amount (RM 0.01 to RM 100000.00)', 'E zero');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 10000001, %L, null, null)', v_move2, 'pay_in', 'Ice'),
    'Enter the amount (RM 0.01 to RM 100000.00)', 'E above RM 100000');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 1500, %L, null, null)', v_move2, 'pay_out', ' '), 'Enter a reason', 'E no reason');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 1500, %L, null, null)', v_move2, 'tips', 'Ice'), 'Choose Pay in or Pay out', 'E kind');
  -- pay out: an approver with the right PIN, never the cashier, never without the PIN
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 1500, %L, null, null)', v_move2, 'pay_out', 'Ice'),
    'Choose who approves', 'E pay out without an approver');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 1500, %L, %L, %L)', v_move2, 'pay_out', 'Ice', v_cashier, '1111'),
    'This person cannot approve voids or refunds', 'E pay out approved by the cashier');
  v_res := record_cash_move(v_move2, 'pay_out', 1500, 'Ice', v_sup, null);
  if (v_res->>'ok')::boolean or v_res->>'error' is distinct from 'Wrong PIN — 4 tries left'
     or exists (select 1 from pos_cash_moves where id = v_move2) then
    raise exception 'FAIL E pay out without the PIN: %', v_res;
  end if;
  v_res := record_cash_move(v_move2, 'pay_out', 1500, 'Ice', v_sup, '2468');
  if not (v_res->>'ok')::boolean or (select approved_by from pos_cash_moves where id = v_move2) is distinct from v_sup then
    raise exception 'FAIL E pay out: %', v_res;
  end if;
  -- refunds in shift 1: cash (leaves the drawer) and card (does not)
  if not (refund_bill(gen_random_uuid(), b1, 1000, v_cash, 'Verify refund', v_sup, '2468')->>'ok')::boolean
     or not (refund_bill(gen_random_uuid(), b2, 300, v_card, 'Verify refund', v_sup, '2468')->>'ok')::boolean then
    raise exception 'FAIL E refunds';
  end if;
  if (select string_agg(kind || ':' || amount_sen, ',' order by amount_sen) from refunds where shift_id = s1) is distinct from 'card:300,cash:1000' then
    raise exception 'FAIL E refund stamps: %', (select json_agg(rr) from refunds rr where rr.bill_id in (b1, b2));
  end if;
  -- expected = float 100.00 + cash 42.40 + 7.75 (amounts, change taken off) − cash refund 10.00 + pay in 20.00 − pay out 15.00
  if pos_shift_expected_cash(s1) is distinct from 14515 then raise exception 'FAIL E expected cash: %', pos_shift_expected_cash(s1); end if;

  -- ── F. close shift 1: blind count, above the limit, approval, first count kept ──
  perform pg_temp.expect_error('select save_shift_settings(800)', 'Only a manager can change the shift settings', 'F settings by the cashier');
  perform pg_temp.act(v_owner);
  perform pg_temp.expect_error('select save_shift_settings(-1)', 'Enter a cash variance limit between RM 0.00 and RM 10000.00', 'F bad limit');
  perform save_shift_settings(500);
  if (select cash_variance_limit_sen from branch_pos_settings where branch_id = v_branch) is distinct from 500
     or (select receipt_route from branch_pos_settings where branch_id = v_branch) is distinct from 'Bar' then
    raise exception 'FAIL F settings';
  end if;
  perform pg_temp.act(v_cashier);
  perform pg_temp.expect_error(format('select close_shift(%L, -5, null, null, null, null)', s1),
    'Enter the counted cash (RM 0.00 to RM 100000.00)', 'F negative count');
  perform pg_temp.expect_error(format('select close_shift(%L, 10000001, null, null, null, null)', s1),
    'Enter the counted cash (RM 0.00 to RM 100000.00)', 'F count above RM 100000');
  -- short RM 5.15 (more than RM 5.00): no approver yet → the sheet asks for one
  v_res := close_shift(s1, 14000, null, null, null, null);
  if v_res is distinct from jsonb_build_object('ok', false, 'needsApproval', true, 'expectedSen', 14515, 'varianceSen', -515, 'limitSen', 500)
     or (select status || ':' || first_count_sen from pos_shifts where id = s1) is distinct from 'open:14000' then
    raise exception 'FAIL F above the limit: %', v_res;
  end if;
  -- the expected cash is on screen now: a new count of exactly that still needs the approval
  v_res := close_shift(s1, 14515, null, null, null, null);
  if v_res is distinct from jsonb_build_object('ok', false, 'needsApproval', true, 'expectedSen', 14515, 'varianceSen', 0, 'limitSen', 500)
     or (select status || ':' || first_count_sen from pos_shifts where id = s1) is distinct from 'open:14000' then
    raise exception 'FAIL F a re-count within the limit after a first count above it closed without approval: %', v_res;
  end if;
  -- the approver was shown another expected cash (it moved meanwhile): the new figures, no PIN tried
  v_res := close_shift(s1, 13900, 'Short — till miscount', v_sup, '0000', 14000);
  if v_res is distinct from jsonb_build_object('ok', false, 'needsApproval', true, 'expectedSen', 14515, 'varianceSen', -615, 'limitSen', 500)
     or (select status from pos_shifts where id = s1) is distinct from 'open'
     or (select failed_attempts from staff_pos_pins where staff_id = v_sup) is distinct from 0 then
    raise exception 'FAIL F approval of a stale expected cash: %', v_res;
  end if;
  -- counted again (RM 139.00, short 6.15): a wrong PIN leaves it open; the first count stays
  v_res := close_shift(s1, 13900, 'Short — till miscount', v_sup, '0000', 14515);
  if (v_res->>'ok')::boolean or v_res->>'error' is distinct from 'Wrong PIN — 4 tries left'
     or (select status || ':' || first_count_sen from pos_shifts where id = s1) is distinct from 'open:14000' then
    raise exception 'FAIL F wrong PIN: %', v_res;
  end if;
  perform pg_temp.expect_error(format('select close_shift(%L, 13900, %L, %L, %L, 14515)', s1, ' ', v_sup, '2468'),
    'Enter a reason for the difference', 'F no reason');
  v_res := close_shift(s1, 13900, 'Short — till miscount', v_sup, '2468', 14515);
  if not (v_res->>'ok')::boolean or not (v_res->>'printed')::boolean then raise exception 'FAIL F close: %', v_res; end if;
  v_rep1 := v_res->'report';
  select * into r from pos_shifts where id = s1;
  if r.status is distinct from 'closed' or r.counted_cash_sen is distinct from 13900 or r.first_count_sen is distinct from 14000 or r.expected_cash_sen is distinct from 14515
     or r.variance_sen is distinct from -615 or r.variance_reason is distinct from 'Short — till miscount' or r.variance_approved_by is distinct from v_sup
     or r.closed_by is distinct from v_cashier or r.report is distinct from v_rep1 or not r.report_printed then
    raise exception 'FAIL F closed row: %', row_to_json(r);
  end if;
  -- the Z report
  if v_rep1->>'branch' is distinct from 'Verify 4A Cafe' or v_rep1->>'openedBy' is distinct from 'Verify 4A Cashier' or v_rep1->>'closedBy' is distinct from 'Verify 4A Cashier'
     or v_rep1->'summary' is distinct from '{"pax": 4, "nettSen": 7565, "voidSen": 3100, "billCount": 3, "refundSen": 1300,
                               "avgPerPaxSen": 1891, "avgPerBillSen": 2522, "voidBillCount": 1}'::jsonb
     or v_rep1->'sales' is distinct from '{"sstSen": 366, "nettSen": 7565, "grossSen": 7100, "roundingSen": -1,
                             "takeawayFeeSen": 100, "serviceChargeSen": 0}'::jsonb then
    raise exception 'FAIL F report summary: % %', v_rep1->'summary', v_rep1->'sales';
  end if;
  -- the report's totals are the bills' totals
  if (select jsonb_build_object('grossSen', sum(subtotal_sen), 'takeawayFeeSen', sum(takeaway_fee_sen), 'serviceChargeSen', sum(service_charge_sen),
                                'sstSen', sum(sst_sen), 'roundingSen', sum(rounding_sen), 'nettSen', sum(total_sen))
        from bills where shift_id = s1) is distinct from v_rep1->'sales' then
    raise exception 'FAIL F report totals differ from the bills';
  end if;
  if v_rep1->'payments' is distinct from '[{"kind": "card", "name": "V Card", "count": 2, "netSen": 2250, "amountSen": 2550, "refundSen": 300, "refundCount": 1},
                            {"kind": "cash", "name": "V Cash", "count": 2, "netSen": 4015, "amountSen": 5015, "refundSen": 1000, "refundCount": 1}]'::jsonb
     or v_rep1->'orderTypes' is distinct from '[{"bills": 2, "nettSen": 4790, "orderType": "dine_in"}, {"bills": 1, "nettSen": 2775, "orderType": "takeaway"}]'::jsonb
     or v_rep1->'sources' is distinct from '[{"orders": 3, "itemSen": 6550, "source": "counter"}, {"orders": 1, "itemSen": 550, "source": "qr"}]'::jsonb
     or v_rep1->'products' is distinct from '[{"qty": 3, "name": "Verify 4A Plate", "valueSen": 6000}, {"qty": 2, "name": "Verify 4A Tea", "valueSen": 1100}]'::jsonb then
    raise exception 'FAIL F report lists: % % % %', v_rep1->'payments', v_rep1->'orderTypes', v_rep1->'sources', v_rep1->'products';
  end if;
  if (v_rep1->'cash') - 'moves' is distinct from '{"countedSen": 13900, "payInSen": 2000, "payOutSen": 1500, "expectedSen": 14515,
                                    "varianceSen": -615, "cashSalesSen": 5015, "cashRefundSen": 1000, "firstCountSen": 14000,
                                    "varianceReason": "Short — till miscount", "openingFloatSen": 10000,
                                    "varianceApprovedBy": "Verify 4A Supervisor"}'::jsonb
     or (select string_agg(m->>'kind' || ':' || (m->>'amountSen') || ':' || (m->>'reason') || ':' || (m->>'by') || ':' || coalesce(m->>'approvedBy', '-'), ',')
           from jsonb_array_elements(v_rep1->'cash'->'moves') m)
        is distinct from 'pay_in:2000:Float top-up:Verify 4A Cashier:-,pay_out:1500:Ice:Verify 4A Cashier:Verify 4A Supervisor' then
    raise exception 'FAIL F report cash drawer: %', v_rep1->'cash';
  end if;
  if (select string_agg((v->>'name') || ':' || (v->>'qty') || ':' || (v->>'valueSen') || ':' || (v->>'reason') || ':' || (v->>'approvedBy'), ',' order by v->>'name', v->>'reason')
        from jsonb_array_elements(v_rep1->'voids'->'items') v)
        is distinct from 'Verify 4A Plate:1:2000:Wrong item keyed:Verify 4A Supervisor,Verify 4A Tea:1:550:Customer left:Verify 4A Supervisor,'
                         'Verify 4A Tea:1:550:Wrong item keyed:Verify 4A Supervisor'
     or jsonb_array_length(v_rep1->'voids'->'bills') is distinct from 1 or v_rep1->'voids'->'bills'->0->>'reason' is distinct from 'Customer left'
     or (select string_agg((x->>'amountSen') || ':' || (x->>'method'), ',' order by (x->>'amountSen')::int) from jsonb_array_elements(v_rep1->'refunds') x)
        is distinct from '300:V Card,1000:V Cash' then
    raise exception 'FAIL F report voids and refunds: % %', v_rep1->'voids', v_rep1->'refunds';
  end if;
  -- printed on the receipt route as a Z report (print_jobs.kind stays 'receipt')
  select count(*) into n from print_jobs where branch_id = v_branch and kind = 'receipt' and route = 'Bar'
     and payload->>'kind' = 'zreport' and payload->'report' = v_rep1 and not (payload->>'reprint')::boolean;
  if n is distinct from 1 then raise exception 'FAIL F: % Z report jobs queued', n; end if;

  -- ── G. a closed shift never changes; money stops until the next shift opens ──
  if close_shift(s1, 13900, null, null, null, null) is distinct from v_res then raise exception 'FAIL G: a resend of the close got another answer'; end if;
  perform pg_temp.expect_error(format('select close_shift(%L, 14515, null, null, null, null)', s1), 'This shift is already closed', 'G close again');
  if (select count(*) from print_jobs where branch_id = v_branch and payload->>'kind' = 'zreport') is distinct from 1 then
    raise exception 'FAIL G: a resend printed the Z report again';
  end if;
  begin
    update pos_shifts set counted_cash_sen = 14515 where id = s1;
    raise exception 'FAIL G: a closed shift was changed';
  exception when raise_exception then if sqlerrm is distinct from 'A closed shift never changes' then raise; end if;
  end;
  begin
    delete from pos_shifts where id = s1;
    raise exception 'FAIL G: a shift was deleted';
  exception when raise_exception then if sqlerrm is distinct from 'A shift is never deleted' then raise; end if;
  end;
  v_id := place_counter_order(v_t4.id, 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_tea, 'variantId', v_tea_v)), gen_random_uuid());
  b6 := (select bill_id from orders where id = v_id);
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L::jsonb, %L)', b6,
      jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 550)), gen_random_uuid()),
    'Open the shift first', 'G checkout after the close');
  perform pg_temp.expect_error(format('select refund_bill(%L, %L, 500, %L, %L, %L, %L)', gen_random_uuid(), b1, v_cash, 'Verify refund', v_sup, '2468'),
    'Open the shift first', 'G refund without a shift');
  perform pg_temp.expect_error(format('select record_cash_move(%L, %L, 100, %L, null, null)', gen_random_uuid(), 'pay_in', 'x'),
    'Open the shift first', 'G pay in after the close');
  v_res := pos_current_shift();
  if v_res->'shift' is distinct from 'null'::jsonb or (v_res->>'lastFloatSen')::int is distinct from 10000 or (v_res->>'openBillCount')::int is distinct from 2 then
    raise exception 'FAIL G status after the close: %', v_res;
  end if;

  -- ── H. shift 2: an old bill's refund belongs to the shift open now; within the limit; no printer ──
  perform pg_temp.act(v_sup);
  s2 := (open_shift(12000)->'shift'->>'id')::uuid;
  v_res := refund_bill(gen_random_uuid(), b1, 500, v_cash, 'Verify refund', v_sup, '2468');
  if not (v_res->>'ok')::boolean
     or (select shift_id from refunds where bill_id = b1 and amount_sen = 500) is distinct from s2 then
    raise exception 'FAIL H: the refund of a closed shift''s bill is not in the shift open now';
  end if;
  perform checkout_bill(b6, jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 550, 'tenderedSen', 1000)), gen_random_uuid());
  if (select shift_id from payments where bill_id = b6) is distinct from s2 then raise exception 'FAIL H: b6 not in shift 2'; end if;
  -- a bill of RM 0.00 (a free water) is paid with no payment rows and still belongs to the shift
  v_id := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_water, 'variantId', v_water_v)), gen_random_uuid());
  b7 := (select bill_id from orders where id = v_id);
  perform checkout_bill(b7, '[]'::jsonb, gen_random_uuid());
  if (select status || ':' || total_sen || ':' || coalesce(shift_id::text, '-') from bills where id = b7) is distinct from 'paid:0:' || s2
     or exists (select 1 from payments where bill_id = b7) then
    raise exception 'FAIL H: the RM 0.00 bill is not paid in shift 2';
  end if;
  update branch_pos_settings set receipt_route = null where branch_id = v_branch;
  -- expected 120.00 − 5.00 + 5.50 = 120.50; counted 121.00 is within RM 5.00: no approver, no reason kept
  v_res := close_shift(s2, 12100, 'ignored', null, null, null);
  if not (v_res->>'ok')::boolean or (v_res->>'printed')::boolean then raise exception 'FAIL H close: %', v_res; end if;
  v_rep := v_res->'report';
  select * into r from pos_shifts where id = s2;
  if r.variance_sen is distinct from 50 or r.expected_cash_sen is distinct from 12050 or r.variance_reason is not null or r.variance_approved_by is not null
     or r.report_printed then
    raise exception 'FAIL H closed row: %', row_to_json(r);
  end if;
  if (v_rep->'summary'->>'billCount')::int is distinct from 2 or (v_rep->'summary'->>'refundSen')::int is distinct from 500
     or v_rep->'products' is distinct from '[{"qty": 1, "name": "Verify 4A Tea", "valueSen": 550}, {"qty": 1, "name": "Verify 4A Water", "valueSen": 0}]'::jsonb
     or (v_rep->'cash'->>'cashRefundSen')::int is distinct from 500 or jsonb_array_length(v_rep->'voids'->'items') is distinct from 0
     or v_rep->'refunds'->0->>'billNo' is distinct from (select bill_no from bills where id = b1) then
    raise exception 'FAIL H report: %', v_rep;
  end if;
  if (select jsonb_build_object('grossSen', sum(subtotal_sen), 'takeawayFeeSen', sum(takeaway_fee_sen), 'serviceChargeSen', sum(service_charge_sen),
                                'sstSen', sum(sst_sen), 'roundingSen', sum(rounding_sen), 'nettSen', sum(total_sen))
        from bills where shift_id = s2) is distinct from v_rep->'sales' then
    raise exception 'FAIL H report totals differ from the bills';
  end if;
  if (select report from pos_shifts where id = s1) is distinct from v_rep1 then raise exception 'FAIL H: shift 1''s report changed'; end if;
  if exists (select 1 from print_jobs where branch_id = v_branch and payload->>'kind' = 'zreport' and payload->'report' = v_rep) then
    raise exception 'FAIL H: printed without a receipt printer';
  end if;

  -- ── I. past shifts and reprint: Approve POS voids & refunds only, own branch only ──
  perform pg_temp.act(v_cashier);
  perform pg_temp.expect_error('select pos_shift_list()', 'Only a supervisor can see past shifts', 'I list by the cashier');
  perform pg_temp.expect_error(format('select pos_shift_zreport(%L)', s1), 'Only a supervisor can see past shifts', 'I report by the cashier');
  perform pg_temp.expect_error(format('select reprint_zreport(%L)', s1), 'Only a supervisor can reprint a Z report', 'I reprint by the cashier');
  perform pg_temp.act(v_sup);
  set local role authenticated;
  v_res := pos_shift_list();
  reset role;
  if jsonb_array_length(v_res) is distinct from 2 or (v_res->0->>'id')::uuid is distinct from s2 or (v_res->1->>'id')::uuid is distinct from s1
     or (v_res->1->>'nettSen')::int is distinct from 7565 or (v_res->1->>'varianceSen')::int is distinct from -615 or v_res->1->>'openedBy' is distinct from 'Verify 4A Cashier' then
    raise exception 'FAIL I list: %', v_res;
  end if;
  if pos_shift_zreport(s1) is distinct from v_rep1 then raise exception 'FAIL I: the frozen report'; end if;
  perform pg_temp.expect_error(format('select reprint_zreport(%L)', s2), 'No receipt printer is set — choose one in POS settings', 'I reprint without a printer');
  update branch_pos_settings set receipt_route = 'Bar' where branch_id = v_branch;
  perform reprint_zreport(s1);
  if (select count(*) from print_jobs where branch_id = v_branch and payload->>'kind' = 'zreport' and (payload->>'reprint')::boolean
        and payload->'report' = v_rep1) is distinct from 1 then
    raise exception 'FAIL I reprint';
  end if;
  perform pg_temp.act(v_far);
  perform pg_temp.expect_error(format('select pos_shift_zreport(%L)', s1), 'Shift not found', 'I another branch');
  perform pg_temp.act(v_owner);

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
