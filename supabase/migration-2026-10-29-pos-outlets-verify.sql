-- Self-check for POS outlets. Run on craft-os-dev after migration-2026-10-29-pos-outlets.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK". Sections follow the
-- migration: A schema, grants and search_path; O3 the capabilities; O1 outlets and their
-- guard; O4 open outlets, scope and who may work where; O2 extra outlets; O5 approvers and
-- PINs; O6 bill numbers; O7 POS settings on a chosen outlet.
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
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_mgr   uuid := 'eeeeeeee-0000-0000-0000-000000000071';   -- manager of VERIFY O A
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-000000000072';   -- cashier of VERIFY O A
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-000000000073';   -- supervisor of VERIFY O B
  v_hr    uuid := 'eeeeeeee-0000-0000-0000-000000000074';   -- hr, home VERIFY O A
  v_a uuid; v_b uuid; v_pop uuid; v_kiosk uuid; v_id uuid;
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  n integer; r record; v_text text;
begin
  -- ── A. schema, grants, search_path ────────────────────────────────────────
  for r in select c from unnest(array['kind', 'opens_on', 'closes_on', 'bill_prefix']) as c loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'branches'
                    and column_name = r.c) then
      raise exception 'FAIL O1 schema: branches.% is missing', r.c;
    end if;
  end loop;
  for r in select c from unnest(array['branches_kind_check', 'branches_outlet_dates_check', 'branches_bill_prefix_check']) as c loop
    if not exists (select 1 from pg_constraint where conname = r.c) then raise exception 'FAIL O1 schema: % is missing', r.c; end if;
  end loop;
  if not exists (select 1 from pg_indexes where indexname = 'branches_bill_prefix_key') then
    raise exception 'FAIL O1 schema: bill prefixes are not unique';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.staff_outlets'::regclass) then
    raise exception 'FAIL O2: staff_outlets has no RLS';
  end if;
  if has_table_privilege('anon', 'staff_outlets', 'select') or has_table_privilege('authenticated', 'staff_outlets', 'insert')
     or has_table_privilege('authenticated', 'staff_outlets', 'delete') or not has_table_privilege('authenticated', 'staff_outlets', 'select') then
    raise exception 'FAIL O2: staff_outlets privileges (staff read only, writes through set_staff_outlet)';
  end if;
  for r in select f from unnest(array['my_outlets()', 'save_outlet(uuid,text,text,date,date,text)', 'set_staff_outlet(uuid,uuid,boolean)',
                                      'pos_manages_outlet(uuid)', 'pos_outlet_approvers(uuid)', 'pos_approvers()', 'clear_pos_pin(uuid)',
                                      'save_receipt_settings(uuid,jsonb)', 'save_shift_settings(uuid,integer)',
                                      'save_branch_catalogs(uuid,jsonb)', 'insert_test_print(text,uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array['staff_outlet_scope(uuid)', 'pos_staff_may_work(uuid,uuid)', 'pos_outlet_open(uuid)',
                                      'pos_next_bill_no(uuid)', 'pos_check_approver(uuid,uuid,text)', 'staff_has_cap(uuid,text)']) as f loop
    if has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL grants: % is internal but callable', r.f;
    end if;
  end loop;
  for r in select f from unnest(array['save_receipt_settings(jsonb)', 'save_shift_settings(integer)', 'save_branch_catalogs(jsonb)',
                                      'insert_test_print(text)']) as f loop
    if to_regprocedure(r.f) is not null then raise exception 'FAIL O7: the old % is still there', r.f; end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public'
              and p.proname = any (array['has_menu_cap', 'staff_has_cap', 'branches_outlet_guard', 'pos_outlet_open',
                                         'staff_outlet_scope', 'pos_staff_may_work', 'pos_manages_outlet', 'my_outlets',
                                         'save_outlet', 'set_staff_outlet', 'pos_approvers', 'pos_outlet_approvers',
                                         'pos_check_approver', 'clear_pos_pin', 'pos_next_bill_no', 'save_receipt_settings',
                                         'save_shift_settings', 'save_branch_catalogs', 'insert_test_print', 'dining_tables_guard'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  for r in select t from unnest(array['print_routes', 'branch_catalogs', 'service_charge_rules', 'payment_methods', 'reason_templates']) as t loop
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = r.t || '_manage' and cmd = 'ALL'
                    and qual like '%pos_manages_outlet(branch_id)%' and with_check like '%pos_manages_outlet(branch_id)%') then
      raise exception 'FAIL O7 rls: %_manage is not limited to the caller''s outlets', r.t;
    end if;
  end loop;
  if pg_get_functiondef('dining_tables_guard()'::regprocedure) not like '%pos_manages_outlet(old.branch_id)%' then
    raise exception 'FAIL O7: dining_tables_guard does not check the outlet — re-run migration-2026-10-29-pos-outlets.sql';
  end if;

  -- ── B. fixture: outlets A, B, a pop-up and a kiosk; a manager, a cashier, a supervisor, hr ──
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;                                                                         -- code defaults
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';
  insert into branches(name, address) values ('VERIFY O A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY O B', 'b') returning id into v_b;
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_mgr), (v_cash), (v_sup), (v_hr);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_mgr,  'Verify O Manager',    'trainee', true, current_date, 'staff', v_a),
    (v_cash, 'Verify O Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify O Supervisor', 'trainee', true, current_date, 'staff', v_b),
    (v_hr,   'Verify O HR',         'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'manager' where id = v_mgr;
  update staff set system_role = 'supervisor' where id = v_sup;
  update staff set system_role = 'hr' where id = v_hr;

  -- ── O3. capabilities ──────────────────────────────────────────────────────
  if not staff_has_cap(v_cash, 'pos_login') or not staff_has_cap(v_sup, 'pos_login') or not staff_has_cap(v_mgr, 'pos_login')
     or staff_has_cap(v_hr, 'pos_login') then
    raise exception 'FAIL O3: pos_login defaults (every role but hr)';
  end if;
  if not staff_has_cap(v_owner, 'all_branches') or not staff_has_cap(v_hr, 'all_branches') or staff_has_cap(v_cash, 'all_branches')
     or staff_has_cap(v_sup, 'all_branches') or staff_has_cap(v_mgr, 'all_branches') then
    raise exception 'FAIL O3: all_branches (owner and hr by default; managers switched off for this run)';
  end if;
  update system_role_permissions set permissions = permissions || '{"pos_login": false}' where system_role = 'staff';
  if staff_has_cap(v_cash, 'pos_login') then raise exception 'FAIL O3: the Owner''s setting does not win'; end if;
  update system_role_permissions set permissions = permissions - 'pos_login' where system_role = 'staff';

  -- ── O1. outlets: HQ only, validated, prefixes unique ──────────────────────
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O POP', 'popup', current_date, current_date, null)$q$,
                               'Only HQ can add or change outlets', 'O1 a branch manager');
  perform pg_temp.expect_error(format('update branches set kind = %L where id = %L', 'kiosk', v_a),
                               'Only HQ can change an outlet''s kind, dates or bill prefix', 'O1 direct write by a branch manager');
  perform pg_temp.expect_error($q$insert into branches(name, kind) values ('VERIFY O Z', 'kiosk')$q$,
                               'Only HQ can change an outlet''s kind, dates or bill prefix', 'O1 direct insert of a kiosk by a branch manager');
  perform pg_temp.act(v_hr);                                                            -- all_branches without access_settings
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O POP', 'popup', current_date, current_date, null)$q$,
                               'Only HQ can add or change outlets', 'O1 hr');
  perform pg_temp.expect_error(format('update branches set bill_prefix = %L where id = %L', 'ZQ6', v_a),
                               'Only HQ can change an outlet''s kind, dates or bill prefix', 'O1 direct write by hr');
  perform pg_temp.act(v_owner);
  perform pg_temp.expect_error($q$select save_outlet(null, '  ', 'branch', null, null, null)$q$, 'Enter the outlet name', 'O1 no name');
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'stall', null, null, null)$q$,
                               'Choose Branch, Kiosk or Pop-up', 'O1 bad kind');
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'popup', current_date, null, null)$q$,
                               'A pop-up needs its first and last day', 'O1 pop-up without its last day');
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'popup', current_date, current_date - 1, null)$q$,
                               'The last day is before the first day', 'O1 pop-up dates reversed');
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'kiosk', null, null, 'TOOLONG')$q$,
                               'The bill prefix is 1 to 4 letters or digits', 'O1 long prefix');
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'kiosk', null, null, 'P-1')$q$,
                               'The bill prefix is 1 to 4 letters or digits', 'O1 prefix with a dash');
  perform pg_temp.expect_error($q$select save_outlet(null, 'verify o a', 'branch', null, null, null)$q$,
                               'An outlet named verify o a already exists', 'O1 duplicate name');
  v_pop := save_outlet(null, ' VERIFY O POP ', 'popup', v_today - 1, v_today + 1, ' zq8 ');
  if (select name || '|' || kind || '|' || opens_on || '|' || closes_on || '|' || bill_prefix || '|' || is_active from branches where id = v_pop)
       is distinct from format('VERIFY O POP|popup|%s|%s|ZQ8|true', v_today - 1, v_today + 1) then
    raise exception 'FAIL O1 pop-up saved: %', (select row_to_json(b) from branches b where id = v_pop);
  end if;
  perform pg_temp.expect_error($q$select save_outlet(null, 'VERIFY O X', 'kiosk', null, null, 'ZQ8')$q$,
                               'The bill prefix ZQ8 is used by VERIFY O POP', 'O1 duplicate prefix');
  v_kiosk := save_outlet(null, 'VERIFY O KIOSK', 'kiosk', v_today, v_today, null);      -- a kiosk keeps no dates
  if (select opens_on is null and closes_on is null and kind = 'kiosk' from branches where id = v_kiosk) is not true then
    raise exception 'FAIL O1: a kiosk kept dates';
  end if;
  v_id := save_outlet(v_kiosk, 'VERIFY O KIOSK', 'kiosk', null, null, 'ZQ7');
  if v_id is distinct from v_kiosk or (select bill_prefix from branches where id = v_kiosk) is distinct from 'ZQ7' then
    raise exception 'FAIL O1: editing an outlet';
  end if;
  perform pg_temp.expect_error(format('select save_outlet(%L, %L, %L, null, null, null)', gen_random_uuid(), 'VERIFY O Y', 'branch'),
                               'Outlet not found', 'O1 unknown outlet');
  begin
    update branches set kind = 'popup' where id = v_b;                                -- HQ, but a pop-up needs dates
    raise exception 'FAIL O1: a pop-up without dates was accepted';
  exception when check_violation then null;
  end;

  -- ── O4. open for POS ──────────────────────────────────────────────────────
  if not pos_outlet_open(v_a) or not pos_outlet_open(v_pop) or not pos_outlet_open(v_kiosk) then
    raise exception 'FAIL O4: an open outlet reads closed';
  end if;
  update branches set opens_on = v_today - 10, closes_on = v_today - 1 where id = v_pop;
  if pos_outlet_open(v_pop) then raise exception 'FAIL O4: a pop-up after its last day is open'; end if;
  update branches set opens_on = v_today + 1, closes_on = v_today + 2 where id = v_pop;
  if pos_outlet_open(v_pop) then raise exception 'FAIL O4: a pop-up before its first day is open'; end if;
  update branches set opens_on = v_today, closes_on = v_today where id = v_pop;
  if not pos_outlet_open(v_pop) then raise exception 'FAIL O4: a one-day pop-up on its day is closed'; end if;
  update branches set is_active = false where id = v_kiosk;
  if pos_outlet_open(v_kiosk) then raise exception 'FAIL O4: an inactive outlet is open'; end if;
  update branches set is_active = true where id = v_kiosk;
  if pos_outlet_open(gen_random_uuid()) then raise exception 'FAIL O4: an unknown outlet is open'; end if;

  -- ── O4 / O2. scope and who may work where ─────────────────────────────────
  if not pos_staff_may_work(v_cash, v_a) or pos_staff_may_work(v_cash, v_b) or pos_staff_may_work(v_cash, v_pop) then
    raise exception 'FAIL O4: a cashier works at the home branch only';
  end if;
  if not pos_staff_may_work(v_owner, v_b) or not pos_staff_may_work(v_owner, v_pop) then
    raise exception 'FAIL O4: all_branches works everywhere';
  end if;
  if pos_staff_may_work(v_hr, v_a) then raise exception 'FAIL O4: no pos_login, still works'; end if;
  if pos_staff_may_work(v_cash, null) then raise exception 'FAIL O4: works at no outlet'; end if;
  perform pg_temp.act(v_cash);
  perform pg_temp.expect_error(format('select set_staff_outlet(%L, %L, true)', v_cash, v_b),
                               'Only a manager can change where staff may work', 'O2 a cashier');
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error(format('select set_staff_outlet(%L, %L, true)', v_cash, v_b),
                               'This outlet is not one of yours', 'O2 an outlet outside the manager''s scope');
  perform pg_temp.expect_error(format('select set_staff_outlet(%L, %L, true)', v_cash, v_a),
                               'This is their home branch already', 'O2 the home branch');
  perform pg_temp.expect_error(format('select set_staff_outlet(%L, %L, true)', gen_random_uuid(), v_a),
                               'Staff member not found', 'O2 unknown staff');
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_cash, v_b, true);
  perform set_staff_outlet(v_cash, v_b, true);                                          -- twice is fine
  if (select count(*) from staff_outlets where staff_id = v_cash and branch_id = v_b and added_by = v_owner) <> 1 then
    raise exception 'FAIL O2: the extra outlet was not recorded once, by its adder';
  end if;
  if not pos_staff_may_work(v_cash, v_b) then raise exception 'FAIL O2: an extra outlet does not count'; end if;
  perform set_staff_outlet(v_mgr, v_b, true);                                           -- the manager's own extra outlet
  perform pg_temp.act(v_mgr);
  select string_agg(name || ':' || is_home || ':' || open_now, ',' order by is_home desc, name) into v_text from my_outlets();
  if v_text is distinct from 'VERIFY O A:true:true,VERIFY O B:false:true' then
    raise exception 'FAIL O4 my_outlets of a manager: %', v_text;
  end if;
  set local role authenticated;
  select count(*) into n from staff_outlets where staff_id in (v_cash, v_mgr);
  reset role;
  if n <> 2 then raise exception 'FAIL O2: staff cannot read staff_outlets (% rows)', n; end if;
  perform set_staff_outlet(v_cash, v_b, false);                                         -- the manager now holds B
  if pos_staff_may_work(v_cash, v_b) then raise exception 'FAIL O2: removing an extra outlet'; end if;
  perform pg_temp.act(v_owner);
  select count(*) into n from my_outlets() where id in (v_a, v_b, v_pop, v_kiosk);
  if n <> 4 then raise exception 'FAIL O4: my_outlets of HQ lists % of the 4 test outlets', n; end if;
  update staff set status = 'resigned' where id = v_mgr;
  if pos_staff_may_work(v_mgr, v_a) or pos_staff_may_work(v_mgr, v_b) then raise exception 'FAIL O4: a resigned manager still works'; end if;
  update staff set status = 'active' where id = v_mgr;

  -- ── O5. approvers and PINs ────────────────────────────────────────────────
  perform pg_temp.act(v_sup);
  if not (set_my_pos_pin('2468', null)->>'ok')::boolean then raise exception 'FAIL O5 fixture: PIN not set'; end if;
  perform pg_temp.expect_error(format('select pos_check_approver(%L, %L, %L)', v_a, v_sup, '2468'),
                               'The approver cannot work at this outlet', 'O5 a supervisor of another outlet');
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_sup, v_a, true);
  if pos_check_approver(v_a, v_sup, '2468') is not null then raise exception 'FAIL O5: an approver from an extra outlet'; end if;
  perform pg_temp.expect_error(format('select pos_check_approver(%L, %L, %L)', v_a, v_cash, '0000'),
                               'This person cannot approve voids or refunds', 'O5 a cashier as approver');
  perform pg_temp.act(v_cash);
  if not exists (select 1 from pos_approvers() where staff_id = v_sup and has_pin) then
    raise exception 'FAIL O5: pos_approvers misses an approver from an extra outlet';
  end if;
  if exists (select 1 from pos_approvers() where staff_id = v_cash) then raise exception 'FAIL O5: a cashier listed as approver'; end if;
  perform pg_temp.expect_error(format('select count(*) from pos_outlet_approvers(%L)', v_a),
                               'This outlet is not one of yours', 'O5 approvers list for a cashier');
  perform pg_temp.act(v_mgr);
  if not exists (select 1 from pos_outlet_approvers(v_a) where staff_id = v_sup) then
    raise exception 'FAIL O5: pos_outlet_approvers misses the extra-outlet approver';
  end if;
  perform pg_temp.expect_error(format('select count(*) from pos_outlet_approvers(%L)', v_pop),
                               'This outlet is not one of yours', 'O5 approvers list outside the scope');
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_mgr, v_b, false);
  perform set_staff_outlet(v_sup, v_a, false);
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error(format('select clear_pos_pin(%L)', v_sup),
                               'This person does not work at your outlets', 'O5 clear a PIN outside the scope');
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_sup, v_a, true);
  perform pg_temp.act(v_mgr);
  perform clear_pos_pin(v_sup);
  if exists (select 1 from staff_pos_pins where staff_id = v_sup) then raise exception 'FAIL O5: the PIN was not cleared'; end if;
  perform pg_temp.expect_error(format('select clear_pos_pin(%L)', v_owner),
                               'Only HQ can clear the PIN of HQ staff', 'O5 a branch manager clears HQ''s PIN');
  perform pg_temp.expect_error(format('select clear_pos_pin(%L)', v_hr),
                               'Only HQ can clear the PIN of HQ staff', 'O5 a branch manager clears hr''s PIN');
  perform pg_temp.act(v_owner);
  perform clear_pos_pin(v_hr);                                                          -- HQ may

  -- ── O6. bill numbers ──────────────────────────────────────────────────────
  v_text := pos_next_bill_no(v_pop);
  if v_text !~ '^ZQ8-\d{6}-001$' then raise exception 'FAIL O6: a prefixed bill number: %', v_text; end if;
  v_text := pos_next_bill_no(v_pop);
  if v_text !~ '^ZQ8-\d{6}-002$' then raise exception 'FAIL O6: the next prefixed bill number: %', v_text; end if;
  if pos_next_bill_no(v_b) !~ '^\d{6}-001$' then raise exception 'FAIL O6: a bill number without a prefix'; end if;
  if pos_next_bill_no(v_pop) <> 'ZQ8-' || to_char(v_today, 'YYMMDD') || '-003' then
    raise exception 'FAIL O6: the prefix, the Malaysia day and the running number';
  end if;

  -- ── O7. POS settings on a chosen outlet ───────────────────────────────────
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100'),
                                                                  (v_b, 'Bar', 'agent', '127.0.0.1:9101');
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error(format('select save_receipt_settings(%L, %L::jsonb)', v_b, '{"receiptTitle": "Nope"}'),
                               'This outlet is not one of yours', 'O7 receipt settings of another outlet');
  perform pg_temp.expect_error(format('select save_shift_settings(%L, 100)', v_b),
                               'This outlet is not one of yours', 'O7 shift settings of another outlet');
  perform pg_temp.expect_error(format('select save_branch_catalogs(%L, %L::jsonb)', v_b, '{}'),
                               'This outlet is not one of yours', 'O7 catalogs of another outlet');
  perform pg_temp.expect_error(format('select insert_test_print(%L, %L)', 'Bar', v_b),
                               'This outlet is not one of yours', 'O7 a test print at another outlet');
  perform save_shift_settings(v_a, 700);
  if (select cash_variance_limit_sen from branch_pos_settings where branch_id = v_a) is distinct from 700 then
    raise exception 'FAIL O7: shift settings of the home branch';
  end if;
  v_id := insert_test_print('Bar', v_a);
  if (select branch_id from print_jobs where id = v_id) is distinct from v_a then raise exception 'FAIL O7: a test print at the chosen outlet'; end if;
  perform pg_temp.act(v_cash);
  v_id := insert_test_print('Bar');                                                     -- the POS: the home branch
  if (select branch_id from print_jobs where id = v_id) is distinct from v_a then raise exception 'FAIL O7: the POS test print'; end if;
  perform pg_temp.expect_error(format('select insert_test_print(%L, %L)', 'Bar', v_a),
                               'This outlet is not one of yours', 'O7 a cashier''s test print for the back office');
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_mgr, v_b, true);                                           -- an extra outlet gives its back office
  perform pg_temp.act(v_mgr);
  perform save_shift_settings(v_b, 900);
  if (select cash_variance_limit_sen from branch_pos_settings where branch_id = v_b) is distinct from 900 then
    raise exception 'FAIL O7: shift settings of an extra outlet';
  end if;
  perform save_receipt_settings(v_b, '{"receiptTitle": "Verify O B"}'::jsonb);
  if (select receipt_title from branches where id = v_b) is distinct from 'Verify O B' then
    raise exception 'FAIL O7: receipt settings of an extra outlet';
  end if;
  perform pg_temp.act(v_owner);
  perform set_staff_outlet(v_mgr, v_b, false);
  -- the write policies, as a signed-in client
  perform pg_temp.act(v_mgr);
  set local role authenticated;
  begin
    insert into print_routes(branch_id, name, kind, address) values (v_b, 'Kitchen', 'agent', '127.0.0.1:9102');
    raise exception 'FAIL O7 rls: a printer added at another outlet';
  exception when insufficient_privilege then null;
  end;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Kitchen', 'agent', '127.0.0.1:9103');
  update print_routes set address = '127.0.0.1:9199' where branch_id = v_b and name = 'Bar';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL O7 rls: a printer changed at another outlet'; end if;
  begin
    insert into dining_tables(branch_id, label) values (v_b, 'OB1');
    raise exception 'FAIL O7 rls: a table added at another outlet';
  exception when insufficient_privilege then null;
  end;
  insert into dining_tables(branch_id, label) values (v_a, 'OA1');
  reset role;
  perform pg_temp.act(v_owner);
  insert into dining_tables(branch_id, label) values (v_b, 'OB1');
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error(format('update dining_tables set sort_order = 5 where branch_id = %L and label = %L', v_b, 'OB1'),
                               'Only a manager can change this table''s QR code, branch or status', 'O7 a table of another outlet');
  update dining_tables set sort_order = 5 where branch_id = v_a and label = 'OA1';
  perform pg_temp.expect_error(format('update dining_tables set branch_id = %L where branch_id = %L and label = %L', v_b, v_a, 'OA1'),
                               'Only a manager can change this table''s QR code, branch or status', 'O7 moving a table to another outlet');

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
