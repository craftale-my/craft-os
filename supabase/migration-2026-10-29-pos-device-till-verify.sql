-- Self-check for the POS till on device sessions. Run on craft-os-dev after
-- migration-2026-10-29-pos-device-till.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections follow the migration: A schema and grants; T1 the till on a device
-- session (actor = the session's staff member, the device recorded); T5 the offline queue;
-- T2 printing; T3 reads; T6 unpairing from the tablet; the C1 transition for staff logins.
-- The other POS verify scripts keep passing as staff logins through the transition.
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

-- act(user id): the next calls run as this signed-in user (staff or device)
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-000000000091';   -- cashier of VERIFY T A
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-000000000092';   -- supervisor of VERIFY T A
  v_mgr   uuid := 'eeeeeeee-0000-0000-0000-000000000093';   -- manager of VERIFY T A (branch-only)
  v_far   uuid := 'eeeeeeee-0000-0000-0000-000000000094';   -- cashier of VERIFY T B
  v_dev1  uuid := 'eeeeeeee-0000-0000-0000-0000000000e1';   -- the printing tablet of A
  v_dev2  uuid := 'eeeeeeee-0000-0000-0000-0000000000e2';   -- another tablet of A
  v_devb  uuid := 'eeeeeeee-0000-0000-0000-0000000000e3';   -- a tablet of B
  v_agent uuid := 'eeeeeeee-0000-0000-0000-0000000000e4';   -- the print agent of A
  v_a uuid; v_b uuid; v_ta uuid; v_ta2 uuid; v_tb uuid;
  v_cat uuid; v_catalog uuid; v_plate uuid; v_plate_v uuid; v_card uuid;
  v_bill uuid; v_bill2 uuid; v_billb uuid; v_order uuid; v_item uuid; v_shift uuid; v_job_a uuid; v_job_b uuid; v_job_t uuid;
  v_res jsonb; v_items jsonb; n integer; r record; v_ok boolean;
begin
  -- ── A. schema and grants ──────────────────────────────────────────────────
  for r in select t, c from (values ('orders', 'device_id'), ('payments', 'device_id'), ('refunds', 'device_id'),
                                    ('pos_cash_moves', 'device_id'), ('pos_shifts', 'opened_device_id'), ('pos_shifts', 'closed_device_id'),
                                    ('bills', 'closed_device_id'), ('order_items', 'voided_device_id')) as x(t, c) loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.t and column_name = r.c) then
      raise exception 'FAIL T4 schema: %.% is missing', r.t, r.c;
    end if;
  end loop;
  for r in select f from unnest(array['pos_current_device()', 'pos_actor()', 'pos_my_branch()', 'pos_ctx()', 'pos_print_branch()',
                                      'pos_revoke_device(uuid,uuid)']) as f loop
    if has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL grants: % is internal but callable', r.f;
    end if;
  end loop;
  for r in select f from unnest(array['pos_unpair_this_device()', 'pos_readable_branches()',
                                      'place_counter_order(uuid,text,integer,jsonb,uuid,uuid,uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: clients cannot call %', r.f; end if;
  end loop;
  if to_regprocedure('place_counter_order(uuid,text,integer,jsonb,uuid,uuid)') is not null then
    raise exception 'FAIL T5: the old place_counter_order is still there';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and policyname in ('pos_read', 'dining_tables_update')
              and (qual = 'true' or with_check = 'true')) or exists (select 1 from pg_policies where policyname = 'print_jobs_update') then
    raise exception 'FAIL T3: an open read or update policy is left';
  end if;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname in ('checkout_bill', 'close_shift', 'merge_bills', 'open_shift', 'record_cash_move',
                                                         'refund_bill', 'void_bill', 'void_order_item', 'pos_pin_attempt', 'place_counter_order')
              and pg_get_functiondef(p.oid) like '%auth.uid()%' loop
    raise exception 'FAIL T1: % still records auth.uid() — re-run migration-2026-10-29-pos-device-till.sql', r.proname;
  end loop;

  -- ── B. fixture: outlets A and B, a product, a card method, staff with PINs, four devices ──
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;                                                                         -- code defaults
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';
  insert into branches(name, address) values ('VERIFY T A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY T B', 'b') returning id into v_b;
  insert into dining_tables(branch_id, label, sort_order) values (v_a, 'TA1', 1) returning id into v_ta;
  insert into dining_tables(branch_id, label, sort_order) values (v_a, 'TA2', 2) returning id into v_ta2;
  insert into dining_tables(branch_id, label, sort_order) values (v_b, 'TB1', 1) returning id into v_tb;
  insert into menu_categories(name, sort_order) values ('VERIFY T FOOD', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify T Plate', v_cat, 0) returning id into v_plate;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 1000) returning id into v_plate_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY T CATALOG', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_plate, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_plate_v, 1000);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog),
    (v_b, 'dine_in', v_catalog), (v_b, 'takeaway', v_catalog), (v_b, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'T Card', 'card', 1) returning id into v_card;
  v_items := jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v));
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_mgr), (v_far), (v_dev1), (v_dev2), (v_devb), (v_agent);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify T Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify T Supervisor', 'trainee', true, current_date, 'staff', v_a),
    (v_mgr,  'Verify T Manager',    'trainee', true, current_date, 'staff', v_a),
    (v_far,  'Verify T Far',        'trainee', true, current_date, 'staff', v_b);
  update staff set system_role = 'supervisor' where id = v_sup;
  update staff set system_role = 'manager' where id = v_mgr;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222'), (v_mgr, '3333'), (v_far, '4444')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values
    (v_dev1, v_a, 'pos', 'T Counter', 'ipad', true, v_owner),
    (v_dev2, v_a, 'pos', 'T Floor', 'ipad', false, v_owner),
    (v_devb, v_b, 'pos', 'T B Counter', 'android', true, v_owner),
    (v_agent, v_a, 'print_agent', 'T Mac', 'agent', false, v_owner);

  -- ── T1. the till on a device session ──────────────────────────────────────
  perform pg_temp.act(v_dev1);
  perform pg_temp.expect_error(format('select open_table(%L, 2)', v_ta), 'no_session', 'T1 no session yet');
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_bill := open_table(v_ta, 2);
  if (select branch_id from bills where id = v_bill) is distinct from v_a then raise exception 'FAIL T1: the bill is not at the device''s outlet'; end if;
  v_order := place_counter_order(v_ta, 'dine_in', 2, v_items, gen_random_uuid());
  if (select placed_by from orders where id = v_order) is distinct from v_cash
     or (select device_id from orders where id = v_order) is distinct from v_dev1 then
    raise exception 'FAIL T1: the order (placed by the session''s staff member, on this device)';
  end if;
  v_res := open_shift(10000);
  v_shift := (v_res->'shift'->>'id')::uuid;
  if (select opened_by from pos_shifts where id = v_shift) is distinct from v_cash
     or (select opened_device_id from pos_shifts where id = v_shift) is distinct from v_dev1 then
    raise exception 'FAIL T1: the shift opening: %', v_res;
  end if;
  v_res := pos_current_shift();                                                       -- a STABLE RPC on a device
  if (v_res->'shift'->>'id')::uuid is distinct from v_shift then raise exception 'FAIL T1: pos_current_shift on a device: %', v_res; end if;
  v_res := record_cash_move(gen_random_uuid(), 'pay_in', 500, 'Change top-up', null, null);
  if not coalesce((v_res->>'ok')::boolean, false)
     or not exists (select 1 from pos_cash_moves where shift_id = v_shift and created_by = v_cash and device_id = v_dev1) then
    raise exception 'FAIL T1: the cash move: %', v_res;
  end if;
  v_res := checkout_bill(v_bill, jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', (pos_bill_totals(v_bill)->>'totalSen')::int)),
                         gen_random_uuid());
  if (v_res->>'billId')::uuid is distinct from v_bill then raise exception 'FAIL T1 checkout: %', v_res; end if;
  if (select closed_by from bills where id = v_bill) is distinct from v_cash
     or (select closed_device_id from bills where id = v_bill) is distinct from v_dev1
     or not exists (select 1 from payments where bill_id = v_bill and taken_by = v_cash and device_id = v_dev1) then
    raise exception 'FAIL T1: the checkout (closed by, closing device, payment device)';
  end if;
  -- a void approved by the supervisor; a wrong approver PIN counts against the session's staff member
  v_bill2 := open_table(v_ta2, 1);
  v_order := place_counter_order(v_ta2, 'dine_in', 1, v_items, gen_random_uuid());
  select id into v_item from order_items where order_id = v_order;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
  if coalesce((v_res->>'ok')::boolean, true) then raise exception 'FAIL fixture: a wrong approver PIN passed: %', v_res; end if;
  if not exists (select 1 from pos_pin_attempts where approver_id = v_sup and caller_id = v_cash) then
    raise exception 'FAIL T1: the approval lockout does not count against the session''s staff member';
  end if;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false)
     or (select voided_by from order_items where id = v_item) is distinct from v_cash
     or (select voided_device_id from order_items where id = v_item) is distinct from v_dev1
     or (select void_approved_by from order_items where id = v_item) is distinct from v_sup then
    raise exception 'FAIL T1: the void (by the session''s staff member, on this device, approved by the supervisor): %', v_res;
  end if;
  v_order := place_counter_order(v_ta2, 'dine_in', 1, v_items, gen_random_uuid());     -- a live item, then void the whole bill
  v_res := void_bill(v_bill2, 'Customer left', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false)
     or (select status || '|' || closed_by || '|' || closed_device_id from bills where id = v_bill2)
          is distinct from 'voided|' || v_cash || '|' || v_dev1
     or (select voided_device_id from order_items where order_id = v_order) is distinct from v_dev1 then
    raise exception 'FAIL T1: voiding the bill (by the session''s staff member, on this device): %', v_res;
  end if;
  v_res := close_shift(v_shift, 10500, null, null, null, null);
  if (select status from pos_shifts where id = v_shift) is distinct from 'closed'
     or (select closed_by from pos_shifts where id = v_shift) is distinct from v_cash
     or (select closed_device_id from pos_shifts where id = v_shift) is distinct from v_dev1 then
    raise exception 'FAIL T1: closing the shift: %', v_res;
  end if;
  -- another outlet's tablet cannot touch this outlet's bill
  perform pg_temp.act(v_devb);
  v_res := pos_start_session(v_far, '4444');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: far sign-in: %', v_res; end if;
  v_billb := open_table(v_tb, 2);
  v_ok := false;
  begin
    perform open_table(v_ta2, 2);
  exception when raise_exception then v_ok := true;
  end;
  if not v_ok then raise exception 'FAIL T1: a tablet of B opened a table of A'; end if;

  -- ── T5. the offline queue ─────────────────────────────────────────────────
  perform pg_temp.act(v_dev1);
  v_order := place_counter_order(null, 'takeaway', null, v_items, gen_random_uuid(), null, v_sup);    -- queued by the supervisor
  if (select placed_by from orders where id = v_order) is distinct from v_sup then raise exception 'FAIL T5: the queued order keeps who took it'; end if;
  v_order := place_counter_order(null, 'takeaway', null, v_items, gen_random_uuid(), null, v_far);    -- may not work here any more
  if (select placed_by from orders where id = v_order) is distinct from v_cash then raise exception 'FAIL T5: a queued order by someone not allowed here'; end if;

  -- ── T2. printing ──────────────────────────────────────────────────────────
  insert into print_jobs(branch_id, route, kind, payload) values (v_a, 'Bar', 'ticket', '{}'::jsonb) returning id into v_job_a;
  insert into print_jobs(branch_id, route, kind, payload) values (v_b, 'Bar', 'ticket', '{}'::jsonb) returning id into v_job_b;
  perform pg_temp.act(v_dev2);
  perform pg_temp.expect_error(format('select claim_print_job(%L)', v_job_a), 'not_printing_tablet', 'T2 a tablet that does not print');
  perform pg_temp.act(v_dev1);
  perform pos_end_session('locked');                                                  -- the printing tablet prints while locked
  if not claim_print_job(v_job_a) then raise exception 'FAIL T2: the printing tablet claims its outlet''s job'; end if;
  if claim_print_job(v_job_b) then raise exception 'FAIL T2: the printing tablet claimed another outlet''s job'; end if;
  perform finish_print_job(v_job_a, false, 'Paper out');                             -- finish and requeue run on the device too
  perform requeue_print_job(v_job_a);
  if (select status from print_jobs where id = v_job_a) is distinct from 'pending' then raise exception 'FAIL T2: finish + requeue on the printing tablet'; end if;
  perform pg_temp.act(v_agent);
  if not claim_print_job(v_job_a) then raise exception 'FAIL T2: the print agent claims its outlet''s job'; end if;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  perform pg_temp.act(v_dev1);
  v_job_t := insert_test_print('Bar');
  if (select branch_id from print_jobs where id = v_job_t) is distinct from v_a then
    raise exception 'FAIL T2: a test print from the printing tablet';
  end if;
  perform pg_temp.act(v_dev2);
  perform pg_temp.expect_error('select insert_test_print(''Bar'')', 'not_printing_tablet', 'T2 a test print from a tablet that does not print');

  -- ── T3. reads ─────────────────────────────────────────────────────────────
  perform pg_temp.act(v_dev1);
  if pos_caller_branch() is distinct from v_a then raise exception 'FAIL T3: pos_caller_branch of a device'; end if;
  set local role authenticated;
  select count(*) into n from bills where id in (v_bill, v_bill2, v_billb);
  if n is distinct from 2 then raise exception 'FAIL T3: a tablet of A reads % of A''s 2 bills (and none of B''s)', n; end if;
  select count(*) into n from order_items where bill_id = v_billb;
  if n is distinct from 0 then raise exception 'FAIL T3: a tablet of A reads B''s order items'; end if;
  select count(*) into n from print_jobs where id = v_job_b;
  if n is distinct from 0 then raise exception 'FAIL T3: a tablet of A reads B''s print jobs'; end if;
  reset role;
  perform pg_temp.act(v_devb);
  set local role authenticated;
  select count(*) into n from bills where id in (v_bill, v_bill2, v_billb);
  reset role;
  if n is distinct from 1 then raise exception 'FAIL T3: a tablet of B reads % bills (expected only its own)', n; end if;
  perform pg_temp.act(v_far);                                                         -- a staff login: its scope
  set local role authenticated;
  select count(*) into n from bills where id in (v_bill, v_bill2, v_billb);
  reset role;
  if n is distinct from 1 then raise exception 'FAIL T3: staff of B read % bills (expected 1)', n; end if;
  perform pg_temp.act(v_owner);                                                       -- HQ: every outlet
  set local role authenticated;
  select count(*) into n from bills where id in (v_bill, v_bill2, v_billb);
  reset role;
  if n is distinct from 3 then raise exception 'FAIL T3: HQ reads % of 3 bills', n; end if;

  -- ── T6. unpairing from the tablet ─────────────────────────────────────────
  perform pg_temp.act(v_dev2);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: sign-in on the second tablet'; end if;
  perform pg_temp.expect_error('select pos_unpair_this_device()', 'Only a manager of this outlet can unpair this device', 'T6 a cashier');
  v_res := pos_start_session(v_mgr, '3333');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: manager sign-in: %', v_res; end if;
  perform pos_unpair_this_device();
  if (select revoked_by from pos_devices where id = v_dev2) is distinct from v_mgr
     or coalesce((select not isfinite(banned_until) or banned_until < now() + interval '99 years' from auth.users where id = v_dev2), true)
     or exists (select 1 from pos_staff_sessions where device_id = v_dev2 and ended_at is null) then
    raise exception 'FAIL T6: unpairing from the tablet (revoked by the manager, banned, session ended)';
  end if;
  perform pg_temp.expect_error(format('select open_table(%L, 2)', v_ta2), 'device_unpaired', 'T6 the unpaired tablet');
  set local role authenticated;
  select count(*) into n from bills where branch_id = v_a;
  reset role;
  if n is distinct from 0 then raise exception 'FAIL T3: an unpaired tablet still reads its outlet'; end if;

  -- ── the C1 transition: a staff login still runs the till at its home branch ──
  perform pg_temp.act(v_cash);
  perform pg_temp.expect_error('select pos_unpair_this_device()', 'device_unpaired', 'T6 a staff login');
  v_bill2 := open_table(v_ta2, 3);
  if (select branch_id from bills where id = v_bill2) is distinct from v_a then raise exception 'FAIL transition: a staff login''s table'; end if;
  v_order := place_counter_order(v_ta2, 'dine_in', 3, v_items, gen_random_uuid());
  if (select placed_by from orders where id = v_order) is distinct from v_cash
     or (select device_id from orders where id = v_order) is not null then
    raise exception 'FAIL transition: a staff login''s order (by them, no device)';
  end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
