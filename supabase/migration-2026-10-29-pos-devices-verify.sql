-- Self-check for POS devices and staff sessions. Run on craft-os-dev after
-- migration-2026-10-29-pos-devices.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections follow the migration: A schema, grants and search_path; D2
-- activation; D3 devices and unpairing; D5 sign-in, lockout and sessions; D4 the device
-- context; D6 the lock setting.
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
  v_mgr   uuid := 'eeeeeeee-0000-0000-0000-000000000081';   -- manager of VERIFY D A
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-000000000082';   -- cashier of VERIFY D A
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-000000000083';   -- supervisor of VERIFY D A
  v_far   uuid := 'eeeeeeee-0000-0000-0000-000000000084';   -- cashier of VERIFY D B
  v_nopin uuid := 'eeeeeeee-0000-0000-0000-000000000085';   -- cashier of VERIFY D A without a PIN
  v_dev1  uuid := 'eeeeeeee-0000-0000-0000-0000000000d1';   -- POS tablet at A
  v_dev2  uuid := 'eeeeeeee-0000-0000-0000-0000000000d2';   -- second POS tablet at A
  v_agent uuid := 'eeeeeeee-0000-0000-0000-0000000000d3';   -- print agent at A
  v_dev4  uuid := 'eeeeeeee-0000-0000-0000-0000000000d4';   -- POS tablet at the closed pop-up
  v_dev5  uuid := 'eeeeeeee-0000-0000-0000-0000000000d5';   -- a later POS tablet at A, approved as the printing tablet
  v_dev6  uuid := 'eeeeeeee-0000-0000-0000-0000000000d6';   -- a tablet whose account is deleted after activation
  v_a uuid; v_b uuid; v_pop uuid;
  v_res jsonb; v_req jsonb; v_code text; v_secret text; v_rid uuid; v_ctx record;
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  n integer; r record; v_text text;
begin
  -- ── A. schema, grants, search_path ────────────────────────────────────────
  for r in select t from unnest(array['pos_devices', 'pos_device_requests', 'pos_staff_sessions', 'pos_login_attempts']) as t loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || r.t)::regclass) then
      raise exception 'FAIL D1: % has no RLS', r.t;
    end if;
    if exists (select 1 from unnest(array['anon', 'authenticated']) as role(name),
                             unnest(array['select', 'insert', 'update', 'delete', 'truncate']) as priv(name)
                where has_table_privilege(role.name, 'public.' || r.t, priv.name)) then
      raise exception 'FAIL D1: % is open to clients', r.t;
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns where table_name = 'branch_pos_settings' and column_name = 'idle_lock_minutes'
                  and column_default = '10') then
    raise exception 'FAIL D1: branch_pos_settings.idle_lock_minutes (default 10) is missing';
  end if;
  for r in select f from unnest(array['pos_activation_request(text,text,text)', 'pos_activation_poll(text,text)',
                                      'pos_activation_finish(uuid,uuid)', 'pos_activation_unclaim(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute')
       or not has_function_privilege('service_role', r.f, 'execute') then
      raise exception 'FAIL grants: % must be service role only', r.f;
    end if;
  end loop;
  for r in select f from unnest(array['pos_device_requests_pending()', 'pos_decide_device_request(uuid,boolean,text,uuid,text,text,boolean)',
                                      'pos_devices_list()', 'pos_unpair_device(uuid)', 'pos_set_print_tablet(uuid)', 'pos_login_roster()',
                                      'pos_start_session(uuid,text)', 'pos_end_session(text)', 'save_lock_settings(uuid,integer)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: clients cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array['pos_ctx()', 'pos_print_branch()', 'pos_is_hq()']) as f loop
    if has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL grants: % is internal but callable', r.f;
    end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public'
              and p.proname = any (array['pos_is_hq', 'pos_activation_request', 'pos_activation_poll', 'pos_activation_finish',
                                         'pos_activation_unclaim', 'pos_device_requests_pending', 'pos_decide_device_request',
                                         'pos_devices_list', 'pos_unpair_device', 'pos_set_print_tablet', 'pos_ctx', 'pos_print_branch',
                                         'pos_login_roster', 'pos_start_session', 'pos_end_session', 'save_lock_settings'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;

  -- ── B. fixture: outlets A and B, a closed pop-up; staff; PINs ─────────────
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;                                                                         -- code defaults
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';
  delete from pos_device_requests where status = 'pending';                             -- a clean slate for the counts (rolled back)
  insert into branches(name, address) values ('VERIFY D A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY D B', 'b') returning id into v_b;
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  v_pop := save_outlet(null, 'VERIFY D POP', 'popup', v_today - 10, v_today - 1, null);
  insert into auth.users (id) values (v_mgr), (v_cash), (v_sup), (v_far), (v_nopin);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_mgr,   'Verify D Manager',    'trainee', true, current_date, 'staff', v_a),
    (v_cash,  'Verify D Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,   'Verify D Supervisor', 'trainee', true, current_date, 'staff', v_a),
    (v_far,   'Verify D Far',        'trainee', true, current_date, 'staff', v_b),
    (v_nopin, 'Verify D No PIN',     'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'manager' where id = v_mgr;
  update staff set system_role = 'supervisor' where id = v_sup;
  perform pg_temp.act(v_cash);
  if not coalesce((set_my_pos_pin('1111', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier PIN'; end if;
  perform pg_temp.act(v_sup);
  if not coalesce((set_my_pos_pin('2222', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: supervisor PIN'; end if;
  perform pg_temp.act(v_far);
  if not coalesce((set_my_pos_pin('3333', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: far PIN'; end if;

  -- ── D2. activation ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', '', true);                                  -- the Edge Function: no user
  if pos_activation_request('Bar iPad', 'toaster', '10.0.0.1') is distinct from '{"error": "bad_request"}'::jsonb then
    raise exception 'FAIL D2: a bad platform was accepted';
  end if;
  v_req := pos_activation_request('  Bar iPad  ', 'ipad', '10.0.0.1');
  v_code := v_req->>'code'; v_secret := v_req->>'secret';
  if v_code !~ '^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$' or v_secret !~ '^[0-9a-f]{48}$' or v_req->>'expiresAt' is null then
    raise exception 'FAIL D2 request: %', v_req;
  end if;
  if (select name || '|' || platform || '|' || status from pos_device_requests where code = v_code) is distinct from 'Bar iPad|ipad|pending'
     or (select expires_at - created_at from pos_device_requests where code = v_code) is distinct from interval '24 hours'
     or exists (select 1 from pos_device_requests where code = v_code and secret_hash = v_secret) then
    raise exception 'FAIL D2: the request row (trimmed name, 24 h, only the secret''s hash stored)';
  end if;
  for n in 1..4 loop perform pos_activation_request(null, 'android', '10.0.0.1'); end loop;   -- 5 from this IP now
  if pos_activation_request(null, 'android', '10.0.0.1') is distinct from '{"error": "too_many"}'::jsonb then
    raise exception 'FAIL D2: a sixth request from one IP within the hour';
  end if;
  if pos_activation_request(null, 'android', '10.0.0.2')->>'code' is null then raise exception 'FAIL D2: another IP is refused'; end if;
  if pos_activation_poll(v_code, 'wrong')->>'status' is distinct from 'unknown' then raise exception 'FAIL D2: a wrong secret is told apart'; end if;
  if pos_activation_poll('ZZZ-ZZZ', v_secret)->>'status' is distinct from 'unknown' then raise exception 'FAIL D2: an unknown code'; end if;
  if pos_activation_poll(lower(v_code), v_secret)->>'status' is distinct from 'pending' then raise exception 'FAIL D2: a pending request'; end if;

  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error('select count(*) from pos_device_requests_pending()', 'Only HQ can approve devices', 'D2 list by a branch manager');
  select id into v_rid from pos_device_requests where code = v_code;
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)', v_rid, v_code, v_a, 'pos', 'Bar iPad'),
                               'Only HQ can approve devices', 'D2 approval by a branch manager');
  perform pg_temp.act(v_owner);
  if not exists (select 1 from pos_device_requests_pending() p where p.code = v_code and p.name = 'Bar iPad') then
    raise exception 'FAIL D2: HQ does not see the waiting request';
  end if;
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)', v_rid, 'ABC-DEF', v_a, 'pos', 'Bar iPad'),
                               'The code does not match the tablet', 'D2 wrong code');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, null, %L, %L, false)', v_rid, v_code, 'pos', 'Bar iPad'),
                               'Choose the outlet', 'D2 no outlet');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)', v_rid, v_code, v_a, 'till', 'Bar iPad'),
                               'Choose POS or Print agent', 'D2 bad kind');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)', v_rid, v_code, v_a, 'pos', repeat('x', 41)),
                               'Enter the device name (up to 40 characters)', 'D2 long name');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, true)', v_rid, v_code, v_a, 'print_agent', 'Shop Mac'),
                               'Only a POS tablet can print and hold the cash drawer', 'D2 a printing print agent');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)', v_rid, v_code, v_a, 'pos', '   '),
                               'Enter the device name (up to 40 characters)', 'D2 empty name');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)', v_rid, 'ABC', v_a, 'pos', 'Bar iPad'),
                               'The code does not match the tablet', 'D2 a short code');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, null, %L, %L, %L, %L, false)', v_rid, v_code, v_a, 'pos', 'Bar iPad'),
                               'Invalid request', 'D2 no decision');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, false, null, null, null, null, null)', gen_random_uuid()),
                               'Request not found', 'D2 unknown request');
  perform pos_decide_device_request(v_rid, true, lower(replace(v_code, '-', ' ')), v_a, 'pos', ' Bar iPad ', true);   -- typed loosely; the printing tablet
  if coalesce((select expires_at from pos_device_requests where id = v_rid) > now() + interval '1 hour', true) then
    raise exception 'FAIL D2: an approved request is not collected within the hour';
  end if;
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, false, null, null, null, null, null)', v_rid),
                               'This request is no longer waiting', 'D2 deciding twice');
  perform set_config('request.jwt.claims', '', true);
  v_res := pos_activation_poll(v_code, v_secret);
  if v_res->>'status' is distinct from 'issue' or (v_res->>'requestId')::uuid is distinct from v_rid or (v_res->>'branchId')::uuid is distinct from v_a
     or v_res->>'kind' is distinct from 'pos' or v_res->>'name' is distinct from 'Bar iPad' then
    raise exception 'FAIL D2 first poll after approval: %', v_res;
  end if;
  if pos_activation_poll(v_code, v_secret)->>'status' is distinct from 'pending' then
    raise exception 'FAIL D2: a second poll while the first creates the account';
  end if;
  perform pos_activation_unclaim(v_rid);                                                 -- the account could not be made
  if pos_activation_poll(v_code, v_secret)->>'status' is distinct from 'issue' then raise exception 'FAIL D2: retry after unclaim'; end if;
  insert into auth.users (id) values (v_dev1);
  perform pos_activation_finish(v_rid, v_dev1);
  if (select branch_id || '|' || kind || '|' || name || '|' || platform || '|' || prints || '|' || approved_by from pos_devices where id = v_dev1)
       is distinct from v_a || '|pos|Bar iPad|ipad|true|' || v_owner then
    raise exception 'FAIL D2: the device row';
  end if;
  if pos_activation_poll(v_code, v_secret)->>'status' is distinct from 'unknown' then raise exception 'FAIL D2: credentials handed out twice'; end if;
  perform pg_temp.expect_error(format('select pos_activation_finish(%L, %L)', v_rid, v_dev2), 'This request cannot be finished', 'D2 finish twice');
  -- reject and expire
  v_req := pos_activation_request(null, 'other', null);
  perform pg_temp.act(v_owner);
  perform pos_decide_device_request((select id from pos_device_requests where code = v_req->>'code'), false, null, null, null, null, null);
  perform set_config('request.jwt.claims', '', true);
  if pos_activation_poll(v_req->>'code', v_req->>'secret')->>'status' is distinct from 'rejected' then raise exception 'FAIL D2: rejected'; end if;
  v_req := pos_activation_request(null, 'other', null);
  update pos_device_requests set expires_at = now() - interval '1 second' where code = v_req->>'code';
  v_res := pos_activation_poll(v_req->>'code', v_req->>'secret');
  if v_res->>'status' is distinct from 'expired' or (select status from pos_device_requests where code = v_req->>'code') is distinct from 'expired' then
    raise exception 'FAIL D2: expired';
  end if;
  -- at most 50 waiting
  insert into pos_device_requests(code, secret_hash, platform)
  select 'QQ' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + g / 32, 1) || '-' || 'QQ'
           || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + g % 32, 1), 'x', 'other'
    from generate_series(0, 49 - (select count(*)::int from pos_device_requests where status = 'pending')) g;
  if pos_activation_request(null, 'other', null) is distinct from '{"error": "busy"}'::jsonb then raise exception 'FAIL D2: more than 50 waiting'; end if;
  delete from pos_device_requests where secret_hash = 'x';
  -- a request waiting past its time cannot be approved; an approved one not collected in time expires
  v_req := pos_activation_request(null, 'other', null);
  update pos_device_requests set expires_at = now() - interval '1 second' where code = v_req->>'code';
  perform pg_temp.act(v_owner);
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)',
                                      (select id from pos_device_requests where code = v_req->>'code'), v_req->>'code', v_a, 'pos', 'Late'),
                               'This request is no longer waiting', 'D2 approving an expired request');
  v_req := pos_activation_request(null, 'other', null);
  perform pos_decide_device_request((select id from pos_device_requests where code = v_req->>'code'), true, v_req->>'code', v_a, 'pos', 'Slow', false);
  update pos_device_requests set expires_at = now() - interval '1 second' where code = v_req->>'code';
  perform set_config('request.jwt.claims', '', true);
  v_res := pos_activation_poll(v_req->>'code', v_req->>'secret');
  if v_res->>'status' is distinct from 'expired' then raise exception 'FAIL D2: an approved request collected too late: %', v_res; end if;
  -- a spent request stays spent, even when its device account is deleted later
  v_req := pos_activation_request('Gone iPad', 'ipad', null);
  perform pg_temp.act(v_owner);
  perform pos_decide_device_request((select id from pos_device_requests where code = v_req->>'code'), true, v_req->>'code', v_a, 'pos', 'Gone iPad', false);
  perform set_config('request.jwt.claims', '', true);
  v_res := pos_activation_poll(v_req->>'code', v_req->>'secret');
  insert into auth.users (id) values (v_dev6);
  perform pos_activation_finish((v_res->>'requestId')::uuid, v_dev6);
  delete from auth.users where id = v_dev6;
  v_res := pos_activation_poll(v_req->>'code', v_req->>'secret');
  if v_res->>'status' is distinct from 'unknown' then raise exception 'FAIL D2: a deleted device''s request issued a new login: %', v_res; end if;
  -- the other test devices, made directly
  insert into auth.users (id) values (v_dev2), (v_agent), (v_dev4);
  insert into pos_devices(id, branch_id, kind, name, platform, approved_by) values
    (v_dev2, v_a, 'pos', 'Kitchen iPad', 'ipad', v_owner),
    (v_agent, v_a, 'print_agent', 'Shop Mac', 'agent', v_owner),
    (v_dev4, v_pop, 'pos', 'Pop-up iPad', 'android', v_owner);

  -- ── D3. devices list ──────────────────────────────────────────────────────
  perform pg_temp.act(v_cash);
  perform pg_temp.expect_error('select count(*) from pos_devices_list()', 'Only a manager can see devices', 'D3 list by a cashier');
  perform pg_temp.act(v_mgr);
  select string_agg(l.name, ',' order by l.name) into v_text from pos_devices_list() l where l.id in (v_dev1, v_dev2, v_agent, v_dev4);
  if v_text is distinct from 'Bar iPad,Kitchen iPad,Shop Mac' then raise exception 'FAIL D3: a branch manager sees %', v_text; end if;
  perform pg_temp.expect_error(format('select pos_unpair_device(%L)', v_dev4), 'This device is not at one of your outlets', 'D3 unpair elsewhere');
  -- the printing tablet: one per outlet, moved by a manager of the outlet or by approving another
  if not coalesce((select l.prints from pos_devices_list() l where l.id = v_dev1), false) then raise exception 'FAIL D3: the list shows the printing tablet'; end if;
  perform pos_set_print_tablet(v_dev2);
  if (select string_agg(name || ':' || prints, ',' order by name) from pos_devices where id in (v_dev1, v_dev2)) is distinct from 'Bar iPad:false,Kitchen iPad:true' then
    raise exception 'FAIL D3: moving the printing tablet';
  end if;
  perform pg_temp.expect_error(format('select pos_set_print_tablet(%L)', v_agent), 'Only an active POS tablet can print', 'D3 a print agent as printing tablet');
  perform pg_temp.expect_error(format('select pos_set_print_tablet(%L)', v_dev4), 'This device is not at one of your outlets', 'D3 printing tablet elsewhere');
  perform pg_temp.expect_error(format('select pos_set_print_tablet(%L)', gen_random_uuid()), 'Device not found', 'D3 printing tablet unknown');
  perform pg_temp.expect_error(format('select pos_unpair_device(%L)', gen_random_uuid()), 'Device not found', 'D3 unpair unknown');
  perform pg_temp.act(v_cash);
  perform pg_temp.expect_error(format('select pos_unpair_device(%L)', v_dev2), 'This device is not at one of your outlets', 'D3 unpair by a cashier');
  perform pg_temp.expect_error(format('select pos_set_print_tablet(%L)', v_dev2), 'This device is not at one of your outlets', 'D3 printing tablet by a cashier');
  perform pg_temp.act(v_mgr);
  begin
    update pos_devices set prints = true where id = v_dev1;
    raise exception 'FAIL D3: two printing tablets at one outlet';
  exception when unique_violation then null;
  end;
  perform pg_temp.act(v_owner);
  perform set_config('request.jwt.claims', '', true);
  v_req := pos_activation_request('Front iPad', 'ipad', null);
  perform pg_temp.act(v_owner);
  perform pos_decide_device_request((select id from pos_device_requests where code = v_req->>'code'), true, v_req->>'code', v_a, 'pos', 'Front iPad', true);
  perform set_config('request.jwt.claims', '', true);
  v_res := pos_activation_poll(v_req->>'code', v_req->>'secret');
  insert into auth.users (id) values (v_dev5);
  perform pos_activation_finish((v_res->>'requestId')::uuid, v_dev5);
  if (select string_agg(name || ':' || prints, ',' order by name) from pos_devices where id in (v_dev2, v_dev5)) is distinct from 'Front iPad:true,Kitchen iPad:false' then
    raise exception 'FAIL D3: approving a new printing tablet moves the role';
  end if;

  -- ── D5. the lock screen and sign-in ───────────────────────────────────────
  perform pg_temp.act(v_cash);                                                          -- a staff email login is no device
  perform pg_temp.expect_error('select pos_login_roster()', 'device_unpaired', 'D5 roster for a staff login');
  perform pg_temp.act(v_agent);
  perform pg_temp.expect_error('select pos_login_roster()', 'device_unpaired', 'D5 roster for a print agent');
  perform pg_temp.act(v_dev1);
  v_res := pos_login_roster();
  if v_res->'device'->>'name' is distinct from 'Bar iPad' or coalesce((v_res->'device'->>'prints')::boolean, true)
     or v_res->'outlet'->>'name' is distinct from 'VERIFY D A' or not coalesce((v_res->'outlet'->>'open')::boolean, false)
     or (v_res->>'idleLockMinutes')::int is distinct from 10 or v_res->'session' is distinct from 'null'::jsonb then
    raise exception 'FAIL D5 roster: %', v_res;
  end if;
  select string_agg(e->>'name' || ':' || (e->>'hasPin'), ',' order by e->>'name') into v_text
    from jsonb_array_elements(v_res->'staff') e where e->>'name' like 'Verify D%';
  if v_text is distinct from 'Verify D Cashier:true,Verify D Manager:false,Verify D No PIN:false,Verify D Supervisor:true' then
    raise exception 'FAIL D5 roster staff: %', v_text;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_res->'staff') e where (e->>'id')::uuid = v_owner) then
    raise exception 'FAIL D5: HQ is missing from the roster';
  end if;
  v_res := pos_start_session(v_far, '3333');
  if v_res->>'code' is distinct from 'not_allowed' or v_res->>'error' is distinct from 'This person cannot sign in here' then
    raise exception 'FAIL D5: another outlet''s cashier signed in: %', v_res;
  end if;
  v_res := pos_start_session(v_nopin, '1234');
  if v_res->>'error' is distinct from 'Set a PIN in Craft OS first' then raise exception 'FAIL D5: no PIN'; end if;
  perform pg_temp.expect_error('select pos_ctx()', 'no_session', 'D4 no session yet');
  -- four wrong tries on tablet 1, the fifth on tablet 2: locked everywhere
  for n in 1..4 loop
    v_res := pos_start_session(v_cash, '9999');
    if v_res->>'error' is distinct from format('Wrong PIN · %s %s left', 5 - n, case when 5 - n = 1 then 'try' else 'tries' end) then
      raise exception 'FAIL D5 wrong PIN %: %', n, v_res;
    end if;
  end loop;
  perform pg_temp.act(v_dev2);
  v_res := pos_start_session(v_cash, '12');
  if v_res->>'code' is distinct from 'pin_locked' then raise exception 'FAIL D5: the fifth wrong try (other tablet) does not lock'; end if;
  perform pg_temp.act(v_dev1);
  v_res := pos_start_session(v_cash, '1111');
  if v_res->>'error' is distinct from 'Too many tries. Try again in 10 minutes.' then
    raise exception 'FAIL D5: the right PIN works during the lock';
  end if;
  if (select count(*) from pos_login_attempts where staff_id = v_cash) is distinct from 5 then raise exception 'FAIL D5: tries are not all recorded'; end if;
  update pos_login_attempts set at = at - interval '11 minutes' where staff_id = v_cash;  -- the 10 minutes pass
  v_res := pos_start_session(v_cash, '5555');                                            -- one more wrong try locks again
  if v_res->>'code' is distinct from 'pin_locked' then raise exception 'FAIL D5: a wrong try after the lock does not lock again: %', v_res; end if;
  update pos_login_attempts set at = at - interval '11 minutes' where staff_id = v_cash;
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) or v_res->'staff'->>'name' is distinct from 'Verify D Cashier' then raise exception 'FAIL D5 sign-in: %', v_res; end if;
  v_res := pos_start_session(v_cash, '0000');
  if v_res->>'error' is distinct from 'Wrong PIN · 4 tries left' then raise exception 'FAIL D5: a success clears the count'; end if;
  select * into v_ctx from pos_ctx();
  if v_ctx.device_id is distinct from v_dev1 or v_ctx.branch_id is distinct from v_a or v_ctx.staff_id is distinct from v_cash then raise exception 'FAIL D4 pos_ctx: %', row_to_json(v_ctx); end if;
  -- stamps: written when older than 30 s, left alone when fresh (now() is fixed inside this transaction)
  update pos_devices set last_seen_at = now() - interval '1 minute' where id = v_dev1;
  update pos_staff_sessions set last_active_at = now() - interval '1 minute' where device_id = v_dev1 and ended_at is null;
  perform pos_ctx();
  if (select last_seen_at from pos_devices where id = v_dev1) is distinct from now()
     or (select last_active_at from pos_staff_sessions where device_id = v_dev1 and ended_at is null) is distinct from now() then
    raise exception 'FAIL D4: pos_ctx does not stamp an old last-seen / last-active';
  end if;
  update pos_devices set last_seen_at = now() - interval '10 seconds' where id = v_dev1;
  perform pos_ctx();
  if (select last_seen_at from pos_devices where id = v_dev1) is distinct from now() - interval '10 seconds' then
    raise exception 'FAIL D4: pos_ctx rewrites a fresh last-seen';
  end if;
  if (pos_login_roster()->'session'->>'staffId')::uuid is distinct from v_cash then raise exception 'FAIL D5: the roster shows who is signed in'; end if;
  -- wrong tries more than 24 h ago do not count: four old ones, then one now
  insert into pos_login_attempts(staff_id, device_id, at, ok)
  select v_sup, v_dev2, now() - interval '25 hours', false from generate_series(1, 4);
  v_res := pos_start_session(v_sup, '9999');
  if v_res->>'error' is distinct from 'Wrong PIN · 4 tries left' then raise exception 'FAIL D5: tries older than 24 h count: %', v_res; end if;
  -- the supervisor takes over the tablet
  v_res := pos_start_session(v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL D5: switching staff (old tries counted?): %', v_res; end if;
  if (select string_agg(end_reason || ':' || (ended_at is not null), ',') from pos_staff_sessions where device_id = v_dev1 and staff_id = v_cash)
       is distinct from 'switched:true' then
    raise exception 'FAIL D5: the previous session is not ended as switched';
  end if;
  perform pg_temp.expect_error('select pos_end_session(''bored'')', 'Invalid reason', 'D5 bad reason');
  perform pos_end_session('locked');
  perform pg_temp.expect_error('select pos_ctx()', 'no_session', 'D4 after Lock');
  -- access changes while signed in
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL D5: sign in again'; end if;
  perform pg_temp.act(v_owner);
  update staff set status = 'resigned' where id = v_cash;
  perform pg_temp.act(v_dev1);
  perform pg_temp.expect_error('select pos_ctx()', 'access_changed', 'D4 resigned while signed in');
  perform pos_end_session('access_changed');
  perform pg_temp.act(v_owner);
  update staff set status = 'active' where id = v_cash;
  -- a closed pop-up: nobody signs in, nothing runs
  perform pg_temp.act(v_dev4);
  v_res := pos_login_roster();
  if coalesce((v_res->'outlet'->>'open')::boolean, true) or v_res->'staff' is distinct from '[]'::jsonb then raise exception 'FAIL D5 closed outlet roster: %', v_res; end if;
  v_res := pos_start_session(v_owner, '0000');
  if v_res->>'code' is distinct from 'outlet_closed' then raise exception 'FAIL D5: sign-in at a closed outlet'; end if;
  insert into pos_staff_sessions(device_id, staff_id) values (v_dev4, v_owner);
  perform pg_temp.expect_error('select pos_ctx()', 'outlet_closed', 'D4 closed outlet');
  -- the print agent: prints, never runs the till
  perform pg_temp.act(v_agent);
  update pos_devices set last_seen_at = null where id = v_agent;
  if pos_print_branch() is distinct from v_a then raise exception 'FAIL D4: the print agent''s outlet'; end if;
  if (select last_seen_at from pos_devices where id = v_agent) is distinct from now() then raise exception 'FAIL D4: printing does not stamp last seen'; end if;
  perform pg_temp.expect_error('select pos_ctx()', 'device_unpaired', 'D4 a print agent at the till');
  perform pg_temp.act(v_dev2);
  if pos_print_branch() is distinct from v_a then raise exception 'FAIL D4: a locked tablet still prints'; end if;

  -- ── D3. unpair ────────────────────────────────────────────────────────────
  perform pg_temp.act(v_dev1);
  v_res := pos_start_session(v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL D3 fixture: sign in before unpairing'; end if;
  perform pg_temp.act(v_mgr);
  perform pos_unpair_device(v_dev1);
  perform pos_unpair_device(v_dev1);                                                    -- twice is fine
  if (select revoked_by from pos_devices where id = v_dev1) is distinct from v_mgr
     or coalesce((select not isfinite(banned_until) or banned_until < now() + interval '99 years' from auth.users where id = v_dev1), true)
     or exists (select 1 from pos_staff_sessions where device_id = v_dev1 and ended_at is null)
     or not exists (select 1 from pos_staff_sessions where device_id = v_dev1 and end_reason = 'unpaired')
     or (select prints from pos_devices where id = v_dev1) then
    raise exception 'FAIL D3: unpairing (revoked by, banned, session ended as unpaired)';
  end if;
  perform pg_temp.act(v_dev1);
  perform pg_temp.expect_error('select pos_ctx()', 'device_unpaired', 'D4 after unpairing');
  perform pg_temp.expect_error('select pos_print_branch()', 'device_unpaired', 'D4 printing after unpairing');
  perform pg_temp.expect_error('select pos_login_roster()', 'device_unpaired', 'D5 roster after unpairing');
  perform pg_temp.expect_error(format('select pos_start_session(%L, %L)', v_sup, '2222'), 'device_unpaired', 'D5 sign-in after unpairing');

  -- ── D6. lock setting ──────────────────────────────────────────────────────
  perform pg_temp.act(v_cash);
  perform pg_temp.expect_error(format('select save_lock_settings(%L, 15)', v_a), 'Only a manager can change the lock settings', 'D6 cashier');
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error(format('select save_lock_settings(%L, 15)', v_b), 'This outlet is not one of yours', 'D6 another outlet');
  perform pg_temp.expect_error(format('select save_lock_settings(%L, 0)', v_a), 'Enter between 1 and 60 minutes', 'D6 zero');
  perform pg_temp.expect_error(format('select save_lock_settings(%L, 61)', v_a), 'Enter between 1 and 60 minutes', 'D6 61');
  perform save_lock_settings(v_a, 15);
  perform pg_temp.act(v_dev2);
  if (pos_login_roster()->>'idleLockMinutes')::int is distinct from 15 then raise exception 'FAIL D6: the roster carries the lock minutes'; end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
