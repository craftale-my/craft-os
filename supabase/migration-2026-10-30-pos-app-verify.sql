-- Self-check for the POS app's server additions. Run on craft-os-dev after
-- migration-2026-10-30-pos-app.sql. Everything is rolled back. Success = "VERIFY OK".
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

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000000a1';   -- cashier of VERIFY P A
  v_mgr   uuid := 'eeeeeeee-0000-0000-0000-0000000000a2';   -- manager of VERIFY P A (branch-only)
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000000a3';   -- the printing tablet of A
  v_a uuid; v_res jsonb;
begin
  if has_function_privilege('anon', 'pos_whoami()', 'execute') or not has_function_privilege('authenticated', 'pos_whoami()', 'execute') then
    raise exception 'FAIL grants: pos_whoami is for signed-in clients only';
  end if;
  if not coalesce((select proconfig @> array['search_path=public, pg_temp'] from pg_proc where oid = 'pos_whoami()'::regprocedure), false) then
    raise exception 'FAIL search_path: pos_whoami';
  end if;
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';
  insert into branches(name, address) values ('VERIFY P A', 'a') returning id into v_a;
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_mgr), (v_dev);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify P Cashier', 'trainee', true, current_date, 'staff', v_a),
    (v_mgr,  'Verify P Manager', 'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'manager' where id = v_mgr;
  perform pg_temp.act(v_cash);
  if not coalesce((set_my_pos_pin('1111', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier PIN'; end if;
  perform pg_temp.act(v_mgr);
  if not coalesce((set_my_pos_pin('2222', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: manager PIN'; end if;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by)
  values (v_dev, v_a, 'pos', 'P Counter', 'ipad', true, v_owner);

  perform pg_temp.act(v_cash);                                                         -- a staff login is no device
  perform pg_temp.expect_error('select pos_whoami()', 'device_unpaired', 'A1 a staff login');
  perform pg_temp.act(v_dev);
  perform pg_temp.expect_error('select pos_whoami()', 'no_session', 'A1 no session');
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in'; end if;
  v_res := pos_whoami();
  if v_res->>'deviceName' is distinct from 'P Counter' or (v_res->>'prints')::boolean is distinct from true
     or (v_res->>'outletId')::uuid is distinct from v_a or v_res->>'outletName' is distinct from 'VERIFY P A'
     or (v_res->>'staffId')::uuid is distinct from v_cash or v_res->>'staffName' is distinct from 'Verify P Cashier'
     or (v_res->>'canSupervise')::boolean is distinct from false or (v_res->>'canUnpair')::boolean is distinct from false then
    raise exception 'FAIL A1 the cashier: %', v_res;
  end if;
  v_res := pos_start_session(v_mgr, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: manager sign-in'; end if;
  v_res := pos_whoami();
  if (v_res->>'staffId')::uuid is distinct from v_mgr or (v_res->>'canSupervise')::boolean is distinct from true
     or (v_res->>'canUnpair')::boolean is distinct from true then
    raise exception 'FAIL A1 the manager: %', v_res;
  end if;
  perform pos_end_session('locked');
  perform pg_temp.expect_error('select pos_whoami()', 'no_session', 'A1 after Lock');

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
