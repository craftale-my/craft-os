-- Self-check for the POS switch-over (C3). Run on craft-os-dev after migration-2026-11-22-pos-switchover.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- Sections (one DO block each, ids in the temp table fixture): FIXTURE; X1 a staff login (cashier and HQ) and
-- no login are refused at the till and the printers; X2 a POS device with a session still runs the till;
-- X3 print agents claim their own outlet's jobs only; X4 the back office still works for a staff login.
-- Outlets VERIFY C3 A (tables C1, C2, a Bar route of kind agent, one product on a dine-in / takeaway catalog)
-- and VERIFY C3 B (a Bar route). A cashier of A with a PIN signed in on a POS tablet of A that does not print;
-- print agents on A and on B; one test job per outlet queued from the back office by the dev owner login.
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
create function pg_temp.items() returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object('productId', pg_temp.id('latte'), 'variantId', pg_temp.id('latte_v'), 'qty', 1))
$$;

-- ── FIXTURE ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000c3c01';
  v_pos   uuid := 'eeeeeeee-0000-0000-0000-0000000c3d01';
  v_ag_a  uuid := 'eeeeeeee-0000-0000-0000-0000000c3d02';
  v_ag_b  uuid := 'eeeeeeee-0000-0000-0000-0000000c3d03';
  v_a uuid; v_b uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_p uuid; v_v uuid; v_res jsonb; i integer;
begin
  -- the role defaults decide (owner: every outlet and access_settings; staff: pos_login, no access_settings)
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  insert into branches(name, address) values ('VERIFY C3 A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY C3 B', 'b') returning id into v_b;
  perform pg_temp.put('a', v_a); perform pg_temp.put('b', v_b);
  for i in 1..2 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'C' || i, i) returning id into v_t;
    perform pg_temp.put('c' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values
    (v_a, 'Bar', 'agent', '127.0.0.1:9100'), (v_b, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into menu_categories(name, sort_order) values ('VERIFY C3 DRINKS', 933) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY C3 MENU', 933) returning id into v_catalog;
  insert into menu_products(name, category_id, sst_rate_bp, print_route) values ('Verify C3 Latte', v_cat, 600, 'Bar') returning id into v_p;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', 1000) returning id into v_v;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, 1000);
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog);
  perform pg_temp.put('latte', v_p); perform pg_temp.put('latte_v', v_v);
  insert into auth.users (id) values (v_cash), (v_pos), (v_ag_a), (v_ag_b);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify C3 Cashier', 'trainee', true, current_date, 'staff', v_a);
  perform pg_temp.act(v_cash);
  if not coalesce((set_my_pos_pin('1111', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of the cashier'; end if;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values
    (v_pos,  v_a, 'pos', 'C3 Counter', 'ipad', false, v_owner),
    (v_ag_a, v_a, 'print_agent', 'C3 Agent A', 'agent', false, v_owner),
    (v_ag_b, v_b, 'print_agent', 'C3 Agent B', 'agent', false, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('cashier', v_cash); perform pg_temp.put('pos', v_pos);
  perform pg_temp.put('ag_a', v_ag_a); perform pg_temp.put('ag_b', v_ag_b);
  perform pg_temp.act(v_pos);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  -- one test job per outlet, from POS Settings → Test print (the back-office path)
  perform pg_temp.act(v_owner);
  perform pg_temp.put('job_a', insert_test_print('Bar', v_a));
  perform pg_temp.put('job_b', insert_test_print('Bar', v_b));
end $$;

-- ── X1. A staff email login — a cashier of A, or HQ — and no login: refused at the till and the printers ──
do $$
declare
  v_a     uuid := pg_temp.id('a');
  v_c1    uuid := pg_temp.id('c1');
  v_job_a uuid := pg_temp.id('job_a');
  v_items jsonb := pg_temp.items();
  n       integer;
  r       record;
begin
  for r in select * from (values ('cashier'), ('owner')) x(who) loop
    perform pg_temp.act(pg_temp.id(r.who));
    perform pg_temp.expect_error(format('select open_table(%L, 2)', v_c1), 'device_unpaired', 'X1 open_table, ' || r.who);
    perform pg_temp.expect_error(format('select place_counter_order(%L, %L, 2, %L::jsonb, gen_random_uuid())', v_c1, 'dine_in', v_items),
                                 'device_unpaired', 'X1 place_counter_order, ' || r.who);
    perform pg_temp.expect_error('select checkout_bill(gen_random_uuid(), ''[]''::jsonb, gen_random_uuid())', 'device_unpaired',
                                 'X1 checkout_bill, ' || r.who);
    perform pg_temp.expect_error(format('select count(*) from pos_open_bill_summaries(%L)', v_a), 'device_unpaired',
                                 'X1 pos_open_bill_summaries, ' || r.who);
    perform pg_temp.expect_error(format('select claim_print_job(%L)', v_job_a), 'device_unpaired', 'X1 claim_print_job, ' || r.who);
    perform pg_temp.expect_error(format('select finish_print_job(%L, true, null)', v_job_a), 'device_unpaired', 'X1 finish_print_job, ' || r.who);
    perform pg_temp.expect_error('select insert_test_print(''Bar'')', 'device_unpaired', 'X1 a test print with no outlet, ' || r.who);
    perform pg_temp.expect_error(format('select requeue_print_job(%L)', v_job_a), 'device_unpaired', 'X1 requeue_print_job, ' || r.who);
    perform pg_temp.expect_error('select pos_whoami()', 'device_unpaired', 'X1 pos_whoami, ' || r.who);
    if pos_session_branch() is not null then raise exception 'FAIL X1 pos_session_branch of %: %', r.who, pos_session_branch(); end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect_error(format('select open_table(%L, 2)', v_c1), 'device_unpaired', 'X1 open_table, no login');
  perform pg_temp.expect_error(format('select claim_print_job(%L)', v_job_a), 'device_unpaired', 'X1 claim_print_job, no login');
  if (select status from print_jobs where id = v_job_a) is distinct from 'pending' then raise exception 'FAIL X1 the job left pending'; end if;
  if exists (select 1 from bills where branch_id = v_a) then raise exception 'FAIL X1 a refused call opened a bill'; end if;
  -- a till write on a table: the cashier's home table, which they do not manage
  perform pg_temp.act(pg_temp.id('cashier'));
  set local role authenticated;
  update dining_tables set qr_paused = true where id = v_c1;
  get diagnostics n = row_count;
  reset role;
  if n <> 0 then raise exception 'FAIL X1 a staff login paused QR on its home table'; end if;
end $$;

-- ── X2. A POS tablet with a session still runs the till; locked, it gets no_session ──
do $$
declare
  v_a     uuid := pg_temp.id('a');
  v_bill  uuid;
  v_order uuid;
begin
  perform pg_temp.act(pg_temp.id('pos'));
  if pos_session_branch() is distinct from v_a then raise exception 'FAIL X2 pos_session_branch: %', pos_session_branch(); end if;
  v_bill := open_table(pg_temp.id('c1'), 2);
  if (select branch_id from bills where id = v_bill) is distinct from v_a then raise exception 'FAIL X2 open_table'; end if;
  perform pg_temp.put('bill', v_bill);
  v_order := place_counter_order(pg_temp.id('c2'), 'dine_in', 2, pg_temp.items(), gen_random_uuid());
  if (select placed_by from orders where id = v_order) is distinct from pg_temp.id('cashier')
     or (select device_id from orders where id = v_order) is distinct from pg_temp.id('pos') then
    raise exception 'FAIL X2 the order (placed by the cashier, on the tablet)';
  end if;
  perform pg_temp.expect_error(format('select claim_print_job(%L)', pg_temp.id('job_a')), 'not_printing_tablet', 'X2 a tablet that does not print');
  update pos_staff_sessions set ended_at = now(), end_reason = 'locked' where device_id = pg_temp.id('pos') and ended_at is null;
  perform pg_temp.expect_error(format('select count(*) from pos_open_bill_summaries(%L)', v_a), 'no_session', 'X2 a locked tablet');
end $$;

-- ── X3. Print agents: own outlet only, no staff session needed; whoami ──
do $$
declare
  v_job_a uuid := pg_temp.id('job_a');
  v_job_b uuid := pg_temp.id('job_b');
begin
  perform pg_temp.act(pg_temp.id('ag_a'));
  if (pos_agent_whoami()->>'outletId')::uuid is distinct from pg_temp.id('a') then raise exception 'FAIL X3 whoami of agent A'; end if;
  if claim_print_job(v_job_b) then raise exception 'FAIL X3 agent A claimed outlet B''s job'; end if;
  if not claim_print_job(v_job_a) then raise exception 'FAIL X3 agent A could not claim its job'; end if;
  perform finish_print_job(v_job_a, true, null);
  if (select status from print_jobs where id = v_job_a) is distinct from 'printed' then raise exception 'FAIL X3 finish'; end if;
  perform pg_temp.act(pg_temp.id('ag_b'));
  if not claim_print_job(v_job_b) then raise exception 'FAIL X3 agent B could not claim its job'; end if;
end $$;

-- ── X4. The back office for a staff login: settings, test print, reports, approvers, devices, reads, My PIN,
--    unpairing an agent (which then stops) ──
do $$
declare
  v_a     uuid := pg_temp.id('a');
  v_bill  uuid := pg_temp.id('bill');
  v_res   jsonb;
  n_routes integer; n_bills integer;
begin
  perform pg_temp.act(pg_temp.id('owner'));
  perform save_receipt_settings(v_a, '{"receiptTitle":"Verify C3"}');
  if (select receipt_title from branches where id = v_a) is distinct from 'Verify C3' then raise exception 'FAIL X4 save_receipt_settings'; end if;
  perform save_shift_settings(v_a, 5000);
  if (select cash_variance_limit_sen from branch_pos_settings where branch_id = v_a) is distinct from 5000 then raise exception 'FAIL X4 save_shift_settings'; end if;
  perform save_lock_settings(v_a, 15);
  if (select idle_lock_minutes from branch_pos_settings where branch_id = v_a) is distinct from 15 then raise exception 'FAIL X4 save_lock_settings'; end if;
  if insert_test_print('Bar', v_a) is null then raise exception 'FAIL X4 test print from POS Settings'; end if;
  if pos_report_sales(array[v_a], current_date, current_date) is null then raise exception 'FAIL X4 the sales report'; end if;
  perform count(*) from pos_outlet_approvers(v_a);
  if (select count(*) from pos_devices_list() l where l.id in (pg_temp.id('pos'), pg_temp.id('ag_a'), pg_temp.id('ag_b'))) <> 3 then
    raise exception 'FAIL X4 Devices lists the outlet devices';
  end if;
  set local role authenticated;
  select count(*) into n_routes from print_routes where branch_id = v_a;
  select count(*) into n_bills from bills where id = v_bill;
  reset role;
  if n_routes <> 1 or n_bills <> 1 then raise exception 'FAIL X4 HQ reads % routes and % bills of A (expected 1, 1)', n_routes, n_bills; end if;
  -- My PIN in Craft OS, for a staff login
  perform pg_temp.act(pg_temp.id('cashier'));
  v_res := set_my_pos_pin('2222', '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL X4 My PIN: %', v_res; end if;
  -- Devices → Unpair: the agent is refused at once
  perform pg_temp.act(pg_temp.id('owner'));
  perform pos_unpair_device(pg_temp.id('ag_b'));
  perform pg_temp.act(pg_temp.id('ag_b'));
  perform pg_temp.expect_error('select pos_agent_whoami()', 'device_unpaired', 'X4 an unpaired agent asks who it is');
  perform pg_temp.expect_error(format('select claim_print_job(%L)', pg_temp.id('job_b')), 'device_unpaired', 'X4 an unpaired agent claims');
end $$;

select 'VERIFY OK' as result;
rollback;
